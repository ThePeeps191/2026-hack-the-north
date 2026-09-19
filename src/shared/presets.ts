import type { AgentPresetId, AgentRole } from './types'

export interface AgentPreset {
  id: AgentPresetId
  name: string
  role: AgentRole
  summary: string
}

export const AGENT_PRESETS: readonly AgentPreset[] = [
  {
    id: 'maya',
    name: 'Maya',
    role: 'frontend',
    summary: 'Frontend teammate for UI, layout, and client-side work.'
  },
  {
    id: 'alex',
    name: 'Alex',
    role: 'systems',
    summary: 'Systems teammate for architecture, services, and runtime work.'
  },
  {
    id: 'sam',
    name: 'Sam',
    role: 'qa',
    summary: 'QA teammate for tests, edge cases, and regression hunting.'
  }
] as const

export function getAgentPreset(id: string): AgentPreset | undefined {
  return AGENT_PRESETS.find((preset) => preset.id === id)
}
