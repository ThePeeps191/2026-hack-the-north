import { useState, type JSX } from 'react'
import type {
  Agent,
  ContextRef,
  Decision,
  IntegrationAttempt,
  Room,
  ShareSurface,
  Task,
  WorkspaceRecord
} from '../../../shared/types'
import type { CallScreenProps, SpeakingState } from '../state/view-model'
import { AvatarMark } from './avatars'
import { basename, openTasks, tasksForAgent } from './derive'
import { formatRelative, roleLabel, shortRevision, speechLabel, taskStatusLabel, taskStatusTone, truncate, workStateLabel, workStateTone } from './format'
import { ArrowLeftIcon, PauseIcon, PlayIcon, SpeechIcon, TrashIcon, VolumeIcon } from './icons'
import { ShareFrame } from './ShareFrame'
import { Badge, Button, Confirm, Empty, IconButton, SectionLabel } from './ui'

/**
 * One-on-one spotlight.
 *
 * A single teammate, their real state, the tasks they own today and their own
 * workspace. The private channel for this view lives in the rail.
 */

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

export function Spotlight({
  agent,
  agents,
  room,
  surface,
  workspace,
  tasks,
  decisions,
  integrations,
  speaking,
  queuedAgentIds,
  now,
  onBack,
  onSelectSurface,
  onSelectAgent,
  onPauseWork,
  onResumeWork,
  onRemoveAgent,
  onPreviewVoice,
  onReveal,
  onRunIntegration,
  onChooseProject,
  onUseDemoProject,
  onCancelTask,
  onRetryTask,
  renderSurface,
  onAttachRef
}: SpotlightProps): JSX.Element {
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const live = speaking[agent.id] ?? null
  const queued = !live && queuedAgentIds.includes(agent.id)
  const owned = tasksForAgent(tasks, agent.id)
  const open = openTasks(owned)
  const done = owned.filter((task) => task.status === 'done').length
  const paused = agent.workState === 'paused'
  const quiet = agent.workState === 'offline' || agent.workState === 'idle'
  const involvedDecisions = decisions.filter((decision) =>
    owned.some((task) => decision.affectedTaskIds.includes(task.id))
  )

  return (
    <section className="hs-spotlight" aria-label={`One-on-one with ${agent.name}`}>
      <header className="hs-spotlight-head">
        <Button
          variant="ghost"
          hint="Returns to the participant gallery"
          shortcut="Esc"
          onClick={onBack}
        >
          <span className="hs-btn-inner">
            <ArrowLeftIcon size={15} /> Back to the room
          </span>
        </Button>

        <span className="hs-spotlight-ident">
          <span className="hs-spotlight-avatar">
            <AvatarMark avatar={agent.avatar} color={agent.color} size={38} dim={quiet} />
            {live ? <span className="hs-speak-ring" aria-hidden="true" /> : null}
          </span>
          <span className="hs-spotlight-text">
            <span className="hs-spotlight-name">
              {agent.name}
              <Badge tone={workStateTone(agent.workState)}>{workStateLabel(agent.workState)}</Badge>
              {agent.connected ? (
                <Badge tone="muted">Connected</Badge>
              ) : (
                <Badge tone="quiet">Offline</Badge>
              )}
              {live ? (
                <Badge tone="live">
                  <SpeechIcon size={11} /> speaking now
                </Badge>
              ) : queued ? (
                <Badge tone="wait">waiting to speak</Badge>
              ) : (
                <Badge tone="muted">{speechLabel(agent.speechState)}</Badge>
              )}
            </span>
            <span className="hs-spotlight-activity" title={agent.activityLabel}>
              {roleLabel(agent.role)} · {agent.activityLabel}
            </span>
          </span>
        </span>

        <span className="hs-spotlight-meta">
          <span className="hs-spotlight-meta-item" title="Assigned voice in settings">
            <VolumeIcon size={13} /> {agent.voice.voiceName}
          </span>
          <span className="hs-spotlight-meta-item hs-mono" title="Model used for this teammate">
            {agent.model}
          </span>
          {workspace ? (
            <span className="hs-spotlight-meta-item" title={workspace.rootPath}>
              {basename(workspace.rootPath)}
              {workspace.branch ? ` · ${workspace.branch}` : ''}
              {workspace.lastVerifiedRevision
                ? ` · verified @${shortRevision(workspace.lastVerifiedRevision)}`
                : ' · not verified'}
            </span>
          ) : (
            <span className="hs-spotlight-meta-item">no workspace yet</span>
          )}
        </span>

        <span className="hs-spotlight-actions">
          <IconButton
            label={`Preview ${agent.name}'s voice`}
            hint="Plays a short sample of the assigned voice"
            onClick={() => onPreviewVoice(agent.voice.voiceId)}
          >
            <VolumeIcon />
          </IconButton>
          <IconButton
            label={paused ? `Resume ${agent.name}` : `Pause ${agent.name}`}
            hint={
              quiet
                ? 'A teammate that is offline or idle has no work to pause'
                : paused
                  ? 'Lets this teammate pick up new work again'
                  : 'Stops new work. Speech in flight still plays.'
            }
            pressed={paused}
            disabled={quiet}
            onClick={() => (paused ? onResumeWork(agent.id) : onPauseWork(agent.id))}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
          </IconButton>
          <IconButton
            label={`Remove ${agent.name} from the room`}
            hint="Takes this teammate out of the room. Its workspace stays on disk."
            tone="danger"
            onClick={() => setConfirmingRemove(true)}
          >
            <TrashIcon />
          </IconButton>
        </span>
      </header>

      {confirmingRemove ? (
        <Confirm
          question={`Remove ${agent.name} from the room?`}
          confirmLabel="Remove"
          onConfirm={() => {
            setConfirmingRemove(false)
            onRemoveAgent(agent.id)
          }}
          onCancel={() => setConfirmingRemove(false)}
        />
      ) : null}

      <div className="hs-spotlight-tasks">
        <SectionLabel
          aside={
            <span className="hs-spotlight-taskcount">
              {open.length} open · {done} done
            </span>
          }
        >
          {agent.name}’s tasks
        </SectionLabel>
        {owned.length === 0 ? (
          <Empty title="No tasks yet" detail={`${agent.name} has not been given work in this room.`} />
        ) : (
          <ul className="hs-tasklist">
            {openTasks(owned)
              .slice(0, 6)
              .map((task) => (
                <li key={task.id} className="hs-task">
                  <header className="hs-task-head">
                    <Badge tone={taskStatusTone(task.status)}>{taskStatusLabel(task.status)}</Badge>
                    {task.staleSince ? (
                      <Badge tone="wait" title={task.staleReason ?? 'A newer decision may affect this task'}>
                        stale
                      </Badge>
                    ) : null}
                    {task.dependsOn.length > 0 ? (
                      <span
                        className="hs-task-dep"
                        title={`Waiting on ${task.dependsOn.length} other task(s)`}
                      >
                        {task.dependsOn.length} dep
                      </span>
                    ) : null}
                  </header>
                  <p className="hs-task-title" title={task.title}>
                    {task.title}
                  </p>
                  {task.blockedReason ? (
                    <p className="hs-task-blocked" title={task.blockedReason}>
                      {truncate(task.blockedReason, 90)}
                    </p>
                  ) : null}
                  <footer className="hs-task-foot">
                    <span
                      className="hs-task-meta"
                      title={`${task.acceptance.length} acceptance criteria · ${task.evidence.length} evidence references · updated ${formatRelative(task.updatedAt, now)}`}
                    >
                      {task.acceptance.length} criteria · {task.evidence.length} evidence ·{' '}
                      {formatRelative(task.updatedAt, now)}
                    </span>
                    <span className="hs-task-actions">
                      <Button
                        variant="ghost"
                        disabled={task.status === 'done' || task.status === 'cancelled'}
                        hint={
                          task.status === 'done' || task.status === 'cancelled'
                            ? 'This task is already closed'
                            : 'Stops work on this task. The teammate keeps its other work.'
                        }
                        onClick={() => onCancelTask(task.id)}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={task.status !== 'failed' && task.status !== 'cancelled'}
                        hint={
                          task.status === 'failed' || task.status === 'cancelled'
                            ? 'Puts this task back in front of its owner'
                            : 'Only failed or cancelled tasks can be retried'
                        }
                        onClick={() => onRetryTask(task.id)}
                      >
                        Retry
                      </Button>
                    </span>
                  </footer>
                </li>
              ))}
            {open.length === 0 ? (
              <li className="hs-task-empty">
                Every task owned by {agent.name} is closed. {done} finished in total.
              </li>
            ) : null}
          </ul>
        )}
        {involvedDecisions.length > 0 ? (
          <p className="hs-spotlight-decisions">
            {involvedDecisions.length} recorded decision
            {involvedDecisions.length === 1 ? '' : 's'} touched these tasks:{' '}
            {involvedDecisions
              .map((decision) => `v${decision.revision}`)
              .join(', ')}
          </p>
        ) : null}
      </div>

      <ShareFrame
        room={room}
        agents={agents}
        owner={{ kind: 'agent', agentId: agent.id }}
        surface={surface}
        workspace={workspace}
        integrations={integrations}
        speaking={speaking}
        queuedAgentIds={queuedAgentIds}
        showFilmstrip={false}
        onSelectSurface={onSelectSurface}
        onSelectOwner={(owner) => {
          if (owner.kind === 'agent') onSelectAgent(owner.agentId)
        }}
        onOpenSpotlight={onSelectAgent}
        onShowGallery={onBack}
        onRunIntegration={onRunIntegration}
        onChooseProject={onChooseProject}
        onUseDemoProject={onUseDemoProject}
        onReveal={onReveal}
        renderSurface={renderSurface}
        onAttachRef={onAttachRef}
      />
    </section>
  )
}
