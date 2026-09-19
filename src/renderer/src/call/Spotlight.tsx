import { useState, type JSX } from 'react'
import type { Agent, ContextRef, Decision, IntegrationAttempt, Room, ShareSurface, Task, WorkspaceRecord } from '../../../shared/types'
import type { CallScreenProps, SpeakingState } from '../state/view-model'
import { ShareFrame } from './ShareFrame'
import { Button, Confirm } from './ui'
export interface SpotlightProps {
  agent: Agent
  agents: Agent[]
  room: Room
  surface: ShareSurface
  workspace: WorkspaceRecord | null
  tasks: Task[]
  decisions: Decision[]
  integrations: IntegrationAttempt[]
  speaking: Record<string, SpeakingState>
  queuedAgentIds: string[]
  now: number
  onBack: () => void
  onSelectSurface: (surface: ShareSurface) => void
  onSelectAgent: (agentId: string) => void
  onPauseWork: (agentId: string) => void
  onResumeWork: (agentId: string) => void
  onRemoveAgent: (agentId: string) => void
  onPreviewVoice: (voiceId: string) => void
  onReveal: (path: string) => void
  onRunIntegration: () => void
  onChooseProject: () => void
  onUseDemoProject: () => void
  onCancelTask: (taskId: string) => void
  onRetryTask: (taskId: string) => void
  renderSurface: CallScreenProps['renderSurface']
  onAttachRef: (ref: ContextRef) => void
}

export function Spotlight(props: SpotlightProps): JSX.Element {
  const { agent } = props
  const [removing, setRemoving] = useState(false)
  const paused = agent.workState === 'paused'
  const quiet = agent.workState === 'idle' || agent.workState === 'offline'
  return <section className="hs-spotlight hw-spotlight" aria-label={`One-on-one with ${agent.name}`}>
    {removing ? <Confirm question={`Remove ${agent.name} from the room?`} confirmLabel="Remove" onCancel={() => setRemoving(false)} onConfirm={() => { setRemoving(false); props.onRemoveAgent(agent.id) }} /> : null}
    <ShareFrame room={props.room} agents={props.agents} owner={{kind:'agent',agentId:agent.id}} surface={props.surface}
      workspace={props.workspace} integrations={props.integrations} speaking={props.speaking} queuedAgentIds={props.queuedAgentIds}
      showFilmstrip={false} focus onSelectSurface={props.onSelectSurface}
      onSelectOwner={owner => { if(owner.kind === 'agent') props.onSelectAgent(owner.agentId) }}
      onOpenSpotlight={props.onSelectAgent} onShowGallery={props.onBack} onRunIntegration={props.onRunIntegration}
      onChooseProject={props.onChooseProject} onUseDemoProject={props.onUseDemoProject} onReveal={props.onReveal}
      renderSurface={props.renderSurface} onAttachRef={props.onAttachRef}
      detailActions={<div className="hw-agent-actions">
        <p>{agent.role} · {agent.voice.voiceName}</p>
        <Button variant="quiet" onClick={() => props.onPreviewVoice(agent.voice.voiceId)}>Preview voice</Button>
        <Button variant="quiet" disabled={quiet} onClick={() => paused ? props.onResumeWork(agent.id) : props.onPauseWork(agent.id)}>{paused ? 'Resume work' : 'Pause work'}</Button>
        <Button variant="ghost" onClick={() => setRemoving(true)}>Remove teammate</Button>
      </div>} />
  </section>
}
