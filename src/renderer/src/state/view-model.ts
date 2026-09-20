import type { ReactNode } from 'react'
import type {
  Agent,
  AgentPresetId,
  AppSettings,
  AppSnapshot,
  Artifact,
  BrowserSessionRecord,
  Capability,
  CallState,
  ContextRef,
  Decision,
  IntegrationAttempt,
  JobRecord,
  LiveTranscript,
  Message,
  ResumableItem,
  Room,
  ShareSurface,
  StageState,
  Task,
  WorkspaceRecord
} from '../../../shared/types'

/**
 * The contract between the integration lead (App.tsx, useHuddle) and the call UI.
 * The UI renders exactly what it is given and calls back; it never talks to
 * `window.huddle` directly and never derives truth of its own.
 */

/** Playback truth for one agent, sourced from the audio device, not from tokens. */
export interface SpeakingState {
  agentId: string
  generationId: string
  /** Caption text currently being spoken. */
  text: string
  /** 0..1 rough envelope for the speaking ring. */
  level: number
  messageId: string | null
}

export interface HumanPresence {
  name: string
  muted: boolean
  deafened: boolean
  /** Live mic level 0..1 while unmuted. */
  level: number
  /** True while local VAD says the human is speaking. */
  speaking: boolean
}

export interface CallActions {
  // rooms
  createRoom: (input?: { name?: string; agentCount?: number }) => Promise<void>
  selectRoom: (roomId: string) => Promise<void>
  removeRoom: (roomId: string) => Promise<void>
  renameRoom: (name: string) => Promise<void>
  setGoal: (goal: string) => Promise<void>

  // call
  joinCall: () => Promise<void>
  leaveCall: () => Promise<void>
  toggleMic: () => Promise<void>
  toggleDeafen: () => Promise<void>
  /** Cancels current audio and obsolete queued speech. Never cancels work. */
  stopSpeaking: (scope: 'current' | 'all') => Promise<void>

  // roster
  addAgent: (presetId: AgentPresetId, options?: { name?: string; assignment?: string }) => Promise<void>
  removeAgent: (agentId: string) => Promise<void>
  setAgentVoice: (agentId: string, voiceId: string) => Promise<void>

  // conversation
  sendMessage: (
    body: string,
    options?: { to?: string[]; refs?: ContextRef[]; replyToId?: string; privateTo?: string }
  ) => Promise<void>

  // stage
  setStage: (stage: StageState) => Promise<void>
  showGallery: () => Promise<void>
  showShare: (owner: { kind: 'team' } | { kind: 'agent'; agentId: string }, surface: ShareSurface) => Promise<void>
  openSpotlight: (agentId: string, surface?: ShareSurface) => Promise<void>
  setFollow: (follow: boolean) => Promise<void>

  // project + work
  chooseProject: () => Promise<void>
  useDemoProject: () => Promise<void>
  recordDecision: (input: { title: string; statement: string; rationale?: string; supersedesId?: string | null }) => Promise<void>
  pauseWork: (agentId?: string) => Promise<void>
  resumeWork: (agentId?: string) => Promise<void>
  cancelTask: (taskId: string) => Promise<void>
  retryTask: (taskId: string) => Promise<void>
  runIntegration: () => Promise<void>
  cancelJob: (jobId: string) => Promise<void>
  resumeItem: (itemId: string) => Promise<void>
  dismissResumable: (itemId: string) => Promise<void>

  // settings
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  setSecret: (key: string, value: string) => Promise<void>
  refreshCapabilities: () => Promise<void>
  previewVoice: (voiceId: string) => Promise<void>
  revealPath: (path: string) => Promise<void>
}

/** A real backend notice: something happened that the person should see. */
export interface NoticeItem {
  id: string
  level: 'info' | 'warn' | 'error'
  text: string
  /** Concrete next step, when we actually have one. */
  fix?: string
  at: string
  roomId: string
}

export interface CallScreenProps {
  snapshot: AppSnapshot
  room: Room
  rooms: Room[]
  agents: Agent[]
  messages: Message[]
  tasks: Task[]
  decisions: Decision[]
  jobs: JobRecord[]
  workspaces: WorkspaceRecord[]
  browserSessions: BrowserSessionRecord[]
  artifacts: Artifact[]
  integrations: IntegrationAttempt[]
  capabilities: Capability[]
  resumable: ResumableItem[]
  settings: AppSettings
  call: CallState
  human: HumanPresence
  /** Provisional transcript of what the human is saying right now, if any. */
  liveTranscript: LiveTranscript | null
  /** agentId -> live playback state. Absent means that agent is silent. */
  speaking: Record<string, SpeakingState>
  /** Real notices from the backend, newest last. */
  notices: NoticeItem[]
  /** Non-fatal action error to surface inline. */
  error: string | null
  actions: CallActions
  onOpenRef: (ref: ContextRef, surface?: ShareSurface) => void
  /**
   * Renders the real workspace surface. Supplied by the integration lead and
   * backed by the execution and browser modules. The call UI provides the frame
   * (header, tabs, ownership label, verified badge) and calls this for the body.
   */
  renderSurface: (args: {
    surface: ShareSurface
    owner: { kind: 'team' } | { kind: 'agent'; agentId: string }
    workspace: WorkspaceRecord | null
    agent: Agent | null
    /** Attach a reference (code span, screenshot region) to the message composer. */
    onAttachRef: (ref: ContextRef) => void
  }) => ReactNode
}

/** Helper: agents ordered the way the grid should show them. */
export function orderAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Helper: the workspace a given owner is showing. */
export function workspaceFor(
  workspaces: WorkspaceRecord[],
  owner: { kind: 'team' } | { kind: 'agent'; agentId: string }
): WorkspaceRecord | null {
  if (owner.kind === 'team') {
    return workspaces.find((workspace) => workspace.kind === 'team') ?? null
  }
  return workspaces.find((workspace) => workspace.agentId === owner.agentId) ?? null
}

/** Helper: active (non-superseded) decisions, newest first. */
export function activeDecisions(decisions: Decision[]): Decision[] {
  return decisions
    .filter((decision) => decision.status === 'active')
    .sort((a, b) => b.revision - a.revision)
}

/** Helper: tasks grouped by owner, dependency-blocked ones flagged. */
export function tasksByOwner(tasks: Task[]): Map<string | null, Task[]> {
  const grouped = new Map<string | null, Task[]>()
  for (const task of tasks) {
    const list = grouped.get(task.ownerAgentId) ?? []
    list.push(task)
    grouped.set(task.ownerAgentId, list)
  }
  return grouped
}
