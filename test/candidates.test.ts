import { describe, it, expect } from 'vitest'
import { proposeCandidates, normalizeCandidates } from '../src/candidates.js'
import { getPlaybook } from '../src/playbooks.js'

describe('proposeCandidates', () => {
  it('source_checklist mentions Audette, PCA, and ECM', () => {
    const { source_checklist } = proposeCandidates({})
    const text = source_checklist.join(' ')
    expect(text).toMatch(/Audette/)
    expect(text).toMatch(/PCA/)
    expect(text).toMatch(/ECM/)
  })

  it('puts an hvac origination prompt first when equipment is older than 15 years', () => {
    const { origination_prompts } = proposeCandidates(
      { asset_attributes: { equipment: [{ type: 'RTU', install_year: 2005 }] } },
      2026,
    )
    expect(getPlaybook('hvac').origination_prompts).toContain(origination_prompts[0])
  })

  it('does not reorder when equipment is not old enough', () => {
    const { origination_prompts } = proposeCandidates(
      { asset_attributes: { equipment: [{ type: 'RTU', install_year: 2015 }] } },
      2026,
    )
    expect(origination_prompts[0]).toBe(getPlaybook('hvac').origination_prompts[0])
  })

  it('includes all six family playbooks worth of prompts, no phases', () => {
    const { origination_prompts } = proposeCandidates({})
    const expectedTotal = ['hvac', 'envelope', 'dhw', 'controls-rcx', 'solar-storage', 'electrification-staging']
      .reduce((sum, k) => sum + getPlaybook(k).origination_prompts.length, 0)
    expect(origination_prompts.length).toBe(expectedTotal)
  })

  it('prioritizes dhw family for old water heaters', () => {
    const { origination_prompts } = proposeCandidates(
      { asset_attributes: { equipment: [{ type: 'Water Heater', install_year: 2000 }] } },
      2026,
    )
    expect(getPlaybook('dhw').origination_prompts).toContain(origination_prompts[0])
  })

  it('returns a candidate_schema describing the normalized shape', () => {
    const { candidate_schema } = proposeCandidates({}) as { candidate_schema: any }
    expect(candidate_schema.properties.measure_family.enum).toContain('hvac')
    expect(candidate_schema.properties.source.enum).toContain('audette')
  })
})

describe('normalizeCandidates', () => {
  it('accepts valid rows and trims strings', () => {
    const result = normalizeCandidates([
      { measure_family: ' hvac ', name: ' RTU replacement ', source: ' audette ', raw_basis: ' measure-123 ' },
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]).toEqual({
        measure_family: 'hvac',
        name: 'RTU replacement',
        source: 'audette',
        raw_basis: 'measure-123',
      })
    }
  })

  it('rejects unknown measure_family, naming index and field', () => {
    const result = normalizeCandidates([
      { measure_family: 'plumbing', name: 'x', source: 'audette', raw_basis: 'y' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/candidates\[0\]\.measure_family/)
    }
  })

  it('rejects unknown source, naming index and field', () => {
    const result = normalizeCandidates([
      { measure_family: 'hvac', name: 'x', source: 'guess', raw_basis: 'y' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/candidates\[0\]\.source/)
    }
  })

  it('rejects empty name and raw_basis', () => {
    const result = normalizeCandidates([
      { measure_family: 'hvac', name: '  ', source: 'audette', raw_basis: '  ' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('.name'))).toBe(true)
      expect(result.errors.some((e) => e.includes('.raw_basis'))).toBe(true)
    }
  })

  it('collects errors across multiple rows', () => {
    const result = normalizeCandidates([
      { measure_family: 'hvac', name: 'good', source: 'audette', raw_basis: 'basis' },
      { measure_family: 'nope', name: 'bad', source: 'nope', raw_basis: 'bad' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('candidates[1]'))).toBe(true)
      expect(result.errors.filter((e) => e.startsWith('candidates[0]')).length).toBe(0)
    }
  })
})
