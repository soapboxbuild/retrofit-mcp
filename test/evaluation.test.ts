import { describe, it, expect } from 'vitest'
import { validateEvaluation, computeExitMath } from '../src/evaluation.js'

const econ = (v: number, unit: string, prov: object) => ({ value: v, unit, ...prov })
const base = () => ({
  asset_id: 'a1', measure_family: 'controls-rcx', name: 'RCx package', candidate_source: 'audit',
  cost: econ(120000, 'USD', { source: 'audit ECM table p.44' }),
  owner_savings_annual: econ(30000, 'USD/yr', { engine: 'll_allocation@1' }),
  noi_delta_annual: econ(30000, 'USD/yr', { engine: 'dcf_engine@1' }),
  cap_rate: econ(0.055, 'ratio', { source: 'asset metadata (client-provided 2026-06)' }),
  feasibility: { score: 4, site_conditions: 'BAS present per PCA p.12', disruption: 'none', contractor_reality: 'active controls permits in metro (Shovels)', staging: 'independent of capital events', sources: ['pca','shovels'] },
  future_proofing: { rationale: 'reduces base load ahead of Reg 28 targets', citations: ['CO Reg 28 rule text'] },
})

describe('validateEvaluation', () => {
  it('accepts a fully-provenanced evaluation', () => {
    expect(validateEvaluation(base()).ok).toBe(true)
  })
  it('rejects economics without provenance, naming the field', () => {
    const e: any = base(); delete e.cost.source
    const r = validateEvaluation(e)
    expect(!r.ok && r.errors.join(' ')).toMatch(/cost/)
  })
  it('rejects green_premium without a source citation', () => {
    const e: any = { ...base(), green_premium: econ(500000, 'USD', { engine: 'vibes' }) }
    const r = validateEvaluation(e)
    expect(!r.ok && r.errors.join(' ')).toMatch(/green_premium.*source/i)
  })
  it('rejects incentives missing eligibility_basis', () => {
    const e: any = { ...base(), incentives: [{ ...econ(50000,'USD',{source:'IRA 179D'}), program: '179D' }] }
    expect(validateEvaluation(e).ok).toBe(false)
  })
})

describe('computeExitMath', () => {
  it('computes exit_value_delta = noi_delta / cap_rate with engine provenance', () => {
    const v = validateEvaluation(base()); if (!v.ok) throw new Error('setup')
    const out = computeExitMath(v.evaluation)
    expect(out.exit_value_delta!.value).toBeCloseTo(30000 / 0.055, 0)
    expect(out.exit_value_delta!.engine).toBe('retrofit-mcp/exit-math@1')
  })
  it('throws on zero/negative cap rate', () => {
    const v = validateEvaluation({ ...base(), cap_rate: econ(0, 'ratio', { source: 'x' }) })
    if (!v.ok) throw new Error('setup')
    expect(() => computeExitMath(v.evaluation)).toThrow(/cap.rate/i)
  })
})
