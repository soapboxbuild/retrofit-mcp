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

  // Adversarial tests: value-sign constraints
  it('rejects empty-string source', () => {
    const e: any = base(); e.cost.source = ''
    const r = validateEvaluation(e)
    expect(r.ok).toBe(false)
    expect(r.errors.some(err => err.includes('source'))).toBe(true)
  })

  it('rejects negative cost, naming the field', () => {
    const e: any = base(); e.cost.value = -100
    const r = validateEvaluation(e)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/cost/)
  })

  it('rejects cost of zero', () => {
    const e: any = base(); e.cost.value = 0
    const r = validateEvaluation(e)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/cost/)
  })

  it('rejects cap_rate <= 0 at validation time', () => {
    const e: any = base(); e.cap_rate.value = 0
    const r = validateEvaluation(e)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/cap.rate/)
  })

  it('rejects negative cap_rate at validation time', () => {
    const e: any = base(); e.cap_rate.value = -0.055
    const r = validateEvaluation(e)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/cap.rate/)
  })

  it('rejects negative owner_savings_annual', () => {
    const e: any = base(); e.owner_savings_annual.value = -1000
    const r = validateEvaluation(e)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/owner_savings_annual/)
  })

  it('accepts zero owner_savings_annual', () => {
    const e: any = base(); e.owner_savings_annual.value = 0
    expect(validateEvaluation(e).ok).toBe(true)
  })

  it('rejects negative incentive value', () => {
    const e: any = { ...base(), incentives: [econ(-1000, 'USD', { source: 'IRA', program: '179D', eligibility_basis: 'office' })] }
    const r = validateEvaluation(e)
    expect(!r.ok && r.errors.join('\n')).toMatch(/incentives/)
  })

  it('accepts zero incentive value', () => {
    const e: any = { ...base(), incentives: [econ(0, 'USD', { source: 'IRA', program: '179D', eligibility_basis: 'office' })] }
    expect(validateEvaluation(e).ok).toBe(true)
  })

  it('rejects feasibility.score outside 1-5', () => {
    const e: any = base(); e.feasibility.score = 0
    let r = validateEvaluation(e)
    expect(!r.ok).toBe(true)
    e.feasibility.score = 6
    r = validateEvaluation(e)
    expect(!r.ok).toBe(true)
  })

  it('aggregates multiple simultaneous violations (3+ errors)', () => {
    const e: any = base()
    e.cost.value = -100  // violation 1
    e.cap_rate.value = -0.05  // violation 2
    e.owner_savings_annual.value = -500  // violation 3
    const r = validateEvaluation(e)
    expect(!r.ok).toBe(true)
    expect(r.errors.length).toBeGreaterThanOrEqual(3)
  })

  it('strips unknown extra fields from the returned evaluation object', () => {
    const e: any = base()
    e.unknown_field = 'should be stripped'
    e.cost.extra_provenance = 'also stripped'
    const r = validateEvaluation(e)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.evaluation as any).unknown_field).toBeUndefined()
      expect((r.evaluation.cost as any).extra_provenance).toBeUndefined()
    }
  })

  it('allows noi_delta_annual and green_premium to be any finite number (including zero or negative)', () => {
    const e1: any = base(); e1.noi_delta_annual.value = -10000
    expect(validateEvaluation(e1).ok).toBe(true)

    const e2: any = base(); e2.noi_delta_annual.value = 0
    expect(validateEvaluation(e2).ok).toBe(true)

    const e3: any = { ...base(), green_premium: econ(-500, 'USD', { source: 'citation' }) }
    expect(validateEvaluation(e3).ok).toBe(true)

    const e4: any = { ...base(), green_premium: econ(0, 'USD', { source: 'citation' }) }
    expect(validateEvaluation(e4).ok).toBe(true)
  })
})

describe('computeExitMath', () => {
  it('computes exit_value_delta = noi_delta / cap_rate with engine provenance', () => {
    const v = validateEvaluation(base()); if (!v.ok) throw new Error('setup')
    const out = computeExitMath(v.evaluation)
    expect(out.exit_value_delta!.value).toBeCloseTo(30000 / 0.055, 0)
    expect(out.exit_value_delta!.engine).toBe('retrofit-mcp/exit-math@1')
  })
  it('validation now rejects zero/negative cap rate (constraint moved to schema)', () => {
    const v = validateEvaluation({ ...base(), cap_rate: econ(0, 'ratio', { source: 'x' }) })
    expect(v.ok).toBe(false)
    expect(v.errors.join('\n')).toMatch(/cap.rate/)
  })
})
