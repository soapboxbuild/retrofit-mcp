import { describe, it, expect } from 'vitest'
import { getPlaybook, listPlaybooks } from '../src/playbooks.js'

describe('playbooks', () => {
  it('exposes six families and three phases', () => {
    const keys = listPlaybooks().sort()
    expect(keys).toEqual(['baseline-discipline','controls-rcx','dhw','electrification-staging','envelope','hvac','solar-storage','staging','walk-the-pca'].sort())
  })
  it('every playbook has doctrine, checks, and version', () => {
    for (const k of listPlaybooks()) {
      const p = getPlaybook(k)
      expect(p.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(p.doctrine.length).toBeGreaterThan(2)
      expect(p.feasibility_checks.length).toBeGreaterThan(1)
    }
  })
  it('controls-rcx doctrine prefers measured baselines and low-cost first', () => {
    const d = getPlaybook('controls-rcx').doctrine.join(' ')
    expect(d).toMatch(/measured/i); expect(d).toMatch(/before/i)
  })
  it('every playbook has valid kind and non-empty origination_prompts and data_requirements', () => {
    for (const k of listPlaybooks()) {
      const p = getPlaybook(k)
      expect(['family', 'phase']).toContain(p.kind)
      expect(p.origination_prompts).toBeDefined()
      expect(Array.isArray(p.origination_prompts)).toBe(true)
      expect(p.origination_prompts.length).toBeGreaterThan(0)
      expect(p.data_requirements).toBeDefined()
      expect(Array.isArray(p.data_requirements)).toBe(true)
      expect(p.data_requirements.length).toBeGreaterThan(0)
    }
  })
  it('hvac doctrine mentions A2L and refrigerant', () => {
    const d = getPlaybook('hvac').doctrine.join(' ')
    expect(d).toMatch(/A2L|refrigerant/i)
  })
  it('envelope doctrine mentions combustion', () => {
    const d = getPlaybook('envelope').doctrine.join(' ')
    expect(d).toMatch(/combustion/i)
  })
  it('unknown key throws listing valid keys', () => {
    expect(() => getPlaybook('nope')).toThrow(/hvac/)
  })
})
