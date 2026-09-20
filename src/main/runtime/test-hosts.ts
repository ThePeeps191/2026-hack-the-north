/**
 * In-memory test doubles for the runtime's hosts.
 *
 * These implement the real contracts from `../contracts.ts` (TypeScript checks
 * that), so a unit test exercises the same shapes the app uses without a
 * network, a microphone, a browser or an API key. `FakeExec` records every call
 * it receives, which is how tests prove that filesystem work goes through
 * `ExecutionHost` and nowhere else.
 *
 * Not a `*.test.ts` file: it is a helper module, not a suite.
 */

import type {
  Agent,
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
  TimingSample,
  ToolRun,
  WorkspaceRecord
} from '../../shared/types.ts'
import { DEFAULT_SETTINGS } from '../../shared/types.ts'
import type { RecordDecisionInput, DirEntry, FileContents, JobOutput, PreviewInfo, ScreenshotResult, VoiceOption, WorkspaceDiff } from '../../shared/api.ts'
import type {
  BrowserActionInput,
  BrowserActionResult,
  BrowserHost,
  BrowserObservation,
  ExecutionHost,
  HuddleBus,
  IntegrateInput,
  NetworkCapture,
  PatchResult,
  RuntimeDeps,
  SearchHit,
  SpeechHandle,
  SpeechIntent,
  StartJobInput,
  SubmitInput,
  SubmitResult,
  VoiceHost,
  WriteResult
} from '../contracts.ts'
import type { HaltReason, PlaybackClientEvent } from '../../shared/voice.ts'

export function makeAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'maya',
    roomId: 'r1',
    presetId: 'maya',
    name: 'Maya',
    title: '',
    role: 'frontend',
    summary: 'Frontend — interface, interaction and styling',
    persona: 'You are Maya, the frontend engineer.',
    color: '#6f5bd6',
    avatar: 'prism',
    voice: { voiceId: 'v1', voiceName: 'Laura', speed: 1, stability: 0.4, similarityBoost: 0.75 },
    model: 'gpt-5.6-luna',
    workState: 'idle',
    speechState: 'silent',
    activityLabel: 'Available',
    connected: true,
    workspaceId: null,
    browserSessionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

export function makeRoom(over: Partial<Room> = {}): Room {
  return {
    id: 'r1',
    name: 'Huddle demo',
    goal: 'Build a live vote screen',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    stage: { mode: { kind: 'gallery' }, follow: true, pendingHint: null },
    project: null,
    joined: true,
    decisionRevision: 1,
    ...over
  }
}

export class FakeBus implements HuddleBus {
  private readonly counters = new Map<string, number>()
  rooms: Room[] = [makeRoom()]
  agents: Agent[] = [makeAgent()]
  tasks: Task[] = []
  messages: Message[] = []
  toolRuns: ToolRun[] = []
  jobs: JobRecord[] = []
  decisions: Decision[] = []
  artifacts: Artifact[] = []
  workspaces: WorkspaceRecord[] = []
  memories: MemoryEntry[] = []
  integrations: IntegrationAttempt[] = []
  browserSessions: BrowserSessionRecord[] = []
  events: RuntimeEventBody[] = []
  activities: Array<{ agentId: string; state: string; label: string }> = []
  notices: Array<{ roomId: string; level: string; text: string; fix?: string }> = []
  stages: Array<{ roomId: string; agentId: string; surface: ShareSurface }> = []
  settings: AppSettings = structuredClone(DEFAULT_SETTINGS)

  emit(roomId: string, body: RuntimeEventBody): RuntimeEvent {
    this.events.push(body)
    const envelope = {
      id: this.newId(),
      seq: this.events.length,
      roomId,
      createdAt: this.now(),
      durable: true
    }
    return Object.assign(envelope, body) as RuntimeEvent
  }

  notice(roomId: string, level: 'info' | 'warn' | 'error', text: string, fix?: string): void {
    this.notices.push(fix === undefined ? { roomId, level, text } : { roomId, level, text, fix })
  }

  upsertJob(job: JobRecord): void {
    this.jobs = upsert(this.jobs, job)
  }

  appendJobOutput(job: JobRecord): void {
    this.emit(job.roomId, { type: 'job.output', jobId: job.id, chunk: '', stream: 'stdout' })
  }

  upsertWorkspace(workspace: WorkspaceRecord): void {
    this.workspaces = upsert(this.workspaces, workspace)
  }

  upsertBrowserSession(session: BrowserSessionRecord): void {
    this.browserSessions = upsert(this.browserSessions, session)
  }

  upsertIntegration(attempt: IntegrationAttempt): void {
    this.integrations = upsert(this.integrations, attempt)
  }

  addArtifact(artifact: Artifact): void {
    this.artifacts = upsert(this.artifacts, artifact)
  }

  updateAgent(agentId: string, patch: Partial<Agent>): Agent | null {
    const agent = this.agents.find((candidate) => candidate.id === agentId)
    if (!agent) return null
    Object.assign(agent, patch)
    return { ...agent }
  }

  upsertAgent(agent: Agent): Agent {
    const existing = this.agents.find((candidate) => candidate.id === agent.id)
    if (existing) {
      Object.assign(existing, agent)
      return { ...existing }
    }
    this.agents.push(agent)
    return { ...agent }
  }

  removeAgentById(agentId: string): boolean {
    const before = this.agents.length
    this.agents = this.agents.filter((agent) => agent.id !== agentId)
    return this.agents.length < before
  }

  upsertTask(task: Task): void {
    this.tasks = upsert(this.tasks, task)
  }

  recordTimings(samples: TimingSample[]): void {
    for (const sample of samples) this.events.push({ type: 'voice.timing', sample })
  }

  setAgentActivity(agentId: string, workState: Agent['workState'], label: string): void {
    this.activities.push({ agentId, state: workState, label })
    const agent = this.agents.find((candidate) => candidate.id === agentId)
    if (agent) {
      agent.workState = workState
      agent.activityLabel = label
    }
  }

  setAgentSpeech(agentId: string, speechState: Agent['speechState']): void {
    const agent = this.agents.find((candidate) => candidate.id === agentId)
    if (agent) agent.speechState = speechState
  }

  proposeStage(roomId: string, agentId: string, surface: ShareSurface): void {
    this.stages.push({ roomId, agentId, surface })
  }

  addMessage(message: Message): Message {
    this.messages = upsert(this.messages, message)
    return message
  }

  updateMessage(messageId: string, patch: Partial<Message>): Message | null {
    const message = this.messages.find((candidate) => candidate.id === messageId)
    if (!message) return null
    Object.assign(message, patch)
    return message
  }

  addMemory(entry: MemoryEntry): void {
    this.memories = upsert(this.memories, entry)
  }

  async recordDecision(input: RecordDecisionInput, source: MessageAuthor): Promise<Decision> {
    const stored = this.rooms.find((candidate) => candidate.id === input.roomId)
    const revision = (stored?.decisionRevision ?? 0) + 1
    const decision: Decision = {
      id: this.newId(),
      roomId: input.roomId,
      revision,
      title: input.title,
      statement: input.statement,
      rationale: input.rationale ?? '',
      source,
      status: 'active',
      supersedesId: input.supersedesId ?? null,
      supersededById: null,
      affectedTaskIds: this.tasks.filter((task) => task.roomId === input.roomId).map((task) => task.id),
      originMessageId: input.originMessageId ?? null,
      createdAt: this.now()
    }
    this.decisions.push(decision)
    if (stored) {
      stored.decisionRevision = revision
      stored.updatedAt = decision.createdAt
    }
    return decision
  }

  recordToolRun(run: ToolRun): void {
    this.toolRuns = upsert(this.toolRuns, run)
    if (run.endedAt) this.emit(run.roomId, { type: 'toolrun.finished', run })
    else this.emit(run.roomId, { type: 'toolrun.started', run })
  }

  getToolRuns(roomId: string): ToolRun[] {
    return this.toolRuns.filter((run) => run.roomId === roomId)
  }

  getDecisions(): Decision[] {
    return [...this.decisions]
  }

  getIntegrations(roomId: string): IntegrationAttempt[] {
    return this.integrations.filter((attempt) => attempt.roomId === roomId)
  }

  getSettings(): AppSettings {
    return structuredClone(this.settings)
  }

  getRoom(roomId: string): Room | null {
    const room = this.rooms.find((candidate) => candidate.id === roomId)
    return room ? structuredClone(room) : null
  }

  getAgent(agentId: string): Agent | null {
    const agent = this.agents.find((candidate) => candidate.id === agentId)
    return agent ? { ...agent } : null
  }

  getAgents(roomId: string): Agent[] {
    return this.agents.filter((agent) => agent.roomId === roomId).map((agent) => ({ ...agent }))
  }

  getTasks(roomId: string): Task[] {
    return this.tasks.filter((task) => task.roomId === roomId).map((task) => structuredClone(task))
  }

  getTask(taskId: string): Task | null {
    const task = this.tasks.find((candidate) => candidate.id === taskId)
    return task ? structuredClone(task) : null
  }

  getActiveDecisions(roomId: string): Decision[] {
    return this.decisions.filter((decision) => decision.roomId === roomId && decision.status === 'active')
  }

  getMessages(roomId: string, limit = 60): Message[] {
    return this.messages.filter((message) => message.roomId === roomId).slice(-limit)
  }

  getMemories(roomId: string): MemoryEntry[] {
    return this.memories.filter((entry) => entry.roomId === roomId)
  }

  getWorkspaces(roomId: string): WorkspaceRecord[] {
    return this.workspaces.filter((workspace) => workspace.roomId === roomId)
  }

  getJobs(roomId: string): JobRecord[] {
    return this.jobs.filter((job) => job.roomId === roomId)
  }

  getBrowserSessions(roomId: string): BrowserSessionRecord[] {
    return this.browserSessions.filter((session) => session.roomId === roomId)
  }

  getArtifacts(roomId: string): Artifact[] {
    return this.artifacts.filter((artifact) => artifact.roomId === roomId)
  }

  newId(): string {
    const next = (this.counters.get('id') ?? 0) + 1
    this.counters.set('id', next)
    return `id-${next}`
  }

  now(): string {
    const next = (this.counters.get('t') ?? 0) + 1
    this.counters.set('t', next)
    return new Date(1_700_000_000_000 + next * 1000).toISOString()
  }
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id)
  if (index >= 0) {
    const next = [...items]
    next[index] = item
    return next
  }
  return [...items, item]
}

/* ------------------------------------------------------------------ *
 * Execution host
 * ------------------------------------------------------------------ */

export class FakeExec implements ExecutionHost {
  calls: Array<{ method: string; args: unknown[] }> = []
  files = new Map<string, string>()
  nextJobStatus: JobRecord['status'] = 'exited'
  nextExitCode: number | null = 0
  /** When set, started and awaited jobs are registered on the bus, as the real host does. */
  bus: FakeBus | null = null
  preview: PreviewInfo = {
    roomId: 'r1',
    workspaceId: 'ws-maya',
    publicUrl: 'https://preview.example',
    localUrl: 'http://localhost:5173',
    mode: 'tunnel',
    state: 'ready',
    detail: 'tunnel up'
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }

  private workspace(workspaceId: string, kind: 'agent' | 'team' = 'agent'): WorkspaceRecord {
    return {
      id: workspaceId,
      roomId: 'r1',
      agentId: kind === 'team' ? null : 'maya',
      kind,
      label: kind === 'team' ? 'Team' : 'Maya',
      rootPath: 'C:\\project',
      branch: kind === 'team' ? 'main' : 'maya/work',
      baseBranch: 'main',
      isWorktree: kind === 'agent',
      devPort: null,
      devJobId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastVerifiedRevision: kind === 'team' ? 'abc123' : null
    }
  }

  async bindProject(roomId: string, rootPath: string, kind: 'existing' | 'demo'): Promise<ProjectBinding> {
    this.record('bindProject', roomId, rootPath, kind)
    return { rootPath, kind, isGitRepo: true, hadDirtyWorkOnBind: false, boundAt: '2026-01-01T00:00:00.000Z' }
  }

  demoTemplatePath(): string {
    return 'C:\\template'
  }

  suggestDemoPath(): string {
    return 'C:\\demo'
  }

  async ensureTeamWorkspace(_roomId: string): Promise<WorkspaceRecord> {
    this.record('ensureTeamWorkspace')
    return this.workspace('ws-team', 'team')
  }

  async ensureAgentWorkspace(_roomId: string, agentId: string): Promise<WorkspaceRecord> {
    this.record('ensureAgentWorkspace', agentId)
    return this.workspace(`ws-${agentId}`)
  }

  getWorkspace(workspaceId: string): WorkspaceRecord | null {
    return this.workspace(workspaceId)
  }

  async readFile(workspaceId: string, path: string): Promise<FileContents> {
    this.record('readFile', workspaceId, path)
    const text = this.files.get(path) ?? 'export const value = 1\n'
    return {
      path: `/root/${path}`,
      relativePath: path,
      text,
      language: 'typescript',
      bytes: text.length,
      truncated: false,
      modifiedAt: '2026-01-01T00:00:00.000Z'
    }
  }

  async listDir(workspaceId: string, path?: string): Promise<DirEntry[]> {
    this.record('listDir', workspaceId, path)
    return [
      { name: 'src', path: path ? `${path}/src` : 'src', kind: 'dir', bytes: null, modifiedAt: null },
      { name: 'package.json', path: path ? `${path}/package.json` : 'package.json', kind: 'file', bytes: 120, modifiedAt: null }
    ]
  }

  async search(workspaceId: string, query: string): Promise<SearchHit[]> {
    this.record('search', workspaceId, query)
    return [{ path: 'src/App.tsx', line: 12, text: `const ${query} = 1` }]
  }

  async writeFile(workspaceId: string, path: string, contents: string): Promise<WriteResult> {
    this.record('writeFile', workspaceId, path, contents)
    const created = !this.files.has(path)
    this.files.set(path, contents)
    return { path: `/root/${path}`, relativePath: path, created, bytes: contents.length }
  }

  async applyPatch(workspaceId: string, patch: string): Promise<PatchResult> {
    this.record('applyPatch', workspaceId, patch)
    return { applied: true, files: ['src/App.tsx'], rejected: [], detail: 'applied' }
  }

  async diff(workspaceId: string): Promise<WorkspaceDiff> {
    this.record('diff', workspaceId)
    return {
      workspaceId,
      branch: 'maya/work',
      baseBranch: 'main',
      revision: 'abc123',
      files: [],
      note: null
    }
  }

  async startJob(input: StartJobInput): Promise<JobRecord> {
    this.record('startJob', input)
    const job: JobRecord = {
      id: 'job-1',
      roomId: input.roomId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      label: input.label,
      command: input.command,
      cwd: input.cwd ?? '.',
      status: this.nextJobStatus,
      exitCode: this.nextExitCode,
      pid: 4242,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      lastObservedAt: '2026-01-01T00:00:01.000Z',
      truncated: false,
      port: null
    }
    this.bus?.upsertJob(job)
    return job
  }

  async cancelJob(jobId: string): Promise<JobRecord> {
    this.record('cancelJob', jobId)
    const job = await this.startJob({
      roomId: 'r1',
      agentId: 'maya',
      workspaceId: 'ws-maya',
      label: 'cancelled',
      command: 'npm test'
    })
    return { ...job, id: jobId, status: 'cancelled' }
  }

  getJobOutput(jobId: string): JobOutput {
    this.record('getJobOutput', jobId)
    return { jobId, text: 'All tests passed', truncated: false, status: 'exited', exitCode: 0 }
  }

  async waitForJob(jobId: string): Promise<JobRecord> {
    this.record('waitForJob', jobId)
    const job: JobRecord = {
      id: jobId,
      roomId: 'r1',
      agentId: 'maya',
      workspaceId: 'ws-maya',
      label: 'unit tests',
      command: 'npm test',
      cwd: '.',
      status: 'exited',
      exitCode: 0,
      pid: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:02.000Z',
      lastObservedAt: '2026-01-01T00:00:02.000Z',
      truncated: false,
      port: null
    }
    this.bus?.upsertJob(job)
    return job
  }

  async submitWork(input: SubmitInput): Promise<SubmitResult> {
    this.record('submitWork', input)
    return { commit: 'c0ffee1234', branch: 'maya/work', filesChanged: 2, detail: 'committed' }
  }

  async integrate(input: IntegrateInput): Promise<IntegrationAttempt> {
    this.record('integrate', input)
    return {
      id: 'int-1',
      roomId: input.roomId,
      agentId: input.agentId,
      sources: [],
      targetBranch: 'main',
      status: 'verified',
      revision: 'verified123',
      checks: [{ name: 'npm test', command: 'npm test', status: 'pass', exitCode: 0, output: 'ok', durationMs: 10 }],
      conflicts: [],
      decisionRevision: input.decisionRevision,
      detail: 'folded in cleanly',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:03.000Z'
    }
  }

  async startPreview(): Promise<PreviewInfo> {
    this.record('startPreview')
    return this.preview
  }

  getPreview(): PreviewInfo | null {
    return this.preview
  }

  async stopPreview(): Promise<void> {
    this.record('stopPreview')
  }

  artifactDir(): string {
    return 'C:\\artifacts'
  }

  async writeArtifact(input: {
    roomId: string
    agentId: string | null
    taskId: string | null
    kind: Artifact['kind']
    title: string
    filename: string
    data: Buffer | string
    mime: string
  }): Promise<Artifact> {
    this.record('writeArtifact', input.title)
    return {
      id: 'artifact-1',
      roomId: input.roomId,
      agentId: input.agentId,
      taskId: input.taskId,
      kind: input.kind,
      title: input.title,
      path: `C:\\artifacts\\${input.filename}`,
      mime: input.mime,
      bytes: typeof input.data === 'string' ? input.data.length : input.data.byteLength,
      createdAt: '2026-01-01T00:00:00.000Z'
    }
  }

  async reconcile(): Promise<void> {
    this.record('reconcile')
  }

  async disposeRoom(): Promise<void> {
    this.record('disposeRoom')
  }

  async dispose(): Promise<void> {
    this.record('dispose')
  }
}

/* ------------------------------------------------------------------ *
 * Browser + voice hosts
 * ------------------------------------------------------------------ */

export class FakeBrowser implements BrowserHost {
  calls: string[] = []
  session: BrowserSessionRecord = {
    id: 'browser-1',
    roomId: 'r1',
    agentId: 'sam',
    provider: 'browserbase',
    remoteId: 'remote-1',
    liveViewUrl: 'https://liveview.example',
    status: 'live',
    currentUrl: 'https://app.example/vote',
    title: 'Vote',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    error: null,
    detail: 'session live'
  }

  observation: BrowserObservation = {
    url: 'https://app.example/vote',
    title: 'Vote',
    text: 'Cast your vote',
    elements: [{ ref: 'e1', role: 'button', name: 'Vote', selector: '#vote' }]
  }

  async openSession(): Promise<BrowserSessionRecord> {
    this.calls.push('openSession')
    return this.session
  }

  async closeSession(): Promise<void> {
    this.calls.push('closeSession')
  }

  getSession(): BrowserSessionRecord | null {
    return this.session
  }

  async act(input: BrowserActionInput): Promise<BrowserActionResult> {
    this.calls.push(`act:${input.action.kind}`)
    return { ok: true, detail: `${input.action.kind} ok`, observation: this.observation }
  }

  async observe(): Promise<BrowserObservation> {
    this.calls.push('observe')
    return this.observation
  }

  async screenshot(): Promise<ScreenshotResult> {
    this.calls.push('screenshot')
    return {
      artifact: {
        id: 'shot-1',
        roomId: 'r1',
        agentId: 'sam',
        taskId: null,
        kind: 'screenshot',
        title: 'Vote page',
        path: 'C:\\artifacts\\shot.png',
        mime: 'image/png',
        bytes: 1000,
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      viewport: { width: 1280, height: 800 },
      url: 'https://app.example/vote',
      dataUrl: 'data:image/png;base64,AAAA'
    }
  }

  async network(): Promise<NetworkCapture[]> {
    this.calls.push('network')
    return [{ url: 'https://app.example/api/votes', method: 'POST', status: 201, body: '{"ok":true}' }]
  }

  async reconcile(): Promise<void> {}

  async disposeRoom(): Promise<void> {}

  async dispose(): Promise<void> {}
}

export class FakeVoice implements VoiceHost {
  spoken: Array<{ agentId: string; text: string; reason: string }> = []
  invalidated: Array<{ roomId: string; revision: number }> = []
  stopped: Array<{ roomId: string; scope: string; reason: string }> = []
  failOnSpeak: string | null = null

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  isActive(): boolean {
    return true
  }

  activeRoomId(): string | null {
    return 'r1'
  }

  setMicMuted(): void {}

  setDeafened(): void {}

  pushMicFrame(): void {}

  reportClientEvent(_event: PlaybackClientEvent): void {}

  speak(intent: SpeechIntent): SpeechHandle {
    if (this.failOnSpeak) throw new Error(this.failOnSpeak)
    this.spoken.push({ agentId: intent.agentId, text: intent.text, reason: intent.reason })
    return {
      generationId: `gen-${intent.id}`,
      done: Promise.resolve({ state: 'played' as const, playedChars: intent.text.length })
    }
  }

  stopSpeaking(roomId: string, scope: 'current' | 'all', reason: HaltReason): void {
    this.stopped.push({ roomId, scope, reason })
  }

  invalidateSpeechBefore(roomId: string, decisionRevision: number): void {
    this.invalidated.push({ roomId, revision: decisionRevision })
  }

  async listVoices(): Promise<VoiceOption[]> {
    return []
  }

  async previewVoice(): Promise<void> {}

  timings(): TimingSample[] {
    return []
  }

  async dispose(): Promise<void> {}
}

/* ------------------------------------------------------------------ *
 * Deps
 * ------------------------------------------------------------------ */

export interface FakeDeps extends RuntimeDeps {
  bus: FakeBus
  exec: FakeExec
  browser: FakeBrowser
  voice: FakeVoice
}

export interface FakeDepsOverrides {
  capability?: Partial<Capability>
  bus?: FakeBus
  exec?: FakeExec
  browser?: FakeBrowser
  voice?: FakeVoice
}

export function fakeDeps(over: FakeDepsOverrides = {}): FakeDeps {
  const bus = over.bus ?? new FakeBus()
  const exec = over.exec ?? new FakeExec()
  const browser = over.browser ?? new FakeBrowser()
  const voice = over.voice ?? new FakeVoice()
  exec.bus = bus
  const capability: Capability = {
    id: 'openai',
    label: 'OpenAI',
    state: 'ready',
    detail: 'ready',
    fix: null,
    checkedAt: '2026-01-01T00:00:00.000Z',
    ...over.capability
  }
  return {
    bus,
    exec,
    browser,
    voice,
    capability: () => capability,
    settings: () => bus.getSettings()
  }
}
