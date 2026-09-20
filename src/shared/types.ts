// Huddle shared domain types.
//
// This file is the single contract between main, preload and renderer.
// Owned by the integration lead. Specialists request changes rather than editing it.

export const STATE_VERSION = 2 as const
export type StateVersion = typeof STATE_VERSION

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

export type AgentRole = 'frontend' | 'systems' | 'qa' | 'research' | 'design' | 'general'
export type AgentPresetId = 'maya' | 'alex' | 'sam' | 'rio' | 'nova'

/** Truthful, observable work state. Never inferred from model tokens. */
export type AgentWorkState =
  | 'offline'
  | 'idle'
  | 'thinking'
  | 'reading'
  | 'editing'
  | 'running'
  | 'browsing'
  | 'testing'
  | 'integrating'
  | 'waiting'
  | 'blocked'
  | 'paused'
  | 'error'

/** Speech state follows client playback, never token arrival. */
export type AgentSpeechState = 'silent' | 'queued' | 'speaking' | 'interrupted'

export interface AgentVoice {
  /** ElevenLabs voice id. */
  voiceId: string
  /** Human label shown in settings. */
  voiceName: string
  /** 0.7 - 1.2, passed to ElevenLabs as `speed`. */
  speed: number
  stability: number
  similarityBoost: number
}

export interface Agent {
  id: string
  roomId: string
  presetId: AgentPresetId
  name: string
  /** Working title the teammate chose, e.g. "Competitor Research". Empty until set. */
  title: string
  role: AgentRole
  /** One-line role summary shown on the tile. */
  summary: string
  /** Full system persona used for model calls. */
  persona: string
  /** Restrained tile colour, hex. */
  color: string
  /** Original SVG avatar key, see shared/avatars.ts */
  avatar: string
  voice: AgentVoice
  model: string
  workState: AgentWorkState
  speechState: AgentSpeechState
  /** Truthful compact label, e.g. "Editing VotePanel.tsx" or "Waiting for Alex". */
  activityLabel: string
  /** Set when the agent is attached to a live runtime session. */
  connected: boolean
  /** Agent-owned workspace id, if it has one. */
  workspaceId: string | null
  /** Agent-owned browser session id, if it has one. */
  browserSessionId: string | null
  createdAt: string
  updatedAt: string
}

/* ------------------------------------------------------------------ *
 * Rooms, stage and project binding
 * ------------------------------------------------------------------ */

export type ShareSurface = 'browser' | 'code' | 'terminal' | 'files'
export const SHARE_SURFACES: readonly ShareSurface[] = ['browser', 'code', 'terminal', 'files']

/** `team` is the integration workspace; otherwise an agent id. */
export type ShareOwner = { kind: 'team' } | { kind: 'agent'; agentId: string }

export type StageMode =
  /** Participant tiles dominate. */
  | { kind: 'gallery' }
  /** A workspace share is expanded, participants shown as a filmstrip. */
  | { kind: 'share'; owner: ShareOwner; surface: ShareSurface }
  /** One-on-one with a single agent: its workspace plus a private side channel. */
  | { kind: 'spotlight'; agentId: string; surface: ShareSurface }

export interface StageState {
  mode: StageMode
  /** Follow lets meaningful agent phase changes move the stage. Pin holds it. */
  follow: boolean
  /** Set while pinned and an agent changed surface elsewhere. */
  pendingHint: { agentId: string; surface: ShareSurface; at: string } | null
}

export interface ProjectBinding {
  /** Absolute canonical path to the target project. Never Huddle's own source. */
  rootPath: string
  kind: 'existing' | 'demo'
  isGitRepo: boolean
  /** Set when the folder had uncommitted work when we bound it. */
  hadDirtyWorkOnBind: boolean
  demoTemplate?: string
  boundAt: string
}

export interface Room {
  id: string
  name: string
  /** The project goal. Replaces v1 `description`. */
  goal: string
  createdAt: string
  updatedAt: string
  stage: StageState
  project: ProjectBinding | null
  /** Whether the human has joined the audible call for this room. */
  joined: boolean
  /** Monotonic decision revision. Tasks and results record the revision they used. */
  decisionRevision: number
}

/* ------------------------------------------------------------------ *
 * Shared attention references
 * ------------------------------------------------------------------ */

export type ContextRef =
  | {
      kind: 'file'
      path: string
      startLine?: number
      endLine?: number
      agentId?: string
      excerpt?: string
    }
  | {
      kind: 'screenshot'
      artifactId: string
      /** Rect in captured-image pixel coordinates. */
      rect: { x: number; y: number; width: number; height: number }
      /** Real viewport the screenshot was taken at, for coordinate mapping. */
      viewport: { width: number; height: number }
      url?: string
    }
  | { kind: 'task'; taskId: string }
  | { kind: 'decision'; decisionId: string }
  | { kind: 'job'; jobId: string; fromLine?: number; toLine?: number }
  | { kind: 'artifact'; artifactId: string }

/* ------------------------------------------------------------------ *
 * Messages (the room's conversation of record)
 * ------------------------------------------------------------------ */

export type MessageAuthor =
  | { type: 'human' }
  | { type: 'agent'; agentId: string }
  | { type: 'system' }

export type MessageKind =
  | 'chat'
  | 'question'
  | 'answer'
  | 'handoff'
  | 'decision'
  | 'result'
  | 'system'

export type SpokenState =
  | 'queued'
  | 'speaking'
  | 'played'
  | 'interrupted'
  | 'unheard'
  | 'cancelled'

export interface SpokenInfo {
  generationId: string
  state: SpokenState
  /** Characters actually played before interruption, when known. */
  playedChars: number | null
}

export interface Message {
  id: string
  roomId: string
  author: MessageAuthor
  body: string
  createdAt: string
  /** Stable across retries, scoped to the room. */
  clientRequestId: string
  kind: MessageKind
  /** Agent ids this message is addressed to. Empty means the whole room. */
  to: string[]
  /** Set on answers, pointing at the question message. */
  replyToId?: string
  /** Present when this text was (or will be) spoken aloud. */
  spoken?: SpokenInfo
  refs?: ContextRef[]
  /** Set for voice input. Guarantees one message per finalized utterance. */
  utteranceId?: string
  /** For agent messages: which decision revision the speaker was working against. */
  decisionRevision?: number
  /** Private 1:1 side channel with a single agent, not a room-wide instruction. */
  private?: { agentId: string }
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

export type TaskStatus =
  | 'proposed'
  | 'assigned'
  | 'in_progress'
  | 'blocked'
  | 'awaiting_review'
  | 'submitted'
  | 'done'
  | 'cancelled'
  | 'failed'

export interface Task {
  id: string
  roomId: string
  title: string
  detail: string
  ownerAgentId: string | null
  createdBy: MessageAuthor
  status: TaskStatus
  /** Task ids that must reach `done` or `submitted` first. */
  dependsOn: string[]
  /** Explicit acceptance criteria. Completion requires evidence, not a claim. */
  acceptance: string[]
  /** Decision revision this task was planned against. */
  decisionRevision: number
  /** Set when a newer decision may invalidate this task's plan or results. */
  staleSince: string | null
  staleReason: string | null
  blockedReason: string | null
  evidence: ContextRef[]
  createdAt: string
  updatedAt: string
}

/* ------------------------------------------------------------------ *
 * Decisions
 * ------------------------------------------------------------------ */

export interface Decision {
  id: string
  roomId: string
  /** Monotonic within the room. */
  revision: number
  title: string
  statement: string
  rationale: string
  source: MessageAuthor
  status: 'active' | 'superseded' | 'withdrawn'
  supersedesId: string | null
  supersededById: string | null
  /** Tasks marked stale when this decision landed. */
  affectedTaskIds: string[]
  /** Message that produced this decision, when there was one. */
  originMessageId: string | null
  createdAt: string
}

/* ------------------------------------------------------------------ *
 * Tool runs, jobs, browser sessions, artifacts, workspaces
 * ------------------------------------------------------------------ */

export type ToolRunStatus = 'running' | 'ok' | 'error' | 'cancelled' | 'rejected'

export interface ToolRun {
  id: string
  roomId: string
  agentId: string
  taskId: string | null
  name: string
  /** Redacted, size-bounded argument preview. */
  argsPreview: string
  status: ToolRunStatus
  /** Short truthful one-line outcome. Never invented. */
  summary: string
  error: string | null
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  refs?: ContextRef[]
}

export type JobStatus =
  | 'starting'
  | 'running'
  | 'exited'
  | 'cancelled'
  | 'failed'
  /** Process state could not be confirmed, typically after a restart. */
  | 'unknown'

export interface JobRecord {
  id: string
  roomId: string
  agentId: string
  workspaceId: string
  label: string
  command: string
  cwd: string
  status: JobStatus
  exitCode: number | null
  pid: number | null
  startedAt: string
  endedAt: string | null
  /** Last moment we observed this process ourselves. */
  lastObservedAt: string
  /** True when retained output was trimmed. */
  truncated: boolean
  /** Set for dev servers. */
  port: number | null
}

export type BrowserSessionStatus = 'starting' | 'live' | 'closed' | 'failed'

export interface BrowserSessionRecord {
  id: string
  roomId: string
  agentId: string
  provider: 'browserbase'
  /** Provider session id. */
  remoteId: string | null
  liveViewUrl: string | null
  status: BrowserSessionStatus
  currentUrl: string | null
  title: string | null
  startedAt: string
  endedAt: string | null
  error: string | null
  /** Shown in the UI so a failed session is never mistaken for a live one. */
  detail: string
}

export type ArtifactKind = 'screenshot' | 'file' | 'diff' | 'report' | 'log' | 'image'

export interface Artifact {
  id: string
  roomId: string
  agentId: string | null
  taskId: string | null
  kind: ArtifactKind
  title: string
  /** Absolute path inside the room's artifact directory, or null for inline. */
  path: string | null
  mime: string
  bytes: number | null
  createdAt: string
  meta?: Record<string, string | number | boolean>
}

export interface WorkspaceRecord {
  id: string
  roomId: string
  /** null for the shared Team integration workspace. */
  agentId: string | null
  kind: 'agent' | 'team'
  label: string
  rootPath: string
  branch: string | null
  baseBranch: string | null
  isWorktree: boolean
  devPort: number | null
  devJobId: string | null
  createdAt: string
  /** Commit of the last revision verified in this workspace. */
  lastVerifiedRevision: string | null
}

export type IntegrationStatus =
  | 'running'
  | 'verified'
  | 'conflict'
  | 'checks_failed'
  | 'failed'
  | 'cancelled'

export interface CheckResult {
  name: string
  command: string
  status: 'pass' | 'fail' | 'skipped'
  exitCode: number | null
  /** Size-bounded tail of real output. */
  output: string
  durationMs: number
}

export interface IntegrationAttempt {
  id: string
  roomId: string
  /** Agent that ran the integration. */
  agentId: string
  sources: Array<{ agentId: string; branch: string; commit: string }>
  targetBranch: string
  status: IntegrationStatus
  /** The exact commit the checks ran against. */
  revision: string | null
  checks: CheckResult[]
  conflicts: string[]
  /** Decision revision in force when the integration ran. */
  decisionRevision: number
  detail: string
  startedAt: string
  endedAt: string | null
}

/* ------------------------------------------------------------------ *
 * Room memory (local persistent memory; onboarding a new teammate)
 * ------------------------------------------------------------------ */

export type MemoryKind =
  | 'goal'
  | 'decision'
  | 'interface'
  | 'convention'
  | 'finding'
  | 'artifact'
  /** A standing room-wide rule the human set out loud, e.g. a spend ceiling. */
  | 'constraint'

export interface MemoryEntry {
  id: string
  roomId: string
  kind: MemoryKind
  title: string
  body: string
  /** Decision revision this memory reflects. */
  decisionRevision: number
  source: MessageAuthor
  createdAt: string
  supersededById: string | null
}

/* ------------------------------------------------------------------ *
 * Capabilities and settings
 * ------------------------------------------------------------------ */

export type CapabilityId =
  | 'openai'
  | 'elevenlabs'
  | 'browserbase'
  | 'localSpeech'
  | 'project'
  | 'preview'

export type CapabilityState = 'ready' | 'starting' | 'unavailable' | 'error' | 'disabled'

export interface Capability {
  id: CapabilityId
  label: string
  state: CapabilityState
  /** Truthful current detail, e.g. "gpt-6-astra reachable" or "No API key". */
  detail: string
  /** Concrete next step when not ready. */
  fix: string | null
  checkedAt: string
}

export interface ModelSettings {
  /** Deep contributor work: planning, coding, tool loops. */
  contributor: string
  /** Fast responsive conversation and routing. */
  conversation: string
}

export interface VoiceSettings {
  enabled: boolean
  inputDeviceId: string | null
  outputDeviceId: string | null
  whisperModel: string
  /** Silence required to end an utterance. */
  endpointSilenceMs: number
  /** Barge-in probability threshold while an agent is speaking. */
  bargeInThreshold: number
  /** Never record raw microphone audio unless explicitly turned on. */
  saveRawAudio: boolean
}

export interface PreviewSettings {
  /** How the remote browser reaches the local dev server. */
  mode: 'tunnel' | 'lan' | 'off'
  /** Explicit LAN host when mode === 'lan'. */
  lanHost: string | null
}

export interface AppSettings {
  models: ModelSettings
  voice: VoiceSettings
  preview: PreviewSettings
  browserbaseEnabled: boolean
  /** Bounded concurrency guards for the target laptop. */
  limits: {
    maxConcurrentBuilds: number
    maxConcurrentToolCalls: number
    maxModelTurnsPerTask: number
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  /**
   * Two slots, because the two jobs have different shapes.
   *
   * `contributor` runs the work loop, reasoning over real tool results.
   * `conversation` answers out loud while that work continues, where latency is
   * the whole point — a teammate that takes four seconds to say "on it" has
   * already broken the illusion of a call.
   *
   * Both default to `deepseek-flash`: its chat API is OpenAI-compatible, it
   * answers in about a second, it holds up on tool selection, and a whole demo
   * run costs cents. Point either slot at an OpenAI model in Settings and the
   * adapter routes that slot there instead.
   */
  models: { contributor: 'deepseek-flash', conversation: 'deepseek-flash' },
  voice: {
    enabled: true,
    inputDeviceId: null,
    outputDeviceId: null,
    whisperModel: 'base.en',
    endpointSilenceMs: 700,
    bargeInThreshold: 0.65,
    saveRawAudio: false
  },
  preview: { mode: 'tunnel', lanHost: null },
  browserbaseEnabled: true,
  limits: { maxConcurrentBuilds: 1, maxConcurrentToolCalls: 4, maxModelTurnsPerTask: 24 }
}

/* ------------------------------------------------------------------ *
 * Live (ephemeral) state
 * ------------------------------------------------------------------ */

export type CallConnection = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface CallState {
  roomId: string | null
  connection: CallConnection
  micMuted: boolean
  deafened: boolean
  /** Truthful mic level 0..1, updated at ~20 Hz, never persisted. */
  micLevel: number
  listening: boolean
  /** Agent currently holding the audio floor, from actual playback. */
  speakingAgentId: string | null
  /** Agent ids with queued speech. */
  queuedAgentIds: string[]
  error: string | null
}

export interface LiveTranscript {
  utteranceId: string
  roomId: string
  text: string
  isFinal: boolean
  updatedAt: string
}

export type TimingLabel =
  | 'vadSpeechStartToPlaybackHalt'
  | 'utteranceEndToFinalTranscript'
  | 'finalTranscriptToFirstAudioChunkPlayed'
  | 'toolCallToStageUpdate'

export interface TimingSample {
  label: TimingLabel
  ms: number
  at: string
  detail?: string
}

/* ------------------------------------------------------------------ *
 * Runtime events
 * ------------------------------------------------------------------ */

export interface RuntimeEventEnvelope {
  id: string
  seq: number
  roomId: string
  createdAt: string
  /** Durable events change persisted state. Ephemeral ones never trigger a write. */
  durable: boolean
}

export type RuntimeEventBody =
  | { type: 'room.created'; room: Room }
  | { type: 'room.updated'; room: Room }
  | { type: 'room.selected'; selectedRoomId: string }
  | { type: 'room.removed'; removedRoomId: string }
  | { type: 'agent.added'; agent: Agent }
  | { type: 'agent.updated'; agent: Agent }
  | { type: 'agent.removed'; agentId: string }
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'task.upserted'; task: Task }
  | { type: 'task.removed'; taskId: string }
  | { type: 'decision.created'; decision: Decision; affected: Task[] }
  | { type: 'decision.updated'; decision: Decision }
  | { type: 'toolrun.started'; run: ToolRun }
  | { type: 'toolrun.finished'; run: ToolRun }
  | { type: 'job.upserted'; job: JobRecord }
  | { type: 'job.output'; jobId: string; chunk: string; stream: 'stdout' | 'stderr' }
  | { type: 'browser.upserted'; session: BrowserSessionRecord }
  | { type: 'artifact.created'; artifact: Artifact }
  | { type: 'workspace.upserted'; workspace: WorkspaceRecord }
  | { type: 'integration.upserted'; attempt: IntegrationAttempt }
  | { type: 'memory.created'; entry: MemoryEntry }
  | { type: 'capability.updated'; capability: Capability }
  | { type: 'settings.updated'; settings: AppSettings }
  | { type: 'call.updated'; call: CallState }
  | { type: 'voice.level'; level: number }
  | { type: 'voice.vad'; speaking: boolean; probability: number }
  | { type: 'voice.transcript'; transcript: LiveTranscript }
  | {
      type: 'voice.playback'
      agentId: string
      generationId: string
      state: 'starting' | 'playing' | 'ended' | 'interrupted' | 'cancelled'
      messageId: string | null
    }
  | { type: 'voice.timing'; sample: TimingSample }
  | { type: 'agent.stream'; agentId: string; taskId: string | null; delta: string; done: boolean }
  /** The human spoke to this agent while it was already running. Ephemeral. */
  | { type: 'agent.steered'; agentId: string; messageId: string; scope: 'direct' | 'broadcast' }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string; fix?: string }

export type RuntimeEvent = RuntimeEventEnvelope & RuntimeEventBody
export type RuntimeEventType = RuntimeEventBody['type']

/** Event types that must never trigger a durable write. */
export const EPHEMERAL_EVENT_TYPES: readonly RuntimeEventType[] = [
  'voice.level',
  'voice.vad',
  'voice.transcript',
  'voice.playback',
  'voice.timing',
  'agent.stream',
  'agent.steered',
  'job.output',
  'call.updated',
  'notice'
]

/* ------------------------------------------------------------------ *
 * Snapshot and persistence
 * ------------------------------------------------------------------ */

export interface RecoveryInfo {
  message: string
  backupPath: string
}

export interface PersistedState {
  version: StateVersion
  rooms: Room[]
  agents: Agent[]
  messages: Message[]
  tasks: Task[]
  decisions: Decision[]
  toolRuns: ToolRun[]
  jobs: JobRecord[]
  browserSessions: BrowserSessionRecord[]
  artifacts: Artifact[]
  workspaces: WorkspaceRecord[]
  integrations: IntegrationAttempt[]
  memories: MemoryEntry[]
  settings: AppSettings
  selectedRoomId: string | null
  lastSeq: number
}

export interface ResumableItem {
  id: string
  roomId: string
  kind: 'job' | 'task' | 'browser' | 'integration'
  title: string
  detail: string
  /** We never claim an interrupted operation succeeded. */
  state: 'interrupted' | 'unknown'
}

export interface AppSnapshot extends PersistedState {
  /** Display ring, not the source of recoverable state. */
  events: RuntimeEvent[]
  capabilities: Capability[]
  call: CallState
  recovery?: RecoveryInfo
  /** Operations interrupted by a restart that need user attention. */
  resumable: ResumableItem[]
}

/* ------------------------------------------------------------------ *
 * IPC inputs
 * ------------------------------------------------------------------ */

export interface CreateRoomInput {
  name?: string
  goal?: string
  /** How many teammates to create. Clamped to 1–MAX_AGENTS_PER_ROOM. */
  agentCount?: number
}

export interface UpdateRoomInput {
  id: string
  name?: string
  goal?: string
  stage?: StageState
}

export interface AddAgentInput {
  roomId: string
  presetId: AgentPresetId
  name?: string
  role?: AgentRole
  voiceId?: string
  /** Extra assignment text given to the new teammate during onboarding. */
  assignment?: string
}

export interface UpdateAgentInput {
  agentId: string
  name?: string
  title?: string
  role?: AgentRole
  voiceId?: string
  persona?: string
  model?: string
}

export interface SendMessageInput {
  roomId: string
  body: string
  clientRequestId: string
  to?: string[]
  refs?: ContextRef[]
  replyToId?: string
  /** Set when submitting a finalized local transcript. Enforces exactly-once. */
  utteranceId?: string
  private?: { agentId: string }
}

export interface BindProjectInput {
  roomId: string
  /** Absolute path. When kind is 'demo' the template is copied here. */
  rootPath: string
  kind: 'existing' | 'demo'
}

export interface StageInput {
  roomId: string
  stage: StageState
}

export interface SpeechControlInput {
  roomId: string
  /** Cancels current audio and obsolete queued speech. Never cancels execution. */
  scope: 'current' | 'all'
}

export interface WorkControlInput {
  roomId: string
  agentId?: string
  action: 'pause' | 'resume' | 'cancelTask'
  taskId?: string
}

export interface HuddleErrorShape {
  code: string
  message: string
  fix?: string
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: HuddleErrorShape }

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

export const MAX_AGENTS_PER_ROOM = 10
export const MAX_EVENT_HISTORY = 400
export const MAX_ROOM_NAME = 80
export const MAX_ROOM_GOAL = 600
export const MAX_MESSAGE_BODY = 8000
export const MAX_TOOL_RUNS_RETAINED = 400
export const MAX_JOB_OUTPUT_BYTES = 512 * 1024
export const MAX_TOOL_OUTPUT_CHARS = 24000
