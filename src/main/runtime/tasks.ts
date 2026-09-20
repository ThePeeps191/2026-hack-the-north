/**
 * Task graph helpers.
 *
 * Pure functions over `Task` records: creation, dependency readiness, decision
 * staleness and stale-result rejection. The room service owns persistence; the
 * runtime owns planning, so these helpers are what the executor and the tools
 * agree on. No bus, no I/O — directly unit-testable.
 */

import type { ContextRef, MessageAuthor, Task, TaskStatus } from '../../shared/types.ts'
import { isTerminalTask } from '../contracts.ts'

/** Anything that can mint ids and timestamps; the bus satisfies it. */
export interface GraphClock {
  newId(): string
  now(): string
}

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  'proposed',
  'assigned',
  'in_progress',
  'awaiting_review',
  'submitted'
]

export function isActiveTask(task: Task): boolean {
  return ACTIVE_TASK_STATUSES.includes(task.status)
}

/** A task a teammate can actually pick up right now. */
export function isOpenForWork(task: Task): boolean {
  return task.status === 'proposed' || task.status === 'assigned' || task.status === 'in_progress'
}

export interface CreateTaskInput {
  roomId: string
  title: string
  detail?: string
  ownerAgentId?: string | null
  createdBy: MessageAuthor
  dependsOn?: string[]
  acceptance?: string[]
  decisionRevision: number
  status?: TaskStatus
}

export function buildTask(clock: GraphClock, input: CreateTaskInput): Task {
  const now = clock.now()
  const owner = input.ownerAgentId ?? null
  return {
    id: clock.newId(),
    roomId: input.roomId,
    title: input.title.slice(0, 160),
    detail: (input.detail ?? '').slice(0, 4000),
    ownerAgentId: owner,
    createdBy: input.createdBy,
    status: input.status ?? (owner ? 'assigned' : 'proposed'),
    dependsOn: [...(input.dependsOn ?? [])],
    acceptance: [...(input.acceptance ?? [])].slice(0, 12),
    decisionRevision: input.decisionRevision,
    staleSince: null,
    staleReason: null,
    blockedReason: null,
    evidence: [],
    createdAt: now,
    updatedAt: now
  }
}

export interface TaskPatch {
  title?: string
  detail?: string
  ownerAgentId?: string | null
  status?: TaskStatus
  dependsOn?: string[]
  acceptance?: string[]
  blockedReason?: string | null
  evidence?: ContextRef[]
  decisionRevision?: number
}

export function applyTaskPatch(task: Task, patch: TaskPatch, now: string): Task {
  const next: Task = { ...task, evidence: [...task.evidence], updatedAt: now }
  if (patch.title !== undefined) next.title = patch.title.slice(0, 160)
  if (patch.detail !== undefined) next.detail = patch.detail.slice(0, 4000)
  if (patch.ownerAgentId !== undefined) {
    next.ownerAgentId = patch.ownerAgentId
    if (next.ownerAgentId && next.status === 'proposed') next.status = 'assigned'
  }
  if (patch.status !== undefined) next.status = patch.status
  if (patch.dependsOn !== undefined) next.dependsOn = [...patch.dependsOn]
  if (patch.acceptance !== undefined) next.acceptance = [...patch.acceptance].slice(0, 12)
  if (patch.blockedReason !== undefined) next.blockedReason = patch.blockedReason
  if (patch.decisionRevision !== undefined) {
    // Moving a task forward to a newer decision revision *is* re-planning it,
    // so the stale flag that the revision bump raised comes off with it. Without
    // this the flag was permanent: a teammate could re-check its work against
    // the new decision and still never be allowed to submit it.
    if (patch.decisionRevision > next.decisionRevision) {
      next.staleSince = null
      next.staleReason = null
    }
    next.decisionRevision = patch.decisionRevision
  }
  if (patch.evidence !== undefined) next.evidence = [...patch.evidence]
  return next
}

/**
 * Dependencies are satisfied when every dependency we still know about has
 * reached `done` or `submitted`. A dependency id that no longer exists in the
 * graph (deleted, or from a previous session) never blocks work.
 */
export function dependenciesSatisfied(task: Task, all: readonly Task[]): boolean {
  if (task.dependsOn.length === 0) return true
  for (const id of task.dependsOn) {
    const dependency = all.find((candidate) => candidate.id === id)
    if (!dependency) continue
    if (dependency.status === 'done' || dependency.status === 'submitted') continue
    if (isTerminalTask(dependency.status)) {
      // Cancelled or failed dependencies must not silently release work.
      if (dependency.status === 'failed') return false
      continue
    }
    return false
  }
  return true
}

/** The task this agent should run next, or null. */
export function nextRunnableTask(all: readonly Task[], agentId: string): Task | null {
  const owned = all.filter(
    (task) => task.ownerAgentId === agentId && !isTerminalTask(task.status) && isOpenForWork(task)
  )
  const runnable = owned.filter((task) => dependenciesSatisfied(task, all))
  if (runnable.length === 0) return null
  const rank: Record<TaskStatus, number> = {
    in_progress: 0,
    assigned: 1,
    proposed: 2,
    blocked: 3,
    awaiting_review: 4,
    submitted: 5,
    done: 6,
    cancelled: 7,
    failed: 8
  }
  return [...runnable].sort((a, b) => {
    const byStatus = rank[a.status] - rank[b.status]
    if (byStatus !== 0) return byStatus
    return a.createdAt.localeCompare(b.createdAt)
  })[0]
}

/** True when a task was planned against a decision revision older than `revision`. */
export function plannedBefore(task: Task, revision: number): boolean {
  return task.decisionRevision < revision
}

/**
 * Task ids that a new decision revision invalidates. Terminal work is left
 * alone: it already happened and marking it stale would invent a claim we
 * cannot undo.
 */
export function tasksPlannedBefore(all: readonly Task[], revision: number): Task[] {
  return all.filter((task) => !isTerminalTask(task.status) && plannedBefore(task, revision))
}

export function staleTask(task: Task, revision: number, reason: string, now: string): Task {
  return { ...task, staleSince: task.staleSince ?? now, staleReason: reason, updatedAt: now }
}

/** Clears stale flags and re-bases a task on the current decision revision. */
export function refreshStaleTask(task: Task, revision: number, now: string): Task {
  return {
    ...task,
    staleSince: null,
    staleReason: null,
    blockedReason: null,
    decisionRevision: revision,
    updatedAt: now
  }
}

/**
 * Guard for `submit_work` and integration: a result produced against an older
 * decision revision than the room's current one is rejected, not merged.
 */
export interface StaleVerdict {
  stale: boolean
  reason: string | null
}

export function rejectStaleResult(
  task: Task | null,
  currentRevision: number,
  source: string
): StaleVerdict {
  if (!task) return { stale: false, reason: null }
  if (!plannedBefore(task, currentRevision)) return { stale: false, reason: null }
  return {
    stale: true,
    reason: `${source} was produced against decision revision ${task.decisionRevision}, but the room is now at revision ${currentRevision}. Re-plan against the current decisions before submitting.`
  }
}

/**
 * Work that was mid-flight when Huddle stopped. We cannot know whether the last
 * command finished, so it is reported as blocked with an honest reason; work
 * that had merely been assigned is left alone and will simply run.
 */
export function interruptedTasks(all: readonly Task[], now: string): Task[] {
  return all
    .filter((task) => task.status === 'in_progress')
    .map((task) => ({
      ...task,
      status: 'blocked' as TaskStatus,
      blockedReason: 'Interrupted when Huddle stopped. Nothing was verified after that point.',
      updatedAt: now
    }))
}

export interface GraphSummaryInput {
  tasks: readonly Task[]
  agents: ReadonlyArray<{ id: string; name: string }>
  /** Limit to one owner; omit for the whole room. */
  agentId?: string
  limit?: number
}

/** Compact, truthful task board text used in prompts and context packs. */
export function summarizeTaskGraph(input: GraphSummaryInput): string {
  const nameOf = (agentId: string | null): string => {
    if (!agentId) return 'unowned'
    return input.agents.find((agent) => agent.id === agentId)?.name ?? 'unknown agent'
  }
  const scoped = input.agentId
    ? input.tasks.filter(
        (task) =>
          task.ownerAgentId === input.agentId ||
          (task.ownerAgentId === null && !isTerminalTask(task.status))
      )
    : input.tasks
  if (scoped.length === 0) return 'No tasks yet.'
  const limit = input.limit ?? 14
  const rows = [...scoped]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-limit)
    .map((task) => {
      const bits = [`[${task.status}]`, task.title, `owner=${nameOf(task.ownerAgentId)}`]
      if (task.dependsOn.length > 0) bits.push(`depends_on=${task.dependsOn.length}`)
      if (task.staleSince) bits.push(`STALE (${task.staleReason ?? 'decision changed'})`)
      if (task.blockedReason) bits.push(`blocked: ${task.blockedReason}`)
      if (task.acceptance.length > 0) bits.push(`acceptance: ${task.acceptance.join(' | ')}`)
      return `- ${task.id.slice(0, 8)} ${bits.join(' ')}`
    })
  return rows.join('\n')
}

/** Which owners a decision revision must be reported to. */
export function affectedOwners(tasks: readonly Task[]): string[] {
  const owners = new Set<string>()
  for (const task of tasks) {
    if (task.ownerAgentId) owners.add(task.ownerAgentId)
  }
  return [...owners]
}
