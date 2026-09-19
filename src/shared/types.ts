export const STATE_VERSION = 1 as const

export type AgentPresetId = 'maya' | 'alex' | 'sam'
export type AgentRole = 'frontend' | 'systems' | 'qa'
export type AgentWorkState = 'not_connected'
export type AgentSpeechState = 'not_connected'

export type WorkspaceTab = 'overview' | 'browser' | 'code' | 'terminal' | 'files'

export type WorkspaceFocus =
  | { type: 'team' }
  | { type: 'agent'; agentId: string }

export interface WorkspaceSelection {
  focus: WorkspaceFocus
  tab: WorkspaceTab
}

export interface Room {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  workspace: WorkspaceSelection
}

export interface Agent {
  id: string
  roomId: string
  presetId: AgentPresetId
  name: string
  role: AgentRole
  summary: string
  workState: AgentWorkState
  speechState: AgentSpeechState
  createdAt: string
}

export type MessageAuthor = { type: 'human' } | { type: 'agent'; agentId: string }

export interface Message {
  id: string
  roomId: string
  author: MessageAuthor
  body: string
  createdAt: string
  clientRequestId: string
}

export type RuntimeEventType =
  | 'room.created'
  | 'room.updated'
  | 'room.selected'
  | 'agent.added'
  | 'message.created'

export interface RoomCreatedEvent {
  id: string
  seq: number
  type: 'room.created'
  roomId: string
  createdAt: string
  payload: { room: Room }
}

export interface RoomUpdatedEvent {
  id: string
  seq: number
  type: 'room.updated'
  roomId: string
  createdAt: string
  payload: { room: Room }
}

export interface RoomSelectedEvent {
  id: string
  seq: number
  type: 'room.selected'
  roomId: string
  createdAt: string
  payload: { roomId: string }
}

export interface AgentAddedEvent {
  id: string
  seq: number
  type: 'agent.added'
  roomId: string
  createdAt: string
  payload: { agent: Agent }
}

export interface MessageCreatedEvent {
  id: string
  seq: number
  type: 'message.created'
  roomId: string
  createdAt: string
  payload: { message: Message }
}

export type RuntimeEvent =
  | RoomCreatedEvent
  | RoomUpdatedEvent
  | RoomSelectedEvent
  | AgentAddedEvent
  | MessageCreatedEvent

export interface RecoveryInfo {
  message: string
  backupPath: string
}

export interface AppSnapshot {
  version: typeof STATE_VERSION
  rooms: Room[]
  agents: Agent[]
  messages: Message[]
  selectedRoomId: string | null
  events: RuntimeEvent[]
  lastSeq: number
  recovery?: RecoveryInfo
}

export interface PersistedState {
  version: typeof STATE_VERSION
  rooms: Room[]
  agents: Agent[]
  messages: Message[]
  selectedRoomId: string | null
  events: RuntimeEvent[]
  lastSeq: number
}

export interface CreateRoomInput {
  name?: string
  description?: string
}

export interface UpdateRoomInput {
  id: string
  name?: string
  description?: string
  workspace?: WorkspaceSelection
}

export interface AddAgentInput {
  roomId: string
  presetId: AgentPresetId
}

export interface SendMessageInput {
  roomId: string
  body: string
  clientRequestId: string
}

export interface HuddleErrorShape {
  code: string
  message: string
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: HuddleErrorShape }

export const MAX_AGENTS_PER_ROOM = 4
export const MAX_EVENT_HISTORY = 200
export const MAX_ROOM_NAME = 80
export const MAX_ROOM_DESCRIPTION = 280
export const MAX_MESSAGE_BODY = 4000
