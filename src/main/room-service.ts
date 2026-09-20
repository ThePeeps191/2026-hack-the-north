import { randomUUID } from 'node:crypto'
import {
  AGENT_PRESETS,
  getAgentPreset,
  nameForPreset,
  personaFor,
  presetForIndex,
  reconcilePersona
} from '../shared/presets.ts'
import {
  DEFAULT_SETTINGS,
  EPHEMERAL_EVENT_TYPES,
  MAX_AGENTS_PER_ROOM,
  MAX_EVENT_HISTORY,
  MAX_MESSAGE_BODY,
  MAX_ROOM_GOAL,
  MAX_ROOM_NAME,
  MAX_TOOL_RUNS_RETAINED,
  STATE_VERSION,
  type AddAgentInput,
  type Agent,
  type AppSettings,
  type AppSnapshot,
  type Artifact,
  type BrowserSessionRecord,
  type CallState,
  type Capability,
  type CapabilityId,
  type CreateRoomInput,
  type Decision,
  type IntegrationAttempt,
  type JobRecord,
  type MemoryEntry,
  type Message,
  type MessageAuthor,
  type PersistedState,
  type ProjectBinding,
  type RecoveryInfo,
  type ResumableItem,
  type Room,
  type RuntimeEvent,
  type RuntimeEventBody,
  type SendMessageInput,
  type ShareSurface,
  type StageState,
  type Task,
  type TimingSample,
  type ToolRun,
  type UpdateAgentInput,
  type UpdateRoomInput,
  type WorkspaceRecord
} from '../shared/types.ts'
import type { RecordDecisionInput } from '../shared/api.ts'
import type { HuddleBus } from './contracts.ts'
import { EventLog } from './event-log.ts'
import type { JsonSnapshotStore } from './json-store.ts'
import { HuddleError } from './huddle-error.ts'
import { eventLogPath } from './paths.ts'

/**
 * Backend-owned room state and the `HuddleBus` every other module reports
 * through.
 *
 * Two properties this class exists to guarantee:
 *
 *  - **Durability before announcement.** Anything the human asked for is
 *    written to disk *before* the corresponding event is broadcast, and a
 *    failed write is surfaced rather than silently treated as saved. Modules
 *    that report asynchronously (jobs, tool runs, playback) go through the
 *    synchronous `emit` path with a coalesced write, because they cannot await.
 *  - **Ephemeral events never touch the disk.** Audio levels, model tokens and
 *    job output are broadcast and dropped; they are not state.
 */

export interface RoomServiceOptions {
  store: JsonSnapshotStore
  log: EventLog
  state: PersistedState
  recovery?: RecoveryInfo
  resumable?: ResumableItem[]
}

export interface OpenOptions {
  /** Durable event log. Defaults to the standard Huddle data directory. */
  log?: EventLog
  /** Seed an empty store with the default room and roster. Defaults to true. */
  seed?: boolean
}

type Listener = (event: RuntimeEvent) => void

const EPHEMERAL = new Set<string>(EPHEMERAL_EVENT_TYPES)

export class RoomService implements HuddleBus {
  private readonly store: JsonSnapshotStore
  private readonly log: EventLog
  private state: PersistedState
  private readonly events: RuntimeEvent[] = []
  private readonly listeners = new Set<Listener>()
  private readonly capabilities = new Map<CapabilityId, Capability>()
  private readonly requestIndex = new Map<string, string>()
  private readonly utteranceIndex = new Map<string, string>()

  private call: CallState = freshCall()
  private recovery?: RecoveryInfo
  private resumable: ResumableItem[] = []
  private timings: TimingSample[] = []

  private writeQueue: Promise<void> = Promise.resolve()
  private coalesceTimer: NodeJS.Timeout | null = null
  private dirty = false
  private persistError: string | null = null
  private disposed = false

  constructor(options: RoomServiceOptions) {
    this.store = options.store
    this.log = options.log
    this.state = options.state
    this.recovery = options.recovery
    this.resumable = options.resumable ?? []
    for (const message of this.state.messages) {
      this.requestIndex.set(requestKey(message.roomId, message.clientRequestId), message.id)
      if (message.utteranceId) {
        this.utteranceIndex.set(requestKey(message.roomId, message.utteranceId), message.id)
      }
    }
  }

  /**
   * Read the store and bring up a coherent service.
   *
   * - A missing file is a first launch: the default room and roster are seeded
   *   and written to disk before anything is announced.
   * - A valid older schema is migrated, backed up by the store, and noted.
   * - A corrupt file is preserved beside the original, reported through
   *   `snapshot().recovery`, and the app still starts on a fresh room.
   * - Operations a restart interrupted become resumable items. We never claim
   *   a job, task or session survived, and we never silently re-run it.
   */
  static async open(store: JsonSnapshotStore, options: OpenOptions = {}): Promise<RoomService> {
    const log = options.log ?? new EventLog(eventLogPath())
    const seed = options.seed ?? true
    const read = await store.read()

    let state: PersistedState
    let recovery: RecoveryInfo | undefined
    const startup: Array<{ level: 'info' | 'warn' | 'error'; text: string; fix?: string }> = []

    if (read.kind === 'ok') {
      state = read.data
      if (read.migratedFrom !== null) {
        startup.push({
          level: 'info',
          text: `Room state was upgraded from schema v${read.migratedFrom}. The previous file was kept as a backup.`
        })
      }
    } else if (read.kind === 'corrupt') {
      state = seedState()
      recovery = {
        message: `Huddle could not read the saved room state (${read.reason}). A fresh room was created and the previous file was preserved.`,
        backupPath: read.backupPath ?? store.path()
      }
      startup.push({
        level: 'warn',
        text: 'Saved room state was unreadable, so Huddle started from a fresh room.',
        fix: `The previous file is kept at ${recovery.backupPath}.`
      })
    } else {
      // A missing file is a first launch: seed the default room and roster.
      state = seed ? seedState() : emptyState()
    }

    const service = new RoomService({
      store,
      log,
      state,
      ...(recovery ? { recovery } : {}),
      resumable: buildResumable(state)
    })

    // Anything the UI is about to show must be on disk first.
    if (read.kind !== 'ok') {
      try {
        await service.flush()
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        startup.push({
          level: 'error',
          text: 'Huddle could not write its state file.',
          fix: `Check that the data folder is writable. ${detail}`
        })
      }
    }

    const roomId = state.selectedRoomId ?? ''
    for (const entry of startup) {
      service.notice(roomId, entry.level, entry.text, entry.fix)
    }
    return service
  }

  /* ---------------------------------------------------------------- *
   * Snapshot and subscription
   * ---------------------------------------------------------------- */

  snapshot(): AppSnapshot {
    return {
      ...structuredClone(this.state),
      events: structuredClone(this.events),
      capabilities: [...this.capabilities.values()].map((capability) => ({ ...capability })),
      call: { ...this.call },
      ...(this.recovery ? { recovery: this.recovery } : {}),
      resumable: structuredClone(this.resumable)
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Last durable-write failure, or null. Never hidden from the user. */
  lastPersistError(): string | null {
    return this.persistError
  }

  /* ---------------------------------------------------------------- *
   * HuddleBus
   * ---------------------------------------------------------------- */

  emit(roomId: string, body: RuntimeEventBody): RuntimeEvent {
    const durable = !EPHEMERAL.has(body.type)
    this.state.lastSeq += 1
    const event = {
      id: randomUUID(),
      seq: this.state.lastSeq,
      roomId,
      createdAt: new Date().toISOString(),
      durable,
      ...body
    } as RuntimeEvent

    this.events.push(event)
    if (this.events.length > MAX_EVENT_HISTORY) {
      this.events.splice(0, this.events.length - MAX_EVENT_HISTORY)
    }

    if (durable) {
      this.log.append(event)
      this.scheduleWrite()
    }

    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A broken subscriber must not stop the room.
      }
    }
    return event
  }

  notice(roomId: string, level: 'info' | 'warn' | 'error', text: string, fix?: string): void {
    this.emit(roomId, fix ? { type: 'notice', level, text, fix } : { type: 'notice', level, text })
  }

  upsertJob(job: JobRecord): void {
    upsertById(this.state.jobs, job)
    this.emit(job.roomId, { type: 'job.upserted', job })
  }

  appendJobOutput(job: JobRecord, chunk: string, stream: 'stdout' | 'stderr'): void {
    // Output is a stream, not state: broadcast it, never write it to the snapshot.
    this.emit(job.roomId, { type: 'job.output', jobId: job.id, chunk, stream })
  }

  upsertWorkspace(workspace: WorkspaceRecord): void {
    upsertById(this.state.workspaces, workspace)
    this.emit(workspace.roomId, { type: 'workspace.upserted', workspace })
  }

  upsertBrowserSession(session: BrowserSessionRecord): void {
    upsertById(this.state.browserSessions, session)
    this.emit(session.roomId, { type: 'browser.upserted', session })
  }

  upsertIntegration(attempt: IntegrationAttempt): void {
    upsertById(this.state.integrations, attempt)
    this.emit(attempt.roomId, { type: 'integration.upserted', attempt })
  }

  addArtifact(artifact: Artifact): void {
    upsertById(this.state.artifacts, artifact)
    this.emit(artifact.roomId, { type: 'artifact.created', artifact })
  }

  addMemory(entry: MemoryEntry): void {
    upsertById(this.state.memories, entry)
    this.emit(entry.roomId, { type: 'memory.created', entry })
  }

  recordToolRun(run: ToolRun): void {
    const existing = this.state.toolRuns.findIndex((item) => item.id === run.id)
    if (existing >= 0) {
      this.state.toolRuns[existing] = run
      this.emit(run.roomId, { type: 'toolrun.finished', run })
    } else {
      this.state.toolRuns.push(run)
      if (this.state.toolRuns.length > MAX_TOOL_RUNS_RETAINED) {
        this.state.toolRuns.splice(0, this.state.toolRuns.length - MAX_TOOL_RUNS_RETAINED)
      }
      this.emit(run.roomId, { type: 'toolrun.started', run })
    }
  }

  updateAgent(agentId: string, patch: Partial<Agent>): Agent | null {
    const agent = this.state.agents.find((item) => item.id === agentId)
    if (!agent) return null
    Object.assign(agent, patch, { updatedAt: new Date().toISOString() })
    this.emit(agent.roomId, { type: 'agent.updated', agent: { ...agent } })
    return { ...agent }
  }

  upsertAgent(agent: Agent): Agent {
    const existing = this.state.agents.find((item) => item.id === agent.id)
    if (existing) {
      Object.assign(existing, agent)
      this.emit(existing.roomId, { type: 'agent.updated', agent: { ...existing } })
      return { ...existing }
    }
    this.state.agents.push(agent)
    this.emit(agent.roomId, { type: 'agent.added', agent: { ...agent } })
    return { ...agent }
  }

  removeAgentById(agentId: string): boolean {
    const agent = this.state.agents.find((item) => item.id === agentId)
    if (!agent) return false
    this.state.agents = this.state.agents.filter((item) => item.id !== agentId)
    for (const task of this.state.tasks) {
      if (task.ownerAgentId === agentId && !isTerminal(task.status)) {
        task.ownerAgentId = null
        task.status = 'proposed'
        task.blockedReason = `${agent.name} left the room; this task needs a new owner.`
        task.updatedAt = this.now()
        this.emit(agent.roomId, { type: 'task.upserted', task })
      }
    }
    this.emit(agent.roomId, { type: 'agent.removed', agentId })
    return true
  }

  upsertTask(task: Task): void {
    upsertById(this.state.tasks, task)
    this.emit(task.roomId, { type: 'task.upserted', task })
  }

  recordTimings(samples: TimingSample[]): void {
    for (const sample of samples) {
      this.timings.push(sample)
      const roomId = this.call.roomId ?? this.state.selectedRoomId ?? ''
      if (roomId) this.emit(roomId, { type: 'voice.timing', sample })
    }
    if (this.timings.length > 400) this.timings.splice(0, this.timings.length - 400)
  }

  getTimings(): TimingSample[] {
    return [...this.timings]
  }

  setAgentActivity(agentId: string, workState: Agent['workState'], label: string): void {
    const agent = this.state.agents.find((item) => item.id === agentId)
    if (!agent) return
    if (agent.workState === workState && agent.activityLabel === label) return
    agent.workState = workState
    agent.activityLabel = label
    agent.updatedAt = new Date().toISOString()
    this.emit(agent.roomId, { type: 'agent.updated', agent: { ...agent } })
  }

  setAgentSpeech(agentId: string, speechState: Agent['speechState']): void {
    const agent = this.state.agents.find((item) => item.id === agentId)
    if (!agent || agent.speechState === speechState) return
    agent.speechState = speechState
    agent.updatedAt = new Date().toISOString()
    this.emit(agent.roomId, { type: 'agent.updated', agent: { ...agent } })
  }

  /**
   * An agent reached a phase worth showing. In Follow mode the stage moves; in
   * Pin mode we only record a hint so the user keeps control. Routine tool
   * events must not call this -- only meaningful phase changes.
   */
  proposeStage(roomId: string, agentId: string, surface: ShareSurface): void {
    const room = this.state.rooms.find((item) => item.id === roomId)
    if (!room) return
    const at = new Date().toISOString()

    if (!room.stage.follow) {
      room.stage.pendingHint = { agentId, surface, at }
      room.updatedAt = at
      this.emit(roomId, { type: 'room.updated', room: structuredClone(room) })
      return
    }

    // Do not yank the user out of a one-on-one they opened themselves.
    if (room.stage.mode.kind === 'spotlight' && room.stage.mode.agentId !== agentId) {
      room.stage.pendingHint = { agentId, surface, at }
      room.updatedAt = at
      this.emit(roomId, { type: 'room.updated', room: structuredClone(room) })
      return
    }

    const nextMode: StageState['mode'] =
      room.stage.mode.kind === 'spotlight'
        ? { kind: 'spotlight', agentId, surface }
        : { kind: 'share', owner: { kind: 'agent', agentId }, surface }

    if (sameMode(room.stage.mode, nextMode)) return
    room.stage = { mode: nextMode, follow: true, pendingHint: null }
    room.updatedAt = at
    this.emit(roomId, { type: 'room.updated', room: structuredClone(room) })
  }

  getRoom(roomId: string): Room | null {
    const room = this.state.rooms.find((item) => item.id === roomId)
    return room ? structuredClone(room) : null
  }

  getAgent(agentId: string): Agent | null {
    const agent = this.state.agents.find((item) => item.id === agentId)
    return agent ? { ...agent } : null
  }

  getAgents(roomId: string): Agent[] {
    return this.state.agents.filter((agent) => agent.roomId === roomId).map((agent) => ({ ...agent }))
  }

  getTasks(roomId: string): Task[] {
    return structuredClone(this.state.tasks.filter((task) => task.roomId === roomId))
  }

  getTask(taskId: string): Task | null {
    const task = this.state.tasks.find((item) => item.id === taskId)
    return task ? structuredClone(task) : null
  }

  getActiveDecisions(roomId: string): Decision[] {
    return structuredClone(
      this.state.decisions.filter(
        (decision) => decision.roomId === roomId && decision.status === 'active'
      )
    )
  }

  getDecisions(roomId: string): Decision[] {
    return structuredClone(this.state.decisions.filter((decision) => decision.roomId === roomId))
  }

  getMessages(roomId: string, limit = 60): Message[] {
    const all = this.state.messages.filter((message) => message.roomId === roomId)
    return structuredClone(all.slice(Math.max(0, all.length - limit)))
  }

  getMemories(roomId: string): MemoryEntry[] {
    return structuredClone(this.state.memories.filter((entry) => entry.roomId === roomId))
  }

  getWorkspaces(roomId: string): WorkspaceRecord[] {
    return structuredClone(this.state.workspaces.filter((item) => item.roomId === roomId))
  }

  getJobs(roomId: string): JobRecord[] {
    return structuredClone(this.state.jobs.filter((item) => item.roomId === roomId))
  }

  getBrowserSessions(roomId: string): BrowserSessionRecord[] {
    return structuredClone(this.state.browserSessions.filter((item) => item.roomId === roomId))
  }

  getArtifacts(roomId: string): Artifact[] {
    return structuredClone(this.state.artifacts.filter((item) => item.roomId === roomId))
  }

  getToolRuns(roomId: string): ToolRun[] {
    return structuredClone(this.state.toolRuns.filter((item) => item.roomId === roomId))
  }

  getIntegrations(roomId: string): IntegrationAttempt[] {
    return structuredClone(this.state.integrations.filter((item) => item.roomId === roomId))
  }

  getSettings(): AppSettings {
    return structuredClone(this.state.settings)
  }

  newId(): string {
    return randomUUID()
  }

  now(): string {
    return new Date().toISOString()
  }

  /* ---------------------------------------------------------------- *
   * Rooms
   * ---------------------------------------------------------------- */

  async createRoom(input: CreateRoomInput = {}): Promise<Room> {
    const now = this.now()
    const room: Room = {
      id: this.newId(),
      name: clampText(input.name?.trim() || defaultRoomName(this.state.rooms.length), MAX_ROOM_NAME),
      goal: clampText(input.goal?.trim() ?? '', MAX_ROOM_GOAL),
      createdAt: now,
      updatedAt: now,
      /*
       * A new room opens on the gallery and stays there.
       *
       * Follow mode used to be on from the first second, so the first teammate
       * to reach a phase worth showing yanked the stage into its own workspace
       * before anybody had looked at the room. What you actually saw after
       * creating a room was one agent's empty file browser ("Select a file to
       * view it") instead of three teammates working. The gallery is the
       * overview; following a single teammate is a choice the human makes, and
       * the header's Follow toggle makes it one click away. Proposals raised
       * before then are still recorded as a hint, so nothing is lost.
       */
      stage: { mode: { kind: 'gallery' }, follow: false, pendingHint: null },
      project: null,
      joined: false,
      decisionRevision: 0
    }

    const count = clampAgentCount(input.agentCount)
    const agents: Agent[] = []
    const names: string[] = []
    // A roster chosen from the goal, when the caller worked one out. Otherwise
    // the fixed preset order, which assumes the room is a software project.
    const roster = input.presetIds ?? []
    for (let index = 0; index < count; index += 1) {
      const preset = getAgentPreset(roster[index] ?? '') ?? presetForIndex(index)
      // The name is decided before the agent exists, so the persona is generated
      // from that exact name. A teammate can never be told it is somebody other
      // than the name on its own tile.
      const name = nameForPreset(preset, names)
      names.push(name)
      agents.push(buildAgent(room.id, preset.id, this.newId(), now, name))
    }

    await this.commit(() => {
      this.state.rooms.push(room)
      this.state.agents.push(...agents)
      this.state.selectedRoomId = room.id
    })

    this.emit(room.id, { type: 'room.created', room: structuredClone(room) })
    for (const agent of agents) this.emit(room.id, { type: 'agent.added', agent: { ...agent } })
    this.emit(room.id, { type: 'room.selected', selectedRoomId: room.id })
    return structuredClone(room)
  }

  async updateRoom(input: UpdateRoomInput): Promise<Room> {
    const room = this.requireRoom(input.id)
    const next: Room = { ...structuredClone(room), updatedAt: this.now() }
    if (input.name !== undefined) next.name = clampText(input.name.trim() || room.name, MAX_ROOM_NAME)
    if (input.goal !== undefined) next.goal = clampText(input.goal, MAX_ROOM_GOAL)
    if (input.stage !== undefined) next.stage = input.stage

    await this.commit(() => {
      replaceById(this.state.rooms, next)
    })
    this.emit(next.id, { type: 'room.updated', room: structuredClone(next) })
    return structuredClone(next)
  }

  async setStage(roomId: string, stage: StageState): Promise<Room> {
    return this.updateRoom({ id: roomId, stage })
  }

  async selectRoom(roomId: string): Promise<void> {
    this.requireRoom(roomId)
    if (this.state.selectedRoomId === roomId) return
    await this.commit(() => {
      this.state.selectedRoomId = roomId
    })
    this.emit(roomId, { type: 'room.selected', selectedRoomId: roomId })
  }

  async removeRoom(roomId: string): Promise<void> {
    this.requireRoom(roomId)
    await this.commit(() => {
      this.state.rooms = this.state.rooms.filter((room) => room.id !== roomId)
      this.state.agents = this.state.agents.filter((agent) => agent.roomId !== roomId)
      this.state.messages = this.state.messages.filter((message) => message.roomId !== roomId)
      this.state.tasks = this.state.tasks.filter((task) => task.roomId !== roomId)
      this.state.decisions = this.state.decisions.filter((item) => item.roomId !== roomId)
      this.state.toolRuns = this.state.toolRuns.filter((item) => item.roomId !== roomId)
      this.state.jobs = this.state.jobs.filter((item) => item.roomId !== roomId)
      this.state.browserSessions = this.state.browserSessions.filter((item) => item.roomId !== roomId)
      this.state.artifacts = this.state.artifacts.filter((item) => item.roomId !== roomId)
      this.state.workspaces = this.state.workspaces.filter((item) => item.roomId !== roomId)
      this.state.integrations = this.state.integrations.filter((item) => item.roomId !== roomId)
      this.state.memories = this.state.memories.filter((item) => item.roomId !== roomId)
      if (this.state.selectedRoomId === roomId) {
        this.state.selectedRoomId = this.state.rooms[0]?.id ?? null
      }
    })
    this.emit(roomId, { type: 'room.removed', removedRoomId: roomId })
    if (this.state.selectedRoomId) {
      this.emit(this.state.selectedRoomId, {
        type: 'room.selected',
        selectedRoomId: this.state.selectedRoomId
      })
    }
  }

  async bindProject(roomId: string, binding: ProjectBinding): Promise<Room> {
    const room = this.requireRoom(roomId)
    const next: Room = { ...structuredClone(room), project: binding, updatedAt: this.now() }
    await this.commit(() => {
      replaceById(this.state.rooms, next)
    })
    this.emit(roomId, { type: 'room.updated', room: structuredClone(next) })
    return structuredClone(next)
  }

  /* ---------------------------------------------------------------- *
   * Call presence (ephemeral; never persisted)
   * ---------------------------------------------------------------- */

  getCall(): CallState {
    return { ...this.call }
  }

  patchCall(patch: Partial<CallState>): CallState {
    const previousRoomId = this.call.roomId
    const next = { ...this.call, ...patch }
    const changed = (Object.keys(patch) as Array<keyof CallState>).some(
      (key) => this.call[key] !== next[key]
    )
    this.call = next
    // Leaving a call clears the room id, so the event must be sent to the room
    // we were in: otherwise the renderer keeps showing a call that has ended.
    const target = next.roomId ?? previousRoomId
    if (changed && target) this.emit(target, { type: 'call.updated', call: { ...next } })
    return { ...this.call }
  }

  async setJoined(roomId: string, joined: boolean): Promise<Room> {
    const room = this.requireRoom(roomId)
    const next: Room = { ...structuredClone(room), joined, updatedAt: this.now() }
    await this.commit(() => {
      for (const other of this.state.rooms) {
        // Exactly one audible room at a time.
        if (other.id !== roomId) other.joined = false
      }
      replaceById(this.state.rooms, next)
    })
    this.emit(roomId, { type: 'room.updated', room: structuredClone(next) })
    return structuredClone(next)
  }

  /* ---------------------------------------------------------------- *
   * Agents
   * ---------------------------------------------------------------- */

  async addAgent(input: AddAgentInput): Promise<Agent> {
    this.requireRoom(input.roomId)
    const existing = this.state.agents.filter((agent) => agent.roomId === input.roomId)
    if (existing.length >= MAX_AGENTS_PER_ROOM) {
      throw new HuddleError(
        'agent_limit',
        `A room holds at most ${MAX_AGENTS_PER_ROOM} teammates.`,
        'Remove a teammate before adding another.'
      )
    }
    const preset = getAgentPreset(input.presetId)
    if (!preset) {
      throw new HuddleError('unknown_preset', `No teammate preset named "${input.presetId}".`)
    }

    const taken = existing.map((item) => item.name)
    const name = input.name?.trim().slice(0, 40) || nameForPreset(preset, taken)
    const agent = buildAgent(input.roomId, preset.id, this.newId(), this.now(), name)
    if (input.role) agent.role = input.role
    if (input.voiceId) agent.voice = { ...agent.voice, voiceId: input.voiceId }
    agent.model = this.state.settings.models.contributor

    await this.commit(() => {
      this.state.agents.push(agent)
    })
    this.emit(agent.roomId, { type: 'agent.added', agent: { ...agent } })
    return { ...agent }
  }

  async updateAgentSettings(input: UpdateAgentInput): Promise<Agent> {
    const agent = this.state.agents.find((item) => item.id === input.agentId)
    if (!agent) throw new HuddleError('unknown_agent', 'That teammate is no longer in the room.')
    const next: Agent = { ...agent, updatedAt: this.now() }
    if (input.name?.trim()) next.name = input.name.trim().slice(0, 40)
    if (input.title !== undefined) next.title = input.title.trim().slice(0, 48)
    if (input.role) next.role = input.role
    // An explicit persona wins. Otherwise a rename carries the identity with it,
    // so a renamed teammate stops introducing itself by its old name.
    if (input.persona) next.persona = input.persona
    else next.persona = reconcilePersona(next.presetId, next.name, next.persona)
    if (input.model) next.model = input.model
    if (input.voiceId) next.voice = { ...agent.voice, voiceId: input.voiceId }

    await this.commit(() => {
      replaceById(this.state.agents, next)
    })
    this.emit(next.roomId, { type: 'agent.updated', agent: { ...next } })
    return { ...next }
  }

  async removeAgent(agentId: string): Promise<void> {
    const agent = this.state.agents.find((item) => item.id === agentId)
    if (!agent) return
    await this.commit(() => {
      this.state.agents = this.state.agents.filter((item) => item.id !== agentId)
      for (const task of this.state.tasks) {
        if (task.ownerAgentId === agentId && !isTerminal(task.status)) {
          task.ownerAgentId = null
          task.status = 'proposed'
          task.blockedReason = `${agent.name} left the room; this task needs a new owner.`
          task.updatedAt = this.now()
        }
      }
    })
    this.emit(agent.roomId, { type: 'agent.removed', agentId })
    for (const task of this.getTasks(agent.roomId)) {
      if (task.ownerAgentId === null) this.emit(agent.roomId, { type: 'task.upserted', task })
    }
  }

  /* ---------------------------------------------------------------- *
   * Messages
   * ---------------------------------------------------------------- */

  /**
   * Exactly-once by `(roomId, clientRequestId)` and, for voice, additionally by
   * `(roomId, utteranceId)`. A retry of the same request returns the message we
   * already stored instead of creating a duplicate, and the id is scoped to the
   * room so two rooms can never collide.
   */
  async sendHumanMessage(input: SendMessageInput): Promise<Message> {
    this.requireRoom(input.roomId)
    const body = input.body.trim()
    if (!body) throw new HuddleError('empty_message', 'Nothing to send.')

    const existing = this.findDuplicate(input)
    if (existing) return structuredClone(existing)

    const message: Message = {
      id: this.newId(),
      roomId: input.roomId,
      author: { type: 'human' },
      body: body.slice(0, MAX_MESSAGE_BODY),
      createdAt: this.now(),
      clientRequestId: input.clientRequestId,
      kind: input.replyToId ? 'answer' : 'chat',
      to: (input.to ?? []).filter((id) => this.state.agents.some((agent) => agent.id === id))
    }
    if (input.replyToId) message.replyToId = input.replyToId
    if (input.refs?.length) message.refs = input.refs
    if (input.utteranceId) message.utteranceId = input.utteranceId
    if (input.private?.agentId) message.private = { agentId: input.private.agentId }

    await this.commit(() => {
      this.state.messages.push(message)
      this.requestIndex.set(requestKey(message.roomId, message.clientRequestId), message.id)
      if (message.utteranceId) {
        this.utteranceIndex.set(requestKey(message.roomId, message.utteranceId), message.id)
      }
    })
    this.emit(message.roomId, { type: 'message.created', message: structuredClone(message) })
    return structuredClone(message)
  }

  /** Agent and system messages. Emitted immediately; written with the next coalesced flush. */
  addMessage(message: Message): Message {
    upsertById(this.state.messages, message)
    this.requestIndex.set(requestKey(message.roomId, message.clientRequestId), message.id)
    this.emit(message.roomId, { type: 'message.created', message: structuredClone(message) })
    return structuredClone(message)
  }

  updateMessage(messageId: string, patch: Partial<Message>): Message | null {
    const message = this.state.messages.find((item) => item.id === messageId)
    if (!message) return null
    Object.assign(message, patch)
    this.emit(message.roomId, { type: 'message.updated', message: structuredClone(message) })
    return structuredClone(message)
  }

  private findDuplicate(input: SendMessageInput): Message | null {
    const byRequest = this.requestIndex.get(requestKey(input.roomId, input.clientRequestId))
    if (byRequest) {
      return this.state.messages.find((message) => message.id === byRequest) ?? null
    }
    if (input.utteranceId) {
      const byUtterance = this.utteranceIndex.get(requestKey(input.roomId, input.utteranceId))
      if (byUtterance) {
        return this.state.messages.find((message) => message.id === byUtterance) ?? null
      }
    }
    return null
  }

  /* ---------------------------------------------------------------- *
   * Decisions
   * ---------------------------------------------------------------- */

  /**
   * Records a revisioned decision and marks every task planned against an older
   * revision as stale. "Heard" and "applied" stay distinct: this marks the work
   * stale, the runtime is responsible for actually replanning it.
   */
  async recordDecision(input: RecordDecisionInput, source: MessageAuthor): Promise<Decision> {
    const room = this.requireRoom(input.roomId)
    const revision = room.decisionRevision + 1
    const now = this.now()

    const superseded = input.supersedesId
      ? this.state.decisions.find((item) => item.id === input.supersedesId) ?? null
      : null

    const affected = this.state.tasks.filter(
      (task) => task.roomId === room.id && !isTerminal(task.status)
    )

    const decision: Decision = {
      id: this.newId(),
      roomId: room.id,
      revision,
      title: input.title.slice(0, 120),
      statement: input.statement.slice(0, 2000),
      rationale: (input.rationale ?? '').slice(0, 2000),
      source,
      status: 'active',
      supersedesId: superseded?.id ?? null,
      supersededById: null,
      affectedTaskIds: affected.map((task) => task.id),
      originMessageId: input.originMessageId ?? null,
      createdAt: now
    }

    const memory: MemoryEntry = {
      id: this.newId(),
      roomId: room.id,
      kind: 'decision',
      title: decision.title,
      body: decision.statement,
      decisionRevision: revision,
      source,
      createdAt: now,
      supersededById: null
    }

    await this.commit(() => {
      this.state.decisions.push(decision)
      if (superseded) {
        superseded.status = 'superseded'
        superseded.supersededById = decision.id
      }
      const roomRef = this.state.rooms.find((item) => item.id === room.id)
      if (roomRef) {
        roomRef.decisionRevision = revision
        roomRef.updatedAt = now
      }
      for (const task of this.state.tasks) {
        if (task.roomId !== room.id || isTerminal(task.status)) continue
        if (task.decisionRevision < revision) {
          task.staleSince = now
          task.staleReason = `Planned before "${decision.title}" (revision ${revision}).`
          task.updatedAt = now
        }
      }
      this.state.memories.push(memory)
    })

    const affectedAfter = this.getTasks(room.id).filter((task) =>
      decision.affectedTaskIds.includes(task.id)
    )
    this.emit(room.id, { type: 'decision.created', decision: structuredClone(decision), affected: affectedAfter })
    if (superseded) {
      this.emit(room.id, { type: 'decision.updated', decision: structuredClone(superseded) })
    }
    const updatedRoom = this.getRoom(room.id)
    if (updatedRoom) this.emit(room.id, { type: 'room.updated', room: updatedRoom })
    for (const task of affectedAfter) this.emit(room.id, { type: 'task.upserted', task })
    this.emit(room.id, { type: 'memory.created', entry: memory })
    return structuredClone(decision)
  }

  /* ---------------------------------------------------------------- *
   * Settings and capabilities
   * ---------------------------------------------------------------- */

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next: AppSettings = {
      ...structuredClone(this.state.settings),
      ...structuredClone(patch),
      models: { ...this.state.settings.models, ...(patch.models ?? {}) },
      voice: { ...this.state.settings.voice, ...(patch.voice ?? {}) },
      preview: { ...this.state.settings.preview, ...(patch.preview ?? {}) },
      limits: { ...this.state.settings.limits, ...(patch.limits ?? {}) }
    }
    await this.commit(() => {
      this.state.settings = next
    })
    const roomId = this.state.selectedRoomId ?? ''
    if (roomId) this.emit(roomId, { type: 'settings.updated', settings: structuredClone(next) })
    return structuredClone(next)
  }

  setCapability(capability: Capability): void {
    const previous = this.capabilities.get(capability.id)
    this.capabilities.set(capability.id, capability)
    if (
      previous &&
      previous.state === capability.state &&
      previous.detail === capability.detail &&
      previous.fix === capability.fix
    ) {
      return
    }
    const roomId = this.state.selectedRoomId ?? ''
    if (roomId) this.emit(roomId, { type: 'capability.updated', capability: { ...capability } })
  }

  getCapability(id: CapabilityId): Capability {
    return (
      this.capabilities.get(id) ?? {
        id,
        label: id,
        state: 'unavailable',
        detail: 'Not checked yet.',
        fix: null,
        checkedAt: this.now()
      }
    )
  }

  getCapabilities(): Capability[] {
    return [...this.capabilities.values()].map((capability) => ({ ...capability }))
  }

  /* ---------------------------------------------------------------- *
   * Restart reconciliation
   * ---------------------------------------------------------------- */

  setResumable(items: ResumableItem[]): void {
    this.resumable = items
  }

  dismissResumable(itemId: string): void {
    this.resumable = this.resumable.filter((item) => item.id !== itemId)
  }

  getResumable(): ResumableItem[] {
    return structuredClone(this.resumable)
  }

  /* ---------------------------------------------------------------- *
   * Persistence
   * ---------------------------------------------------------------- */

  /**
   * Apply a mutation, write it, and only then let the caller announce it. If
   * the write fails the in-memory state is restored so the UI never shows a
   * change that is not on disk.
   */
  private async commit<T>(mutate: () => T): Promise<T> {
    const rollback = structuredClone(this.state)
    let result: T
    try {
      result = mutate()
    } catch (error) {
      this.state = rollback
      throw error
    }

    try {
      await this.flush()
    } catch (error) {
      this.state = rollback
      this.rebuildIndexes()
      const detail = error instanceof Error ? error.message : String(error)
      this.persistError = detail
      throw new HuddleError(
        'persist_failed',
        'That change could not be saved, so it was rolled back.',
        detail
      )
    }
    this.persistError = null
    return result
  }

  private scheduleWrite(): void {
    if (this.disposed) return
    this.dirty = true
    if (this.coalesceTimer) return
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null
      void this.flush().catch((error) => {
        const detail = error instanceof Error ? error.message : String(error)
        if (this.persistError === detail) return
        this.persistError = detail
        const roomId = this.state.selectedRoomId ?? ''
        if (roomId) {
          this.notice(
            roomId,
            'error',
            'Huddle could not save the latest room state.',
            `Check disk space and permissions for the data folder. ${detail}`
          )
        }
      })
    }, 250)
    this.coalesceTimer.unref?.()
  }

  /** Serialised so two writes never interleave. */
  flush(): Promise<void> {
    const snapshot = structuredClone(this.state)
    snapshot.version = STATE_VERSION
    this.dirty = false
    this.writeQueue = this.writeQueue.then(
      () => this.store.write(snapshot),
      () => this.store.write(snapshot)
    )
    return this.writeQueue
  }

  hasPendingWrite(): boolean {
    return this.dirty
  }

  private rebuildIndexes(): void {
    this.requestIndex.clear()
    this.utteranceIndex.clear()
    for (const message of this.state.messages) {
      this.requestIndex.set(requestKey(message.roomId, message.clientRequestId), message.id)
      if (message.utteranceId) {
        this.utteranceIndex.set(requestKey(message.roomId, message.utteranceId), message.id)
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer)
      this.coalesceTimer = null
    }
    try {
      await this.flush()
    } catch {
      // Reported already; shutting down must not hang on a failing disk.
    }
    await this.log.close()
    this.listeners.clear()
  }

  private requireRoom(roomId: string): Room {
    const room = this.state.rooms.find((item) => item.id === roomId)
    if (!room) throw new HuddleError('unknown_room', 'That room no longer exists.')
    return room
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function emptyState(): PersistedState {
  return {
    version: STATE_VERSION,
    rooms: [],
    agents: [],
    messages: [],
    tasks: [],
    decisions: [],
    toolRuns: [],
    jobs: [],
    browserSessions: [],
    artifacts: [],
    workspaces: [],
    integrations: [],
    memories: [],
    settings: structuredClone(DEFAULT_SETTINGS),
    selectedRoomId: null,
    lastSeq: 0
  }
}

export function buildAgent(
  roomId: string,
  presetId: (typeof AGENT_PRESETS)[number]['id'],
  id: string,
  now: string,
  /** The teammate's real name. Its persona is generated from this, never before it. */
  name?: string
): Agent {
  const preset = getAgentPreset(presetId) ?? AGENT_PRESETS[0]
  const finalName = name?.trim() || preset.name
  return {
    id,
    roomId,
    presetId: preset.id,
    name: finalName,
    title: '',
    role: preset.role,
    summary: preset.summary,
    persona: personaFor(preset.id, finalName),
    color: preset.color,
    avatar: preset.avatar,
    voice: { ...preset.voice },
    model: DEFAULT_SETTINGS.models.contributor,
    workState: 'offline',
    speechState: 'silent',
    activityLabel: 'Not connected',
    connected: false,
    workspaceId: null,
    browserSessionId: null,
    createdAt: now,
    updatedAt: now
  }
}

function freshCall(): CallState {
  return {
    roomId: null,
    connection: 'disconnected',
    micMuted: false,
    deafened: false,
    micLevel: 0,
    listening: false,
    speakingAgentId: null,
    queuedAgentIds: [],
    error: null
  }
}

function requestKey(roomId: string, requestId: string): string {
  return `${roomId}::${requestId}`
}

function defaultRoomName(count: number): string {
  return count === 0 ? 'Build room' : `Room ${count + 1}`
}

function clampText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function upsertById<T extends { id: string }>(list: T[], item: T): void {
  const index = list.findIndex((existing) => existing.id === item.id)
  if (index >= 0) list[index] = item
  else list.push(item)
}

function replaceById<T extends { id: string }>(list: T[], item: T): void {
  const index = list.findIndex((existing) => existing.id === item.id)
  if (index >= 0) list[index] = item
}

function isTerminal(status: Task['status']): boolean {
  return status === 'done' || status === 'cancelled' || status === 'failed'
}

function sameMode(a: StageState['mode'], b: StageState['mode']): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/* ------------------------------------------------------------------ *
 * First launch and restart reconciliation
 * ------------------------------------------------------------------ */

/**
 * A fresh install: one room, the default roster, nothing else invented. The
 * room has no project bound until the human picks a real folder or asks for
 * the demo project, so the team can never silently work on Huddle itself.
 */
export function seedState(): PersistedState {
  return emptyState()
}

function clampAgentCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1
  return Math.min(MAX_AGENTS_PER_ROOM, Math.max(1, Math.round(value)))
}

const MAX_RESUMABLE = 12

/**
 * What a restart interrupted, told honestly. A persisted `running` job is not
 * evidence the process survived, and we never re-run it on the user's behalf.
 */
function buildResumable(state: PersistedState): ResumableItem[] {
  const items: ResumableItem[] = []

  for (const job of state.jobs) {
    if (job.status === 'running' || job.status === 'starting' || job.status === 'unknown') {
      items.push({
        id: job.id,
        roomId: job.roomId,
        kind: 'job',
        title: job.label,
        detail: `\`${job.command}\` was still running when Huddle last exited. Its process state is unverified, so it was not restarted automatically.`,
        state: 'unknown'
      })
    }
  }

  for (const task of state.tasks) {
    if (task.status === 'in_progress' || task.status === 'awaiting_review') {
      items.push({
        id: task.id,
        roomId: task.roomId,
        kind: 'task',
        title: task.title,
        detail: 'This task was mid-flight at shutdown. Its owner can pick it up again, but any partial result should be re-checked.',
        state: 'interrupted'
      })
    }
  }

  for (const attempt of state.integrations) {
    if (attempt.status === 'running') {
      items.push({
        id: attempt.id,
        roomId: attempt.roomId,
        kind: 'integration',
        title: `Integration into ${attempt.targetBranch}`,
        detail: 'The integration was interrupted. The previously verified revision is unchanged.',
        state: 'interrupted'
      })
    }
  }

  return items.slice(0, MAX_RESUMABLE)
}
