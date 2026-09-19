import type { AppSnapshot, RuntimeEvent } from '../../shared/types'

export function applyRuntimeEvent(snapshot: AppSnapshot, event: RuntimeEvent): AppSnapshot {
  if (event.seq <= snapshot.lastSeq) {
    return snapshot
  }
  if (snapshot.events.some((item) => item.id === event.id)) {
    return { ...snapshot, lastSeq: Math.max(snapshot.lastSeq, event.seq) }
  }

  const next: AppSnapshot = {
    ...snapshot,
    lastSeq: event.seq,
    events: [...snapshot.events, event].slice(-200)
  }

  switch (event.type) {
    case 'room.created':
      if (!next.rooms.some((room) => room.id === event.payload.room.id)) {
        next.rooms = [...next.rooms, event.payload.room]
      }
      break
    case 'room.updated':
      next.rooms = next.rooms.map((room) =>
        room.id === event.payload.room.id ? event.payload.room : room
      )
      break
    case 'room.selected':
      next.selectedRoomId = event.payload.roomId
      break
    case 'agent.added':
      if (!next.agents.some((agent) => agent.id === event.payload.agent.id)) {
        next.agents = [...next.agents, event.payload.agent]
      }
      break
    case 'message.created':
      if (!next.messages.some((message) => message.id === event.payload.message.id)) {
        next.messages = [...next.messages, event.payload.message]
      }
      break
  }

  return next
}
