import { type CSSProperties, type JSX, type ReactNode } from 'react'
import type { Agent, ContextRef, IntegrationAttempt, Room, ShareSurface, WorkspaceRecord } from '../../../shared/types'
import { SHARE_SURFACES } from '../../../shared/types'
import type { CallScreenProps, SpeakingState } from '../state/view-model'
import { AvatarMark } from './avatars'
import { findAgent, latestIntegration } from './derive'
import { integrationStatus, shortRevision, surfaceLabel, workStateLabel } from './format'
import { ArrowLeftIcon, CodeIcon, FileIcon, GlobeIcon, TerminalIcon, PinIcon } from './icons'
import { Button } from './ui'
import '../styles/stage.css'

const SURFACE_ICONS: Record<ShareSurface, JSX.Element> = {
  browser: <GlobeIcon size={15} />, code: <CodeIcon size={15} />,
  terminal: <TerminalIcon size={15} />, files: <FileIcon size={15} />
}
export interface ShareFrameProps {
  room: Room
  agents: Agent[]
  owner: { kind: 'team' } | { kind: 'agent'; agentId: string }
  surface: ShareSurface
  workspace: WorkspaceRecord | null
  integrations: IntegrationAttempt[]
  speaking: Record<string, SpeakingState>
  queuedAgentIds: string[]
  showFilmstrip: boolean
  focus?: boolean
  detailActions?: ReactNode
  onToggleFollow?: () => void
  onSelectSurface: (surface: ShareSurface) => void
  onSelectOwner: (owner: { kind: 'team' } | { kind: 'agent'; agentId: string }) => void
  onOpenSpotlight: (agentId: string) => void
  onShowGallery: () => void
  onRunIntegration: () => void
  onChooseProject: () => void
  onUseDemoProject: () => void
  onReveal: (path: string) => void
  renderSurface: CallScreenProps['renderSurface']
  onAttachRef: (ref: ContextRef) => void
}

export function ShareFrame(props: ShareFrameProps): JSX.Element {
  const { room, agents, owner, surface, workspace, integrations, speaking, queuedAgentIds,
    showFilmstrip, onSelectSurface, onSelectOwner, onShowGallery, onRunIntegration,
    onChooseProject, onUseDemoProject, onReveal, renderSurface, onAttachRef } = props
  const agent = owner.kind === 'agent' ? findAgent(agents, owner.agentId) : null
  const latest = latestIntegration(integrations)
  const verified = workspace?.lastVerifiedRevision
  const teamVerified = [...integrations].filter(item => item.status === 'verified').sort((a,b) => b.startedAt.localeCompare(a.startedAt))[0]
  const status = !workspace ? 'No workspace yet' : latest?.status === 'running' && owner.kind === 'team'
    ? 'Checking changes' : verified ? `Verified @${shortRevision(verified)}` : 'Not verified'
  const teamStatus = teamVerified?.revision ? `Team verified @${shortRevision(teamVerified.revision)}` : 'Team not verified yet'
  const activity = agent?.activityLabel || (agent ? workStateLabel(agent.workState) : '')
  return (
    <section className={`hs-share hs-workstage${props.focus ? ' hs-workstage-focus' : ''}`} aria-label={agent ? `${agent.name}'s workspace` : 'Team workspace'}>
      <header className="hw-header">
        <div className="hw-identity">
          <AvatarMark avatar={agent?.avatar ?? 'huddle'} color={agent?.color ?? '#f0a868'} size={props.focus ? 40 : 28} />
          <div className="hw-heading">
            <h2>{agent ? (props.focus ? agent.name : `${agent.name}'s workspace`) : 'Shared workspace'}</h2>
            {props.focus ? <p title={activity}>{activity}</p> : <p className={verified ? 'hw-verified' : ''}>{status}{owner.kind === 'agent' ? <span className="hw-team-relation"> · {teamStatus}</span> : null}</p>}
          </div>
        </div>
        <div className="hw-header-actions">
          {props.onToggleFollow ? <Button variant="ghost" pressed={!room.stage.follow} onClick={props.onToggleFollow} hint={room.stage.follow ? 'Follow teammate workspace changes. Click to pin this view.' : 'This view is pinned. Click to follow changes.'}><span className="hs-btn-inner"><PinIcon size={14} />{room.stage.follow ? 'Follow' : 'Pinned'}</span></Button> : null}
          <details className="hw-disclosure">
            <summary>Details</summary>
            <div className="hw-detail-panel">
              <h3>{agent ? `${agent.name}'s workspace` : 'Team integration'}</h3>
              <p>{status}{agent ? ` · ${teamStatus}` : ''}</p>
              {workspace ? <><p className="hw-technical">{workspace.branch ?? 'No branch'} · {workspace.isWorktree ? 'Individual worktree' : 'Project folder'}</p><p className="hw-path">{workspace.rootPath}</p><Button variant="quiet" onClick={() => onReveal(workspace.rootPath)}>Reveal folder</Button></> : null}
              {agent && !props.focus ? <Button variant="quiet" onClick={() => props.onOpenSpotlight(agent.id)}>One-on-one with {agent.name}</Button> : null}
              {props.detailActions}
              {owner.kind === 'team' ? <Button variant="primary" disabled={!workspace || latest?.status === 'running'} onClick={onRunIntegration}>{latest?.status === 'running' ? 'Checking changes…' : 'Run integration'}</Button> : null}
              {integrations.length ? <div className="hw-history"><h3>Integration history</h3>{[...integrations].reverse().map(item => <details key={item.id}><summary>{integrationStatus(item.status).label} {item.revision ? `@${shortRevision(item.revision)}` : ''} · decision r{item.decisionRevision}</summary><p>{item.detail}</p><p className="hw-technical">{item.revision ?? 'No revision recorded'}</p>{item.sources.map(source => <p className="hw-technical" key={source.agentId}>{source.branch} @{shortRevision(source.commit)}</p>)}{item.checks.map((check,i) => <details key={i}><summary>{check.status} · {check.name}</summary><code>{check.command}</code><pre>{check.output || 'No output recorded.'}</pre></details>)}</details>)}</div> : <p>No integration has run yet.</p>}
            </div>
          </details>
          <Button variant="quiet" onClick={onShowGallery} hint="Return to the room" shortcut="Esc"><span className="hs-btn-inner"><ArrowLeftIcon size={14} /><span>Room</span></span></Button>
        </div>
      </header>
      <div className="hw-navigation">
        <div className="hw-tabs" role="tablist" aria-label="Workspace surface">
          {SHARE_SURFACES.map((item,index) => <button key={item} type="button" role="tab" aria-selected={surface === item} tabIndex={surface === item ? 0 : -1}
            onClick={() => onSelectSurface(item)} onKeyDown={event => {
              const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
              if (!offset && event.key !== 'Home' && event.key !== 'End') return
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + offset + 4) % 4
              ;(event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus()
              onSelectSurface(SHARE_SURFACES[next]!)
            }}>{SURFACE_ICONS[item]}<span>{surfaceLabel(item)}</span></button>)}
        </div>
        {showFilmstrip ? <Filmstrip agents={agents} owner={owner} speaking={speaking} queuedAgentIds={queuedAgentIds} onSelectOwner={onSelectOwner} /> : <span className="hw-scope">Private conversation · shared project</span>}
      </div>
      <div className="hs-share-body hw-body">
        {!room.project ? <div className="hw-empty"><h3>Bring a project into the room</h3><p>Choose a folder for the team to work on.</p><div><Button variant="primary" onClick={onChooseProject}>Choose folder</Button></div></div> : renderSurface({surface, owner, workspace, agent, onAttachRef})}
      </div>
    </section>
  )
}
export interface FilmstripProps {
  agents: Agent[]
  owner: {kind:'team'} | {kind:'agent';agentId:string}
  speaking: Record<string,SpeakingState>
  queuedAgentIds: string[]
  onSelectOwner: ShareFrameProps['onSelectOwner']
}
export function Filmstrip({agents,owner,speaking,queuedAgentIds,onSelectOwner}: FilmstripProps): JSX.Element {
  return <div className="hw-filmstrip" role="group" aria-label="Workspace owner">
    <button type="button" aria-pressed={owner.kind === 'team'} onClick={() => onSelectOwner({kind:'team'})} title="Team integration"><AvatarMark avatar="huddle" color="#f0a868" size={20}/><span>Team</span></button>
    {agents.map(agent => <button key={agent.id} type="button" aria-pressed={owner.kind === 'agent' && owner.agentId === agent.id} onClick={() => onSelectOwner({kind:'agent',agentId:agent.id})} title={`${agent.name} · ${agent.activityLabel || workStateLabel(agent.workState)}${queuedAgentIds.includes(agent.id) ? ' · waiting to speak' : ''}`} style={{'--voice-level':speaking[agent.id]?.level ?? 0,'--agent-color':agent.color} as CSSProperties}><AvatarMark avatar={agent.avatar} color={agent.color} size={20}/><span>{agent.name}</span></button>)}
  </div>
}
