import express from 'express'
import { fileURLToPath } from 'node:url'
import { createHash, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { proposeCandidates } from './candidates.js'
import { validateEvaluation, computeExitMath, type MeasureEvaluation } from './evaluation.js'
import { screenMeasures } from './screening.js'
import { saveMeasure, getMeasures, type Scope as RegisterScope } from './register.js'
import { getPlaybook } from './playbooks.js'
import { searchLibrary, addReference } from './library.js'

// Lazy/memoized client, mirroring src/registry.ts: constructing eagerly at
// import time would crash any environment (e.g. tests) where SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY are unset.
let client: SupabaseClient | null = null

function getClient(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  }
  return client
}

type RequestScope = { portfolioId?: string; organizationId?: string }

function scopeFromHeaders(headers: Record<string, string | string[] | undefined>): RequestScope {
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  return {
    portfolioId: pick(headers['x-soapbox-portfolio-id']),
    organizationId: pick(headers['x-soapbox-organization-id']),
  }
}

function requirePortfolio(scope: RequestScope): string {
  if (!scope.portfolioId) {
    throw new Error('Missing required trusted header x-soapbox-portfolio-id — this tool must be called through the Soapbox connector proxy.')
  }
  return scope.portfolioId
}

// Validates that asset_id (an optional tool parameter) belongs to the
// portfolio established by the trusted header, mirroring the assets lookup
// pattern in src/registry.ts.
async function resolveScope(scope: RequestScope, assetId?: string): Promise<{ portfolioId: string; assetId?: string }> {
  const portfolioId = requirePortfolio(scope)
  if (!assetId) return { portfolioId }
  const supabase = getClient()
  const { data, error } = await supabase
    .from('assets')
    .select('id')
    .eq('id', assetId)
    .eq('portfolio_id', portfolioId)
    .maybeSingle()
  if (error) throw new Error(`asset lookup failed: ${error.message ?? error}`)
  if (!data) throw new Error(`asset_id ${assetId} does not belong to portfolio ${portfolioId}`)
  return { portfolioId, assetId }
}

// Narrows a resolved scope (portfolioId + optional assetId) to the register
// module's Scope (portfolioId + required assetId), for callers that already
// require asset_id as a tool parameter.
function requireAssetScope(scope: { portfolioId: string; assetId?: string }, assetId: string): RegisterScope {
  return { portfolioId: scope.portfolioId, assetId }
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

const MIN_SECRET_LENGTH = 32

// Constant-time bearer-token check. Hashing both sides to a fixed-length
// digest before comparing means we never run timingSafeEqual on
// attacker-controlled-length buffers (which would itself leak length via
// the thrown RangeError / early return), and it means the two buffers we
// do compare are always equal length regardless of the presented secret's
// length.
function secretsMatch(expected: string, presented: string): boolean {
  const expectedHash = createHash('sha256').update(expected).digest()
  const presentedHash = createHash('sha256').update(presented).digest()
  return timingSafeEqual(expectedHash, presentedHash)
}

// Authenticates every request to /mcp with `Authorization: Bearer <secret>`.
// The Soapbox connector proxy strips any inbound Authorization header and
// re-sends the connector row's api_key as this bearer — so this is the only
// thing standing between the public Railway domain and full tenant access
// via spoofed x-soapbox-* headers. If the secret isn't configured (or is
// too short to be a real secret), refuse to serve rather than run open.
function requireMcpAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const secret = process.env.MCP_SERVER_SECRET
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    res.status(503).json({ error: 'server misconfigured: MCP_SERVER_SECRET is unset or too short' })
    return
  }
  const header = req.headers.authorization
  const presented = Array.isArray(header) ? header[0] : header
  const prefix = 'Bearer '
  if (!presented || !presented.startsWith(prefix)) {
    res.status(401).json({ error: 'missing or malformed Authorization header' })
    return
  }
  const token = presented.slice(prefix.length)
  if (!secretsMatch(secret, token)) {
    res.status(401).json({ error: 'invalid bearer token' })
    return
  }
  next()
}

const MEASURE_STATUS = ['proposed', 'recommended', 'defensive', 'screened-out', 'needs-data', 'implemented'] as const

function buildServer(scope: RequestScope): McpServer {
  const server = new McpServer({ name: 'retrofit-mcp', version: '1.0.0' })

  server.tool(
    'propose_candidates',
    'Start retrofit candidate discovery: returns the source checklist to pull (Audette, PCA, audit ECMs, equipment survey), playbook origination prompts, and the candidate schema.',
    {
      asset_attributes: z.record(z.string(), z.unknown()).optional().describe('Caller-supplied asset attributes (archetype, jurisdiction, equipment) used to prioritize origination prompts'),
    },
    async ({ asset_attributes }) => {
      requirePortfolio(scope)
      const result = proposeCandidates({ asset_attributes: asset_attributes as any })
      return textResult(result)
    }
  )

  server.tool(
    'evaluate_measure',
    'Validate + persist a measure evaluation. Every economic field requires engine or cited source provenance — LLM-computed numbers are rejected. Computes exit value (NOI ÷ cap rate) deterministically.',
    {
      asset_id: z.string().describe('Asset this measure evaluation belongs to'),
      measure: z.record(z.string(), z.unknown()).describe('The measure evaluation payload (see MeasureEvaluation schema)'),
    },
    async ({ asset_id, measure }) => {
      requirePortfolio(scope)
      const withAsset = { ...(measure as Record<string, unknown>), asset_id }
      const validated = validateEvaluation(withAsset)
      if (!validated.ok) {
        throw new Error(`measure evaluation failed validation: ${validated.errors.join('; ')}`)
      }
      let withExitMath: MeasureEvaluation
      try {
        withExitMath = computeExitMath(validated.evaluation)
      } catch (err) {
        throw new Error(`exit math computation failed: ${(err as Error).message ?? err}`)
      }
      const resolved = await resolveScope(scope, asset_id)
      const registerScope = requireAssetScope(resolved, asset_id)
      // Re-evaluating an existing measure id re-validates and re-saves it
      // from scratch; if the incoming payload doesn't carry notes (they
      // aren't part of what a caller re-submits for evaluation), preserve
      // whatever notes were previously recorded via update_measure_state
      // rather than silently dropping them.
      let toSave: MeasureEvaluation = withExitMath
      if (withExitMath.id) {
        const existingMeasures = await getMeasures(registerScope)
        const existing = existingMeasures.find((m) => m.id === withExitMath.id)
        toSave = { ...withExitMath, notes: withExitMath.notes ?? existing?.notes }
      }
      const { id } = await saveMeasure(registerScope, toSave)
      const persisted = { ...toSave, id }
      return textResult(persisted)
    }
  )

  server.tool(
    'screen_measures',
    'Apply the three tests (value, feasibility, future-proofing) to evaluated measures; labels recommended/defensive/screened-out/needs-data with reasons.',
    {
      asset_id: z.string().describe('Asset whose measure register to screen'),
      measure_ids: z.array(z.string()).optional().describe('Restrict screening to these measure ids; omit to screen the full register'),
    },
    async ({ asset_id, measure_ids }) => {
      const resolved = await resolveScope(scope, asset_id)
      const registerScope = requireAssetScope(resolved, asset_id)
      const all = await getMeasures(registerScope)
      const toScreen = measure_ids ? all.filter((m) => m.id && measure_ids.includes(m.id)) : all
      const labels = screenMeasures(toScreen)
      for (let i = 0; i < toScreen.length; i++) {
        const measure = toScreen[i]
        const label = labels[i]
        await saveMeasure(registerScope, { ...measure, status: label.label })
      }
      return textResult(labels)
    }
  )

  server.tool(
    'get_measure_state',
    "Read the asset's retrofit measure register (working state across sessions).",
    {
      asset_id: z.string().describe('Asset whose measure register to read'),
      status: z.enum(MEASURE_STATUS).optional().describe('Filter to measures with this status'),
    },
    async ({ asset_id, status }) => {
      const resolved = await resolveScope(scope, asset_id)
      const registerScope = requireAssetScope(resolved, asset_id)
      const result = await getMeasures(registerScope, status)
      return textResult(result)
    }
  )

  server.tool(
    'update_measure_state',
    "Update a measure's lifecycle status (e.g. mark implemented) with an optional note.",
    {
      asset_id: z.string().describe('Asset whose measure register to update'),
      measure_id: z.string().describe('The measure id to update'),
      status: z.enum(MEASURE_STATUS),
      note: z.string().optional().describe('Optional note to append to the measure record'),
    },
    async ({ asset_id, measure_id, status, note }) => {
      const resolved = await resolveScope(scope, asset_id)
      const registerScope = requireAssetScope(resolved, asset_id)
      const measures = await getMeasures(registerScope)
      const measure = measures.find((m) => m.id === measure_id) as (MeasureEvaluation & { notes?: string[] }) | undefined
      if (!measure) {
        throw new Error(`measure_id ${measure_id} not found in asset ${asset_id}'s measure register`)
      }
      const updated = note
        ? { ...measure, status, notes: [...(measure.notes ?? []), note] }
        : { ...measure, status }
      const { id } = await saveMeasure(registerScope, updated as MeasureEvaluation)
      return textResult({ ...updated, id })
    }
  )

  server.tool(
    'get_retrofit_playbook',
    'Get the versioned retrofit methodology for a measure family (hvac, envelope, dhw, controls-rcx, solar-storage, electrification-staging) or process phase (walk-the-pca, staging, baseline-discipline) — follow its doctrine.',
    {
      key: z.string().describe('Playbook key: a measure family or process phase name'),
    },
    async ({ key }) => {
      const result = getPlaybook(key)
      return textResult(result)
    }
  )

  server.tool(
    'search_reference_library',
    "Search Soapbox's curated building-science reference library (ASHRAE/DOE/PNNL/RMI-class sources). Citations carry provenance:'library'.",
    {
      query: z.string().describe('Search query'),
    },
    async ({ query }) => {
      const result = await searchLibrary(query)
      return textResult(result)
    }
  )

  server.tool(
    'add_reference',
    'Admin-only: add a reference document to the shared library.',
    {
      admin_key: z.string().describe('Shared library admin key'),
      title: z.string(),
      source_org: z.string(),
      year: z.number().optional(),
      content: z.string(),
      topics: z.array(z.string()),
    },
    async ({ admin_key, title, source_org, year, content, topics }) => {
      const result = await addReference({ admin_key, title, source_org, year, content, topics })
      return textResult(result)
    }
  )

  return server
}

export function createApp(): express.Express {
  const app = express()
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.post('/mcp', requireMcpAuth, async (req, res) => {
    const scope = scopeFromHeaders(req.headers)
    const server = buildServer(scope)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { server.close().catch(() => {}) })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  return app
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080)
  createApp().listen(port, () => console.log(`[retrofit-mcp] :${port}`))
}
