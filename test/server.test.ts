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

// ---- resolveScope's Supabase assets lookup (tenancy boundary) -------------
//
// The suite above runs against the module graph imported at file-load time,
// where '@supabase/supabase-js' is NOT mocked — resolveScope's asset lookup
// is never actually exercised there (every existing test either omits
// asset_id or fails validation/auth before reaching resolveScope). To cover
// resolveScope itself we reset the module registry, mock supabase-js (in
// addition to the register.js mock already registered above via vi.mock,
// which is hoisted and stays in effect across resetModules), and build a
// second app instance from a fresh import — mirroring the vi.doMock +
// resetModules + dynamic-import pattern used in test/register.test.ts.
describe('resolveScope: tenancy boundary + notes persistence across re-evaluation', () => {
  let scopedServer: Server, scopedBase: string
  let assetRow: { id: string } | null = { id: 'a1' }
  let measures: Array<Record<string, unknown>> = []
  const saveMeasureCalls: Array<Record<string, unknown>> = []

  const measureFixture = (overrides: Record<string, unknown> = {}) => ({
    measure_family: 'hvac',
    name: 'RTU replacement',
    candidate_source: 'audit',
    cost: { value: 50000, unit: 'USD', source: 'audit ECM table p.44' },
    owner_savings_annual: { value: 10000, unit: 'USD/yr', engine: 'll_allocation@1' },
    noi_delta_annual: { value: 10000, unit: 'USD/yr', engine: 'dcf_engine@1' },
    cap_rate: { value: 0.055, unit: 'ratio', source: 'asset metadata' },
    feasibility: { score: 4, site_conditions: 'ok', disruption: 'none', contractor_reality: 'ok', staging: 'ok', sources: ['pca'] },
    future_proofing: { rationale: 'ahead of Reg 28', citations: ['CO Reg 28'] },
    ...overrides,
  })

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: vi.fn(() => ({
        from: (table: string) => {
          if (table !== 'assets') throw new Error(`unexpected table ${table}`)
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: assetRow, error: null }),
                }),
              }),
            }),
          }
        },
      })),
    }))
    vi.doMock('../src/register.js', () => ({
      saveMeasure: vi.fn(async (_scope: unknown, m: Record<string, unknown>) => {
        const full = { ...m, id: (m.id as string) ?? 'm1' }
        saveMeasureCalls.push(full)
        const idx = measures.findIndex((x) => x.id === full.id)
        if (idx === -1) measures.push(full)
        else measures[idx] = full
        return { id: full.id as string }
      }),
      getMeasures: vi.fn(async () => measures),
    }))

    const mod = await import('../src/index.js')
    scopedServer = mod.createApp().listen(0)
    scopedBase = `http://localhost:${(scopedServer.address() as any).port}`
  })

  afterAll(async () => {
    scopedServer.close()
    vi.doUnmock('@supabase/supabase-js')
    vi.doUnmock('../src/register.js')
  })

  const scopedRpc = (method: string, params?: any) =>
    fetch(`${scopedBase}/mcp`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${SECRET}`,
      'x-soapbox-portfolio-id': 'pf-test', 'x-soapbox-organization-id': 'org-test',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(r => r.text())

  it('rejects get_measure_state for an asset_id that does not belong to the portfolio', async () => {
    assetRow = null
    const raw = await scopedRpc('tools/call', { name: 'get_measure_state', arguments: { asset_id: 'foreign-1' } })
    expect(raw).toMatch(/asset/i)
  })

  it('allows get_measure_state when the asset lookup returns a matching row', async () => {
    assetRow = { id: 'a1' }
    const raw = await scopedRpc('tools/call', { name: 'get_measure_state', arguments: { asset_id: 'a1' } })
    expect(raw).not.toMatch(/isError.{0,5}true/)
  })

  it('preserves a note added via update_measure_state across a later evaluate_measure re-save', async () => {
    assetRow = { id: 'a1' }

    // Seed measure m1 with no notes.
    await scopedRpc('tools/call', { name: 'evaluate_measure', arguments: { asset_id: 'a1', measure: measureFixture({ id: 'm1' }) } })

    // Append a note via update_measure_state.
    await scopedRpc('tools/call', { name: 'update_measure_state', arguments: { asset_id: 'a1', measure_id: 'm1', status: 'recommended', note: 'field verified 2026-07-03' } })
    const afterNote = saveMeasureCalls[saveMeasureCalls.length - 1]
    expect(afterNote.notes).toEqual(['field verified 2026-07-03'])

    // Re-evaluate the same measure id without notes in the payload.
    await scopedRpc('tools/call', { name: 'evaluate_measure', arguments: { asset_id: 'a1', measure: measureFixture({ id: 'm1' }) } })
    const afterReEval = saveMeasureCalls[saveMeasureCalls.length - 1]
    expect(afterReEval.notes).toEqual(['field verified 2026-07-03'])
  })
})
