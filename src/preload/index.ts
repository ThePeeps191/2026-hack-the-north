import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  type DirEntry,
  type FileContents,
  type HuddleApi,
  type IntegrationInput,
  type JobOutput,
  type ListDirInput,
  type ModelOption,
  type NavigateInput,
  type NetworkEntry,
  type OpenBrowserInput,
  type PreviewInfo,
  type ReadFileInput,
  type RecordDecisionInput,
  type ResumeInput,
  type ScreenshotResult,
  type SearchHit,
  type SearchInput,
  type SetSecretInput,
  type VoiceOption,
  type WorkspaceDiff
} from '../shared/api.ts'
import type {
  AddAgentInput,
  Agent,
  AppSettings,
  AppSnapshot,
  BrowserSessionRecord,
  Capability,
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
} from '../shared/types.ts'
import type {
  AudioChunkMessage,
  AudioDeviceInfo,
  PlaybackClientEvent,
  PlaybackServerEvent
} from '../shared/voice.ts'

/**
 * The only bridge between the sandboxed renderer and the main process.
 *
 * There is no raw `ipcRenderer`, no channel string and no filesystem access
 * here: the renderer can call exactly the named operations below and nothing
 * else. Every failure comes back as a typed error carrying a stable `code` and,
 * where we actually have one, a concrete `fix`.
 */

export class HuddleIpcError extends Error {
  readonly code: string
  readonly fix: string | undefined

  constructor(code: string, message: string, fix?: string) {
    super(message)
    this.name = 'HuddleIpcError'
    this.code = code
    this.fix = fix
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T> | undefined
  if (!result || typeof result !== 'object' || !('ok' in result)) {
    throw new HuddleIpcError('malformed_response', 'Huddle received a malformed response.')
  }
  if (!result.ok) {
    throw new HuddleIpcError(result.error.code, result.error.message, result.error.fix)
  }
  return result.value
}

function subscribeTo<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api: HuddleApi = {
  getSnapshot: () => invoke<AppSnapshot>(IPC_CHANNELS.getSnapshot),
  subscribe: (listener: (event: RuntimeEvent) => void) =>
    subscribeTo<RuntimeEvent>(IPC_CHANNELS.event, listener),

  createRoom: (input?: CreateRoomInput) => invoke<Room>(IPC_CHANNELS.createRoom, input),
  updateRoom: (input: UpdateRoomInput) => invoke<Room>(IPC_CHANNELS.updateRoom, input),
  selectRoom: (roomId: string) => invoke<void>(IPC_CHANNELS.selectRoom, roomId),
  removeRoom: (roomId: string) => invoke<void>(IPC_CHANNELS.removeRoom, roomId),
  joinCall: (roomId: string) => invoke<void>(IPC_CHANNELS.joinCall, roomId),
  leaveCall: (roomId: string) => invoke<void>(IPC_CHANNELS.leaveCall, roomId),

  addAgent: (input: AddAgentInput) => invoke<Agent>(IPC_CHANNELS.addAgent, input),
  updateAgent: (input: UpdateAgentInput) => invoke<Agent>(IPC_CHANNELS.updateAgent, input),
  removeAgent: (agentId: string) => invoke<void>(IPC_CHANNELS.removeAgent, agentId),

  sendMessage: (input: SendMessageInput) => invoke<Message>(IPC_CHANNELS.sendMessage, input),

  recordDecision: (input: RecordDecisionInput) =>
    invoke<Decision>(IPC_CHANNELS.recordDecision, input),
  controlWork: (input: WorkControlInput) => invoke<void>(IPC_CHANNELS.controlWork, input),
  retryTask: (taskId: string) => invoke<Task>(IPC_CHANNELS.retryTask, taskId),
  resumeItem: (input: ResumeInput) => invoke<void>(IPC_CHANNELS.resumeItem, input),
  dismissResumable: (input: ResumeInput) => invoke<void>(IPC_CHANNELS.dismissResumable, input),

  chooseProjectFolder: () => invoke<string | null>(IPC_CHANNELS.chooseProjectFolder),
  bindProject: (input) => invoke<Room>(IPC_CHANNELS.bindProject, input),
  createDemoProject: (roomId: string) => invoke<Room>(IPC_CHANNELS.createDemoProject, roomId),
  setStage: (input: StageInput) => invoke<Room>(IPC_CHANNELS.setStage, input),

  voice: {
    start: (roomId: string) => invoke<void>(IPC_CHANNELS.voiceStart, roomId),
    stop: () => invoke<void>(IPC_CHANNELS.voiceStop),
    setMicMuted: (muted: boolean) => invoke<void>(IPC_CHANNELS.voiceSetMicMuted, muted),
    setDeafened: (deafened: boolean) => invoke<void>(IPC_CHANNELS.voiceSetDeafened, deafened),
    stopSpeaking: (input: SpeechControlInput) => invoke<void>(IPC_CHANNELS.voiceStopSpeaking, input),
    listDevices: () => invoke<AudioDeviceInfo[]>(IPC_CHANNELS.voiceListDevices),
    timings: () => invoke<TimingSample[]>(IPC_CHANNELS.voiceTimings),
    sendMicFrame: (pcm: ArrayBuffer, capturedAt: number) => {
      ipcRenderer.send(IPC_CHANNELS.voiceMicFrame, pcm, capturedAt)
    },
    reportClientEvent: (event: PlaybackClientEvent) => {
      ipcRenderer.send(IPC_CHANNELS.voiceClientEvent, event)
    },
    onServerEvent: (listener: (event: PlaybackServerEvent) => void) =>
      subscribeTo<PlaybackServerEvent>(IPC_CHANNELS.voiceServerEvent, listener),
    onAudioChunk: (listener: (chunk: AudioChunkMessage) => void) =>
      subscribeTo<AudioChunkMessage>(IPC_CHANNELS.voiceAudioChunk, listener)
  },

  exec: {
    readFile: (input: ReadFileInput) => invoke<FileContents>(IPC_CHANNELS.readWorkspaceFile, input),
    listDir: (input: ListDirInput) => invoke<DirEntry[]>(IPC_CHANNELS.listWorkspaceDir, input),
    search: (input: SearchInput) => invoke<SearchHit[]>(IPC_CHANNELS.searchWorkspace, input),
    diff: (workspaceId: string) => invoke<WorkspaceDiff>(IPC_CHANNELS.getWorkspaceDiff, workspaceId),
    cancelJob: (jobId: string) => invoke<void>(IPC_CHANNELS.cancelJob, jobId),
    jobOutput: (jobId: string) => invoke<JobOutput>(IPC_CHANNELS.getJobOutput, jobId),
    runIntegration: (input: IntegrationInput) => invoke<void>(IPC_CHANNELS.runIntegration, input),
    startPreview: (roomId: string, workspaceId: string) =>
      invoke<PreviewInfo>(IPC_CHANNELS.startPreview, roomId, workspaceId)
  },

  browser: {
    open: (input: OpenBrowserInput) =>
      invoke<BrowserSessionRecord>(IPC_CHANNELS.openBrowserSession, input),
    close: (sessionId: string) => invoke<void>(IPC_CHANNELS.closeBrowserSession, sessionId),
    navigate: (input: NavigateInput) =>
      invoke<BrowserSessionRecord>(IPC_CHANNELS.browserNavigate, input),
    screenshot: (sessionId: string) =>
      invoke<ScreenshotResult>(IPC_CHANNELS.browserScreenshot, sessionId),
    network: (sessionId: string, filter?: string) =>
      invoke<NetworkEntry[]>(IPC_CHANNELS.browserNetwork, sessionId, filter)
  },

  settings: {
    update: (settings: Partial<AppSettings>) =>
      invoke<AppSettings>(IPC_CHANNELS.updateSettings, settings),
    setSecret: (input: SetSecretInput) => invoke<Capability>(IPC_CHANNELS.setSecret, input),
    refreshCapabilities: () => invoke<Capability[]>(IPC_CHANNELS.refreshCapabilities),
    listModels: () => invoke<ModelOption[]>(IPC_CHANNELS.listModels),
    listVoices: () => invoke<VoiceOption[]>(IPC_CHANNELS.listVoices),
    previewVoice: (voiceId: string) => invoke<void>(IPC_CHANNELS.previewVoice, voiceId),
    revealPath: (path: string) => invoke<void>(IPC_CHANNELS.revealPath, path)
  }
}

contextBridge.exposeInMainWorld('huddle', api)
