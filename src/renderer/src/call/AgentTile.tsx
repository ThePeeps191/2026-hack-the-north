import type { CSSProperties, JSX } from 'react'
import type { Agent } from '../../../shared/types'
import type { HumanPresence, SpeakingState } from '../state/view-model'
import type { AgentScreen } from './screen-feed'
import { AvatarMark } from './avatars'
import {
  agentDisplayName,
  formatRelative,
  roleLabel,
  truncate,
  workStateLabel,
  workStateTone
} from './format'
import {
  EnterCallIcon,
  LeaveCallIcon,
  LockIcon,
  MicIcon,
  MicOffIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  SpeechIcon,
  TrashIcon
} from './icons'
import { Confirm, LevelBar, IconButton } from './ui'

/**
 * One participant tile — a teammate's screen, not a status card.
 *
 * A call tile that shows a name and a status word tells you nothing, and the
 * claim this product makes is that you can watch each teammate work. So the
 * body of the tile is the teammate's live screen: the place the work is
 * happening and the last real actions taken, in the order they happened.
 *
 * The tile is still a strict mirror of runtime state. Every line comes from a
 * committed tool run, job or browser session; the activity line comes only from
 * `agent.activityLabel`; the outline comes only from real playback in
 * `props.speaking`. There is no spinner, no shimmer, and no inferred "working"
 * state anywhere — a teammate that has done nothing shows an empty screen and
 * says so.
 */

export interface AgentTileProps {
  agent: Agent
  /** Live playback for this agent, or null when it is silent. */
  speaking: SpeakingState | null
  /** True while this agent has speech queued behind the current floor holder. */
  queued: boolean
  /** What this teammate's screen shows, derived from committed records. */
  screen: AgentScreen
  /** True for a moment after the human redirected this teammate mid-task. */
  steered: boolean
  now: number
  removing: boolean
  onOpenSpotlight: () => void
  onShowWorkspace: () => void
  onPauseWork: () => void
  onResumeWork: () => void
  onRequestRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
}

export function AgentTile({
  agent,
  speaking,
  queued,
  screen,
  steered,
  now,
  removing,
  onOpenSpotlight,
  onShowWorkspace,
  onPauseWork,
  onResumeWork,
  onRequestRemove,
  onCancelRemove,
  onConfirmRemove
}: AgentTileProps): JSX.Element {
  const tone = workStateTone(agent.workState)
  const quiet = agent.workState === 'offline' || agent.workState === 'idle'
  // Playback analysis supplies this value. Do not manufacture an audible level.
  const level = speaking ? Math.min(1, Math.max(0, speaking.level)) : 0
  const paused = agent.workState === 'paused'

  const classes = [
    'hs-tile',
    `hs-tile--${tone}`,
    quiet ? 'is-quiet' : '',
    speaking ? 'is-speaking' : '',
    !speaking && queued ? 'is-queued' : '',
    steered ? 'is-steered' : '',
    removing ? 'is-confirming' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <article
      className={classes}
      style={
        {
          '--tile-accent': agent.color,
          ...(speaking ? { '--speak-level': level } : {})
        } as CSSProperties
      }
      title={`${agent.name} — ${workStateLabel(agent.workState)} · updated ${formatRelative(
        agent.updatedAt,
        now
      )}`}
    >
      <button
        type="button"
        className="hs-tile-main"
        onClick={onOpenSpotlight}
        aria-label={`Open one-on-one with ${agent.name}, ${roleLabel(agent.role)}`}
      >
        <span className="hs-tile-head">
          <span className="hs-tile-avatar">
            <AvatarMark avatar={agent.avatar} color={agent.color} size={26} dim={quiet} />
            {speaking ? <span className="hs-speak-ring" aria-hidden="true" /> : null}
          </span>
          <span className="hs-tile-ident">
            <span className="hs-tile-idline">
              <span className="hs-tile-name">{agentDisplayName(agent)}</span>
              <span className="hs-tile-role">{roleLabel(agent.role)}</span>
            </span>
            <span className="hs-tile-task" title={screen.task ?? undefined}>
              {screen.task ? truncate(screen.task, 46) : 'no task assigned'}
            </span>
          </span>
          <span className={`hs-tile-state hs-tile-state--${tone}`}>
            {steered ? 'Heard you' : workStateLabel(agent.workState)}
          </span>
        </span>

        <span className="hs-screen">
          <span className="hs-screen-now">
            <span className="hs-screen-headline">{screen.headline}</span>
            {screen.locus ? <span className="hs-screen-locus">{screen.locus}</span> : null}
          </span>

          {screen.empty ? (
            <span className="hs-screen-blank">
              {quiet ? 'Nothing on this screen yet.' : 'Starting up — no actions recorded yet.'}
            </span>
          ) : (
            <span className="hs-screen-feed">
              {screen.lines.map((line) => (
                <span key={line.id} className={`hs-screen-line hs-screen-line--${line.tone}`}>
                  <span className="hs-screen-action">{line.action}</span>
                  {line.target ? <span className="hs-screen-target">{line.target}</span> : null}
                  {line.note ? <span className="hs-screen-note">{truncate(line.note, 52)}</span> : null}
                </span>
              ))}
            </span>
          )}

          {speaking && speaking.text ? (
            <span className="hs-screen-caption">
              <SpeechIcon size={12} />
              <span className="hs-screen-caption-text">{truncate(speaking.text, 120)}</span>
            </span>
          ) : null}
        </span>
      </button>

      <footer className="hs-tile-foot">
        <span className="hs-tile-signals">
          {screen.branch ? (
            <span className="hs-tile-branch" title={`Real git worktree branch: ${screen.branch}`}>
              {screen.branch}
            </span>
          ) : (
            <span className="hs-tile-branch is-none">no worktree</span>
          )}
        </span>
        <span className="hs-tile-actions">
          <IconButton
            label={`Show ${agent.name}'s workspace`}
            hint={
              agent.workspaceId
                ? 'Opens this teammate’s workspace on the stage'
                : 'This teammate has no workspace yet'
            }
            size="sm"
            onClick={onShowWorkspace}
            disabled={!agent.workspaceId}
          >
            <MonitorIcon size={15} />
          </IconButton>
          <IconButton
            label={paused ? `Resume ${agent.name}` : `Pause ${agent.name}`}
            hint={
              quiet
                ? 'A teammate that is offline or idle has no work to pause'
                : paused
                  ? 'Lets this teammate pick up new work again'
                  : 'Stops this teammate from starting or continuing work. Speech keeps playing.'
            }
            size="sm"
            onClick={paused ? onResumeWork : onPauseWork}
            disabled={quiet}
          >
            {paused ? <PlayIcon size={15} /> : <PauseIcon size={15} />}
          </IconButton>
          {removing ? null : (
            <IconButton
              label={`Remove ${agent.name}`}
              hint="Takes this teammate out of the room. Its workspace is left on disk."
              size="sm"
              tone="danger"
              onClick={onRequestRemove}
            >
              <TrashIcon size={15} />
            </IconButton>
          )}
        </span>
      </footer>

      {removing ? (
        <Confirm
          question={`Remove ${agent.name} from the room?`}
          confirmLabel="Remove"
          onConfirm={onConfirmRemove}
          onCancel={onCancelRemove}
        />
      ) : null}
    </article>
  )
}

export interface HumanTileProps {
  human: HumanPresence
  /** Human display colour from the presets. */
  color: string
  avatar: string
  connected: boolean
  connectionLabel: string
  joined: boolean
  level: number
  onJoin: () => void
  onLeave: () => void
  joinDisabledReason: string | null
}

export function HumanTile({
  human,
  color,
  avatar,
  connected,
  connectionLabel,
  joined,
  level,
  onJoin,
  onLeave,
  joinDisabledReason
}: HumanTileProps): JSX.Element {
  const quiet = !human.speaking && level < 0.04
  const classes = [
    'hs-tile',
    'hs-tile--human',
    human.speaking ? 'is-speaking' : '',
    quiet ? 'is-quiet' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <article className={classes} title={`${human.name} — ${connectionLabel}`}>
      <div className="hs-tile-main is-static">
        <span className="hs-tile-avatar">
          <AvatarMark avatar={avatar} color={color} size={46} dim={quiet} />
          {human.speaking ? <span className="hs-speak-ring" aria-hidden="true" /> : null}
        </span>
        <span className="hs-tile-ident">
          <span className="hs-tile-name">
            {human.name}
            {human.speaking ? <span className="hs-tile-speaking-tag">Speaking</span> : null}
          </span>
          <span className="hs-tile-role">You · in this room</span>
          <span className="hs-tile-activity">
            {human.deafened
              ? 'Deafened — you are not hearing the team'
              : human.muted
                ? 'Microphone muted'
                : connected
                  ? 'Microphone live'
                  : connectionLabel}
          </span>
        </span>
      </div>

      <footer className="hs-tile-foot">
        <span className="hs-tile-signals">
          <span className={`hs-conn${connected ? ' is-on' : ''}`}>
            <span className="hs-conn-dot" aria-hidden="true" />
            {connectionLabel}
          </span>
          <span className="hs-micline">
            {human.muted ? <MicOffIcon size={14} /> : <MicIcon size={14} />}
            <LevelBar
              level={level}
              muted={human.muted || human.deafened}
              label={`Microphone level, ${human.muted ? 'muted' : 'live'}`}
            />
          </span>
          {human.deafened ? (
            <span className="hs-queued is-cut">
              <LockIcon size={12} /> Deafened
            </span>
          ) : null}
        </span>
        <span className="hs-tile-actions">
          {joined || connected ? (
            <IconButton
              label="Leave the call"
              hint="Leave this room. Team work continues."
              size="sm"
              onClick={onLeave}
            >
              <LeaveCallIcon size={15} />
            </IconButton>
          ) : (
            <IconButton
              label="Join the call"
              hint={joinDisabledReason ?? 'Starts your microphone and playback'}
              size="sm"
              tone="accent"
              onClick={onJoin}
              disabled={joinDisabledReason !== null}
            >
              <EnterCallIcon size={15} />
            </IconButton>
          )}
          {joined && !connected ? <span className="hs-queued">{connectionLabel}</span> : null}
        </span>
      </footer>
    </article>
  )
}

/** Compact presence row used by the filmstrip and rails. */
export function PresenceDot({ agent, speaking }: { agent: Agent; speaking: boolean }): JSX.Element {
  return (
    <span
      className={`hs-presence-dot${speaking ? ' is-speaking' : ''}`}
      style={{ background: speaking ? agent.color : undefined }}
      title={truncate(`${agent.name} · ${workStateLabel(agent.workState)}`, 60)}
      aria-hidden="true"
    />
  )
}
