import { useEffect, useRef, useState, type JSX } from 'react'
import type {
  Agent,
  AgentPresetId,
  CallState,
  LiveTranscript,
  Room,
  StageState
} from '../../../shared/types'
import { AGENT_PRESETS } from '../../../shared/presets'
import { MAX_AGENTS_PER_ROOM } from '../../../shared/types'
import type { HumanPresence } from '../state/view-model'
import { AvatarMark } from './avatars'
import type { ConnectionStatus } from './derive'
import { roleLabel, truncate } from './format'
import {
  ChatIcon,
  CloseIcon,
  GridIcon,
  LeaveCallIcon,
  EnterCallIcon,
  MicIcon,
  MicOffIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  MonitorIcon,
  PinIcon,
  ArrowRightIcon,
  PlusIcon,
  SlidersIcon,
  StopIcon
} from './icons'
import { Badge, Button, IconButton, LevelBar } from './ui'

/**
 * The bottom call dock.
 *
 * Every control here does something real, and every unavailable control says
 * why in its own words. The level meter and the transcript line come from live
 * capture; the queue count comes from playback state.
 */

export interface DockProps {
  room: Room
  agents: Agent[]
  call: CallState
  human: HumanPresence
  connection: ConnectionStatus
  liveTranscript: LiveTranscript | null
  stage: StageState
  railOpen: boolean
  teamWorkspaceLabel: string | null
  onJoin: () => void
  onLeave: () => void
  onToggleMic: () => void
  onToggleDeafen: () => void
  onStopSpeaking: (scope: 'current' | 'all') => void
  onAddAgent: (
    presetId: AgentPresetId,
    options?: { name?: string; assignment?: string }
  ) => Promise<void> | void
  onShowGallery: () => void
  onShowTeamShare: () => void
  onSetFollow: (follow: boolean) => void
  onToggleRail: () => void
  onOpenSettings: () => void
}

export function Dock({
  room,
  agents,
  call,
  human,
  connection,
  liveTranscript,
  stage,
  railOpen,
  teamWorkspaceLabel,
  onJoin,
  onLeave,
  onToggleMic,
  onToggleDeafen,
  onStopSpeaking,
  onAddAgent,
  onShowGallery,
  onShowTeamShare,
  onSetFollow,
  onToggleRail,
  onOpenSettings
}: DockProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const live = connection.live
  const inGallery = stage.mode.kind === 'gallery'
  const roomFull = agents.length >= MAX_AGENTS_PER_ROOM
  const speakingNow = call.speakingAgentId !== null
  const queued = call.queuedAgentIds.length

  const micReason = !live
    ? 'Join the call before muting — there is no live microphone yet.'
    : human.muted
      ? 'Unmutes your microphone for this room'
      : 'Mutes your microphone for this room. The team keeps working.'
  const deafenReason = !live
    ? 'Join the call before deafening — there is no playback to stop yet.'
    : human.deafened
      ? 'Starts playing teammate speech again'
      : 'Stops all agent speech from reaching you. Work continues.'
  const stopCurrentReason = !live
    ? 'Join the call before stopping speech — nothing is playing yet.'
    : speakingNow
      ? 'Cuts the teammate who is speaking right now'
      : 'No teammate is speaking right now.'
  const stopAllReason = !live
    ? 'Join the call before stopping speech — nothing is playing yet.'
    : speakingNow || queued > 0
      ? `Cuts the current speaker and drops ${queued} queued repl${
          queued === 1 ? 'y' : 'ies'
        }. Work keeps running.`
      : 'Nothing is speaking or queued for speech right now.'

  return (
    <div className="hs-dock" role="toolbar" aria-label="Call controls" aria-orientation="horizontal">
      <div className="hs-dock-strip">
        <span className="hs-dock-mic">
          {human.muted ? <MicOffIcon size={14} /> : <MicIcon size={14} />}
          <LevelBar
            level={call.micLevel}
            muted={human.muted || human.deafened}
            label={`Microphone level, ${human.muted ? 'muted' : 'live'}`}
          />
          <span className="hs-dock-mic-label">
            {human.deafened ? 'Deafened' : human.muted ? 'Muted' : live ? 'Mic live' : 'Mic off'}
          </span>
        </span>

        <p className="hs-dock-transcript" aria-live="polite" title={liveTranscript?.text ?? ''}>
          {liveTranscript ? (
            <>
              <span className="hs-dock-transcript-who">You</span>
              {truncate(liveTranscript.text, 120)}
              {liveTranscript.isFinal ? '' : '…'}
            </>
          ) : (
            <span className="hs-dock-transcript-idle">
              {live ? 'Listening for your voice…' : connection.label}
            </span>
          )}
        </p>

        <span className="hs-dock-meta">
          {speakingNow ? (
            <span
              className="hs-bars"
              aria-hidden="true"
              title="A teammate is speaking right now"
            />
          ) : null}
          {queued > 0 ? (
            <span className="hs-dock-queued" title="Queued speech waiting for the floor">
              {queued} queued
            </span>
          ) : null}
          <span className={`hs-channel-state hs-channel-state--${connection.tone}`} title={connection.detail}>
            <span className="hs-conn-dot" aria-hidden="true" />
            {connection.label}
          </span>
          <span className="hs-dock-count" title="Participants in this room">
            {agents.length + 1} in room
          </span>
        </span>
      </div>

      <div className="hs-dock-controls">
        <div className="hs-dock-group">
          {live ? (
            <Button
              variant="danger"
              onClick={onLeave}
              hint="Stops capture and playback for this room. The team keeps working."
            >
              <span className="hs-btn-inner">
                <LeaveCallIcon size={15} /> Leave call
              </span>
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={onJoin}
              hint={connection.detail}
              disabled={call.connection === 'connecting'}
            >
              <span className="hs-btn-inner">
                <EnterCallIcon size={15} /> {call.connection === 'connecting' ? 'Connecting…' : 'Join call'}
              </span>
            </Button>
          )}

          <IconButton
            label={human.muted ? 'Unmute microphone' : 'Mute microphone'}
            hint={micReason}
            shortcut="Ctrl+Shift+M"
            pressed={human.muted}
            disabled={!live}
            onClick={onToggleMic}
          >
            {human.muted ? <MicOffIcon /> : <MicIcon />}
          </IconButton>

          <IconButton
            label={human.deafened ? 'Undeafen' : 'Deafen'}
            hint={deafenReason}
            shortcut="Ctrl+Shift+D"
            pressed={human.deafened}
            disabled={!live}
            onClick={onToggleDeafen}
          >
            {human.deafened ? <HeadphonesOffIcon /> : <HeadphonesIcon />}
          </IconButton>
        </div>

        <div className="hs-dock-group hs-dock-group--mid">
          <IconButton
            label="Stop current speech"
            hint={stopCurrentReason}
            disabled={!live || !speakingNow}
            onClick={() => onStopSpeaking('current')}
          >
            <StopIcon />
          </IconButton>
          <IconButton
            label="Stop all speech"
            hint={stopAllReason}
            disabled={!live || (!speakingNow && queued === 0)}
            onClick={() => onStopSpeaking('all')}
          >
            <StopIcon />
            <span className="hs-stop-all" aria-hidden="true">
              all
            </span>
          </IconButton>

          <div className="hs-addagent">
            <Button
              variant="quiet"
              pressed={menuOpen}
              disabled={roomFull}
              hint={roomFull ? `The room is full at ${MAX_AGENTS_PER_ROOM} teammates. Remove one first.` : 'Adds a teammate from the preset roster or as a custom role'}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className="hs-btn-inner">
                <PlusIcon size={15} /> Add teammate
              </span>
            </Button>
            {menuOpen ? (
              <AddTeammateMenu
                agents={agents}
                onClose={() => setMenuOpen(false)}
                onAdd={onAddAgent}
              />
            ) : null}
          </div>
        </div>

        <div className="hs-dock-group hs-dock-group--end">
          <IconButton
            label="Gallery"
            hint={
              inGallery
                ? 'Participant tiles are already on the stage'
                : 'Shows every participant tile again'
            }
            shortcut="Ctrl+Shift+G"
            pressed={inGallery}
            disabled={inGallery}
            onClick={onShowGallery}
          >
            <GridIcon />
          </IconButton>
          <IconButton
            label="Team workspace"
            hint={
              teamWorkspaceLabel
                ? `Shows the shared integration workspace (${teamWorkspaceLabel})`
                : 'The team workspace appears once a project is bound to this room'
            }
            disabled={!teamWorkspaceLabel}
            onClick={onShowTeamShare}
          >
            <MonitorIcon />
          </IconButton>
          <IconButton
            label={stage.follow ? 'Following the team' : 'Pinned to your view'}
            hint={
              stage.follow
                ? 'The stage follows meaningful changes. Click to pin your current view.'
                : 'Your view stays put and new activity shows a hint instead. Click to follow again.'
            }
            pressed={stage.follow}
            onClick={() => onSetFollow(!stage.follow)}
          >
            {stage.follow ? <ArrowRightIcon /> : <PinIcon />}
          </IconButton>
          <IconButton
            label={railOpen ? 'Hide room panel' : 'Show room panel'}
            hint={railOpen ? 'Collapses chat, questions and decisions' : 'Shows chat, questions and decisions'}
            shortcut="Ctrl+Shift+E"
            pressed={railOpen}
            onClick={onToggleRail}
          >
            <ChatIcon />
          </IconButton>
          <IconButton
            label="Settings"
            hint="Voice, models, capabilities and keys"
            shortcut="Ctrl+,"
            onClick={onOpenSettings}
          >
            <SlidersIcon />
          </IconButton>
        </div>
      </div>
    </div>
  )
}

interface AddTeammateMenuProps {
  agents: Agent[]
  onClose: () => void
  onAdd: (
    presetId: AgentPresetId,
    options?: { name?: string; assignment?: string }
  ) => Promise<void> | void
}

function AddTeammateMenu({ agents, onClose, onAdd }: AddTeammateMenuProps): JSX.Element {
  const [presetId, setPresetId] = useState<AgentPresetId | null>(null)
  const [name, setName] = useState('')
  const [assignment, setAssignment] = useState('')
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onDown = (event: MouseEvent): void => {
      if (box.current && event.target instanceof Node && !box.current.contains(event.target)) {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const preset = AGENT_PRESETS.find((item) => item.id === presetId) ?? null

  const submit = (): void => {
    if (!preset) return
    setBusy(true)
    const options: { name?: string; assignment?: string } = {}
    if (name.trim()) options.name = name.trim()
    if (assignment.trim()) options.assignment = assignment.trim()
    void Promise.resolve(onAdd(preset.id, options)).then(() => {
      setBusy(false)
      onClose()
    })
  }

  return (
    <div className="hs-popover" ref={box} role="dialog" aria-label="Add a teammate">
      <p className="hs-popover-title">Add a teammate</p>
      {preset === null ? (
        <ul className="hs-presetlist">
          {AGENT_PRESETS.map((item) => {
            const present = agents.filter((agent) => agent.presetId === item.id).length
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="hs-preset"
                  onClick={() => {
                    setPresetId(item.id)
                    setName(present > 0 ? `${item.name} ${present + 1}` : item.name)
                  }}
                >
                  <AvatarMark avatar={item.avatar} color={item.color} size={28} />
                  <span className="hs-preset-text">
                    <span className="hs-preset-name">
                      {item.name}
                      <span className="hs-preset-role">{roleLabel(item.role)}</span>
                      {present > 0 ? <Badge tone="muted">in room</Badge> : null}
                    </span>
                    <span className="hs-preset-summary">{item.summary}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="hs-preset-form">
          <div className="hs-preset-chosen">
            <AvatarMark avatar={preset.avatar} color={preset.color} size={32} />
            <div>
              <p className="hs-preset-name">{preset.name}</p>
              <p className="hs-preset-summary">{preset.summary}</p>
            </div>
          </div>
          <label className="hs-field">
            <span className="hs-field-label">Name</span>
            <input
              className="hs-input"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="hs-field">
            <span className="hs-field-label">First assignment</span>
            <textarea
              className="hs-textarea"
              rows={3}
              value={assignment}
              placeholder="What should this teammate pick up first?"
              onChange={(event) => setAssignment(event.target.value)}
            />
          </label>
          <div className="hs-preset-form-actions">
            <Button variant="ghost" onClick={() => setPresetId(null)} hint="Back to the preset list">
              Back
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={busy || name.trim().length === 0}
              hint={
                name.trim().length === 0
                  ? 'Give the teammate a name first'
                  : 'Creates a workspace and joins this teammate to the call'
              }
            >
              {busy ? 'Adding…' : 'Add to call'}
            </Button>
          </div>
        </div>
      )}
      <button type="button" className="hs-popover-close" onClick={onClose} aria-label="Close the teammate picker">
        <CloseIcon size={14} />
      </button>
    </div>
  )
}
