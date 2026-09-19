import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Message } from '../../shared/types.ts'
import { collectRoomState } from './context.ts'
import { FakeBus, makeAgent, makeRoom } from './test-hosts.ts'

function message(over: Partial<Message> & Pick<Message, 'id' | 'body'>): Message {
  return {
    roomId: 'r1',
    author: { type: 'human' },
    createdAt: new Date(1_700_000_000_000).toISOString(),
    clientRequestId: over.id,
    kind: 'chat',
    to: [],
    ...over
  }
}

describe('collectRoomState', () => {
  test('a private message reaches only the teammate it was addressed to', () => {
    const bus = new FakeBus()
    bus.rooms = [makeRoom({ id: 'r1' })]
    bus.agents = [
      makeAgent({ id: 'maya', roomId: 'r1', name: 'Maya' }),
      makeAgent({ id: 'sam', roomId: 'r1', name: 'Sam' })
    ]
    bus.messages = [
      message({ id: 'm1', body: 'room message' }),
      message({ id: 'm2', body: 'just between us', private: { agentId: 'maya' } })
    ]

    const forMaya = collectRoomState(bus, 'r1', 'maya')
    const forSam = collectRoomState(bus, 'r1', 'sam')

    assert.ok(forMaya)
    assert.ok(forSam)
    assert.deepEqual(
      forMaya.messages.map((entry) => entry.body),
      ['room message', 'just between us']
    )
    assert.deepEqual(
      forSam.messages.map((entry) => entry.body),
      ['room message']
    )
  })

  test('private traffic does not push room messages out of another agent window', () => {
    const bus = new FakeBus()
    bus.rooms = [makeRoom({ id: 'r1' })]
    bus.agents = [makeAgent({ id: 'sam', roomId: 'r1', name: 'Sam' })]
    bus.messages = [
      message({ id: 'm0', body: 'the one room message' }),
      ...Array.from({ length: 6 }, (_, index) =>
        message({ id: `p${index}`, body: `secret ${index}`, private: { agentId: 'maya' } })
      )
    ]

    const forSam = collectRoomState(bus, 'r1', 'sam', { messageLimit: 3 })

    assert.ok(forSam)
    assert.deepEqual(
      forSam.messages.map((entry) => entry.body),
      ['the one room message']
    )
  })
})
