import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { Server } from 'node:http'

const SECRET = 'a'.repeat(32)
process.env.MCP_SERVER_SECRET = SECRET

vi.mock('../src/register.js', () => ({
  saveMeasure: vi.fn(async () => ({ id: 'm1' })),
  getMeasures: vi.fn(async () => []),
}))

const { createApp } = await import('../src/index.js')

let server: Server, base: string
beforeAll(async () => {
  server = createApp().listen(0)
  base = `http://localhost:${(server.address() as any).port}`
})
afterAll(() => server.close())

const TOOL_NAMES = [
  'propose_candidates',
  'evaluate_measure',
  'screen_measures',
  'get_measure_state',
  'update_measure_state',
  'get_retrofit_playbook',
  'search_reference_library',
  'add_reference',
]

const rpc = (method: string, params?: any, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${SECRET}`,
    'x-soapbox-portfolio-id': 'pf-test', 'x-soapbox-organization-id': 'org-test',
    ...headers,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(r => r.text())

describe('retrofit mcp server', () => {
  it('lists all eight tools', async () => {
    const raw = await rpc('tools/list')
    for (const t of TOOL_NAMES) expect(raw).toContain(t)
  })

  it('serves a playbook doctrine for hvac', async () => {
    const raw = await rpc('tools/call', { name: 'get_retrofit_playbook', arguments: { key: 'hvac' } })
    expect(raw).toMatch(/doctrine/)
  })

  it('exposes a health endpoint', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('rejects scoped tool calls without the trusted portfolio header', async () => {
    const raw = await rpc('tools/call', { name: 'get_measure_state', arguments: { asset_id: 'a1' } }, { 'x-soapbox-portfolio-id': '' })
    expect(raw).toMatch(/portfolio/i)
  })

  it('rejects evaluate_measure with an un-provenanced cost, naming the field', async () => {
    const measure = {
      measure_family: 'hvac',
      name: 'RTU replacement',
      candidate_source: 'audit',
      cost: { value: 50000, unit: 'USD' }, // no engine/source provenance
      owner_savings_annual: { value: 10000, unit: 'USD/yr', engine: 'll_allocation@1' },
      noi_delta_annual: { value: 10000, unit: 'USD/yr', engine: 'dcf_engine@1' },
      cap_rate: { value: 0.055, unit: 'ratio', source: 'asset metadata' },
      feasibility: { score: 4, site_conditions: 'ok', disruption: 'none', contractor_reality: 'ok', staging: 'ok', sources: ['pca'] },
      future_proofing: { rationale: 'ahead of Reg 28', citations: ['CO Reg 28'] },
    }
    const raw = await rpc('tools/call', { name: 'evaluate_measure', arguments: { asset_id: 'a1', measure } })
    expect(raw).toMatch(/cost/)
  })
})

describe('/mcp authentication', () => {
  it('rejects requests with no Authorization header', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: expect.any(String) })
  })
  it('rejects requests with the wrong bearer token', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer nope',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    expect(res.status).toBe(401)
  })
  it('accepts requests with the correct bearer token', async () => {
    const raw = await rpc('tools/list')
    expect(raw).toContain('propose_candidates')
  })
})

describe('/mcp refuses to serve when MCP_SERVER_SECRET is missing or weak', () => {
  // The auth middleware reads process.env.MCP_SERVER_SECRET per-request (not
  // captured at import time), so we can exercise the misconfigured-server
  // path against the same running app by toggling the env var around the call.
  it('responds 503 with no secret configured', async () => {
    const prev = process.env.MCP_SERVER_SECRET
    delete process.env.MCP_SERVER_SECRET
    try {
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      expect(res.status).toBe(503)
    } finally {
      process.env.MCP_SERVER_SECRET = prev
    }
  })
  it('responds 503 when the secret is too short', async () => {
    const prev = process.env.MCP_SERVER_SECRET
    process.env.MCP_SERVER_SECRET = 'short'
    try {
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      expect(res.status).toBe(503)
    } finally {
      process.env.MCP_SERVER_SECRET = prev
    }
  })
})
