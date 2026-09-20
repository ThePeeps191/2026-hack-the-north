import { AGENT_PRESETS, getAgentPreset, reconcilePersona } from '../shared/presets.ts'
import {
  DEFAULT_SETTINGS,
  MAX_ROOM_GOAL,
  MAX_ROOM_NAME,
  STATE_VERSION,
  type Agent,
  type AgentRole,
  type AgentSpeechState,
  type AgentVoice,
  type AgentWorkState,
  type AppSettings,
  type Artifact,
  type BrowserSessionRecord,
  type Decision,
  type IntegrationAttempt,
  type JobRecord,
  type MemoryEntry,
  type Message,
  type MessageAuthor,
  type MessageKind,
  type PersistedState,
  type ProjectBinding,
  type Room,
  type ShareSurface,
  type SpokenState,
  type StageState,
  type Task,
  type ToolRun,
  type WorkspaceRecord
} from '../shared/types.ts'

/**
 * Schema migration and nested validation.
 *
 * A snapshot written by an older supported version is *migrated*. Only a file
 * we cannot read at all counts as corruption. Records that are individually
 * malformed are repaired with defaults or dropped, and dropping one record
 * never invalidates the rest of the file.
 */

export type MigrationOutcome =
  | { ok: true; state: PersistedState; fromVersion: number; notes: string[] }
  | { ok: false; reason: string }

const SUPPORTED_VERSIONS = [1, 2]

export function migrateToCurrent(parsed: unknown): MigrationOutcome {
  if (!isRecord(parsed)) {
    return { ok: false, reason: 'State file is not a JSON object.' }
  }

  const version = typeof parsed.version === 'number' ? parsed.version : null
  if (version === null) {
    return { ok: false, reason: 'State file has no schema version.' }
  }
  if (!SUPPORTED_VERSIONS.includes(version)) {
    return {
      ok: false,
      reason:
        version > STATE_VERSION
          ? `State file was written by a newer version of Huddle (schema v${version}).`
          : `Schema v${version} is not supported.`
    }
  }
  if (!Array.isArray(parsed.rooms)) {
    return { ok: false, reason: 'State file has no rooms array.' }
  }

  const notes: string[] = []
  const state = version === 1 ? fromV1(parsed, notes) : fromV2(parsed, notes)
  return { ok: true, state, fromVersion: version, notes }
}

/* ------------------------------------------------------------------ *
 * v1 -> v2
 * ------------------------------------------------------------------ */

function fromV1(raw: Record<string, unknown>, notes: string[]): PersistedState {
  const now = new Date().toISOString()

  const rooms: Room[] = asArray(raw.rooms)
    .filter(isRecord)
    .map((room): Room | null => {
      const id = str(room.id)
      if (!id) return null
      const migrated: Room = {
        id,
        name: clamp(str(room.name) || 'Room', MAX_ROOM_NAME),
        // v1 called this `description`; it was used as the project goal.
        goal: clamp(str(room.description), MAX_ROOM_GOAL),
        createdAt: str(room.createdAt) || now,
        updatedAt: str(room.updatedAt) || now,
        // v1's workspace tab selection is presentation, not state: a migrated
        // room opens on the gallery with Follow on, like a fresh room.
        stage: { mode: { kind: 'gallery' }, follow: true, pendingHint: null },
        project: null,
        joined: false,
        decisionRevision: 0
      }
      return migrated
    })
    .filter((room): room is Room => room !== null)

  const agents: Agent[] = asArray(raw.agents)
    .filter(isRecord)
    .map((agent) => normalizeAgent(agent, now))
    .filter((agent): agent is Agent => agent !== null)

  const messages: Message[] = asArray(raw.messages)
    .filter(isRecord)
    .map((message) => normalizeMessage(message, now))
    .filter((message): message is Message => message !== null)

  if (rooms.length > 0) notes.push(`Migrated ${rooms.length} room(s) from schema v1.`)
  if (messages.length > 0) notes.push(`Preserved ${messages.length} message(s).`)

  return {
    version: STATE_VERSION,
    rooms,
    agents,
    messages,
    tasks: [],
    decisions: [],
    toolRuns: [],
    jobs: [],
    browserSessions: [],
    artifacts: [],
    workspaces: [],
    integrations: [],
    memories: [],
    settings: normalizeSettings(raw.settings),
    selectedRoomId: pickSelected(str(raw.selectedRoomId), rooms),
    lastSeq: num(raw.lastSeq, 0)
  }
}

/* ------------------------------------------------------------------ *
 * v2 validation (repairs rather than rejects)
 * ------------------------------------------------------------------ */

function fromV2(raw: Record<string, unknown>, notes: string[]): PersistedState {
  const now = new Date().toISOString()

  const rooms = asArray(raw.rooms)
    .filter(isRecord)
    .map((room) => normalizeRoom(room, now))
    .filter((room): room is Room => room !== null)

  const roomIds = new Set(rooms.map((room) => room.id))
  const keep = <T extends { roomId: string }>(items: T[]): T[] =>
    items.filter((item) => roomIds.has(item.roomId))

  const agents = keep(
    asArray(raw.agents)
      .filter(isRecord)
      .map((agent) => normalizeAgent(agent, now))
      .filter((agent): agent is Agent => agent !== null)
  )
  const messages = keep(
    asArray(raw.messages)
      .filter(isRecord)
      .map((message) => normalizeMessage(message, now))
      .filter((message): message is Message => message !== null)
  )

  const dropped =
    asArray(raw.rooms).length - rooms.length + (asArray(raw.agents).length - agents.length)
  if (dropped > 0) notes.push(`Dropped ${dropped} malformed record(s) while loading.`)

  return {
    version: STATE_VERSION,
    rooms,
    agents,
    messages,
    tasks: keep(passthrough<Task>(raw.tasks)),
    decisions: keep(passthrough<Decision>(raw.decisions)),
    toolRuns: keep(passthrough<ToolRun>(raw.toolRuns)),
    jobs: keep(passthrough<JobRecord>(raw.jobs)).map(reconcileJobOnLoad),
    browserSessions: keep(passthrough<BrowserSessionRecord>(raw.browserSessions)).map(
      reconcileBrowserOnLoad
    ),
    artifacts: keep(passthrough<Artifact>(raw.artifacts)),
    workspaces: keep(passthrough<WorkspaceRecord>(raw.workspaces)),
    integrations: keep(passthrough<IntegrationAttempt>(raw.integrations)),
    memories: keep(passthrough<MemoryEntry>(raw.memories)),
    settings: normalizeSettings(raw.settings),
    selectedRoomId: pickSelected(str(raw.selectedRoomId), rooms),
    lastSeq: num(raw.lastSeq, 0)
  }
}

/**
 * A stored `running` flag is not proof the process survived the restart. The
 * execution host probes for real during reconcile; until then the honest value
 * is `unknown`.
 */
function reconcileJobOnLoad(job: JobRecord): JobRecord {
  if (job.status === 'running' || job.status === 'starting') {
    return { ...job, status: 'unknown' }
  }
  return job
}

function reconcileBrowserOnLoad(session: BrowserSessionRecord): BrowserSessionRecord {
  if (session.status === 'live' || session.status === 'starting') {
    return {
      ...session,
      status: 'closed',
      detail: 'Session ended when Huddle restarted. Open a new one to continue.',
      endedAt: session.endedAt ?? new Date().toISOString()
    }
  }
  return session
}

/* ------------------------------------------------------------------ *
 * Record normalizers
 * ------------------------------------------------------------------ */

export function normalizeRoom(raw: Record<string, unknown>, now: string): Room | null {
  const id = str(raw.id)
  if (!id) return null
  return {
    id,
    name: clamp(str(raw.name) || 'Room', MAX_ROOM_NAME),
    goal: clamp(str(raw.goal) || str(raw.description), MAX_ROOM_GOAL),
    createdAt: str(raw.createdAt) || now,
    updatedAt: str(raw.updatedAt) || now,
    stage: normalizeStage(raw.stage),
    project: normalizeProject(raw.project),
    // A restart never inherits a joined call.
    joined: false,
    decisionRevision: num(raw.decisionRevision, 0)
  }
}

function toSurface(value: unknown): ShareSurface | null {
  const surface = str(value)
  return surface === 'browser' || surface === 'code' || surface === 'terminal' || surface === 'files'
    ? surface
    : null
}

export function normalizeStage(raw: unknown): StageState {
  const fallback: StageState = { mode: { kind: 'gallery' }, follow: true, pendingHint: null }
  if (!isRecord(raw)) return fallback
  const follow = bool(raw.follow, true)
  const mode = raw.mode
  if (!isRecord(mode)) return { ...fallback, follow }
  const surface = toSurface(mode.surface) ?? 'code'

  if (mode.kind === 'share' && isRecord(mode.owner)) {
    const owner = mode.owner
    if (owner.kind === 'team') {
      return { mode: { kind: 'share', owner: { kind: 'team' }, surface }, follow, pendingHint: null }
    }
    const agentId = str(owner.agentId)
    if (agentId) {
      return {
        mode: { kind: 'share', owner: { kind: 'agent', agentId }, surface },
        follow,
        pendingHint: null
      }
    }
  }
  if (mode.kind === 'spotlight') {
    const agentId = str(mode.agentId)
    if (agentId) return { mode: { kind: 'spotlight', agentId, surface }, follow, pendingHint: null }
  }
  return { mode: { kind: 'gallery' }, follow, pendingHint: null }
}

function normalizeProject(raw: unknown): ProjectBinding | null {
  if (!isRecord(raw)) return null
  const rootPath = str(raw.rootPath)
  if (!rootPath) return null
  const binding: ProjectBinding = {
    rootPath,
    kind: raw.kind === 'demo' ? 'demo' : 'existing',
    isGitRepo: bool(raw.isGitRepo, false),
    hadDirtyWorkOnBind: bool(raw.hadDirtyWorkOnBind, false),
    boundAt: str(raw.boundAt) || new Date().toISOString()
  }
  const template = str(raw.demoTemplate)
  if (template) binding.demoTemplate = template
  return binding
}

const ROLES: AgentRole[] = ['frontend', 'systems', 'qa', 'research', 'design', 'general']

export function normalizeAgent(raw: Record<string, unknown>, now: string): Agent | null {
  const id = str(raw.id)
  const roomId = str(raw.roomId)
  if (!id || !roomId) return null

  const preset = getAgentPreset(str(raw.presetId)) ?? AGENT_PRESETS[0]
  const roleRaw = str(raw.role) as AgentRole
  const name = str(raw.name) || preset.name
  // State written by an earlier build stored a persona whose name had nothing to
  // do with the name on the tile, so a teammate called Sam introduced itself as
  // Maya. Repair that here; a hand-written persona is left exactly as it is.
  const persona = reconcilePersona(preset.id, name, str(raw.persona))

  return {
    id,
    roomId,
    presetId: preset.id,
    name,
    title: str(raw.title),
    role: ROLES.includes(roleRaw) ? roleRaw : preset.role,
    summary: str(raw.summary) || preset.summary,
    persona,
    color: str(raw.color) || preset.color,
    avatar: str(raw.avatar) || preset.avatar,
    voice: normalizeVoice(raw.voice, preset.voice),
    model: str(raw.model) || DEFAULT_SETTINGS.models.contributor,
    // v1 stored 'not_connected' for both states. Either way nothing is running
    // after a restart, so the only honest value is offline/silent until the
    // runtime attaches to this room.
    workState: 'offline' satisfies AgentWorkState,
    speechState: 'silent' satisfies AgentSpeechState,
    activityLabel: 'Not connected',
    connected: false,
    workspaceId: str(raw.workspaceId) || null,
    browserSessionId: null,
    createdAt: str(raw.createdAt) || now,
    updatedAt: str(raw.updatedAt) || now
  }
}

function normalizeVoice(raw: unknown, fallback: AgentVoice): AgentVoice {
  if (!isRecord(raw)) return { ...fallback }
  return {
    voiceId: str(raw.voiceId) || fallback.voiceId,
    voiceName: str(raw.voiceName) || fallback.voiceName,
    speed: clampNumber(num(raw.speed, fallback.speed), 0.7, 1.2),
    stability: clampNumber(num(raw.stability, fallback.stability), 0, 1),
    similarityBoost: clampNumber(num(raw.similarityBoost, fallback.similarityBoost), 0, 1)
  }
}

const MESSAGE_KINDS: MessageKind[] = [
  'chat',
  'question',
  'answer',
  'handoff',
  'decision',
  'result',
  'system'
]

const SPOKEN_STATES: SpokenState[] = [
  'queued',
  'speaking',
  'played',
  'interrupted',
  'unheard',
  'cancelled'
]

export function normalizeMessage(raw: Record<string, unknown>, now: string): Message | null {
  const id = str(raw.id)
  const roomId = str(raw.roomId)
  if (!id || !roomId) return null

  const author = normalizeAuthor(raw.author)
  const kindRaw = str(raw.kind) as MessageKind
  const message: Message = {
    id,
    roomId,
    author,
    body: str(raw.body),
    createdAt: str(raw.createdAt) || now,
    clientRequestId: str(raw.clientRequestId) || id,
    kind: MESSAGE_KINDS.includes(kindRaw) ? kindRaw : author.type === 'system' ? 'system' : 'chat',
    to: asArray(raw.to).map(str).filter(Boolean)
  }

  const replyToId = str(raw.replyToId)
  if (replyToId) message.replyToId = replyToId
  const utteranceId = str(raw.utteranceId)
  if (utteranceId) message.utteranceId = utteranceId

  if (isRecord(raw.spoken)) {
    const stateRaw = str(raw.spoken.state) as SpokenState
    message.spoken = {
      generationId: str(raw.spoken.generationId),
      // Speech that was mid-flight when we shut down was certainly not played.
      state: SPOKEN_STATES.includes(stateRaw)
        ? stateRaw === 'queued' || stateRaw === 'speaking'
          ? 'cancelled'
          : stateRaw
        : 'cancelled',
      playedChars: typeof raw.spoken.playedChars === 'number' ? raw.spoken.playedChars : null
    }
  }
  if (Array.isArray(raw.refs)) {
    message.refs = raw.refs.filter(isRecord) as unknown as Message['refs']
  }
  if (typeof raw.decisionRevision === 'number') message.decisionRevision = raw.decisionRevision
  if (isRecord(raw.private) && str(raw.private.agentId)) {
    message.private = { agentId: str(raw.private.agentId) }
  }
  return message
}

function normalizeAuthor(raw: unknown): MessageAuthor {
  if (isRecord(raw)) {
    if (raw.type === 'agent' && str(raw.agentId)) return { type: 'agent', agentId: str(raw.agentId) }
    if (raw.type === 'system') return { type: 'system' }
  }
  return { type: 'human' }
}

export function normalizeSettings(raw: unknown): AppSettings {
  const base = structuredClone(DEFAULT_SETTINGS)
  if (!isRecord(raw)) return base

  if (isRecord(raw.models)) {
    base.models.contributor = str(raw.models.contributor) || base.models.contributor
    base.models.conversation = str(raw.models.conversation) || base.models.conversation
  }
  if (isRecord(raw.voice)) {
    base.voice.enabled = bool(raw.voice.enabled, base.voice.enabled)
    base.voice.inputDeviceId = str(raw.voice.inputDeviceId) || null
    base.voice.outputDeviceId = str(raw.voice.outputDeviceId) || null
    base.voice.whisperModel = str(raw.voice.whisperModel) || base.voice.whisperModel
    base.voice.endpointSilenceMs = clampNumber(
      num(raw.voice.endpointSilenceMs, base.voice.endpointSilenceMs),
      200,
      3000
    )
    base.voice.bargeInThreshold = clampNumber(
      num(raw.voice.bargeInThreshold, base.voice.bargeInThreshold),
      0.2,
      0.98
    )
    base.voice.saveRawAudio = bool(raw.voice.saveRawAudio, false)
  }
  if (isRecord(raw.preview)) {
    const mode = str(raw.preview.mode)
    base.preview.mode = mode === 'lan' || mode === 'off' ? mode : 'tunnel'
    base.preview.lanHost = str(raw.preview.lanHost) || null
  }
  base.browserbaseEnabled = bool(raw.browserbaseEnabled, base.browserbaseEnabled)
  if (isRecord(raw.limits)) {
    base.limits.maxConcurrentBuilds = clampNumber(
      num(raw.limits.maxConcurrentBuilds, base.limits.maxConcurrentBuilds),
      1,
      4
    )
    base.limits.maxConcurrentToolCalls = clampNumber(
      num(raw.limits.maxConcurrentToolCalls, base.limits.maxConcurrentToolCalls),
      1,
      12
    )
    base.limits.maxModelTurnsPerTask = clampNumber(
      num(raw.limits.maxModelTurnsPerTask, base.limits.maxModelTurnsPerTask),
      4,
      80
    )
  }
  return base
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Keeps records that at least carry an id and a roomId; the owning module
 *  is responsible for the rest of the shape. */
function passthrough<T extends { id: string; roomId: string }>(raw: unknown): T[] {
  return asArray(raw)
    .filter(isRecord)
    .filter((item) => typeof item.id === 'string' && typeof item.roomId === 'string')
    .map((item) => item as unknown as T)
}

function pickSelected(candidate: string, rooms: Room[]): string | null {
  if (candidate && rooms.some((room) => room.id === candidate)) return candidate
  return rooms[0]?.id ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
