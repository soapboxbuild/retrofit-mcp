// Measure register: the per-asset measures jsonl object at
// `<assetId>/retrofit/measures.jsonl` in the `asset-files` bucket is the
// source of truth for a scope's retrofit measure evaluations. Every
// mutation (save) re-renders a client-visible `measures.md`, registers/
// updates it as a `files` row (folder 'Retrofit'), and reindexes it via the
// soapbox-api internal endpoint. Never fail silently: any Supabase or fetch
// error propagates so the MCP layer can surface a structured tool error.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import type { MeasureEvaluation } from './evaluation.js'

export type Scope = { portfolioId: string; assetId: string }

const BUCKET = 'asset-files'

// Lazy/memoized client: constructing eagerly at import time would crash any
// module that transitively imports register.ts wherever SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY are unset (e.g. tests). See registry.ts.
let client: SupabaseClient | null = null

function getClient(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  }
  return client
}

function jsonlPath(scope: Scope): string {
  return `${scope.assetId}/retrofit/measures.jsonl`
}

// ---- pure functions -------------------------------------------------------

// Sanitize user-supplied inline data to prevent XSS and markdown injection.
// Applied to every interpolated user-data field in renderMeasuresMarkdown.
function sanitizeInline(s: string): string {
  // (1) Strip < and > (replace with ‹ ›)
  let result = s.replace(/</g, '‹').replace(/>/g, '›')

  // (2) Escape backticks to prevent markdown fence injection
  result = result.replace(/`/g, '\\`')

  // (3) Collapse newlines/carriage returns to single spaces (inline fields)
  result = result.replace(/[\r\n]+/g, ' ')

  // (4) Truncate to 2000 chars
  result = result.substring(0, 2000)

  return result
}

function fmtEcon(field?: { value: number; unit: string }): string {
  if (!field) return 'n/a'
  return sanitizeInline(`${field.value} ${field.unit}`)
}

export function renderMeasuresMarkdown(measures: MeasureEvaluation[]): string {
  const line = (m: MeasureEvaluation) => {
    const sourcesJoined = m.feasibility.sources.map(sanitizeInline).join(', ')
    const citationsJoined = m.future_proofing.citations.map(sanitizeInline).join(', ')
    return (
      `## ${sanitizeInline(m.name)}\n\n` +
      `- **Status:** ${sanitizeInline(m.status ?? 'proposed')} · **Family:** ${sanitizeInline(m.measure_family)} · **Candidate source:** ${sanitizeInline(m.candidate_source)}\n` +
      `- **Cost:** ${fmtEcon(m.cost)} · **NOI delta/yr:** ${fmtEcon(m.noi_delta_annual)} · **Exit value delta:** ${fmtEcon(m.exit_value_delta)}\n` +
      `- **Feasibility:** score ${m.feasibility.score}/5 · disruption: ${sanitizeInline(m.feasibility.disruption)} · site conditions: ${sanitizeInline(m.feasibility.site_conditions)} · contractor reality: ${sanitizeInline(m.feasibility.contractor_reality)} · staging: ${sanitizeInline(m.feasibility.staging)}\n` +
      `- **Feasibility sources:** ${sourcesJoined}\n` +
      `- **Future-proofing:** ${sanitizeInline(m.future_proofing.rationale)}\n` +
      `- **Citations:** ${citationsJoined}\n`
    )
  }
  return `# Retrofit Measures\n\n_Maintained by the Soapbox retrofit-specialist plugin._\n\n${measures.map(line).join('\n')}`
}

// ---- I/O half --------------------------------------------------------------

function isNotFoundError(error: unknown): boolean {
  if (!error) return false
  const msg = String((error as { message?: unknown }).message ?? error).toLowerCase()
  const status = (error as { statusCode?: unknown; status?: unknown }).statusCode ?? (error as { status?: unknown }).status
  return (
    msg.includes('not found') ||
    msg.includes('404') ||
    String(status) === '404'
  )
}

export async function loadMeasures(scope: Scope): Promise<MeasureEvaluation[]> {
  const supabase = getClient()
  const { data, error } = await supabase.storage.from(BUCKET).download(jsonlPath(scope))
  if (error) {
    if (isNotFoundError(error)) return []
    throw new Error(`loadMeasures failed: ${(error as { message?: string }).message ?? error}`)
  }
  const text = await data.text()
  if (!text.trim()) return []
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as MeasureEvaluation)
}

async function indexFile(fileId: string): Promise<void> {
  const res = await fetch(`${process.env.SOAPBOX_API_URL}/internal/index-file`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MCP_SERVER_SECRET}`,
    },
    body: JSON.stringify({ fileId }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`index-file failed: HTTP ${res.status}`)
}

async function findExistingFilesRow(scope: Scope): Promise<{ id: string } | null> {
  const supabase = getClient()
  const { data, error } = await supabase
    .from('files')
    .select('id')
    .eq('folder', 'Retrofit')
    .eq('name', 'measures.md')
    .eq('asset_id', scope.assetId)
    .maybeSingle()
  if (error) throw new Error(`findExistingFilesRow failed: ${error.message ?? error}`)
  return data ? { id: data.id as string } : null
}

export async function saveMeasures(scope: Scope, measures: MeasureEvaluation[]): Promise<void> {
  const supabase = getClient()

  const jsonl = measures.map((m) => JSON.stringify(m)).join('\n') + (measures.length ? '\n' : '')
  const { error: jsonlErr } = await supabase.storage
    .from(BUCKET)
    .upload(jsonlPath(scope), jsonl, { contentType: 'text/plain', upsert: true })
  if (jsonlErr) throw new Error(`saveMeasures: jsonl upload failed: ${jsonlErr.message ?? jsonlErr}`)

  const md = renderMeasuresMarkdown(measures)
  const size = Buffer.byteLength(md, 'utf8')

  const existing = await findExistingFilesRow(scope)
  let fileId: string

  if (existing) {
    fileId = existing.id
    const { error: updateErr } = await supabase
      .from('files')
      .update({ size, indexing_status: 'indexing' })
      .eq('id', fileId)
    if (updateErr) throw new Error(`saveMeasures: files row update failed: ${updateErr.message ?? updateErr}`)
  } else {
    fileId = randomUUID()
    const { error: insertErr } = await supabase.from('files').insert({
      id: fileId,
      asset_id: scope.assetId,
      portfolio_id: scope.portfolioId,
      name: 'measures.md',
      folder: 'Retrofit',
      mime_type: 'text/plain',
      size,
      storage_path: `${scope.assetId}/${fileId}/measures.md`,
      indexed: false,
      indexing_status: 'indexing',
    })
    if (insertErr) throw new Error(`saveMeasures: files row insert failed: ${insertErr.message ?? insertErr}`)
  }

  const { error: mdErr } = await supabase.storage
    .from(BUCKET)
    .upload(`${scope.assetId}/${fileId}/measures.md`, md, { contentType: 'text/plain', upsert: true })
  if (mdErr) throw new Error(`saveMeasures: md upload failed: ${mdErr.message ?? mdErr}`)

  await indexFile(fileId)
}

// ---- public API -------------------------------------------------------------

export async function saveMeasure(scope: Scope, e: MeasureEvaluation): Promise<{ id: string }> {
  const measures = await loadMeasures(scope)
  const full: MeasureEvaluation = { ...e, id: e.id ?? randomUUID() }
  const idx = measures.findIndex((m) => m.id === full.id)
  const next = idx === -1 ? [...measures, full] : measures.map((m, i) => (i === idx ? full : m))
  await saveMeasures(scope, next)
  return { id: full.id! }
}

export async function getMeasures(
  scope: Scope,
  status?: MeasureEvaluation['status']
): Promise<MeasureEvaluation[]> {
  const measures = await loadMeasures(scope)
  return status ? measures.filter((m) => m.status === status) : measures
}

async function teardownRegisterFile(scope: Scope): Promise<void> {
  const supabase = getClient()
  const existing = await findExistingFilesRow(scope)
  const paths = [jsonlPath(scope)]
  if (existing) paths.push(`${scope.assetId}/${existing.id}/measures.md`)
  const { error: rmErr } = await supabase.storage.from(BUCKET).remove(paths)
  if (rmErr) throw new Error(`teardownRegisterFile: storage remove failed: ${rmErr.message ?? rmErr}`)
  if (existing) {
    // embeddings.file_id has ON DELETE CASCADE on files(id), so deleting the
    // files row removes the RAG chunks automatically.
    const { error: delErr } = await supabase.from('files').delete().eq('id', existing.id)
    if (delErr) throw new Error(`teardownRegisterFile: files row delete failed: ${delErr.message ?? delErr}`)
  }
}

export async function deleteMeasure(scope: Scope, measureId: string): Promise<{ deleted: true; remaining: number }> {
  const measures = await loadMeasures(scope)
  if (!measures.some((m) => m.id === measureId)) {
    throw new Error(`measure_id ${measureId} not found in asset ${scope.assetId}'s measure register`)
  }
  const next = measures.filter((m) => m.id !== measureId)
  if (next.length > 0) {
    await saveMeasures(scope, next)
  } else {
    await teardownRegisterFile(scope)
  }
  return { deleted: true, remaining: next.length }
}
