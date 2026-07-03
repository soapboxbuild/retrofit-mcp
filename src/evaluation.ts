import { z } from 'zod'

export type Provenance = { engine?: string; source?: string; provenance?: 'library' | 'web' }
export type EconField = { value: number; unit: string } & Provenance
export type MeasureEvaluation = {
  id?: string; asset_id: string; measure_family: string; name: string
  candidate_source: 'audette' | 'pca' | 'audit' | 'originated'
  cost: EconField
  owner_savings_annual: EconField          // post LL/TT allocation
  noi_delta_annual: EconField
  cap_rate: EconField                       // source required
  exit_value_delta?: EconField              // computed, engine:'retrofit-mcp/exit-math@1'
  green_premium?: EconField                 // citation required
  incentives?: Array<EconField & { program: string; eligibility_basis: string }>
  feasibility: { score: 1 | 2 | 3 | 4 | 5; site_conditions: string; disruption: 'none' | 'light' | 'in-unit' | 'vacancy-required'; contractor_reality: string; staging: string; sources: string[] }
  future_proofing: { rationale: string; citations: string[] }
  status?: 'proposed' | 'recommended' | 'defensive' | 'screened-out' | 'needs-data' | 'implemented'
}

// Base econ field schema with engine/source provenance requirement
const baseEconFieldSchema = z.object({
  value: z.number(),
  unit: z.string(),
  engine: z.string().optional(),
  source: z.string().optional(),
  provenance: z.enum(['library', 'web']).optional(),
}).superRefine((v, ctx) => {
  if (!v.engine && !v.source) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'requires engine or source provenance' })
  }
  if (v.source === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'source cannot be empty string' })
  }
})

// Cost must be > 0
const costSchema = baseEconFieldSchema.superRefine((v, ctx) => {
  if (v.value <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cost.value must be > 0', path: ['cost'] })
  }
})

// Cap rate must be > 0
const capRateSchema = baseEconFieldSchema.superRefine((v, ctx) => {
  if (v.value <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cap_rate.value must be > 0', path: ['cap_rate'] })
  }
})

// Owner savings annual must be >= 0
const ownerSavingsAnnualSchema = baseEconFieldSchema.superRefine((v, ctx) => {
  if (v.value < 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'owner_savings_annual.value must be >= 0', path: ['owner_savings_annual'] })
  }
})

// Green premium: any value, but source required
const greenPremiumSchema = baseEconFieldSchema.superRefine((v, ctx) => {
  if (!v.source) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'green_premium requires source citation (engine alone is not sufficient)' })
  }
})

// Incentive: value must be >= 0, and requires program/eligibility_basis
const incentiveSchema = baseEconFieldSchema.extend({
  program: z.string(),
  eligibility_basis: z.string(),
}).superRefine((v, ctx) => {
  if (v.value < 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'incentives[].value must be >= 0', path: ['incentives'] })
  }
})

const measureEvaluationSchema = z.object({
  id: z.string().optional(),
  asset_id: z.string(),
  measure_family: z.string(),
  name: z.string(),
  candidate_source: z.enum(['audette', 'pca', 'audit', 'originated']),
  cost: costSchema,
  owner_savings_annual: ownerSavingsAnnualSchema,
  noi_delta_annual: baseEconFieldSchema,
  cap_rate: capRateSchema,
  exit_value_delta: baseEconFieldSchema.optional(),
  green_premium: greenPremiumSchema.optional(),
  incentives: z.array(incentiveSchema).optional(),
  feasibility: z.object({
    score: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    site_conditions: z.string(),
    disruption: z.enum(['none', 'light', 'in-unit', 'vacancy-required']),
    contractor_reality: z.string(),
    staging: z.string(),
    sources: z.array(z.string()),
  }),
  future_proofing: z.object({
    rationale: z.string(),
    citations: z.array(z.string()),
  }),
  status: z.enum(['proposed', 'recommended', 'defensive', 'screened-out', 'needs-data', 'implemented']).optional(),
}).strip()

export function validateEvaluation(e: unknown): { ok: true; evaluation: MeasureEvaluation } | { ok: false; errors: string[] } {
  const result = measureEvaluationSchema.safeParse(e)
  if (result.success) {
    return { ok: true, evaluation: result.data as MeasureEvaluation }
  }
  const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
  return { ok: false, errors }
}

export function computeExitMath(e: MeasureEvaluation): MeasureEvaluation {
  if (e.cap_rate.value <= 0) {
    throw new Error('cap_rate must be > 0')
  }
  const exit_value_delta: EconField = {
    value: Math.round(e.noi_delta_annual.value / e.cap_rate.value),
    unit: 'USD',
    engine: 'retrofit-mcp/exit-math@1',
  }
  return { ...e, exit_value_delta }
}
