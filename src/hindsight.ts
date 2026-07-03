// Hindsight shared-memory client, implemented against the verified stateless
// REST API rather than the JSON-RPC MCP endpoint (which requires stateful
// sessions and is not usable from a stateless caller like this one).
//
// Policy boundary: this module is a thin, unvalidated transport to the
// shared-memory store. All anonymization and tier-gating policy (domain
// enum, source-slug validation, distinct-source counts, confirmed-finding
// checks) lives in expertise.ts. Future callers must not call
// hindsightRetain directly against a shared/cross-client bank — go through
// expertise.ts's retainSharedExpertise so those gates cannot be bypassed.

function baseUrl(): string {
  return process.env.HINDSIGHT_API_URL!
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.HINDSIGHT_API_KEY}`,
  }
}

export async function hindsightRetain(bankId: string, content: string, tags?: string[]): Promise<void> {
  const item: { content: string; tags?: string[] } = { content }
  if (tags && tags.length > 0) item.tags = tags
  const res = await fetch(`${baseUrl()}/v1/default/banks/${bankId}/memories`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ items: [item] }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`hindsight retain: HTTP ${res.status}`)
}

export async function hindsightRecall(
  bankId: string,
  query: string,
  tags?: string[]
): Promise<{ results: Array<{ text: string; score?: number; tags?: string[] }> }> {
  const body: { query: string; tags?: string[]; tags_match?: 'any' } = { query }
  if (tags && tags.length > 0) {
    body.tags = tags
    body.tags_match = 'any'
  }
  const res = await fetch(`${baseUrl()}/v1/default/banks/${bankId}/memories/recall`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`hindsight recall: HTTP ${res.status}`)
  const json = await res.json()
  const mapResult = (r: { text: string; score?: number; tags?: string[] }) => ({
    text: r.text,
    score: r.score,
    tags: r.tags,
  })
  if (json && Array.isArray(json.results)) {
    return { results: (json.results as Array<{ text: string; score?: number; tags?: string[] }>).map(mapResult) }
  }
  if (Array.isArray(json)) {
    return { results: (json as Array<{ text: string; score?: number; tags?: string[] }>).map(mapResult) }
  }
  return { results: [] }
}
