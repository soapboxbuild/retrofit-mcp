import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderMeasuresMarkdown } from '../src/register.js'
import type { MeasureEvaluation } from '../src/evaluation.js'

const econ = (v: number, unit: string, prov: object) => ({ value: v, unit, ...prov })
const base = (): MeasureEvaluation => ({
  asset_id: 'a1', measure_family: 'controls-rcx', name: 'RCx package', candidate_source: 'audit',
  cost: econ(120000, 'USD', { source: 'audit ECM table p.44' }),
  owner_savings_annual: econ(30000, 'USD/yr', { engine: 'll_allocation@1' }),
  noi_delta_annual: econ(30000, 'USD/yr', { engine: 'dcf_engine@1' }),
  cap_rate: econ(0.055, 'ratio', { source: 'asset metadata (client-provided 2026-06)' }),
  feasibility: { score: 4, site_conditions: 'BAS present per PCA p.12', disruption: 'none', contractor_reality: 'active controls permits in metro (Shovels)', staging: 'independent of capital events', sources: ['pca', 'shovels'] },
  future_proofing: { rationale: 'reduces base load ahead of Reg 28 targets', citations: ['CO Reg 28 rule text'] },
})

describe('renderMeasuresMarkdown', () => {
  it('renders name, status, family, candidate source, econ numbers, feasibility and future-proofing', () => {
    const md = renderMeasuresMarkdown([{ ...base(), status: 'recommended' }])
    expect(md).toContain('# Retrofit Measures')
    expect(md).toContain('RCx package')
    expect(md).toContain('recommended')
    expect(md).toContain('controls-rcx')
    expect(md).toContain('audit')
    expect(md).toContain('120000 USD')
    expect(md).toContain('30000 USD/yr')
    expect(md).toMatch(/score 4\/5/)
    expect(md).toContain('none')
    expect(md).toContain('reduces base load ahead of Reg 28 targets')
  })

  it('sanitizes an injection fixture in the measure name', () => {
    const md = renderMeasuresMarkdown([{ ...base(), name: '# fake\n<script>' }])
    expect(md).not.toContain('<script>')
    expect(md).not.toContain('\n# fake')
    // one heading before the render + no injected new heading line
    const headingLines = md.split('\n').filter((l) => l.startsWith('# '))
    expect(headingLines).toEqual(['# Retrofit Measures'])
  })

  it('renders feasibility.site_conditions and contractor_reality with joined sources', () => {
    const md = renderMeasuresMarkdown([{ ...base(), feasibility: { ...base().feasibility, site_conditions: 'BAS present per PCA p.12', contractor_reality: 'active controls permits in metro', sources: ['pca', 'shovels'] } }])
    expect(md).toContain('BAS present per PCA p.12')
    expect(md).toContain('active controls permits in metro')
    expect(md).toContain('pca, shovels')
  })

  it('renders future_proofing.citations joined with commas', () => {
    const md = renderMeasuresMarkdown([{ ...base(), future_proofing: { rationale: 'reduces base load', citations: ['CO Reg 28 rule text', 'IECC 2021'] } }])
    expect(md).toContain('CO Reg 28 rule text, IECC 2021')
  })

  it('sanitizes an injection fixture in feasibility.staging', () => {
    const md = renderMeasuresMarkdown([{ ...base(), feasibility: { ...base().feasibility, staging: '# fake\n<script>alert(1)</script>' } }])
    expect(md).not.toContain('<script>')
    expect(md).not.toContain('\n# fake')
    // one heading (document title) + no injected new heading
    const headingLines = md.split('\n').filter((l) => l.startsWith('# '))
    expect(headingLines).toEqual(['# Retrofit Measures'])
  })

  it('renders a measure without exit_value_delta as "n/a"', () => {
    const noExit = { ...base() }
    delete noExit.exit_value_delta
    const md = renderMeasuresMarkdown([noExit])
    expect(md).toContain('Exit value delta:')
    expect(md).toMatch(/Exit value delta:\*\*.*n\/a/)
  })
})

// ---- I/O half: mock @supabase/supabase-js + global fetch -------------------

function makeFilesTable(existingRow: { id: string } | null, calls: Record<string, unknown[]>) {
  return {
    select: () => ({
      eq: (col: string, val: unknown) => {
        const state = { filters: [[col, val]] as [string, unknown][] }
        const builder = {
          eq: (col2: string, val2: unknown) => {
            state.filters.push([col2, val2])
            return builder
          },
          maybeSingle: () => {
            calls.selectFilters = state.filters
            return Promise.resolve({ data: existingRow, error: null })
          },
        }
        return builder
      },
    }),
    insert: (row: Record<string, unknown>) => {
      calls.insert = [row]
      return Promise.resolve({ error: null })
    },
    update: (patch: Record<string, unknown>) => ({
      eq: (_col: string, id: unknown) => {
        calls.update = [patch, id]
        return Promise.resolve({ error: null })
      },
    }),
    delete: () => ({
      eq: (_c: string, id: unknown) => {
        calls.filesDelete = [id]
        return Promise.resolve({ error: null })
      },
    }),
  }
}

function mockSupabaseModule(opts: {
  downloadResult: { data: { text: () => Promise<string> } | null; error: unknown }
  existingFilesRow: { id: string } | null
  calls: Record<string, unknown[]>
}) {
  return {
    createClient: vi.fn(() => ({
      storage: {
        from: (_bucket: string) => ({
          download: (path: string) => {
            opts.calls.downloadPath = [path]
            return Promise.resolve(opts.downloadResult)
          },
          upload: (path: string, body: unknown, uploadOpts: unknown) => {
            const key = path.endsWith('.jsonl') ? 'uploadJsonl' : 'uploadMd'
            opts.calls[key] = [path, body, uploadOpts]
            return Promise.resolve({ error: null })
          },
          remove: (paths: string[]) => {
            opts.calls.storageRemove = [paths]
            return Promise.resolve({ error: null })
          },
        }),
      },
      from: (table: string) => {
        if (table === 'files') return makeFilesTable(opts.existingFilesRow, opts.calls)
        throw new Error(`unexpected table ${table}`)
      },
    })),
  }
}

describe('register I/O', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('@supabase/supabase-js')
    process.env.SUPABASE_URL = 'http://example.invalid'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
    process.env.SOAPBOX_API_URL = 'https://api.example.invalid'
    process.env.MCP_SERVER_SECRET = 'shh-secret'
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('saveMeasure: uploads jsonl (upsert, text/plain) + md, inserts files row, calls index-file with bearer', async () => {
    const calls: Record<string, unknown[]> = {}
    vi.doMock('@supabase/supabase-js', () =>
      mockSupabaseModule({
        downloadResult: { data: null, error: { message: 'Object not found', statusCode: '404' } },
        existingFilesRow: null,
        calls,
      })
    )

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.fetch = [url, init]
      return { ok: true, status: 200 } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { saveMeasure } = await import('../src/register.js')
    const result = await saveMeasure({ portfolioId: 'p1', assetId: 'a1' }, base())

    expect(result.id).toBeTruthy()

    // jsonl uploaded with the new measure, upsert + text/plain
    expect(calls.uploadJsonl).toBeTruthy()
    const [jsonlPath, jsonlBody, jsonlOpts] = calls.uploadJsonl as [string, string, { contentType: string; upsert: boolean }]
    expect(jsonlPath).toBe('a1/retrofit/measures.jsonl')
    expect(jsonlBody).toContain('RCx package')
    expect(jsonlOpts.contentType).toBe('text/plain')
    expect(jsonlOpts.upsert).toBe(true)

    // md uploaded (new files row created since none existed)
    expect(calls.uploadMd).toBeTruthy()
    const [mdPath, mdBody, mdOpts] = calls.uploadMd as [string, string, { contentType: string; upsert: boolean }]
    expect(mdPath).toMatch(/^a1\/.+\/measures\.md$/)
    expect(mdBody).toContain('RCx package')
    expect(mdOpts.contentType).toBe('text/plain')

    // files row inserted (no existing row)
    expect(calls.insert).toBeTruthy()
    const [insertedRow] = calls.insert as [Record<string, unknown>]
    expect(insertedRow.name).toBe('measures.md')
    expect(insertedRow.folder).toBe('Retrofit')
    expect(insertedRow.asset_id).toBe('a1')
    expect(insertedRow.portfolio_id).toBe('p1')
    expect(insertedRow.mime_type).toBe('text/plain')

    // index-file called with bearer secret
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = calls.fetch as [string, RequestInit]
    expect(url).toBe('https://api.example.invalid/internal/index-file')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer shh-secret')
    expect(JSON.parse(init.body as string).fileId).toBe(insertedRow.id)
  })

  it('saveMeasure upserts by id: replaces the matching jsonl entry rather than duplicating', async () => {
    const calls: Record<string, unknown[]> = {}
    const existing = { ...base(), id: 'm1', status: 'proposed' as const }
    vi.doMock('@supabase/supabase-js', () =>
      mockSupabaseModule({
        downloadResult: { data: { text: async () => JSON.stringify(existing) + '\n' }, error: null },
        existingFilesRow: { id: 'file-1' },
        calls,
      })
    )
    global.fetch = vi.fn(async () => ({ ok: true, status: 200 } as Response)) as unknown as typeof fetch

    const { saveMeasure } = await import('../src/register.js')
    const result = await saveMeasure({ portfolioId: 'p1', assetId: 'a1' }, { ...existing, status: 'recommended' })

    expect(result.id).toBe('m1')
    const [, jsonlBody] = calls.uploadJsonl as [string, string, unknown]
    const rows = jsonlBody.trim().split('\n').map((l) => JSON.parse(l))
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('recommended')

    // existing files row updated, not inserted
    expect(calls.update).toBeTruthy()
    expect(calls.insert).toBeFalsy()
  })

  it('getMeasures returns [] when the jsonl object is missing (404)', async () => {
    const calls: Record<string, unknown[]> = {}
    vi.doMock('@supabase/supabase-js', () =>
      mockSupabaseModule({
        downloadResult: { data: null, error: { message: 'Object not found', statusCode: '404' } },
        existingFilesRow: null,
        calls,
      })
    )
    const { getMeasures } = await import('../src/register.js')
    const measures = await getMeasures({ portfolioId: 'p1', assetId: 'a1' })
    expect(measures).toEqual([])
  })

  it('getMeasures throws on a non-404 storage error', async () => {
    const calls: Record<string, unknown[]> = {}
    vi.doMock('@supabase/supabase-js', () =>
      mockSupabaseModule({
        downloadResult: { data: null, error: { message: 'permission denied' } },
        existingFilesRow: null,
        calls,
      })
    )
    const { getMeasures } = await import('../src/register.js')
    await expect(getMeasures({ portfolioId: 'p1', assetId: 'a1' })).rejects.toThrow(/loadMeasures failed/)
  })

  it('getMeasures filters by status when given', async () => {
    const calls: Record<string, unknown[]> = {}
    const measures = [
      { ...base(), id: 'm1', status: 'proposed' as const },
      { ...base(), id: 'm2', status: 'recommended' as const },
    ]
    vi.doMock('@supabase/supabase-js', () =>
      mockSupabaseModule({
        downloadResult: { data: { text: async () => measures.map((m) => JSON.stringify(m)).join('\n') + '\n' }, error: null },
        existingFilesRow: null,
        calls,
      })
    )
    const { getMeasures } = await import('../src/register.js')
    const result = await getMeasures({ portfolioId: 'p1', assetId: 'a1' }, 'recommended')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('m2')
  })
})

describe('deleteMeasure', () => {
  const originalFetch = global.fetch
  beforeEach(() => {
    vi.resetModules(); vi.doUnmock('@supabase/supabase-js')
    process.env.SUPABASE_URL = 'http://example.invalid'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
    process.env.SOAPBOX_API_URL = 'https://api.example.invalid'
    process.env.MCP_SERVER_SECRET = 'shh-secret'
  })
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks() })

  it('removes one measure and re-saves the rest when others remain', async () => {
    const calls: Record<string, unknown[]> = {}
    const m1 = { ...base(), id: 'm1', status: 'recommended' as const }
    const m2 = { ...base(), id: 'm2', name: 'Second', status: 'proposed' as const }
    vi.doMock('@supabase/supabase-js', () => mockSupabaseModule({
      downloadResult: { data: { text: async () => [m1, m2].map((m) => JSON.stringify(m)).join('\n') + '\n' }, error: null },
      existingFilesRow: { id: 'file-1' }, calls,
    }))
    global.fetch = vi.fn(async () => ({ ok: true, status: 200 } as Response)) as unknown as typeof fetch

    const { deleteMeasure } = await import('../src/register.js')
    const res = await deleteMeasure({ portfolioId: 'p1', assetId: 'a1' }, 'm1')

    expect(res).toEqual({ deleted: true, remaining: 1 })
    // re-saved jsonl no longer contains m1
    const [, jsonlBody] = calls.uploadJsonl as [string, string, unknown]
    const rows = jsonlBody.trim().split('\n').map((l) => JSON.parse(l))
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('m2')
    // no teardown when others remain
    expect(calls.storageRemove).toBeFalsy()
    expect(calls.filesDelete).toBeFalsy()
  })

  it('tears down storage + files row when deleting the last measure', async () => {
    const calls: Record<string, unknown[]> = {}
    const only = { ...base(), id: 'm1', status: 'recommended' as const }
    vi.doMock('@supabase/supabase-js', () => mockSupabaseModule({
      downloadResult: { data: { text: async () => JSON.stringify(only) + '\n' }, error: null },
      existingFilesRow: { id: 'file-1' }, calls,
    }))
    const { deleteMeasure } = await import('../src/register.js')
    const res = await deleteMeasure({ portfolioId: 'p1', assetId: 'a1' }, 'm1')

    expect(res).toEqual({ deleted: true, remaining: 0 })
    // removed both storage objects
    const [paths] = calls.storageRemove as [string[]]
    expect(paths).toContain('a1/retrofit/measures.jsonl')
    expect(paths).toContain('a1/file-1/measures.md')
    // deleted the files row (embeddings cascade off the FK)
    expect(calls.filesDelete).toEqual(['file-1'])
    // did not re-save an empty jsonl
    expect(calls.uploadJsonl).toBeFalsy()
  })

  it('throws when the measure id is not in the register', async () => {
    const calls: Record<string, unknown[]> = {}
    vi.doMock('@supabase/supabase-js', () => mockSupabaseModule({
      downloadResult: { data: { text: async () => JSON.stringify({ ...base(), id: 'm1' }) + '\n' }, error: null },
      existingFilesRow: { id: 'file-1' }, calls,
    }))
    const { deleteMeasure } = await import('../src/register.js')
    await expect(deleteMeasure({ portfolioId: 'p1', assetId: 'a1' }, 'nope'))
      .rejects.toThrow(/not found/)
  })
})
