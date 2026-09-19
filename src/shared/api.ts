import type {
  AddAgentInput,
  Agent,
  AppSettings,
  AppSnapshot,
  Artifact,
  BindProjectInput,
  BrowserSessionRecord,
  Capability,
  ContextRef,
  CreateRoomInput,
  Decision,
  IpcResult,
  Message,
  Room,
  RuntimeEvent,
  SendMessageInput,
  SpeechControlInput,
  StageInput,
  Task,
  TimingSample,
  UpdateAgentInput,
  UpdateRoomInput,
  WorkControlInput
} from './types.ts'
import type {
  AudioChunkMessage,
  AudioDeviceInfo,
  PlaybackClientEvent,
  PlaybackServerEvent
} from './voice.ts'

export const IPC_CHANNELS = {
  // snapshot + events
  getSnapshot: 'huddle:getSnapshot',
  event: 'huddle:event',

  // rooms
  createRoom: 'huddle:createRoom',
  updateRoom: 'huddle:updateRoom',
  selectRoom: 'huddle:selectRoom',
  removeRoom: 'huddle:removeRoom',
  joinCall: 'huddle:joinCall',
  leaveCall: 'huddle:leaveCall',

  // agents
  addAgent: 'huddle:addAgent',
  updateAgent: 'huddle:updateAgent',
  removeAgent: 'huddle:removeAgent',

  // conversation
  sendMessage: 'huddle:sendMessage',

  // work
  recordDecision: 'huddle:recordDecision',
  controlWork: 'huddle:controlWork',
  retryTask: 'huddle:retryTask',
  resumeItem: 'huddle:resumeItem',
  dismissResumable: 'huddle:dismissResumable',

  // project + stage
  chooseProjectFolder: 'huddle:chooseProjectFolder',
  bindProject: 'huddle:bindProject',
  createDemoProject: 'huddle:createDemoProject',
  setStage: 'huddle:setStage',

  // voice control
  voiceStart: 'huddle:voice:start',
  voiceStop: 'huddle:voice:stop',
  voiceSetMicMuted: 'huddle:voice:setMicMuted',
  voiceSetDeafened: 'huddle:voice:setDeafened',
  voiceStopSpeaking: 'huddle:voice:stopSpeaking',
  voiceListDevices: 'huddle:voice:listDevices',
  voiceTimings: 'huddle:voice:timings',
  /** renderer -> main, streaming mic PCM (send, not invoke) */
  voiceMicFrame: 'huddle:voice:micFrame',
  /** renderer -> main, playback truth reports (send) */
  voiceClientEvent: 'huddle:voice:clientEvent',
  /** main -> renderer, playback control (send) */
  voiceServerEvent: 'huddle:voice:serverEvent',
  /** main -> renderer, TTS PCM chunks (send) */
  voiceAudioChunk: 'huddle:voice:audioChunk',

  // execution surfaces
  readWorkspaceFile: 'huddle:exec:readFile',
  listWorkspaceDir: 'huddle:exec:listDir',
  searchWorkspace: 'huddle:exec:search',
  getWorkspaceDiff: 'huddle:exec:diff',
  cancelJob: 'huddle:exec:cancelJob',
  getJobOutput: 'huddle:exec:jobOutput',
  runIntegration: 'huddle:exec:runIntegration',
  startPreview: 'huddle:exec:startPreview',

  // browser
  openBrowserSession: 'huddle:browser:open',
  closeBrowserSession: 'huddle:browser:close',
  browserNavigate: 'huddle:browser:navigate',
  browserScreenshot: 'huddle:browser:screenshot',
  browserNetwork: 'huddle:browser:network',

  // settings + capabilities
  updateSettings: 'huddle:updateSettings',
  setSecret: 'huddle:setSecret',
  refreshCapabilities: 'huddle:refreshCapabilities',
  listModels: 'huddle:listModels',
  listVoices: 'huddle:listVoices',
  previewVoice: 'huddle:previewVoice',
  revealPath: 'huddle:revealPath'
} as const

/* ------------------------------------------------------------------ *
 * Payload shapes used by more than one layer
 * ------------------------------------------------------------------ */

export interface DirEntry {
  name: string
  path: string
  kind: 'file' | 'dir'
  bytes: number | null
  modifiedAt: string | null
}

export interface FileContents {
  path: string
  /** Path relative to the workspace root, for display. */
  relativePath: string
  text: string
  language: string
  bytes: number
  truncated: boolean
  modifiedAt: string
}

/** One real text match from a workspace search. */
export interface SearchHit {
  path: string
  line: number
  text: string
}

/** A real response captured from a remote browser session. */
export interface NetworkEntry {
  url: string
  method: string
  status: number
  /** Size-bounded response body, so an agent can check the real payload. */
  body: string
}

export interface DiffHunk {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  /** Unified diff text produced by git, never synthesised. */
  patch: string
  additions: number
  deletions: number
}

export interface WorkspaceDiff {
  workspaceId: string
  branch: string | null
  baseBranch: string | null
  /** Commit the diff was computed against. */
  revision: string | null
  files: DiffHunk[]
  /** Set when the workspace is not a git repository. */
  note: string | null
}

export interface JobOutput {
  jobId: string
  /** Real captured output, oldest trimmed first. */
  text: string
  truncated: boolean
  status: string
  exitCode: number | null
}

export interface VoiceOption {
  voiceId: string
  name: string
  accent: string | null
  gender: string | null
  description: string | null
  previewUrl: string | null
}

export interface ModelOption {
  id: string
  /** Whether a probe call with this id actually succeeded. */
  verified: boolean
}

export interface ScreenshotResult {
  artifact: Artifact
  viewport: { width: number; height: number }
  url: string
  /** data: URL so the renderer can show it without filesystem access. */
  dataUrl: string
}

export interface PreviewInfo {
  roomId: string
  workspaceId: string
  /** URL the remote browser can actually reach, or null when not exposed. */
  publicUrl: string | null
  localUrl: string
  mode: 'tunnel' | 'lan' | 'off'
  state: 'starting' | 'ready' | 'failed' | 'off'
  detail: string
}

export interface RecordDecisionInput {
  roomId: string
  title: string
  statement: string
  rationale?: string
  supersedesId?: string | null
  originMessageId?: string | null
}

export interface OpenBrowserInput {
  roomId: string
  agentId: string
  url?: string
}

export interface NavigateInput {
  sessionId: string
  url: string
}

export interface ReadFileInput {
  workspaceId: string
  /** Relative to the workspace root. Traversal outside the root is refused. */
  path: string
  maxBytes?: number
}

export interface ListDirInput {
  workspaceId: string
  path?: string
}

export interface SearchInput {
  workspaceId: string
  query: string
  glob?: string
  max?: number
}

export interface SetSecretInput {
  key: 'OPENAI_API_KEY' | 'ELEVENLABS_API_KEY' | 'BROWSERBASE_API_KEY' | 'BROWSERBASE_PROJECT_ID'
  value: string
}

export interface IntegrationInput {
  roomId: string
  /** Agent branches to fold in. Empty means every agent workspace with commits. */
  agentIds?: string[]
}

export interface ResumeInput {
  roomId: string
  itemId: string
}

/* ------------------------------------------------------------------ *
 * The preload-exposed API
 * ------------------------------------------------------------------ */

export interface HuddleApi {
  getSnapshot: () => Promise<AppSnapshot>
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void

  createRoom: (input?: CreateRoomInput) => Promise<Room>
  updateRoom: (input: UpdateRoomInput) => Promise<Room>
  selectRoom: (roomId: string) => Promise<void>
  removeRoom: (roomId: string) => Promise<void>
  joinCall: (roomId: string) => Promise<void>
  leaveCall: (roomId: string) => Promise<void>

  addAgent: (input: AddAgentInput) => Promise<Agent>
  updateAgent: (input: UpdateAgentInput) => Promise<Agent>
  removeAgent: (agentId: string) => Promise<void>

  sendMessage: (input: SendMessageInput) => Promise<Message>

  recordDecision: (input: RecordDecisionInput) => Promise<Decision>
  controlWork: (input: WorkControlInput) => Promise<void>
  retryTask: (taskId: string) => Promise<Task>
  resumeItem: (input: ResumeInput) => Promise<void>
  dismissResumable: (input: ResumeInput) => Promise<void>

  chooseProjectFolder: () => Promise<string | null>
  bindProject: (input: BindProjectInput) => Promise<Room>
  createDemoProject: (roomId: string) => Promise<Room>
  setStage: (input: StageInput) => Promise<Room>

  voice: {
    start: (roomId: string) => Promise<void>
    stop: () => Promise<void>
    setMicMuted: (muted: boolean) => Promise<void>
    setDeafened: (deafened: boolean) => Promise<void>
    stopSpeaking: (input: SpeechControlInput) => Promise<void>
    listDevices: () => Promise<AudioDeviceInfo[]>
    timings: () => Promise<TimingSample[]>
    sendMicFrame: (pcm: ArrayBuffer, capturedAt: number) => void
    reportClientEvent: (event: PlaybackClientEvent) => void
    onServerEvent: (listener: (event: PlaybackServerEvent) => void) => () => void
    onAudioChunk: (listener: (chunk: AudioChunkMessage) => void) => () => void
  }

  exec: {
    readFile: (input: ReadFileInput) => Promise<FileContents>
    listDir: (input: ListDirInput) => Promise<DirEntry[]>
    search: (input: SearchInput) => Promise<SearchHit[]>
    diff: (workspaceId: string) => Promise<WorkspaceDiff>
    cancelJob: (jobId: string) => Promise<void>
    jobOutput: (jobId: string) => Promise<JobOutput>
    runIntegration: (input: IntegrationInput) => Promise<void>
    startPreview: (roomId: string, workspaceId: string) => Promise<PreviewInfo>
  }

  browser: {
    open: (input: OpenBrowserInput) => Promise<BrowserSessionRecord>
    close: (sessionId: string) => Promise<void>
    navigate: (input: NavigateInput) => Promise<BrowserSessionRecord>
    screenshot: (sessionId: string) => Promise<ScreenshotResult>
    network: (sessionId: string, filter?: string) => Promise<NetworkEntry[]>
  }

  settings: {
    update: (settings: Partial<AppSettings>) => Promise<AppSettings>
    setSecret: (input: SetSecretInput) => Promise<Capability>
    refreshCapabilities: () => Promise<Capability[]>
    listModels: () => Promise<ModelOption[]>
    listVoices: () => Promise<VoiceOption[]>
    previewVoice: (voiceId: string) => Promise<void>
    revealPath: (path: string) => Promise<void>
  }
}

/* ------------------------------------------------------------------ *
 * Invoke map, used to keep main and preload in step
 * ------------------------------------------------------------------ */

export type InvokeMap = {
  [IPC_CHANNELS.getSnapshot]: { args: []; result: IpcResult<AppSnapshot> }
  [IPC_CHANNELS.createRoom]: { args: [CreateRoomInput | undefined]; result: IpcResult<Room> }
  [IPC_CHANNELS.updateRoom]: { args: [UpdateRoomInput]; result: IpcResult<Room> }
  [IPC_CHANNELS.selectRoom]: { args: [string]; result: IpcResult<void> }
  [IPC_CHANNELS.removeRoom]: { args: [string]; result: IpcResult<void> }
  [IPC_CHANNELS.joinCall]: { args: [string]; result: IpcResult<void> }
  [IPC_CHANNELS.leaveCall]: { args: [string]; result: IpcResult<void> }
  [IPC_CHANNELS.addAgent]: { args: [AddAgentInput]; result: IpcResult<Agent> }
  [IPC_CHANNELS.updateAgent]: { args: [UpdateAgentInput]; result: IpcResult<Agent> }
  [IPC_CHANNELS.removeAgent]: { args: [string]; result: IpcResult<void> }
  [IPC_CHANNELS.sendMessage]: { args: [SendMessageInput]; result: IpcResult<Message> }
  [IPC_CHANNELS.recordDecision]: { args: [RecordDecisionInput]; result: IpcResult<Decision> }
  [IPC_CHANNELS.controlWork]: { args: [WorkControlInput]; result: IpcResult<void> }
  [IPC_CHANNELS.retryTask]: { args: [string]; result: IpcResult<Task> }
  [IPC_CHANNELS.resumeItem]: { args: [ResumeInput]; result: IpcResult<void> }
  [IPC_CHANNELS.dismissResumable]: { args: [ResumeInput]; result: IpcResult<void> }
  [IPC_CHANNELS.chooseProjectFolder]: { args: []; result: IpcResult<string | null> }
  [IPC_CHANNELS.bindProject]: { args: [BindProjectInput]; result: IpcResult<Room> }
  [IPC_CHANNELS.createDemoProject]: { args: [string]; result: IpcResult<Room> }
  [IPC_CHANNELS.setStage]: { args: [StageInput]; result: IpcResult<Room> }
  [IPC_CHANNELS.voiceStart]: { args: [string]; result: IpcResult<void> }
  [IPC_CHANNELS.voiceStop]: { args: []; result: IpcResult<void> }
  [IPC_CHANNELS.voiceSetMicMuted]: { args: [boolean]; result: IpcResult<void> }
  [IPC_CHANNELS.voiceSetDeafened]: { args: [boolean]; result: IpcResult<void> }
  [IPC_CHANNELS.voiceStopSpeaking]: { args: [SpeechControlInput]; result: IpcResult<void> }
  [IPC_CHANNELS.voiceListDevices]: { args: []; result: IpcResult<AudioDeviceInfo[]> }
  [IPC_CHANNELS.voiceTimings]: { args: []; result: IpcResult<TimingSample[]> }
  [IPC_CHANNELS.readWorkspaceFile]: { args: [ReadFileInput]; result: IpcResult<FileContents> }
  [IPC_CHANNELS.listWorkspaceDir]: { args: [ListDirInput]; result: IpcResult<DirEntry[]> }
  [IPC_CHANNELS.searchWorkspace]: { args: [SearchInput]; result: IpcResult<SearchHit[]> }
  [IPC_CHANNELS.getWorkspaceDiff]: { args: [string]; result: IpcResult<WorkspaceDiff> }
  [IPC_CHANNELS.cancelJob]: { args: [string]; result: IpcResult<void> }
  [IPC_CHANNELS.getJobOutput]: { args: [string]; result: IpcResult<JobOutput> }
  [IPC_CHANNELS.runIntegration]: { args: [IntegrationInput]; result: IpcResult<void> }
  [IPC_CHANNELS.startPreview]: { args: [string, string]; result: IpcResult<PreviewInfo> }
  [IPC_CHANNELS.openBrowserSession]: {
    args: [OpenBrowserInput]
    result: IpcResult<BrowserSessionRecord>
  }
  [IPC_CHANNELS.closeBrowserSession]: { args: [string]; result: IpcResult<void> }
  [IPC_CHANNELS.browserNavigate]: {
    args: [NavigateInput]
    result: IpcResult<BrowserSessionRecord>
  }
  [IPC_CHANNELS.browserScreenshot]: { args: [string]; result: IpcResult<ScreenshotResult> }
  [IPC_CHANNELS.browserNetwork]: { args: [string, string | undefined]; result: IpcResult<NetworkEntry[]> }
  [IPC_CHANNELS.updateSettings]: { args: [Partial<AppSettings>]; result: IpcResult<AppSettings> }
  [IPC_CHANNELS.setSecret]: { args: [SetSecretInput]; result: IpcResult<Capability> }
  [IPC_CHANNELS.refreshCapabilities]: { args: []; result: IpcResult<Capability[]> }
  [IPC_CHANNELS.listModels]: { args: []; result: IpcResult<ModelOption[]> }
  [IPC_CHANNELS.listVoices]: { args: []; result: IpcResult<VoiceOption[]> }
  [IPC_CHANNELS.previewVoice]: { args: [string]; result: IpcResult<void> }
  [IPC_CHANNELS.revealPath]: { args: [string]; result: IpcResult<void> }
}

/** Channels the renderer may `send` on (fire and forget). */
export const RENDERER_SEND_CHANNELS: readonly string[] = [
  IPC_CHANNELS.voiceMicFrame,
  IPC_CHANNELS.voiceClientEvent
]

export type ContextRefInput = ContextRef
