// Main-process host contracts.
//
// These interfaces are the seam between the modules built in parallel. Each
// specialist implements the interface for their directory and depends only on
// the interfaces of others, never on their files.
//
//   HuddleBus        implemented by src/main/room-service.ts        (integration lead)
//   ExecutionHost    implemented by src/main/exec/                  (execution)
//   BrowserHost      implemented by src/main/browser/               (browser)
//   VoiceHost        implemented by src/main/voice/                 (voice)
//   AgentRuntime     implemented by src/main/runtime/               (agent runtime)
//
// Nobody edits this file except the integration lead.

import type {
  DirEntry,
  FileContents,
  JobOutput,
  NetworkEntry,
  PreviewInfo,
  ScreenshotResult,
  SearchHit,
  VoiceOption,
  WorkspaceDiff
} from '../shared/api.ts'
import type { RecordDecisionInput } from '../shared/api.ts'
import type {
  Agent,
  AgentPresetId,
  AppSettings,
  Artifact,
  BrowserSessionRecord,
  Capability,
  Decision,
  IntegrationAttempt,
  JobRecord,
  MemoryEntry,
  Message,
  MessageAuthor,
  ProjectBinding,
  Room,
  RuntimeEvent,
  RuntimeEventBody,
  ShareSurface,
  Task,
  TaskStatus,
  TimingSample,
  ToolRun,
  WorkspaceRecord
} from '../shared/types.ts'
import type {
  AudioChunkMessage,
  HaltReason,
  PlaybackClientEvent,
  PlaybackServerEvent,
  SpeechReason
} from '../shared/voice.ts'

/* ================================================================== *
 * Bus: how every module reports truth back to the room
 * ================================================================== */

export interface HuddleBus {
  /** Broadcast and, when durable, schedule a coalesced write. */
  emit(roomId: string, body: RuntimeEventBody): RuntimeEvent

  /** Truthful, user-visible notice with an optional concrete fix. */
  notice(roomId: string, level: 'info' | 'warn' | 'error', text: string, fix?: string): void

  upsertJob(job: JobRecord): void
  appendJobOutput(job: JobRecord, chunk: string, stream: 'stdout' | 'stderr'): void
  upsertWorkspace(workspace: WorkspaceRecord): void
  upsertBrowserSession(session: BrowserSessionRecord): void
  upsertIntegration(attempt: IntegrationAttempt): void
  addArtifact(artifact: Artifact): void
  updateAgent(agentId: string, patch: Partial<Agent>): Agent | null
  upsertAgent(agent: Agent): Agent
  removeAgentById(agentId: string): boolean
  upsertTask(task: Task): void
  recordTimings(samples: TimingSample[]): void

  /** Agent's current, observable activity. Work state and speech state are independent. */
  setAgentActivity(agentId: string, workState: Agent['workState'], label: string): void

  /** Speech state follows client playback, never token arrival. */
  setAgentSpeech(agentId: string, speechState: Agent['speechState']): void

  /** A meaningful phase change an agent wants the stage to follow. */
  proposeStage(roomId: string, agentId: string, surface: ShareSurface): void

  /** The room's conversation of record. Agent and system messages land here. */
  addMessage(message: Message): Message
  updateMessage(messageId: string, patch: Partial<Message>): Message | null
  addMemory(entry: MemoryEntry): void
  recordDecision(input: RecordDecisionInput, source: MessageAuthor): Promise<Decision>
  recordToolRun(run: ToolRun): void
  getToolRuns(roomId: string): ToolRun[]
  getDecisions(roomId: string): Decision[]
  getIntegrations(roomId: string): IntegrationAttempt[]
  getSettings(): AppSettings

  getRoom(roomId: string): Room | null
  getAgent(agentId: string): Agent | null
  getAgents(roomId: string): Agent[]
  getTasks(roomId: string): Task[]
  getTask(taskId: string): Task | null
  getActiveDecisions(roomId: string): Decision[]
  getMessages(roomId: string, limit?: number): Message[]
  getMemories(roomId: string): MemoryEntry[]
  getWorkspaces(roomId: string): WorkspaceRecord[]
  getJobs(roomId: string): JobRecord[]
  getBrowserSessions(roomId: string): BrowserSessionRecord[]
  getArtifacts(roomId: string): Artifact[]

  newId(): string
  now(): string
}

/* ================================================================== *
 * Execution host  (src/main/exec)
 * ================================================================== */

export interface StartJobInput {
  roomId: string
  agentId: string
  workspaceId: string
  label: string
  command: string
  /** Relative to the workspace root; defaults to the root. */
  cwd?: string
  /** Mark as a dev server so the port is tracked and reused. */
  devServer?: boolean
  env?: Record<string, string>
}

/** Workspace text search hit. Defined in the shared API layer, re-exported here. */
export type { SearchHit } from '../shared/api.ts'

export interface WriteResult {
  path: string
  relativePath: string
  created: boolean
  bytes: number
}

export interface PatchResult {
  applied: boolean
  /** Files actually changed on disk. */
  files: string[]
  /** Populated when the patch could not be applied cleanly. */
  rejected: string[]
  detail: string
}

export interface IntegrateInput {
  roomId: string
  /** The agent performing the integration, normally Alex. */
  agentId: string
  /** Agent ids whose branches should be folded in. */
  sourceAgentIds: string[]
  decisionRevision: number
  /** Commands to run on the integrated revision. */
  checks?: Array<{ name: string; command: string }>
}

export interface SubmitInput {
  roomId: string
  agentId: string
  workspaceId: string
  summary: string
  taskId: string | null
}

export interface SubmitResult {
  commit: string
  branch: string
  filesChanged: number
  detail: string
}

export interface ExecutionHost {
  /** Bind a room to a real project directory, or copy in the demo template. */
  bindProject(roomId: string, rootPath: string, kind: 'existing' | 'demo'): Promise<ProjectBinding>
  /** Absolute path of the packaged demo template. */
  demoTemplatePath(): string
  /** Suggested destination for a fresh demo project. */
  suggestDemoPath(roomId: string): string

  /** Create (or return) the Team integration workspace for the room. */
  ensureTeamWorkspace(roomId: string): Promise<WorkspaceRecord>
  /** Create (or return) an agent's own worktree/branch. */
  ensureAgentWorkspace(roomId: string, agentId: string): Promise<WorkspaceRecord>
  getWorkspace(workspaceId: string): WorkspaceRecord | null

  readFile(workspaceId: string, path: string, maxBytes?: number): Promise<FileContents>
  listDir(workspaceId: string, path?: string): Promise<DirEntry[]>
  search(workspaceId: string, query: string, opts?: { glob?: string; max?: number }): Promise<SearchHit[]>
  writeFile(workspaceId: string, path: string, contents: string): Promise<WriteResult>
  applyPatch(workspaceId: string, patch: string): Promise<PatchResult>
  diff(workspaceId: string): Promise<WorkspaceDiff>

  startJob(input: StartJobInput): Promise<JobRecord>
  cancelJob(jobId: string): Promise<JobRecord>
  getJobOutput(jobId: string, maxChars?: number): JobOutput
  /** Resolves when the job leaves `running`, or at the deadline. */
  waitForJob(jobId: string, timeoutMs: number): Promise<JobRecord>

  submitWork(input: SubmitInput): Promise<SubmitResult>
  integrate(input: IntegrateInput): Promise<IntegrationAttempt>

  /** Start (or reuse) the project's dev server and expose it for a remote browser. */
  startPreview(roomId: string, workspaceId: string): Promise<PreviewInfo>
  getPreview(roomId: string, workspaceId: string): PreviewInfo | null
  stopPreview(roomId: string): Promise<void>

  /** Directory where artifacts for a room are written. */
  artifactDir(roomId: string): string
  writeArtifact(input: {
    roomId: string
    agentId: string | null
    taskId: string | null
    kind: Artifact['kind']
    title: string
    filename: string
    data: Buffer | string
    mime: string
  }): Promise<Artifact>

  /** Reconcile persisted job records after a restart. Never assume survival. */
  reconcile(jobs: JobRecord[], workspaces: WorkspaceRecord[]): Promise<void>
  /** Stop everything owned by this room. */
  disposeRoom(roomId: string): Promise<void>
  dispose(): Promise<void>
}

/* ================================================================== *
 * Browser host  (src/main/browser)
 * ================================================================== */

export interface BrowserObservation {
  url: string
  title: string
  /** Trimmed, size-bounded accessibility/text summary of the page. */
  text: string
  /** Interactive elements the model can act on. */
  elements: Array<{ ref: string; role: string; name: string; selector: string }>
}

export interface BrowserActionInput {
  sessionId: string
  action:
    | { kind: 'navigate'; url: string }
    | { kind: 'click'; selector: string }
    | { kind: 'type'; selector: string; text: string; submit?: boolean }
    | { kind: 'press'; key: string }
    | { kind: 'select'; selector: string; value: string }
    | { kind: 'waitFor'; selector?: string; ms?: number }
    | { kind: 'evaluate'; expression: string }
    | { kind: 'draw'; selector: string; strokes: number }
}

export interface BrowserActionResult {
  ok: boolean
  detail: string
  observation: BrowserObservation | null
}

/** A real response captured from a remote browser session, for QA evidence. */
export type NetworkCapture = NetworkEntry

export interface BrowserHost {
  /** Open a real remote session. Fails loudly when credentials are missing. */
  openSession(input: {
    roomId: string
    agentId: string
    url?: string
    /** A second independent session for multi-user flows. */
    label?: string
  }): Promise<BrowserSessionRecord>

  closeSession(sessionId: string): Promise<void>
  getSession(sessionId: string): BrowserSessionRecord | null
  act(input: BrowserActionInput): Promise<BrowserActionResult>
  observe(sessionId: string): Promise<BrowserObservation>
  screenshot(sessionId: string, opts?: { fullPage?: boolean }): Promise<ScreenshotResult>
  /** Recent network responses, so an agent can check payloads, not just the UI. */
  network(sessionId: string, filter?: string): Promise<NetworkCapture[]>

  reconcile(sessions: BrowserSessionRecord[]): Promise<void>
  disposeRoom(roomId: string): Promise<void>
  dispose(): Promise<void>
}

/* ================================================================== *
 * Voice host  (src/main/voice)
 * ================================================================== */

export interface SpeechIntent {
  id: string
  roomId: string
  agentId: string
  text: string
  reason: SpeechReason
  /** Decision revision the speech was generated against. Stale speech is dropped. */
  decisionRevision: number
  /** Message this speech belongs to, so chat can show interruption state. */
  messageId: string | null
  /** Optional deadline after which the intent is no longer worth saying. */
  expiresAt?: number
}

export interface SpeechHandle {
  generationId: string
  /** Resolves when the utterance finished, was interrupted, or was cancelled. */
  done: Promise<{ state: 'played' | 'interrupted' | 'cancelled' | 'unheard' | 'error'; playedChars: number | null }>
}

export interface VoiceHost {
  /** Start local capture + transcription for a room. */
  start(roomId: string): Promise<void>
  stop(): Promise<void>
  isActive(): boolean
  activeRoomId(): string | null

  setMicMuted(muted: boolean): void
  setDeafened(deafened: boolean): void

  /** Renderer microphone frames, Int16 little-endian PCM at CAPTURE_SAMPLE_RATE. */
  pushMicFrame(pcm: ArrayBuffer, capturedAt: number): void
  /** Renderer reports of what the audio hardware actually did. */
  reportClientEvent(event: PlaybackClientEvent): void

  /** Queue speech through the floor manager. */
  speak(intent: SpeechIntent): SpeechHandle
  /** Cancel current audio and obsolete queued speech. Never cancels execution. */
  stopSpeaking(roomId: string, scope: 'current' | 'all', reason: HaltReason): void
  /** Drop queued speech that predates a decision revision. */
  invalidateSpeechBefore(roomId: string, decisionRevision: number): void

  listVoices(): Promise<VoiceOption[]>
  previewVoice(voiceId: string): Promise<void>

  timings(): TimingSample[]
  dispose(): Promise<void>
}

/** What the voice host needs from the composition root. */
export interface VoiceHostDeps {
  bus: HuddleBus
  settings(): AppSettings
  /** The room service's utterance sink. Resolved late: the runtime attaches after the voice host. */
  sink(): VoiceSink | null
  /** main -> renderer playback control. Never buffered, never persisted. */
  sendServerEvent(event: PlaybackServerEvent): void
  /** main -> renderer TTS PCM. Never buffered, never persisted. */
  sendAudioChunk(chunk: AudioChunkMessage): void
}

export type CreateVoiceHost = (deps: VoiceHostDeps) => VoiceHost

/** The voice host calls this when a complete human utterance is ready. */
export interface VoiceSink {
  onFinalUtterance(input: {
    roomId: string
    utteranceId: string
    text: string
    startedAt: number
    endedAt: number
  }): void
  onPartialUtterance(input: { roomId: string; utteranceId: string; text: string }): void
  /** Human began speaking. Used for barge-in and floor priority. */
  onHumanSpeechStart(roomId: string): void
  onHumanSpeechEnd(roomId: string): void
}

/* ================================================================== *
 * Agent runtime  (src/main/runtime)
 * ================================================================== */

export interface RuntimeDeps {
  bus: HuddleBus
  exec: ExecutionHost
  browser: BrowserHost
  voice: VoiceHost
  /** Provider capability lookup so tools degrade honestly. */
  capability(id: Capability['id']): Capability
  /** Current settings: model ids, limits, preview mode. */
  settings(): AppSettings
}

export interface InboundMessage {
  roomId: string
  message: Message
  /** Agent ids the router resolved this message to. Empty means the room. */
  addressed: string[]
}

export interface AgentRuntime {
  attachRoom(roomId: string): Promise<void>
  detachRoom(roomId: string): Promise<void>

  /**
   * Which teammates a room with this goal should be staffed with.
   *
   * Asked before the room exists, so it takes the goal rather than a room id.
   * Never rejects and never hangs: a provider that is slow, missing or
   * unhelpful falls through to a keyword reading of the goal, because a room
   * that does not open is worse than a roster that is slightly off.
   */
  planRoster(goal: string, count: number): Promise<AgentPresetId[]>

  /** A human message arrived (typed or finalized transcript). */
  handleHumanMessage(input: InboundMessage): Promise<void>

  /** Onboard a teammate added mid-project with current goal and decisions. */
  onboardAgent(roomId: string, agentId: string, assignment?: string): Promise<void>

  /** Human changed a requirement. Steer or replan affected work. */
  applyDecision(roomId: string, decision: Decision, affected: Task[]): Promise<void>

  pauseWork(roomId: string, agentId?: string): Promise<void>
  resumeWork(roomId: string, agentId?: string): Promise<void>
  cancelTask(roomId: string, taskId: string): Promise<void>
  retryTask(taskId: string): Promise<Task>

  /** Record a tool run for the activity view. */
  listToolRuns(roomId: string): ToolRun[]

  /**
   * Optional: prove a model id actually answers a request. Used by the settings
   * screen so a model can be shown as verified rather than merely configured.
   */
  probeModel?(model: string): Promise<{ ok: boolean; detail: string; fix?: string }>

  dispose(): Promise<void>
}

/* ================================================================== *
 * Composition seams. The integration lead owns main/index.ts and wires
 * these factories together; each specialist exports exactly one.
 * ================================================================== */

export interface ExecutionHostDeps {
  bus: HuddleBus
  capability(id: Capability['id']): Capability
  settings(): AppSettings
}

export type CreateExecutionHost = (deps: ExecutionHostDeps) => ExecutionHost

export interface BrowserHostDeps {
  bus: HuddleBus
  /** Artifacts, the artifact directory and the reachable preview come from exec. */
  exec: Pick<ExecutionHost, 'writeArtifact' | 'artifactDir' | 'getPreview'>
  settings(): AppSettings
}

export type CreateBrowserHost = (deps: BrowserHostDeps) => BrowserHost

export type CreateAgentRuntime = (deps: RuntimeDeps) => AgentRuntime

/* ================================================================== *
 * Re-exports
 *
 * Specialists import the shared domain and API types from this file so that a
 * single module describes the whole main-process seam. Nothing is redefined
 * here: these are the same types the renderer uses.
 * ================================================================== */

export type {
  Agent,
  AppSettings,
  Artifact,
  BrowserSessionRecord,
  Capability,
  CapabilityId,
  Decision,
  IntegrationAttempt,
  JobRecord,
  MemoryEntry,
  Message,
  MessageAuthor,
  ProjectBinding,
  Room,
  RuntimeEvent,
  RuntimeEventBody,
  ShareOwner,
  ShareSurface,
  StageState,
  Task,
  TaskStatus,
  TimingSample,
  ToolRun,
  WorkspaceRecord
} from '../shared/types.ts'

export type {
  DirEntry,
  FileContents,
  JobOutput,
  ModelOption,
  NetworkEntry,
  PreviewInfo,
  ScreenshotResult,
  VoiceOption,
  WorkspaceDiff
} from '../shared/api.ts'

export type { HaltReason, PlaybackClientEvent, SpeechReason } from '../shared/voice.ts'

/* ================================================================== *
 * Shared small helpers
 * ================================================================== */

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'done',
  'cancelled',
  'failed'
]

export function isTerminalTask(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status)
}
