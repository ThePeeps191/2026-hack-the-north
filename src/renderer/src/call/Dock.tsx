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
import { roleLabel } from './format'
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
  PlusIcon,
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

export function Dock(props: DockProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const { call, human, connection, stage } = props
  const live = connection.live
  const speaking = call.speakingAgentId !== null
  const full = props.agents.length >= MAX_AGENTS_PER_ROOM
  return <div className="hs-dock hd-dock" role="toolbar" aria-label="Call controls">
    <Button variant={live ? 'danger' : 'primary'} disabled={call.connection === 'connecting'} onClick={live ? props.onLeave : props.onJoin} hint={live ? 'Leave the call. Team work continues.' : 'Join with local microphone and teammate audio'}><span className="hs-btn-inner">{live ? <LeaveCallIcon size={15}/> : <EnterCallIcon size={15}/>}<span className="hd-join-label">{live ? 'Leave' : call.connection === 'connecting' ? 'Connecting...' : 'Join call'}</span></span></Button>
    <IconButton label={human.muted ? 'Unmute microphone' : 'Mute microphone'} disabled={!live} pressed={human.muted} onClick={props.onToggleMic} hint={live ? 'Toggle your microphone; work continues' : 'Join the call first'} shortcut="Ctrl+Shift+M">{human.muted ? <MicOffIcon/> : <MicIcon/>}</IconButton>
    <IconButton label={human.deafened ? 'Undeafen' : 'Deafen'} disabled={!live} pressed={human.deafened} onClick={props.onToggleDeafen} hint={live ? 'Toggle teammate audio; work continues' : 'Join the call first'} shortcut="Ctrl+Shift+D">{human.deafened ? <HeadphonesOffIcon/> : <HeadphonesIcon/>}</IconButton>
    <IconButton label="Stop current speech" disabled={!live || !speaking} onClick={() => props.onStopSpeaking('current')} hint="Stop the current speaker; work continues"><StopIcon/></IconButton>
    <span className="hd-spacer"/>
    <div className="hs-addagent"><IconButton label="Add teammate" disabled={full} pressed={menuOpen} onClick={() => setMenuOpen(v => !v)} hint={full ? 'This room has four teammates. Remove one to add another.' : 'Add a teammate'}><PlusIcon/></IconButton>{menuOpen ? <AddTeammateMenu agents={props.agents} onClose={() => setMenuOpen(false)} onAdd={props.onAddAgent}/> : null}</div>
    <IconButton label={stage.mode.kind === 'gallery' ? 'Team workspace' : 'Gallery'} onClick={stage.mode.kind === 'gallery' ? props.onShowTeamShare : props.onShowGallery} hint={stage.mode.kind === 'gallery' ? 'Open the shared workspace' : 'Back to the room'}>{stage.mode.kind === 'gallery' ? <MonitorIcon/> : <GridIcon/>}</IconButton>
    <IconButton label={props.railOpen ? 'Hide room panel' : 'Show room panel'} pressed={props.railOpen} onClick={props.onToggleRail} hint="Conversation, questions, decisions and work" shortcut="Ctrl+Shift+E"><ChatIcon/></IconButton>
    <details className="hd-more"><summary aria-label="More call controls">•••</summary><div>
      <p>{connection.label} · {props.agents.length + 1} in room</p>
      {live ? <LevelBar level={call.micLevel} muted={human.muted} label="Microphone level"/> : null}
      <Button variant="ghost" disabled={!live || (!speaking && !call.queuedAgentIds.length)} onClick={() => props.onStopSpeaking('all')}>Stop all speech</Button>
      {stage.mode.kind === 'gallery' ? <Button variant="ghost" onClick={() => props.onSetFollow(!stage.follow)}>{stage.follow ? 'Pin room view' : 'Follow the team'}</Button> : null}
      <Button variant="ghost" onClick={props.onOpenSettings}>Settings</Button>
    </div></details>
  </div>
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
