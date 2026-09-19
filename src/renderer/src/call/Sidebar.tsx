import { useState, type JSX } from 'react'
import type { Agent, CallState, ProjectBinding, Room } from '../../../shared/types'
import { ACCENT, HUMAN_AVATAR, HUMAN_COLOR } from '../../../shared/presets'
import type { HumanPresence, SpeakingState } from '../state/view-model'
import { AvatarMark } from './avatars'
import { basename, type ConnectionStatus } from './derive'
import { formatClock, formatDateTime, formatRelative, roleLabel, truncate, workStateLabel, workStateTone } from './format'
import {
  EnterCallIcon,
  FolderIcon,
  HeadphonesOffIcon,
  LockIcon,
  MicIcon,
  MicOffIcon,
  PlusIcon,
  SlidersIcon,
  SpeechIcon,
  TrashIcon
} from './icons'
import { Badge, Button, Confirm, IconButton, LevelBar, SectionLabel } from './ui'

/**
 * Left sidebar: identity, rooms, the active voice channel with its participants
 * nested underneath, and project binding. Participants are drawn from the room
 * roster and the live call state only.
 */

export interface SidebarProps {
  room: Room
  rooms: Room[]
  agents: Agent[]
  human: HumanPresence
  call: CallState
  connection: ConnectionStatus
  speaking: Record<string, SpeakingState>
  queuedAgentIds: string[]
  /** Team messages from non-humans visible in the retained event ring, per room. */
  retainedTeamMessages: Map<string, number>
  project: ProjectBinding | null
  creating: boolean
  now: number
  onSelectRoom: (roomId: string) => void
  onCreateRoom: () => void
  onRemoveRoom: (roomId: string) => void
  onOpenSpotlight: (agentId: string) => void
  onOpenSettings: () => void
  onChooseProject: () => void
  onUseDemoProject: () => void
  onRevealPath: (path: string) => void
}

export function Sidebar({
  room,
  rooms,
  agents,
  human,
  call,
  connection,
  speaking,
  queuedAgentIds,
  retainedTeamMessages,
  project,
  creating,
  now,
  onSelectRoom,
  onCreateRoom,
  onRemoveRoom,
  onOpenSpotlight,
  onOpenSettings,
  onChooseProject,
  onUseDemoProject,
  onRevealPath
}: SidebarProps): JSX.Element {
  const [confirmRoomId, setConfirmRoomId] = useState<string | null>(null)
  const quietVoice = connection.tone === 'quiet'

  return (
    <aside className="hs-side" aria-label="Rooms and voice channel">
      <div className="hs-brand">
        <AvatarMark avatar="huddle" color={ACCENT} size={26} />
        <div>
          <p className="hs-wordmark">Huddle</p>
          <p className="hs-wordmark-sub">Engineering rooms</p>
        </div>
      </div>

      <section className="hs-side-block hs-side-rooms" aria-label="Rooms">
        <SectionLabel
          aside={
            <IconButton
              label="Create room"
              hint="Starts a new room with the default three-teammate roster"
              size="sm"
              disabled={creating}
              onClick={onCreateRoom}
            >
              <PlusIcon size={15} />
            </IconButton>
          }
        >
          Rooms
        </SectionLabel>
        <ul className="hs-roomlist">
          {rooms.map((item) => {
            const selected = item.id === room.id
            const teamMessages = retainedTeamMessages.get(item.id) ?? 0
            const confirming = confirmRoomId === item.id
            return (
              <li key={item.id} className="hs-roomlist-item">
                <button
                  type="button"
                  className={`hs-room${selected ? ' is-selected' : ''}`}
                  aria-current={selected ? 'true' : undefined}
                  title={`${item.name}\n${item.goal || 'No goal set'}`}
                  onClick={() => {
                    if (!selected) onSelectRoom(item.id)
                  }}
                >
                  <span className="hs-room-top">
                    <span className="hs-room-name">{item.name}</span>
                    {teamMessages > 0 ? (
                      <span
                        className="hs-room-badge"
                        title={`${teamMessages} message${
                          teamMessages === 1 ? '' : 's'
                        } from teammates in the retained event history`}
                      >
                        {teamMessages > 99 ? '99+' : teamMessages}
                      </span>
                    ) : null}
                  </span>
                  <span className="hs-room-goal">
                    {item.goal ? truncate(item.goal, 70) : 'No goal set'}
                  </span>
                  <span className="hs-room-meta">
                    {selected ? <span className="hs-room-active">Active</span> : null}
                    {item.joined ? (
                      <span className="hs-room-in-call" title="You joined the call in this room">
                        <EnterCallIcon size={11} /> joined
                      </span>
                    ) : null}
                    <span
                      className="hs-room-time"
                      title={`Updated ${formatDateTime(item.updatedAt)}`}
                    >
                      {formatClock(item.updatedAt)}
                    </span>
                  </span>
                </button>
                {confirming ? (
                  <Confirm
                    question="Delete this room and its history?"
                    confirmLabel="Delete"
                    onConfirm={() => {
                      setConfirmRoomId(null)
                      onRemoveRoom(item.id)
                    }}
                    onCancel={() => setConfirmRoomId(null)}
                  />
                ) : (
                  <IconButton
                    label={`Delete room ${item.name}`}
                    hint="Removes the room and its messages from Huddle. Project files on disk are untouched."
                    size="sm"
                    tone="danger"
                    disabled={confirming}
                    onClick={() => setConfirmRoomId(item.id)}
                  >
                    <TrashIcon size={14} />
                  </IconButton>
                )}
              </li>
            )
          })}
          {rooms.length === 0 ? <li className="hs-room-empty">No rooms yet.</li> : null}
        </ul>
      </section>

      <section className="hs-side-block hs-channel" aria-label="Voice channel">
        <div className="hs-channel-head">
          <span className="hs-channel-title">
            <span className={`hs-channel-icon${quietVoice ? '' : ' is-on'}`} aria-hidden="true">
              {human.deafened ? <HeadphonesOffIcon size={14} /> : <SpeechIcon size={14} />}
            </span>
            Voice
          </span>
          <span className="hs-channel-room">{truncate(room.name, 22)}</span>
        </div>
        <p className={`hs-channel-state hs-channel-state--${connection.tone}`} title={connection.detail}>
          <span className="hs-conn-dot" aria-hidden="true" />
          {connection.label}
        </p>

        <ul className="hs-participants" aria-label="Participants">
          <li className="hs-participant is-human">
            <span className="hs-participant-avatar">
              <AvatarMark avatar={HUMAN_AVATAR} color={HUMAN_COLOR} size={24} dim={!connection.live} />
            </span>
            <span className="hs-participant-ident">
              <span className="hs-participant-name">{human.name}</span>
              <span className="hs-participant-role">Host</span>
            </span>
            <span className="hs-participant-flags">
              {human.speaking ? <span className="hs-bars is-sm" aria-hidden="true" /> : null}
              {human.muted ? (
                <span className="hs-flag" title="Microphone muted">
                  <MicOffIcon size={13} />
                </span>
              ) : (
                <span className="hs-micmini" title="Microphone level">
                  <LevelBar
                    level={call.micLevel}
                    muted={human.deafened}
                    label={`Your microphone level, ${human.muted ? 'muted' : 'live'}`}
                  />
                </span>
              )}
              {human.deafened ? (
                <span className="hs-flag is-warn" title="Deafened">
                  <LockIcon size={13} />
                </span>
              ) : null}
              {!human.muted && !human.deafened ? (
                <span className="hs-flag" title="Microphone open">
                  <MicIcon size={13} />
                </span>
              ) : null}
            </span>
          </li>

          {agents.map((agent) => {
            const live = speaking[agent.id] ?? null
            const queued = !live && queuedAgentIds.includes(agent.id)
            const tone = workStateTone(agent.workState)
            return (
              <li key={agent.id} className="hs-participant">
                <button
                  type="button"
                  className={`hs-participant-btn${live ? ' is-speaking' : ''}`}
                  onClick={() => onOpenSpotlight(agent.id)}
                  title={`${agent.name} · ${roleLabel(agent.role)} — ${workStateLabel(
                    agent.workState
                  )}${agent.activityLabel ? ` · ${agent.activityLabel}` : ''}`}
                  aria-label={`Talk to ${agent.name} one on one`}
                >
                  <span className="hs-participant-avatar">
                    <AvatarMark
                      avatar={agent.avatar}
                      color={agent.color}
                      size={24}
                      dim={tone === 'quiet'}
                    />
                    {live ? <span className="hs-speak-ring is-sm" aria-hidden="true" /> : null}
                  </span>
                  <span className="hs-participant-ident">
                    <span className="hs-participant-name">{agent.name}</span>
                    <span className="hs-participant-role">{roleLabel(agent.role)}</span>
                  </span>
                  <span className="hs-participant-flags">
                    {live ? (
                      <span className="hs-bars is-sm" aria-hidden="true" />
                    ) : queued ? (
                      <span className="hs-flag" title="Waiting to speak">
                        <SpeechIcon size={13} />
                      </span>
                    ) : null}
                    <span
                      className={`hs-work-dot hs-work-dot--${tone}`}
                      title={workStateLabel(agent.workState)}
                      aria-hidden="true"
                    />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        {!call.listening && human.muted ? (
          <p className="hs-channel-hint">
            You are muted. Join or unmute to talk; the team keeps working either way.
          </p>
        ) : null}
      </section>

      <section className="hs-side-block hs-project" aria-label="Project">
        <SectionLabel>Project</SectionLabel>
        {project ? (
          <>
            <p className="hs-project-path" title={project.rootPath}>
              <FolderIcon size={13} /> {basename(project.rootPath)}
            </p>
            <p className="hs-project-meta">
              <Badge tone={project.kind === 'demo' ? 'accent' : 'plain'}>
                {project.kind === 'demo' ? 'Demo' : 'Folder'}
              </Badge>
              <Badge tone={project.isGitRepo ? 'plain' : 'wait'}>
                {project.isGitRepo ? 'git' : 'no git'}
              </Badge>
              {project.hadDirtyWorkOnBind ? (
                <Badge tone="wait" title="This folder had uncommitted changes when it was bound">
                  uncommitted work
                </Badge>
              ) : null}
            </p>
            <p className="hs-project-actions">
              <Button
                variant="ghost"
                hint="Opens the project folder in the file manager"
                onClick={() => onRevealPath(project.rootPath)}
              >
                Reveal
              </Button>
              <Button
                variant="ghost"
                hint="Binds a different folder to this room"
                onClick={onChooseProject}
              >
                Change
              </Button>
            </p>
          </>
        ) : (
          <>
            <p className="hs-project-hint">
              No project bound. The team has nothing real to work on until this room points at a
              folder.
            </p>
            <p className="hs-project-actions">
              <Button
                variant="primary"
                hint="Choose an existing folder to bind to this room"
                onClick={onChooseProject}
              >
                Choose folder
              </Button>
              <Button
                variant="quiet"
                hint="Copies the bundled demo project into a new folder"
                onClick={onUseDemoProject}
              >
                Use demo
              </Button>
            </p>
          </>
        )}
      </section>

      <footer className="hs-side-foot">
        <Button
          variant="ghost"
          hint="Voice, models, capabilities and API keys"
          shortcut="Ctrl+,"
          onClick={onOpenSettings}
        >
          <span className="hs-btn-inner">
            <SlidersIcon size={15} /> Settings
          </span>
        </Button>
        <span
          className="hs-side-foot-meta"
          title={`This room was updated ${formatRelative(room.updatedAt, now)}`}
        >
          {agents.length}/4 teammates
        </span>
      </footer>
    </aside>
  )
}
