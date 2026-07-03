// Shared reference library: a hindsight bank ('retrofit-library') holding
// curated third-party reference material (utility incentive programs, code
// requirements, manufacturer specs, etc). Anyone can search it; adding to it
// is gated behind RETROFIT_LIBRARY_ADMIN_KEY so the bank can't be polluted
// by arbitrary tool callers. Never call hindsightRetain before the gate has
// passed — rejection paths must be side-effect-free.

import { createHash, timingSafeEqual } from 'node:crypto'
import { hindsightRetain, hindsightRecall } from './hindsight.js'

const BANK_ID = 'retrofit-library'
const MIN_SECRET_LENGTH = 32
const MAX_CHUNK_LENGTH = 4000
const TITLE_MAX_LENGTH = 120
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/

export type LibraryResult = { text: string; tags: string[]; provenance: 'library' }

export type AddReferenceInput = {
  admin_key: string
  title: string
  source_org: string
  year?: number
  content: string
  topics: string[]
}

export type AddReferenceResult = { added: boolean; chunks?: number; error?: string }

// Same pattern as verifier-mcp's secretsMatch: hash both sides to a fixed
// length before timingSafeEqual, so we never leak the presented secret's
// length via an early return or a RangeError.
function secretsMatch(expected: string, presented: string): boolean {
  const expectedHash = createHash('sha256').update(expected).digest()
  const presentedHash = createHash('sha256').update(presented).digest()
  return timingSafeEqual(expectedHash, presentedHash)
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

// Splits content into chunks of at most MAX_CHUNK_LENGTH characters,
// preferring paragraph boundaries ('\n\n'). Any single paragraph longer than
// the limit is hard-split so no chunk ever exceeds it.
function chunkContent(content: string): string[] {
  const paragraphs = content.split('\n\n')
  const chunks: string[] = []
  let current = ''

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current)
      current = ''
    }
  }

  for (const para of paragraphs) {
    // Hard-split any paragraph that alone exceeds the limit.
    const pieces: string[] = []
    if (para.length > MAX_CHUNK_LENGTH) {
      for (let i = 0; i < para.length; i += MAX_CHUNK_LENGTH) {
        pieces.push(para.slice(i, i + MAX_CHUNK_LENGTH))
      }
    } else {
      pieces.push(para)
    }

    for (const piece of pieces) {
      const candidate = current.length > 0 ? `${current}\n\n${piece}` : piece
      if (candidate.length <= MAX_CHUNK_LENGTH) {
        current = candidate
      } else {
        flush()
        current = piece
      }
    }
  }
  flush()

  return chunks.length > 0 ? chunks : ['']
}

export async function searchLibrary(query: string): Promise<LibraryResult[]> {
  const { results } = await hindsightRecall(BANK_ID, query)
  return results.map((r) => ({ text: r.text, tags: r.tags ?? [], provenance: 'library' as const }))
}

export async function addReference(input: AddReferenceInput): Promise<AddReferenceResult> {
  // Gate first, before any other work (validation or hindsight calls).
  const secret = process.env.RETROFIT_LIBRARY_ADMIN_KEY
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return { added: false, error: 'library admin key not configured' }
  }
  if (!secretsMatch(secret, input.admin_key)) {
    return { added: false, error: 'unauthorized' }
  }

  if (input.title.length > TITLE_MAX_LENGTH) {
    return { added: false, error: 'title exceeds max length of 120 chars' }
  }

  const sourceOrgSlug = input.source_org.trim().toLowerCase()
  if (!SLUG_RE.test(sourceOrgSlug)) {
    return { added: false, error: 'source_org must be a valid slug' }
  }

  const topicSlugs: string[] = []
  for (const topic of input.topics) {
    const slug = topic.trim().toLowerCase()
    if (!SLUG_RE.test(slug)) {
      return { added: false, error: 'topics must be valid slugs' }
    }
    topicSlugs.push(slug)
  }

  const titleSlug = slugify(input.title)
  const tags = [
    'library',
    `org:${sourceOrgSlug}`,
    ...topicSlugs.map((t) => `topic:${t}`),
    `title:${titleSlug}`,
    ...(input.year !== undefined ? [`year:${input.year}`] : []),
  ]

  const chunks = chunkContent(input.content)
  const total = chunks.length
  const yearSuffix = input.year !== undefined ? `, ${input.year}` : ''

  for (let i = 0; i < total; i++) {
    const prefix = `${input.title} (${input.source_org}${yearSuffix}) — part ${i + 1}/${total}: `
    await hindsightRetain(BANK_ID, `${prefix}${chunks[i]}`, tags)
  }

  return { added: true, chunks: total }
}
