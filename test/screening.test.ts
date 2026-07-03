import { describe, it, expect } from 'vitest'
import { computeExitMath } from '../src/evaluation.js'
import { screenMeasures, MAX_SIMPLE_PAYBACK_YEARS, MIN_FEASIBILITY_SCORE } from '../src/screening.js'

const econ = (v: number, unit: string, prov: object) => ({ value: v, unit, ...prov })
const base = () => ({
  asset_id: 'a1', measure_family: 'controls-rcx', name: 'RCx package', candidate_source: 'audit',
  cost: econ(120000, 'USD', { source: 'audit ECM table p.44' }),
  owner_savings_annual: econ(30000, 'USD/yr', { engine: 'll_allocation@1' }),
  noi_delta_annual: econ(30000, 'USD/yr', { engine: 'dcf_engine@1' }),
  cap_rate: econ(0.055, 'ratio', { source: 'asset metadata (client-provided 2026-06)' }),
  feasibility: { score: 4, site_conditions: 'BAS present per PCA p.12', disruption: 'none', contractor_reality: 'active controls permits in metro (Shovels)', staging: 'independent of capital events', sources: ['pca', 'shovels'] },
  future_proofing: { rationale: 'reduces base load ahead of Reg 28 targets', citations: ['CO Reg 28 rule text'] },
})

describe('screenMeasures', () => {
  it('labels recommended / defensive / screened-out(with failing test) / needs-data', () => {
    // 1. base passing measure -> recommended
    const recommendedMeasure = computeExitMath(base() as any)

    // 2. uneconomic measure (cost 2,000,000 / savings 30,000 ~= 67y payback) with citations, feasibility ok -> defensive
    const defensiveMeasure = computeExitMath({
      ...base(),
      name: 'Uneconomic but future-proofing measure',
      cost: econ(2000000, 'USD', { source: 'audit ECM table p.50' }),
      owner_savings_annual: econ(30000, 'USD/yr', { engine: 'll_allocation@1' }),
    } as any)

    // 3. same uneconomic measure but feasibility.score 2 -> screened-out, failing_test 'feasibility'
    const screenedOutMeasure = computeExitMath({
      ...base(),
      name: 'Uneconomic and infeasible measure',
      cost: econ(2000000, 'USD', { source: 'audit ECM table p.50' }),
      owner_savings_annual: econ(30000, 'USD/yr', { engine: 'll_allocation@1' }),
      feasibility: { ...base().feasibility, score: 2 },
    } as any)

    // 4. missing exit_value_delta -> needs-data
    const needsDataMeasure = { ...base(), name: 'Missing exit math' } as any

    const results = screenMeasures([recommendedMeasure, defensiveMeasure, screenedOutMeasure, needsDataMeasure])

    expect(results[0].label).toBe('recommended')

    expect(results[1].label).toBe('defensive')
    expect(results[1].failing_test).toBeUndefined()

    expect(results[2].label).toBe('screened-out')
    expect(results[2].failing_test).toBe('feasibility')

    expect(results[3].label).toBe('needs-data')
  })

  it('reasons always non-empty and name the numbers (payback, score)', () => {
    const recommendedMeasure = computeExitMath(base() as any)

    const defensiveMeasure = computeExitMath({
      ...base(),
      cost: econ(2000000, 'USD', { source: 'audit ECM table p.50' }),
      owner_savings_annual: econ(30000, 'USD/yr', { engine: 'll_allocation@1' }),
    } as any)

    const screenedOutMeasure = computeExitMath({
      ...base(),
      cost: econ(2000000, 'USD', { source: 'audit ECM table p.50' }),
      owner_savings_annual: econ(30000, 'USD/yr', { engine: 'll_allocation@1' }),
      feasibility: { ...base().feasibility, score: 2 },
    } as any)

    const needsDataMeasure = { ...base() } as any

    const results = screenMeasures([recommendedMeasure, defensiveMeasure, screenedOutMeasure, needsDataMeasure])

    for (const r of results) {
      expect(r.reasons.length).toBeGreaterThan(0)
    }

    // defensive reason names the payback (67.x years, > MAX_SIMPLE_PAYBACK_YEARS)
    expect(results[1].reasons.join(' ')).toMatch(/payback/i)
    expect(results[1].reasons.join(' ')).toMatch(/66\.7|67\.0|66\.6/)

    // screened-out reason names the feasibility score
    expect(results[2].reasons.join(' ')).toMatch(/feasibility/i)
    expect(results[2].reasons.join(' ')).toMatch(/2/)
  })

  it('needs-data triggers when feasibility.sources is empty even if exit_value_delta present', () => {
    const m = computeExitMath({ ...base(), feasibility: { ...base().feasibility, sources: [] } } as any)
    const [result] = screenMeasures([m])
    expect(result.label).toBe('needs-data')
  })

  it('screens out value failure with no citations (no future-proofing justification)', () => {
    const m = computeExitMath({
      ...base(),
      cost: econ(2000000, 'USD', { source: 'audit ECM table p.50' }),
      owner_savings_annual: econ(30000, 'USD/yr', { engine: 'll_allocation@1' }),
      future_proofing: { rationale: 'no strong rationale', citations: [] },
    } as any)
    const [result] = screenMeasures([m])
    expect(result.label).toBe('screened-out')
    expect(result.failing_test).toBe('value')
  })

  it('treats zero or negative owner_savings_annual as infinite payback, failing value', () => {
    const m = computeExitMath({
      ...base(),
      owner_savings_annual: econ(0, 'USD/yr', { engine: 'll_allocation@1' }),
      future_proofing: { rationale: 'no strong rationale', citations: [] },
    } as any)
    const [result] = screenMeasures([m])
    expect(result.label).toBe('screened-out')
    expect(result.failing_test).toBe('value')
    expect(result.reasons.join(' ')).toMatch(/no positive owner savings/i)
  })

  it('exports the named threshold constants', () => {
    expect(MAX_SIMPLE_PAYBACK_YEARS).toBe(15)
    expect(MIN_FEASIBILITY_SCORE).toBe(3)
  })

  it('boundary: payback exactly 15.0 yields recommended', () => {
    // cost / savings = 450000 / 30000 = 15.0 exactly
    const m = computeExitMath({
      ...base(),
      cost: econ(450000, 'USD', { source: 'boundary test' }),
      owner_savings_annual: econ(30000, 'USD/yr', { engine: 'll_allocation@1' }),
    } as any)
    const [result] = screenMeasures([m])
    expect(result.label).toBe('recommended')
    expect(result.reasons.join(' ')).toMatch(/15\.0/)
  })

  it('boundary: feasibility score exactly 3 passes feasibility check', () => {
    const m = computeExitMath({
      ...base(),
      feasibility: { ...base().feasibility, score: 3 },
    } as any)
    const [result] = screenMeasures([m])
    expect(result.label).toBe('recommended')
    expect(result.failing_test).toBeUndefined()
  })

  it('dual failure: measure failing both feasibility and value tests lists both reasons', () => {
    // feasibility score 2 (fails), payback 66.7 (fails)
    const m = computeExitMath({
      ...base(),
      name: 'Infeasible and uneconomic',
      cost: econ(2000000, 'USD', { source: 'boundary test' }),
      owner_savings_annual: econ(30000, 'USD/yr', { engine: 'll_allocation@1' }),
      feasibility: { ...base().feasibility, score: 2 },
      future_proofing: { rationale: 'none', citations: [] },
    } as any)
    const [result] = screenMeasures([m])
    expect(result.label).toBe('screened-out')
    expect(result.failing_test).toBe('feasibility')
    // Should mention both the feasibility score AND the payback
    expect(result.reasons.join(' ')).toMatch(/feasibility score 2/)
    expect(result.reasons.join(' ')).toMatch(/66\.7/)
  })
})
