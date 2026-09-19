import type {
  Agent,
  AppSnapshot,
  CallState,
  Decision,
  IntegrationAttempt,
  Message,
  Room,
  Task,
  WorkspaceRecord
} from '../../../shared/types'
import { orderAgents, workspaceFor } from '../state/view-model'
import type { Tone } from './format'
import { unansweredQuestions } from './format'

/**
 * View derivations.
 *
 * These read props and turn them into layout facts (counts, labels, which
 * workspace is on the stage). Nothing here invents state: if a value is not in
 * the snapshot it is not shown.
 */

export interface ConnectionStatus {
  label: string
  detail: string
  tone: Tone
  live: boolean
}

export function connectionStatus(call: CallState, room: Room): ConnectionStatus {
  if (call.connection === 'connected' && call.roomId === room.id) {
    return { label: 'Connected', detail: 'Live audio for this room', tone: 'live', live: true }
  }
  if (call.connection === 'connecting') {
    return {
      label: 'Connecting',
      detail: 'Opening the microphone and playback',
      tone: 'wait',
      live: false
    }
  }
  if (call.connection === 'error') {
    return {
      label: 'Connection error',
      detail: call.error ?? 'The audio connection failed',
      tone: 'stop',
      live: false
    }
  }
  if (room.joined) {
    return {
      label: 'Audio offline',
      detail: 'The room is marked joined but there is no live audio connection',
      tone: 'wait',
      live: false
    }
  }
  return {
    label: 'Not in call',
    detail: 'Join the call to talk to the team and hear replies',
    tone: 'quiet',
    live: false
  }
}

export function activeAgents(agents: Agent[]): Agent[] {
  return orderAgents(agents)
}

export function findAgent(agents: Agent[], agentId: string | null | undefined): Agent | null {
  if (!agentId) return null
  return agents.find((agent) => agent.id === agentId) ?? null
}

export function teamWorkspace(workspaces: WorkspaceRecord[]): WorkspaceRecord | null {
  return workspaceFor(workspaces, { kind: 'team' })
}

export function latestIntegration(integrations: IntegrationAttempt[]): IntegrationAttempt | null {
  if (integrations.length === 0) return null
  return [...integrations].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null
}

export function tasksForAgent(tasks: Task[], agentId: string): Task[] {
  return tasks
    .filter((task) => task.ownerAgentId === agentId)
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Tasks that are still moving, in the order the stage should show them. */
export function openTasks(tasks: Task[]): Task[] {
  const weight = (task: Task): number => {
    switch (task.status) {
      case 'in_progress':
        return 0
      case 'blocked':
        return 1
      case 'awaiting_review':
        return 2
      case 'assigned':
        return 3
      case 'proposed':
        return 4
      case 'submitted':
        return 5
      default:
        return 6
    }
  }
  return tasks
    .filter((task) => task.status !== 'done' && task.status !== 'cancelled')
    .slice()
    .sort((a, b) => weight(a) - weight(b) || b.updatedAt.localeCompare(a.updatedAt))
}

export function decisionsNewestFirst(decisions: Decision[]): Decision[] {
  return [...decisions].sort((a, b) => b.revision - a.revision)
}

export function pendingQuestions(messages: Message[]): Message[] {
  return unansweredQuestions(messages)
}

/**
 * Team messages visible in the retained event ring, per room. This is the only
 * honest activity signal the UI has for rooms it is not currently showing, and
 * it is labelled as retained history wherever it is displayed.
 */
export function retainedTeamMessages(snapshot: AppSnapshot): Map<string, number> {
  const counts = new Map<string, number>()
  for (const event of snapshot.events) {
    if (event.type !== 'message.created') continue
    if (event.message.author.type === 'human') continue
    if (event.message.private) continue
    counts.set(event.roomId, (counts.get(event.roomId) ?? 0) + 1)
  }
  return counts
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path
}

export function ownerLabel(
  owner: { kind: 'team' } | { kind: 'agent'; agentId: string },
  agents: Agent[]
): string {
  if (owner.kind === 'team') return 'Team workspace'
  const agent = findAgent(agents, owner.agentId)
  return agent ? `${agent.name}'s workspace` : 'Teammate workspace'
}
