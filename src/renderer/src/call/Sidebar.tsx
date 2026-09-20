import { useState, type JSX } from 'react'
import type { Agent, CallState, ProjectBinding, Room } from '../../../shared/types'
import { MAX_AGENTS_PER_ROOM } from '../../../shared/types'
import { ACCENT } from '../../../shared/presets'
import type { HumanPresence, SpeakingState } from '../state/view-model'
import { AvatarMark } from './avatars'
import { basename, type ConnectionStatus } from './derive'
import { agentDisplayName, roleLabel, workStateLabel } from './format'
import { FolderIcon, PlusIcon, SlidersIcon, TrashIcon } from './icons'
import { CreateRoomDialog } from './CreateRoomDialog'
import { Button, Confirm, IconButton } from './ui'

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
  onCreateRoom: (name: string, agentCount: number) => void
  onRemoveRoom: (roomId: string) => void
  onOpenSpotlight: (agentId: string) => void
  onOpenSettings: () => void
  onChooseProject: () => void
  onUseDemoProject: () => void
  onRevealPath: (path: string) => void
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const [deleting, setDeleting] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  return <aside className="hs-side hs-sidebar-flat" aria-label="Rooms and teammates">
    <div className="hs-brand"><AvatarMark avatar="huddle" color={ACCENT} size={30}/><div><h1>Huddle</h1><p>Your engineering team</p></div></div>
    {creating ? <CreateRoomDialog onCancel={() => setCreating(false)} onCreate={(name, agentCount) => { setCreating(false); props.onCreateRoom(name, agentCount) }} /> : null}
    <section className="hf-rooms"><div className="hf-section-title"><span>Rooms</span><IconButton label="Create room" disabled={props.creating} onClick={() => setCreating(true)} hint="Create a room and choose how many teammates join"><PlusIcon size={16}/></IconButton></div>
      <ul>{props.rooms.map(room => <li key={room.id}><div className="hf-room-row"><button type="button" className={`hf-room${room.id === props.room.id ? ' is-selected' : ''}`} aria-current={room.id === props.room.id ? 'page' : undefined} onClick={() => props.onSelectRoom(room.id)} title={room.goal || room.name}>{room.name}</button><IconButton label={`Delete room ${room.name}`} size="sm" onClick={() => setDeleting(room.id)} hint="Remove room history; project files are kept"><TrashIcon size={13}/></IconButton></div>{deleting === room.id ? <Confirm question="Delete this room and its history?" confirmLabel="Delete" onConfirm={() => {setDeleting(null);props.onRemoveRoom(room.id)}} onCancel={() => setDeleting(null)}/> : null}</li>)}</ul>
    </section>
    <section className="hf-teammates" aria-label="Teammate shortcuts"><div className="hf-section-title">Teammates</div>{props.agents.map(agent => <button key={agent.id} className="hf-person" type="button" onClick={() => props.onOpenSpotlight(agent.id)} aria-label={`Talk to ${agentDisplayName(agent)} one on one`} title={`${agentDisplayName(agent)} · ${agent.activityLabel || workStateLabel(agent.workState)}`}><AvatarMark avatar={agent.avatar} color={agent.color} size={24}/><span>{agentDisplayName(agent)}</span><span className="hf-role">{agent.role === 'general' ? '' : roleLabel(agent.role)}</span></button>)}</section>
    <section className="hf-project" aria-label="Project"><div className="hf-section-title">Project</div>{props.project ? <><p title={props.project.rootPath}><FolderIcon size={14}/><span>{basename(props.project.rootPath)}</span></p><div className="hf-project-actions"><Button variant="ghost" onClick={() => props.onRevealPath(props.project!.rootPath)}>Reveal</Button><Button variant="ghost" onClick={props.onChooseProject}>Change folder</Button></div><details><summary>Project details</summary><p>{props.project.kind === 'demo' ? 'Sketch Night demo' : 'Local project'} · {props.project.isGitRepo ? 'Git repository' : 'Shared folder'}</p>{props.project.hadDirtyWorkOnBind ? <p>Had uncommitted changes when added.</p> : null}</details></> : <><p>Give the team a project to work on.</p><Button variant="quiet" onClick={props.onChooseProject}>Choose folder</Button>{/* Use demo project is disabled: no filler Sketch Night bind from the UI. */}</>}</section>
    <footer className="hf-footer"><Button variant="ghost" onClick={props.onOpenSettings}><span className="hs-btn-inner"><SlidersIcon size={15}/> Settings</span></Button><span>{props.agents.length}/{MAX_AGENTS_PER_ROOM} teammates</span></footer>
  </aside>
}
