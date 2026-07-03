import { getPlaybook } from './playbooks.js'

export const FAMILY_KEYS = [
  'hvac',
  'envelope',
  'dhw',
  'controls-rcx',
  'solar-storage',
  'electrification-staging',
] as const

export type FamilyKey = (typeof FAMILY_KEYS)[number]

export const SOURCE_KEYS = ['audette', 'pca', 'audit', 'originated'] as const
export type SourceKey = (typeof SOURCE_KEYS)[number]

export type RawCandidate = {
  measure_family: string
  name: string
  source: string
  raw_basis: string
}

export type NormalizedCandidate = {
  measure_family: FamilyKey
  name: string
  source: SourceKey
  raw_basis: string
}

export type ProposeCandidatesInput = {
  asset_attributes?: {
    archetype?: string
    jurisdiction?: string
    equipment?: Array<{ type: string; install_year?: number }>
  }
}

export type ProposeCandidatesResult = {
  source_checklist: string[]
  origination_prompts: string[]
  candidate_schema: object
}

const SOURCE_CHECKLIST: string[] = [
  'Pull Audette measures for the linked property (get_available_measures / building model details).',
  'Search asset files (RAG) for the PCA immediate-repairs and capital-needs tables.',
  'Search asset files (RAG) for audit ECM tables with costs and savings.',
  'Check the equipment survey for install years and remaining useful life.',
]

const AGING_THRESHOLD_YEARS = 15

const EQUIPMENT_FAMILY_PATTERNS: Array<{ pattern: RegExp; family: FamilyKey }> = [
  { pattern: /rtu|ahu|air.?handl|chiller|boiler|split|hvac/i, family: 'hvac' },
  { pattern: /water.?heat|dhw/i, family: 'dhw' },
  { pattern: /panel|electri/i, family: 'electrification-staging' },
]

function familyForEquipmentType(type: string): FamilyKey | undefined {
  for (const { pattern, family } of EQUIPMENT_FAMILY_PATTERNS) {
    if (pattern.test(type)) return family
  }
  return undefined
}

const CANDIDATE_SCHEMA: object = {
  type: 'object',
  required: ['measure_family', 'name', 'source', 'raw_basis'],
  properties: {
    measure_family: { type: 'string', enum: [...FAMILY_KEYS] },
    name: { type: 'string', description: 'Human-readable measure name.' },
    source: { type: 'string', enum: [...SOURCE_KEYS] },
    raw_basis: { type: 'string', description: 'The evidence this candidate was originated from (e.g. an Audette measure id, a PCA line item, an audit ECM row, or an origination prompt).' },
  },
}

export function proposeCandidates(
  input: ProposeCandidatesInput,
  now_year: number = new Date().getFullYear(),
): ProposeCandidatesResult {
  const equipment = input.asset_attributes?.equipment ?? []

  let priorityFamily: FamilyKey | undefined
  for (const item of equipment) {
    if (item.install_year === undefined) continue
    if (now_year - item.install_year > AGING_THRESHOLD_YEARS) {
      const family = familyForEquipmentType(item.type)
      if (family) {
        priorityFamily = family
        break
      }
    }
  }

  const orderedFamilies: FamilyKey[] = priorityFamily
    ? [priorityFamily, ...FAMILY_KEYS.filter((f) => f !== priorityFamily)]
    : [...FAMILY_KEYS]

  const origination_prompts = orderedFamilies.flatMap((f) => getPlaybook(f).origination_prompts)

  return {
    source_checklist: [...SOURCE_CHECKLIST],
    origination_prompts,
    candidate_schema: CANDIDATE_SCHEMA,
  }
}

export function normalizeCandidates(
  raw: RawCandidate[],
): { ok: true; candidates: NormalizedCandidate[] } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const candidates: NormalizedCandidate[] = []

  raw.forEach((r, i) => {
    const measure_family = typeof r.measure_family === 'string' ? r.measure_family.trim() : r.measure_family
    const name = typeof r.name === 'string' ? r.name.trim() : r.name
    const source = typeof r.source === 'string' ? r.source.trim() : r.source
    const raw_basis = typeof r.raw_basis === 'string' ? r.raw_basis.trim() : r.raw_basis

    if (!FAMILY_KEYS.includes(measure_family as FamilyKey)) {
      errors.push(`candidates[${i}].measure_family: unknown family "${r.measure_family}" (expected one of ${FAMILY_KEYS.join(', ')})`)
    }
    if (!SOURCE_KEYS.includes(source as SourceKey)) {
      errors.push(`candidates[${i}].source: unknown source "${r.source}" (expected one of ${SOURCE_KEYS.join(', ')})`)
    }
    if (!name) {
      errors.push(`candidates[${i}].name: must not be empty`)
    }
    if (!raw_basis) {
      errors.push(`candidates[${i}].raw_basis: must not be empty`)
    }

    if (
      FAMILY_KEYS.includes(measure_family as FamilyKey) &&
      SOURCE_KEYS.includes(source as SourceKey) &&
      name &&
      raw_basis
    ) {
      candidates.push({
        measure_family: measure_family as FamilyKey,
        name,
        source: source as SourceKey,
        raw_basis,
      })
    }
  })

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, candidates }
}
