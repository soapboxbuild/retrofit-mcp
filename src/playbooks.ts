import hvac from '../playbooks/hvac.json' with { type: 'json' }
import envelope from '../playbooks/envelope.json' with { type: 'json' }
import dhw from '../playbooks/dhw.json' with { type: 'json' }
import controlsRcx from '../playbooks/controls-rcx.json' with { type: 'json' }
import solarStorage from '../playbooks/solar-storage.json' with { type: 'json' }
import electrificationStaging from '../playbooks/electrification-staging.json' with { type: 'json' }
import walkThePca from '../playbooks/phases/walk-the-pca.json' with { type: 'json' }
import staging from '../playbooks/phases/staging.json' with { type: 'json' }
import baselineDiscipline from '../playbooks/phases/baseline-discipline.json' with { type: 'json' }

export type Playbook = {
  key: string; version: string; kind: 'family' | 'phase'
  doctrine: string[]; origination_prompts: string[]
  feasibility_checks: string[]; data_requirements: string[]
}

const ALL: Record<string, Playbook> = {
  hvac, envelope, dhw,
  'controls-rcx': controlsRcx,
  'solar-storage': solarStorage,
  'electrification-staging': electrificationStaging,
  'walk-the-pca': walkThePca,
  staging,
  'baseline-discipline': baselineDiscipline,
} as unknown as Record<string, Playbook>

export function listPlaybooks(): string[] { return Object.keys(ALL) }
export function getPlaybook(key: string): Playbook {
  const p = ALL[key]
  if (!p) throw new Error(`Unknown playbook "${key}". Valid: ${listPlaybooks().sort().join(', ')}`)
  return p
}
