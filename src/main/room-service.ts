import { randomUUID } from 'node:crypto'
import { getAgentPreset } from '../shared/presets.ts'
import {
  MAX_AGENTS_PER_ROOM,
  MAX_EVENT_HISTORY,
  MAX_MESSAGE_BODY,
  MAX_ROOM_DESCRIPTION,
  MAX_ROOM_NAME,
  STATE_VERSION,
  type AddAgentInput,
  type Agent,
  type AppSnapshot,
  type CreateRoomInput,
  type Message,
  type PersistedState,
  type RecoveryInfo,
  type Room,
  type RuntimeEvent,
  type SendMessageInput,
  type UpdateRoomInput,
  type WorkspaceSelection
} from '../shared/types.ts'
import { HuddleError } from './huddle-error.ts'
import { JsonSnapshotStore } from './json-store.ts'

type EventListener = (event: RuntimeEvent) => void

export class RoomService {
  private rooms: Room[] = []
  private agents: Agent[] = []
  private messages: Message[] = []
  private events: RuntimeEvent[] = []
  private selectedRoomId: string | null = null
  private lastSeq = 0
  private recovery?: RecoveryInfo
  private readonly listeners = new Set<EventListener>()
  private writeChain: Promise<void> = Promise.resolve()
  private readonly store: JsonSnapshotStore

  private constructor(store: JsonSnapshotStore) {
    this.store = store
  }

  static async open(store: JsonSnapshotStore): Promise<RoomService> {
    const service = new RoomService(store)
    await service.initialize()
    return service
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot(): AppSnapshot {
    return {
      version: STATE_VERSION,
      rooms: this.rooms.map(clone),
      agents: this.agents.map(clone),
      messages: this.messages.map(clone),
      selectedRoomId: this.selectedRoomId,
      events: this.events.map(clone),
      lastSeq: this.lastSeq,
      recovery: this.recovery ? { ...this.recovery } : undefined
    }
  }

  async createRoom(input: CreateRoomInput = {}): Promise<Room> {
    const room = this.buildRoom(input.name, input.description)
    this.rooms.push(room)
    this.selectedRoomId = room.id
    this.emit({
      type: 'room.created',
      roomId: room.id,
      payload: { room: clone(room) }
    })
    this.emit({
      type: 'room.selected',
      roomId: room.id,
      payload: { roomId: room.id }
    })
    await this.persist()
    return clone(room)
  }

  async updateRoom(input: UpdateRoomInput): Promise<Room> {
    const room = this.requireRoom(input.id)
    if (input.name !== undefined) {
      room.name = normalizeName(input.name)
    }
    if (input.description !== undefined) {
      room.description = normalizeDescription(input.description)
    }
    if (input.workspace !== undefined) {
      room.workspace = validateWorkspace(input.workspace, this.agentsFor(room.id))
    }
    room.updatedAt = now()
    this.emit({
      type: 'room.updated',
      roomId: room.id,
      payload: { room: clone(room) }
    })
    await this.persist()
    return clone(room)
  }

  async selectRoom(roomId: string): Promise<void> {
    this.requireRoom(roomId)
    this.selectedRoomId = roomId
    this.emit({
      type: 'room.selected',
      roomId,
      payload: { roomId }
    })
    await this.persist()
  }

  async addAgent(input: AddAgentInput): Promise<Agent> {
    const room = this.requireRoom(requireString(input.roomId, 'roomId'))
    const preset = getAgentPreset(input.presetId)
    if (!preset) {
      throw new HuddleError('invalid_preset', 'Unknown agent preset.')
    }
    const existing = this.agentsFor(room.id)
    if (existing.length >= MAX_AGENTS_PER_ROOM) {
      throw new HuddleError('agent_limit', 'This room already has four agents.')
    }
    const agent: Agent = {
      id: randomUUID(),
      roomId: room.id,
      presetId: preset.id,
      name: preset.name,
      role: preset.role,
      summary: preset.summary,
      workState: 'not_connected',
      speechState: 'not_connected',
      createdAt: now()
    }
    this.agents.push(agent)
    room.updatedAt = now()
    this.emit({
      type: 'agent.added',
      roomId: room.id,
      payload: { agent: clone(agent) }
    })
    await this.persist()
    return clone(agent)
  }

  async sendMessage(input: SendMessageInput): Promise<Message> {
    const roomId = requireString(input.roomId, 'roomId')
    const clientRequestId = requireString(input.clientRequestId, 'clientRequestId')
    this.requireRoom(roomId)
    const duplicate = this.messages.find(
      (message) => message.clientRequestId === clientRequestId
    )
    if (duplicate) {
      return clone(duplicate)
    }
    const body = normalizeMessage(input.body)
    const message: Message = {
      id: randomUUID(),
      roomId,
      author: { type: 'human' },
      body,
      createdAt: now(),
      clientRequestId
    }
    this.messages.push(message)
    this.emit({
      type: 'message.created',
      roomId,
      payload: { message: clone(message) }
    })
    await this.persist()
    return clone(message)
  }

  private async initialize(): Promise<void> {
    const result = await this.store.read()
    if (result.kind === 'ok') {
      this.hydrate(result.data)
      if (this.rooms.length === 0) {
        await this.seedDefaultRoom()
      }
      return
    }
    if (result.kind === 'corrupt') {
      this.recovery = {
        message:
          'The previous save could not be read. It was copied aside so nothing was destroyed. A fresh room was created.',
        backupPath: result.backupPath
      }
    }
    await this.seedDefaultRoom()
  }

  private hydrate(state: PersistedState): void {
    this.rooms = state.rooms
    this.agents = state.agents
    this.messages = state.messages
    this.events = state.events
    this.selectedRoomId = state.selectedRoomId
    this.lastSeq = state.lastSeq
  }

  private async seedDefaultRoom(): Promise<void> {
    const room = this.buildRoom('New project', '')
    this.rooms = [room]
    this.selectedRoomId = room.id
    this.emit({
      type: 'room.created',
      roomId: room.id,
      payload: { room: clone(room) }
    })
    await this.addAgent({ roomId: room.id, presetId: 'maya' })
  }

  private buildRoom(name: string | undefined, description: string | undefined): Room {
    const timestamp = now()
    return {
      id: randomUUID(),
      name: normalizeName(name ?? 'New room'),
      description: normalizeDescription(description ?? ''),
      createdAt: timestamp,
      updatedAt: timestamp,
      workspace: { focus: { type: 'team' }, tab: 'overview' }
    }
  }

  private requireRoom(id: string): Room {
    const room = this.rooms.find((item) => item.id === id)
    if (!room) {
      throw new HuddleError('room_not_found', 'That room does not exist.')
    }
    return room
  }

  private agentsFor(roomId: string): Agent[] {
    return this.agents.filter((agent) => agent.roomId === roomId)
  }

  private emit(
    event: Omit<RuntimeEvent, 'id' | 'seq' | 'createdAt'> & { type: RuntimeEvent['type'] }
  ): void {
    this.lastSeq += 1
    const full = {
      ...event,
      id: randomUUID(),
      seq: this.lastSeq,
      createdAt: now()
    } as RuntimeEvent
    this.events.push(full)
    if (this.events.length > MAX_EVENT_HISTORY) {
      this.events.splice(0, this.events.length - MAX_EVENT_HISTORY)
    }
    for (const listener of this.listeners) {
      listener(clone(full))
    }
  }

  private persist(): Promise<void> {
    const snapshot: PersistedState = {
      version: STATE_VERSION,
      rooms: this.rooms,
      agents: this.agents,
      messages: this.messages,
      selectedRoomId: this.selectedRoomId,
      events: this.events,
      lastSeq: this.lastSeq
    }
    this.writeChain = this.writeChain
      .then(() => this.store.write(snapshot))
      .catch((error) => {
        this.writeChain = Promise.resolve()
        throw error
      })
    return this.writeChain
  }
}

function now(): string {
  return new Date().toISOString()
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HuddleError('invalid_argument', `${field} is required.`)
  }
  return value.trim()
}

function normalizeName(value: string): string {
  const name = value.trim()
  if (!name) {
    throw new HuddleError('invalid_argument', 'Room name cannot be empty.')
  }
  if (name.length > MAX_ROOM_NAME) {
    throw new HuddleError('invalid_argument', `Room name must be ${MAX_ROOM_NAME} characters or fewer.`)
  }
  return name
}

function normalizeDescription(value: string): string {
  const description = value.trim()
  if (description.length > MAX_ROOM_DESCRIPTION) {
    throw new HuddleError(
      'invalid_argument',
      `Description must be ${MAX_ROOM_DESCRIPTION} characters or fewer.`
    )
  }
  return description
}

function normalizeMessage(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HuddleError('invalid_argument', 'Message body is required.')
  }
  const body = value.trim()
  if (!body) {
    throw new HuddleError('invalid_argument', 'Message cannot be empty.')
  }
  if (body.length > MAX_MESSAGE_BODY) {
    throw new HuddleError(
      'invalid_argument',
      `Message must be ${MAX_MESSAGE_BODY} characters or fewer.`
    )
  }
  return body
}

function validateWorkspace(workspace: WorkspaceSelection, agents: Agent[]): WorkspaceSelection {
  if (workspace.tab !== 'overview' && workspace.tab !== 'browser' && workspace.tab !== 'code' && workspace.tab !== 'terminal' && workspace.tab !== 'files') {
    throw new HuddleError('invalid_argument', 'Unknown workspace tab.')
  }
  if (workspace.focus.type === 'team') {
    return { focus: { type: 'team' }, tab: workspace.tab }
  }
  if (workspace.focus.type !== 'agent') {
    throw new HuddleError('invalid_argument', 'Unknown workspace focus.')
  }
  const agentId = workspace.focus.agentId
  if (typeof agentId !== 'string') {
    throw new HuddleError('invalid_argument', 'Unknown workspace focus.')
  }
  if (!agents.some((agent) => agent.id === agentId)) {
    throw new HuddleError('invalid_argument', 'That agent is not in this room.')
  }
  return {
    focus: { type: 'agent', agentId },
    tab: workspace.tab
  }
}
