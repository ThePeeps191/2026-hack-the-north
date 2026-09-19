import type { HuddleBus } from '../contracts.ts'
import type { RecordDecisionInput } from '../../shared/api.ts'
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
  Task,
  TimingSample,
  ToolRun,
  WorkspaceRecord
} from '../../shared/types.ts'
import { DEFAULT_SETTINGS } from '../../shared/types.ts'

/**
 * An in-memory `HuddleBus` for tests.
 *
 * It records everything the execution host reports so a test can assert on real
 * behaviour: job records, notices, integrations and artifacts. It performs no
 * persistence and simulates nothing else.
 */

export interface FakeBus extends HuddleBus {
  sequence: number
  jobs: Map<string, JobRecord>
  workspaces: Map<string, WorkspaceRecord>
  integrations: IntegrationAttempt[]
  /** Every upsert in call order, so serialisation can be asserted. */
  integrationLog: Array<{ id: string; status: IntegrationAttempt['status'] }>
  artifacts: Artifact[]
  notices: Array<{ roomId: string; level: 'info' | 'warn' | 'error'; text: string; fix: string | null }>
  rooms: Map<string, Room>
  agents: Map<string, Agent>
  events: RuntimeEvent[]
  settings: AppSettings
  addRoom(roomId: string, project?: ProjectBinding | null): Room
  setProject(roomId: string, project: ProjectBinding): Room
  addAgent(agent: Agent): Agent
  upsertTaskForTest(task: Task): void
}

export function fakeAgent(roomId: string, id: string, name: string): Agent {
  const at = new Date().toISOString()
  return {
    id,
    roomId,
    presetId: 'maya',
    name,
    role: 'frontend',
    summary: `${name} test agent`,
    persona: `${name} is a test agent.`,
    color: '#888888',
    avatar: 'maya',
    voice: { voiceId: 'voice', voiceName: 'Test voice', speed: 1, stability: 0.5, similarityBoost: 0.75 },
    model: 'test-model',
    workState: 'idle',
    speechState: 'silent',
    activityLabel: 'idle',
    connected: false,
    workspaceId: null,
    browserSessionId: null,
    createdAt: at,
    updatedAt: at
  }
}

export function fakeRoom(roomId: string, project: ProjectBinding | null = null): Room {
  const at = new Date().toISOString()
  return {
    id: roomId,
    name: `Room ${roomId}`,
    goal: 'A test goal',
    createdAt: at,
    updatedAt: at,
    stage: { mode: { kind: 'gallery' }, follow: true, pendingHint: null },
    project,
    joined: false,
    decisionRevision: 1
  }
}

export function createFakeBus(): FakeBus {
  const bus: FakeBus = {
    sequence: 0,
    jobs: new Map<string, JobRecord>(),
    workspaces: new Map<string, WorkspaceRecord>(),
    integrations: [],
    integrationLog: [],
    artifacts: [],
    notices: [],
    rooms: new Map<string, Room>(),
    agents: new Map<string, Agent>(),
    events: [],
    settings: DEFAULT_SETTINGS,

    emit(roomId: string, body: RuntimeEventBody): RuntimeEvent {
      bus.sequence += 1
      const event = {
        ...body,
        id: `evt-${bus.sequence}`,
        seq: bus.sequence,
        roomId,
        createdAt: bus.now(),
        durable: true
      } as RuntimeEvent
      bus.events.push(event)
      return event
    },
    notice(roomId, level, text, fix) {
      bus.notices.push({ roomId, level, text, fix: fix ?? null })
    },
    upsertJob(job) {
      bus.jobs.set(job.id, { ...job })
    },
    appendJobOutput(job, chunk, stream) {
      bus.emit(job.roomId, { type: 'job.output', jobId: job.id, chunk, stream })
    },
    upsertWorkspace(workspace) {
      bus.workspaces.set(workspace.id, { ...workspace })
    },
    upsertBrowserSession() {
      // Not exercised by execution tests.
    },
    upsertIntegration(attempt) {
      bus.integrationLog.push({ id: attempt.id, status: attempt.status })
      const index = bus.integrations.findIndex((entry) => entry.id === attempt.id)
      if (index >= 0) bus.integrations[index] = { ...attempt }
      else bus.integrations.push({ ...attempt })
    },
    addArtifact(artifact) {
      bus.artifacts.push({ ...artifact })
    },
    updateAgent(agentId, patch) {
      const agent = bus.agents.get(agentId)
      if (agent === undefined) return null
      const next = { ...agent, ...patch }
      bus.agents.set(agentId, next)
      return next
    },
    upsertTask() {
      // Not exercised by execution tests.
    },
    recordTimings(samples: TimingSample[]) {
      bus.events.push(
        ...samples.map((sample) => ({
          type: 'voice.timing' as const,
          sample,
          id: `evt-${(bus.sequence += 1)}`,
          seq: bus.sequence,
          roomId: '',
          createdAt: bus.now(),
          durable: false
        }))
      )
    },
    setAgentActivity() {
      // Not exercised by execution tests.
    },
    setAgentSpeech() {
      // Not exercised by execution tests.
    },
    proposeStage() {
      // Not exercised by execution tests.
    },
    addMessage(message: Message) {
      bus.emit(message.roomId, { type: 'message.created', message })
      return message
    },
    updateMessage() {
      return null
    },
    addMemory(entry: MemoryEntry) {
      bus.emit(entry.roomId, { type: 'memory.created', entry })
    },
    async recordDecision(input: RecordDecisionInput, source: MessageAuthor): Promise<Decision> {
      const decision: Decision = {
        id: bus.newId(),
        roomId: input.roomId,
        revision: bus.sequence + 1,
        title: input.title,
        statement: input.statement,
        rationale: input.rationale ?? '',
        source,
        status: 'active',
        supersedesId: input.supersedesId ?? null,
        supersededById: null,
        affectedTaskIds: [],
        originMessageId: input.originMessageId ?? null,
        createdAt: bus.now()
      }
      bus.emit(input.roomId, { type: 'decision.created', decision, affected: [] })
      return decision
    },
    recordToolRun(run: ToolRun) {
      bus.emit(run.roomId, { type: 'toolrun.finished', run })
    },
    getToolRuns() {
      return []
    },
    getDecisions() {
      return []
    },
    getIntegrations(roomId: string) {
      return bus.integrations.filter((attempt) => attempt.roomId === roomId)
    },
    getSettings() {
      return bus.settings
    },
    getRoom(roomId: string) {
      return bus.rooms.get(roomId) ?? null
    },
    getAgent(agentId: string) {
      return bus.agents.get(agentId) ?? null
    },
    getAgents(roomId: string) {
      return [...bus.agents.values()].filter((agent) => agent.roomId === roomId)
    },
    getTasks() {
      return []
    },
    getTask() {
      return null
    },
    getActiveDecisions() {
      return []
    },
    getMessages() {
      return []
    },
    getMemories() {
      return []
    },
    getWorkspaces(roomId: string) {
      return [...bus.workspaces.values()].filter((workspace) => workspace.roomId === roomId)
    },
    getJobs(roomId: string) {
      return [...bus.jobs.values()].filter((job) => job.roomId === roomId)
    },
    getBrowserSessions() {
      return []
    },
    getArtifacts(roomId: string) {
      return bus.artifacts.filter((artifact) => artifact.roomId === roomId)
    },
    newId() {
      bus.sequence += 1
      return `id-${bus.sequence}`
    },
    now() {
      return new Date().toISOString()
    },

    addRoom(roomId: string, project: ProjectBinding | null = null) {
      const room = fakeRoom(roomId, project)
      bus.rooms.set(roomId, room)
      return room
    },
    setProject(roomId: string, project: ProjectBinding) {
      const room = bus.rooms.get(roomId) ?? bus.addRoom(roomId)
      const next = { ...room, project }
      bus.rooms.set(roomId, next)
      return next
    },
    addAgent(agent: Agent) {
      bus.agents.set(agent.id, agent)
      return agent
    },
    upsertTaskForTest() {
      // Not exercised by execution tests.
    }
  }

  return bus
}
