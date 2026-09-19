/**
 * Room context: what an agent actually knows when it opens its mouth.
 *
 * Every prompt in the runtime is built from records the room really holds —
 * tasks, job records, tool runs, decisions, messages, artifacts, integrations —
 * never from a running summary the model produced about itself. When something
 * is unknown, the prompt says it is unknown.
 */

import type { Agent, JobRecord, Message, ToolRun } from '../../shared/types.ts'
import type { HuddleBus } from '../contracts.ts'

export interface RoomStateSnapshot {
  room: {
    id: string
    name: string
    goal: string
    decisionRevision: number
    projectRoot: string | null
    projectKind: string | null
  }
  agent: {
    id: string
    name: string
    role: string
    summary: string
  } | null
  agents: Array<{ id: string; name: string; role: string; workState: string; activity: string }>
  tasks: Array<{
    id: string
    title: string
    status: string
    ownerName: string
    stale: boolean
    acceptance: string[]
  }>
  jobs: Array<{
    id: string
    label: string
    command: string
    status: string
    exitCode: number | null
    port: number | null
  }>
  toolRuns: Array<{ agentName: string; name: string; status: string; summary: string; at: string }>
  decisions: Array<{ revision: number; title: string; statement: string }>
  integrations: Array<{ status: string; revision: string | null; detail: string; at: string }>
  messages: Array<{ author: string; kind: string; body: string; at: string }>
  browserSessions: Array<{ status: string; url: string | null; detail: string }>
  artifacts: Array<{ title: string; kind: string }>
  workspaces: Array<{ label: string; branch: string | null; verifiedRevision: string | null }>
  memories: Array<{ kind: string; title: string; body: string }>
}

export interface CollectOptions {
  /** How many recent transcript lines to include. */
  messageLimit?: number
  /** How many recent tool runs to include. */
  toolRunLimit?: number
}

function agentName(agents: readonly Agent[], agentId: string | null): string {
  if (!agentId) return 'unowned'
  return agents.find((agent) => agent.id === agentId)?.name ?? 'a teammate who left'
}

export function collectRoomState(
  bus: HuddleBus,
  roomId: string,
  agentId: string | null,
  options: CollectOptions = {}
): RoomStateSnapshot | null {
  const room = bus.getRoom(roomId)
  if (!room) return null
  const agents = bus.getAgents(roomId)
  const agent = agentId ? agents.find((candidate) => candidate.id === agentId) ?? null : null
  const tasks = bus.getTasks(roomId)
  const jobs = bus.getJobs(roomId)
  const toolRuns = bus.getToolRuns(roomId)
  const integrations = bus.getIntegrations(roomId)

  return {
    room: {
      id: room.id,
      name: room.name,
      goal: room.goal,
      decisionRevision: room.decisionRevision,
      projectRoot: room.project?.rootPath ?? null,
      projectKind: room.project?.kind ?? null
    },
    agent: agent
      ? { id: agent.id, name: agent.name, role: agent.role, summary: agent.summary }
      : null,
    agents: agents.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      role: candidate.role,
      workState: candidate.workState,
      activity: candidate.activityLabel
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      ownerName: agentName(agents, task.ownerAgentId),
      stale: task.staleSince !== null,
      acceptance: task.acceptance
    })),
    jobs: jobs.slice(-8).map((job) => ({
      id: job.id,
      label: job.label,
      command: job.command,
      status: job.status,
      exitCode: job.exitCode,
      port: job.port
    })),
    toolRuns: toolRuns
      .slice(-(options.toolRunLimit ?? 12))
      .map((run) => ({
        agentName: agentName(agents, run.agentId),
        name: run.name,
        status: run.status,
        summary: run.summary,
        at: run.startedAt
      })),
    decisions: bus
      .getActiveDecisions(roomId)
      .slice(-8)
      .map((decision) => ({ revision: decision.revision, title: decision.title, statement: decision.statement })),
    integrations: integrations.slice(-4).map((attempt) => ({
      status: attempt.status,
      revision: attempt.revision,
      detail: attempt.detail,
      at: attempt.startedAt
    })),
    messages: bus
      .getMessages(roomId, options.messageLimit ?? 12)
      .map((message) => ({
        author: message.author.type === 'human' ? 'Human' : agentName(agents, message.author.type === 'agent' ? message.author.agentId : null),
        kind: message.kind,
        body: message.body,
        at: message.createdAt
      })),
    browserSessions: bus.getBrowserSessions(roomId).map((session) => ({
      status: session.status,
      url: session.currentUrl,
      detail: session.detail
    })),
    artifacts: bus.getArtifacts(roomId).slice(-8).map((artifact) => ({ title: artifact.title, kind: artifact.kind })),
    workspaces: bus.getWorkspaces(roomId).map((workspace) => ({
      label: workspace.label,
      branch: workspace.branch,
      verifiedRevision: workspace.lastVerifiedRevision
    })),
    memories: bus
      .getMemories(roomId)
      .slice(-10)
      .map((memory) => ({ kind: memory.kind, title: memory.title, body: memory.body }))
  }
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

function line(prefix: string, value: string): string {
  return `${prefix}${value}`
}

/**
 * Plain-text state block used by every prompt. Deliberately explicit about what
 * is *not* known, so a teammate cannot fill the gap with invention.
 */
export function formatRoomState(snapshot: RoomStateSnapshot, style: 'conversation' | 'work' | 'onboarding'): string {
  const parts: string[] = []
  const { room } = snapshot

  parts.push(line('Room: ', `${room.name} — goal: ${room.goal || '(no goal recorded yet)'}`))
  parts.push(line('Project: ', room.projectRoot ? `${room.projectRoot} (${room.projectKind})` : 'no project folder bound to this room yet'))
  parts.push(line('Decision revision: ', String(room.decisionRevision)))

  if (snapshot.decisions.length > 0) {
    parts.push('Active decisions:')
    for (const decision of snapshot.decisions) {
      parts.push(`- r${decision.revision} ${decision.title}: ${clip(decision.statement, 300)}`)
    }
  } else {
    parts.push('Active decisions: none recorded yet.')
  }

  const taskLines = snapshot.tasks
    .slice(-14)
    .map(
      (task) =>
        `- ${task.title} [${task.status}] owner=${task.ownerName}${task.stale ? ' STALE' : ''}${
          task.acceptance.length > 0 ? ` acceptance: ${task.acceptance.map((item) => clip(item, 80)).join(' | ')}` : ''
        }`
    )
  parts.push(taskLines.length > 0 ? `Tasks:\n${taskLines.join('\n')}` : 'Tasks: none yet.')

  if (snapshot.jobs.length > 0) {
    parts.push(
      `Commands the team actually ran:\n${snapshot.jobs
        .map(
          (job) =>
            `- ${job.label} \`${clip(job.command, 120)}\` -> ${job.status}${job.exitCode === null ? '' : ` (exit ${job.exitCode})`}${
              job.port === null ? '' : ` port ${job.port}`
            }`
        )
        .join('\n')}`
    )
  } else {
    parts.push('Commands actually run: none.')
  }

  if (snapshot.toolRuns.length > 0) {
    parts.push(
      `Recent tool activity (truthful, from recorded runs):\n${snapshot.toolRuns
        .map((run) => `- ${run.agentName} ${run.name} -> ${run.status}: ${clip(run.summary, 160)}`)
        .join('\n')}`
    )
  }

  if (snapshot.browserSessions.length > 0) {
    parts.push(
      `Browser sessions:\n${snapshot.browserSessions
        .map((session) => `- ${session.status}${session.url ? ` ${session.url}` : ''}: ${clip(session.detail, 120)}`)
        .join('\n')}`
    )
  }

  if (snapshot.integrations.length > 0) {
    parts.push(
      `Integration attempts:\n${snapshot.integrations
        .map((attempt) => `- ${attempt.status} at ${attempt.revision ?? 'unknown revision'}: ${clip(attempt.detail, 160)}`)
        .join('\n')}`
    )
  }

  if (snapshot.artifacts.length > 0) {
    parts.push(`Artifacts: ${snapshot.artifacts.map((artifact) => `${artifact.kind}/${artifact.title}`).join(', ')}`)
  }

  if (snapshot.workspaces.length > 0 && style !== 'conversation') {
    parts.push(
      `Workspaces: ${snapshot.workspaces
        .map((workspace) => `${workspace.label}${workspace.branch ? `@${workspace.branch}` : ''}${workspace.verifiedRevision ? ` verified ${workspace.verifiedRevision.slice(0, 8)}` : ' not verified'}`)
        .join('; ')}`
    )
  }

  if (style !== 'conversation' && snapshot.memories.length > 0) {
    parts.push(
      `Room memory:\n${snapshot.memories.map((memory) => `- ${memory.kind}: ${clip(memory.title, 80)} — ${clip(memory.body, 200)}`).join('\n')}`
    )
  }

  const others = snapshot.agents.filter((agent) => agent.id !== snapshot.agent?.id)
  if (others.length > 0) {
    parts.push(
      `Teammates right now: ${others
        .map((agent) => `${agent.name} (${agent.role}) ${agent.workState}${agent.activity ? ` — ${clip(agent.activity, 60)}` : ''}`)
        .join('; ')}`
    )
  }

  if (snapshot.messages.length > 0) {
    const transcript = snapshot.messages
      .map((message) => `${message.author} [${message.kind}]: ${clip(message.body, style === 'conversation' ? 220 : 400)}`)
      .join('\n')
    parts.push(`Recent transcript (newest last):\n${transcript}`)
  }

  return parts.join('\n')
}

export function describeToolRun(run: ToolRun): string {
  return `${run.name} ${run.status} (${run.durationMs ?? '?'}ms): ${clip(run.summary, 160)}`
}

export function describeJob(job: JobRecord): string {
  return `${job.label} \`${job.command}\` -> ${job.status}${job.exitCode === null ? '' : ` exit ${job.exitCode}`}`
}

export function transcriptLine(message: Message, nameOf: (id: string) => string): string {
  const author =
    message.author.type === 'human'
      ? 'Human'
      : message.author.type === 'agent'
        ? nameOf(message.author.agentId)
        : 'System'
  return `${author} [${message.kind}]: ${clip(message.body, 300)}`
}
