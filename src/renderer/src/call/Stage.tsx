import { useState, type JSX } from 'react'
import type {
  Agent,
  ContextRef,
  CallState,
  Decision,
  IntegrationAttempt,
  Room,
  ShareSurface,
  StageState,
  Task,
  WorkspaceRecord
} from '../../../shared/types'
import type { CallScreenProps, HumanPresence, SpeakingState } from '../state/view-model'
import { workspaceFor } from '../state/view-model'
import { AgentTile, HumanTile } from './AgentTile'
import type { ConnectionStatus } from './derive'
import { findAgent } from './derive'
import { truncate } from './format'
import { ArrowRightIcon, CloseIcon, PinIcon } from './icons'
import { ShareFrame } from './ShareFrame'
import { Spotlight } from './Spotlight'
import { Badge, Button, Empty, IconButton } from './ui'

/**
 * The stage.
 *
 * Three real views: the participant gallery, a focused workspace share, and a
 * one-on-one spotlight. Follow lets the backend move the stage; pin holds the
 * user's view and surfaces `room.stage.pendingHint` instead of stealing focus.
 */

export interface StageProps {
  room: Room
  agents: Agent[]
  workspaces: WorkspaceRecord[]
  tasks: Task[]
  decisions: Decision[]
  integrations: IntegrationAttempt[]
  speaking: Record<string, SpeakingState>
  queuedAgentIds: string[]
  human: HumanPresence
  call: CallState
  connection: ConnectionStatus
  now: number
  label: string
  humanAvatar: string
  humanColor: string
  onJoin: () => void
  onLeave: () => void
  joinDisabledReason: string | null
  onOpenSpotlight: (agentId: string) => void
  onShowShare: (owner: { kind: 'team' } | { kind: 'agent'; agentId: string }, surface: ShareSurface) => void
  onShowGallery: () => void
  onSetStage: (stage: StageState) => void
  onRenameRoom: (name: string) => void
  onSetGoal: (goal: string) => void
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

export function Stage(props: StageProps): JSX.Element {
  const {
    room,
    agents,
    workspaces,
    speaking,
    queuedAgentIds,
    human,
    call,
    connection,
    now,
    label,
    humanAvatar,
    humanColor,
    onOpenSpotlight,
    onShowShare,
    onShowGallery,
    onSetStage,
    onRenameRoom,
    onSetGoal
  } = props

  const [editing, setEditing] = useState(false)
  const mode = room.stage.mode
  const pending = room.stage.pendingHint
  const pendingAgent = pending ? findAgent(agents, pending.agentId) : null

  return (
    <section className="hs-stage" aria-label={`Stage: ${label}`}>
      {mode.kind === 'gallery' ? (
        <header className="hs-stage-head">
          {editing ? (
            <RoomEditor
              room={room}
              onCancel={() => setEditing(false)}
              onSave={(name, goal) => {
                if (name !== room.name) onRenameRoom(name)
                if (goal !== room.goal) onSetGoal(goal)
                setEditing(false)
              }}
            />
          ) : (
            <>
              <div className="hs-stage-ident">
                <h2 className="hs-stage-name" title={room.name}>
                  {room.name}
                </h2>
                <p className="hs-stage-goal" title={room.goal || 'No goal set for this room'}>
                  {room.goal ? truncate(room.goal, 160) : 'No goal set for this room yet.'}
                </p>
              </div>
              <div className="hs-stage-meta">
                <Badge tone="muted">{agents.length + 1} in call</Badge>
                <Badge tone={room.project ? 'plain' : 'wait'}>
                  {room.project ? (room.project.kind === 'demo' ? 'demo project' : 'project bound') : 'no project'}
                </Badge>
                <Badge tone="muted">decision rev {room.decisionRevision}</Badge>
                <Button
                  variant="ghost"
                  hint="Rename this room or change its goal"
                  onClick={() => setEditing(true)}
                >
                  Edit
                </Button>
              </div>
            </>
          )}
        </header>
      ) : null}

      {pending && pendingAgent ? (
        <div className="hs-pending" role="note">
          <PinIcon size={14} />
          <span className="hs-pending-text">
            {pendingAgent.name} moved to {pending.surface}. Your view is pinned.
          </span>
          <Button
            variant="quiet"
            hint={`Follows ${pendingAgent.name} to their ${pending.surface} view`}
            onClick={() => onShowShare({ kind: 'agent', agentId: pendingAgent.id }, pending.surface)}
          >
            <span className="hs-btn-inner">
              <ArrowRightIcon size={14} /> Show
            </span>
          </Button>
          <IconButton
            label="Dismiss this hint"
            hint="Clears the hint and keeps your view where it is"
            size="sm"
            onClick={() => onSetStage({ ...room.stage, pendingHint: null })}
          >
            <CloseIcon size={14} />
          </IconButton>
        </div>
      ) : null}

      {mode.kind === 'gallery' ? (
        <div className="hs-gallery">
          <HumanTile
            human={human}
            color={humanColor}
            avatar={humanAvatar}
            connected={connection.live}
            connectionLabel={connection.label}
            joined={room.joined}
            level={call.micLevel}
            onJoin={props.onJoin}
            onLeave={props.onLeave}
            joinDisabledReason={props.joinDisabledReason}
          />
          {agents.map((agent) => (
            <GalleryAgent key={agent.id} agent={agent} stage={props} />
          ))}
          {agents.length === 0 ? (
            <div className="hs-gallery-empty">
              <Empty
                title="No teammates in this room"
                detail="Add a teammate from the dock to start working with an AI engineering team."
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {mode.kind === 'share' ? (
        <ShareFrame
          room={room}
          agents={agents}
          owner={mode.owner}
          surface={mode.surface}
          workspace={workspaceForOwner(workspaces, mode.owner)}
          integrations={props.integrations}
          speaking={speaking}
          queuedAgentIds={queuedAgentIds}
          showFilmstrip
          onSelectSurface={(surface) => onShowShare(mode.owner, surface)}
          onSelectOwner={(owner) => onShowShare(owner, mode.surface)}
          onOpenSpotlight={onOpenSpotlight}
          onShowGallery={onShowGallery}
          onRunIntegration={props.onRunIntegration}
          onChooseProject={props.onChooseProject}
          onUseDemoProject={props.onUseDemoProject}
          onReveal={props.onReveal}
          renderSurface={props.renderSurface}
          onAttachRef={props.onAttachRef}
        />
      ) : null}

      {mode.kind === 'spotlight' ? (
        <SpotlightShell room={room} agents={agents} workspaces={workspaces} stage={props} />
      ) : null}
    </section>
  )
}

/** Agent tile wired to the shell callbacks, with its own remove confirmation. */
function GalleryAgent({ agent, stage }: { agent: Agent; stage: StageProps }): JSX.Element {
  const [removing, setRemoving] = useState(false)
  const live = stage.speaking[agent.id] ?? null
  return (
    <AgentTile
      agent={agent}
      speaking={live}
      queued={!live && stage.queuedAgentIds.includes(agent.id)}
      now={stage.now}
      removing={removing}
      onOpenSpotlight={() => stage.onOpenSpotlight(agent.id)}
      onShowWorkspace={() => stage.onShowShare({ kind: 'agent', agentId: agent.id }, 'code')}
      onPauseWork={() => stage.onPauseWork(agent.id)}
      onResumeWork={() => stage.onResumeWork(agent.id)}
      onRequestRemove={() => setRemoving(true)}
      onCancelRemove={() => setRemoving(false)}
      onConfirmRemove={() => {
        setRemoving(false)
        stage.onRemoveAgent(agent.id)
      }}
    />
  )
}

/** Resolves the spotlight agent once, so the view never renders half a record. */
function SpotlightShell({
  room,
  agents,
  workspaces,
  stage
}: {
  room: Room
  agents: Agent[]
  workspaces: WorkspaceRecord[]
  stage: StageProps
}): JSX.Element | null {
  const mode = room.stage.mode
  if (mode.kind !== 'spotlight') return null
  const agent = findAgent(agents, mode.agentId)
  if (!agent) {
    return (
      <Empty
        title="That teammate is no longer in the room"
        detail="The spotlight was pointing at a teammate that has been removed."
      >
        <Button variant="primary" onClick={stage.onShowGallery} hint="Returns to the gallery">
          Back to the gallery
        </Button>
      </Empty>
    )
  }
  return (
    <Spotlight
      agent={agent}
      agents={agents}
      room={room}
      surface={mode.surface}
      workspace={workspaceForOwner(workspaces, { kind: 'agent', agentId: agent.id })}
      tasks={stage.tasks}
      decisions={stage.decisions}
      integrations={stage.integrations}
      speaking={stage.speaking}
      queuedAgentIds={stage.queuedAgentIds}
      now={stage.now}
      onBack={stage.onShowGallery}
      onSelectSurface={(surface) => stage.onShowShare({ kind: 'agent', agentId: agent.id }, surface)}
      onSelectAgent={(agentId) => stage.onOpenSpotlight(agentId)}
      onPauseWork={stage.onPauseWork}
      onResumeWork={stage.onResumeWork}
      onRemoveAgent={stage.onRemoveAgent}
      onPreviewVoice={stage.onPreviewVoice}
      onReveal={stage.onReveal}
      onRunIntegration={stage.onRunIntegration}
      onChooseProject={stage.onChooseProject}
      onUseDemoProject={stage.onUseDemoProject}
      onCancelTask={stage.onCancelTask}
      onRetryTask={stage.onRetryTask}
      renderSurface={stage.renderSurface}
      onAttachRef={stage.onAttachRef}
    />
  )
}

function workspaceForOwner(
  workspaces: WorkspaceRecord[],
  owner: { kind: 'team' } | { kind: 'agent'; agentId: string }
): WorkspaceRecord | null {
  return workspaceFor(workspaces, owner)
}

function RoomEditor({
  room,
  onSave,
  onCancel
}: {
  room: Room
  onSave: (name: string, goal: string) => void
  onCancel: () => void
}): JSX.Element {
  const [name, setName] = useState(room.name)
  const [goal, setGoal] = useState(room.goal)
  return (
    <div className="hs-room-editor">
      <label className="hs-field">
        <span className="hs-field-label">Room name</span>
        <input
          className="hs-input"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="hs-field">
        <span className="hs-field-label">Goal for this room</span>
        <textarea
          className="hs-textarea"
          rows={2}
          value={goal}
          maxLength={600}
          onChange={(event) => setGoal(event.target.value)}
        />
      </label>
      <div className="hs-room-editor-actions">
        <Button variant="ghost" onClick={onCancel} hint="Leaves the room unchanged">
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={name.trim().length === 0}
          hint={
            name.trim().length === 0
              ? 'A room needs a name'
              : 'Saves the name and goal. Teammates read the goal before their next task.'
          }
          onClick={() => onSave(name.trim(), goal.trim())}
        >
          Save room
        </Button>
      </div>
    </div>
  )
}
