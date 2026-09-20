import type { AppSnapshot, RuntimeEvent } from '../../shared/types'

/**
 * Fold one runtime event into the renderer's copy of the room.
 *
 * The renderer holds a *view* of the backend state, never the truth: every
 * branch here mirrors a durable event the main process already committed. An
 * event we do not understand is ignored rather than guessed at.
 */

const MAX_RENDERED_EVENTS = 200

export function applyRuntimeEvent(snapshot: AppSnapshot, event: RuntimeEvent): AppSnapshot {
  const alreadyApplied =
    snapshot.events.some((item) => item.id === event.id) || event.seq <= snapshot.lastSeq

  if (alreadyApplied) {
    return event.seq <= snapshot.lastSeq
      ? snapshot
      : { ...snapshot, lastSeq: Math.max(snapshot.lastSeq, event.seq) }
  }

  const next: AppSnapshot = {
    ...snapshot,
    lastSeq: event.seq,
    events: [...snapshot.events, event].slice(-MAX_RENDERED_EVENTS)
  }

  switch (event.type) {
    case 'room.created':
      if (!next.rooms.some((room) => room.id === event.room.id)) {
        next.rooms = [...next.rooms, event.room]
      }
      break

    case 'room.updated':
      next.rooms = upsert(next.rooms, event.room)
      break

    case 'room.selected':
      next.selectedRoomId = event.selectedRoomId
      break

    case 'room.removed': {
      const removed = event.removedRoomId
      next.rooms = next.rooms.filter((room) => room.id !== removed)
      next.agents = next.agents.filter((agent) => agent.roomId !== removed)
      next.messages = next.messages.filter((message) => message.roomId !== removed)
      next.tasks = next.tasks.filter((task) => task.roomId !== removed)
      next.decisions = next.decisions.filter((decision) => decision.roomId !== removed)
      next.toolRuns = next.toolRuns.filter((run) => run.roomId !== removed)
      next.jobs = next.jobs.filter((job) => job.roomId !== removed)
      next.browserSessions = next.browserSessions.filter((session) => session.roomId !== removed)
      next.artifacts = next.artifacts.filter((artifact) => artifact.roomId !== removed)
      next.workspaces = next.workspaces.filter((workspace) => workspace.roomId !== removed)
      next.integrations = next.integrations.filter((attempt) => attempt.roomId !== removed)
      next.memories = next.memories.filter((memory) => memory.roomId !== removed)
      if (next.selectedRoomId === removed) {
        next.selectedRoomId = next.rooms[0]?.id ?? null
      }
      break
    }

    case 'agent.added':
      next.agents = upsert(next.agents, event.agent)
      break

    case 'agent.updated':
      next.agents = upsert(next.agents, event.agent)
      break

    case 'agent.removed':
      next.agents = next.agents.filter((agent) => agent.id !== event.agentId)
      break

    case 'message.created':
      next.messages = upsert(next.messages, event.message)
      break

    case 'message.updated':
      next.messages = upsert(next.messages, event.message)
      break

    case 'task.upserted':
      next.tasks = upsert(next.tasks, event.task)
      break

    case 'task.removed':
      next.tasks = next.tasks.filter((task) => task.id !== event.taskId)
      break

    case 'decision.created':
      next.decisions = upsert(next.decisions, event.decision)
      for (const task of event.affected) next.tasks = upsert(next.tasks, task)
      break

    case 'decision.updated':
      next.decisions = upsert(next.decisions, event.decision)
      break

    case 'toolrun.started':
      next.toolRuns = upsert(next.toolRuns, event.run)
      break

    case 'toolrun.finished':
      next.toolRuns = upsert(next.toolRuns, event.run)
      break

    case 'job.upserted':
      next.jobs = upsert(next.jobs, event.job)
      break

    case 'job.output':
      // Streamed, not state: the terminal surface reads it live from the event
      // stream and asks the main process for retained output when it mounts.
      break

    case 'browser.upserted':
      next.browserSessions = upsert(next.browserSessions, event.session)
      break

    case 'artifact.created':
      next.artifacts = upsert(next.artifacts, event.artifact)
      break

    case 'workspace.upserted':
      next.workspaces = upsert(next.workspaces, event.workspace)
      break

    case 'integration.upserted':
      next.integrations = upsert(next.integrations, event.attempt)
      break

    case 'memory.created':
      next.memories = upsert(next.memories, event.entry)
      break

    case 'capability.updated':
      next.capabilities = upsert(next.capabilities, event.capability)
      break

    case 'settings.updated':
      next.settings = event.settings
      break

    case 'call.updated':
      next.call = event.call
      break

    case 'voice.level':
    case 'voice.vad':
    case 'voice.transcript':
    case 'voice.playback':
    case 'voice.timing':
    case 'agent.stream':
    case 'agent.steered':
    case 'notice':
      // Ephemeral: the call UI subscribes to these directly. They are kept in
      // the event ring for the activity view but never merged into state.
      break
  }

  return next
}

/** The most recent runtime events, newest first, for the transcript/activity view. */
export function recentEvents(snapshot: AppSnapshot, limit = 40): RuntimeEvent[] {
  return [...snapshot.events].slice(-limit).reverse()
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((existing) => existing.id === item.id)
  if (index < 0) return [...list, item]
  const copy = [...list]
  copy[index] = item
  return copy
}
