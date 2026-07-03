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
  it('unknown key throws listing valid keys', () => {
    expect(() => getPlaybook('nope')).toThrow(/hvac/)
  })
})
