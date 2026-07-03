import type { MeasureEvaluation } from './evaluation.js'

export const MAX_SIMPLE_PAYBACK_YEARS = 15
export const MIN_FEASIBILITY_SCORE = 3

export type ScreenedMeasure = {
  id?: string
  name: string
  label: 'recommended' | 'defensive' | 'screened-out' | 'needs-data'
  failing_test?: 'value' | 'feasibility' | 'future-proofing'
  reasons: string[]
}

function simplePayback(e: MeasureEvaluation): number {
  if (e.owner_savings_annual.value <= 0) return Infinity
  return e.cost.value / e.owner_savings_annual.value
}

function valuePasses(e: MeasureEvaluation): boolean {
  if (e.owner_savings_annual.value <= 0) return false
  if (!(e.noi_delta_annual.value > 0)) return false
  return simplePayback(e) <= MAX_SIMPLE_PAYBACK_YEARS
}

export function screenMeasures(evals: MeasureEvaluation[]): ScreenedMeasure[] {
  return evals.map((e) => {
    const payback = simplePayback(e)
    const paybackStr = Number.isFinite(payback) ? payback.toFixed(1) : 'Infinity'

    // 1. needs-data: missing exit_value_delta OR feasibility.sources empty
    if (!e.exit_value_delta || e.feasibility.sources.length === 0) {
      const reasons: string[] = []
      if (!e.exit_value_delta) reasons.push('missing exit_value_delta: exit math has not been computed for this measure')
      if (e.feasibility.sources.length === 0) reasons.push('feasibility.sources is empty: no sourcing for the feasibility assessment')
      return { id: e.id, name: e.name, label: 'needs-data', reasons }
    }

    // 2. feasibility check
    if (e.feasibility.score < MIN_FEASIBILITY_SCORE) {
      return {
        id: e.id,
        name: e.name,
        label: 'screened-out',
        failing_test: 'feasibility',
        reasons: [
          `feasibility score ${e.feasibility.score} is below the minimum feasibility score of ${MIN_FEASIBILITY_SCORE}`,
        ],
      }
    }

    // 3. value check
    if (valuePasses(e)) {
      return {
        id: e.id,
        name: e.name,
        label: 'recommended',
        reasons: [
          `simple payback of ${paybackStr} years is within the ${MAX_SIMPLE_PAYBACK_YEARS}-year threshold`,
          `noi_delta_annual is positive (${e.noi_delta_annual.value})`,
        ],
      }
    }

    // value failed — determine why
    const valueFailureReason = e.owner_savings_annual.value <= 0
      ? 'no positive owner savings: owner_savings_annual is zero or negative, so payback is undefined (infinite)'
      : !(e.noi_delta_annual.value > 0)
      ? `noi_delta_annual is not positive (${e.noi_delta_annual.value})`
      : `simple payback of ${paybackStr} years exceeds the ${MAX_SIMPLE_PAYBACK_YEARS}-year threshold`

    // 4. defensive fallback: value fails but future_proofing.citations non-empty
    if (e.future_proofing.citations.length > 0) {
      return {
        id: e.id,
        name: e.name,
        label: 'defensive',
        reasons: [
          valueFailureReason,
          `retained on future-proofing grounds: ${e.future_proofing.citations.join('; ')}`,
        ],
      }
    }

    // value fails, no citations to justify keeping it
    return {
      id: e.id,
      name: e.name,
      label: 'screened-out',
      failing_test: 'value',
      reasons: [valueFailureReason, 'no future_proofing citations to justify retention'],
    }
  })
}
