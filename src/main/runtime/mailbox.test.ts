import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Mailbox } from './mailbox.ts'
import type { GraphClock } from './tasks.ts'

function clock(): GraphClock {
  let n = 0
  return {
    newId: () => `id-${++n}`,
    now: () => new Date(1_700_000_000_000 + n * 1000).toISOString()
  }
}

describe('Mailbox', () => {
  test('the highest-priority item is served first', () => {
    const box = new Mailbox(clock())
    box.enqueue({ roomId: 'r1', agentId: 'maya', kind: 'onboarding', summary: 'say hello' })
    box.enqueue({ roomId: 'r1', agentId: 'maya', kind: 'human_message', summary: 'fix the header' })
    box.enqueue({ roomId: 'r1', agentId: 'maya', kind: 'teammate_message', summary: 'payload shape' })
    assert.equal(box.peek('maya')?.kind, 'human_message')
    assert.equal(box.take('maya')?.summary, 'fix the header')
    assert.equal(box.take('maya')?.kind, 'teammate_message')
    assert.equal(box.take('maya')?.kind, 'onboarding')
    assert.equal(box.take('maya'), null)
  })

  test('identical pending items are collapsed so a burst cannot become a burst of work', () => {
    const box = new Mailbox(clock())
    const first = box.enqueue({
      roomId: 'r1',
      agentId: 'alex',
      kind: 'handoff',
      summary: 'Wire the endpoint',
      taskId: 't1'
    })
    const second = box.enqueue({
      roomId: 'r1',
      agentId: 'alex',
      kind: 'handoff',
      summary: 'Wire the endpoint',
      taskId: 't1'
    })
    assert.equal(first.id, second.id)
    assert.equal(box.size('alex'), 1)
  })

  test('a different task is a different item', () => {
    const box = new Mailbox(clock())
    box.enqueue({ roomId: 'r1', agentId: 'alex', kind: 'handoff', summary: 'Wire the endpoint', taskId: 't1' })
    box.enqueue({ roomId: 'r1', agentId: 'alex', kind: 'handoff', summary: 'Wire the endpoint', taskId: 't2' })
    assert.equal(box.size('alex'), 2)
  })

  test('acknowledgements are remembered per agent and per assignment', () => {
    const box = new Mailbox(clock())
    assert.equal(box.hasAcknowledged('maya', 'ack:m1'), false)
    box.markAcknowledged('maya', 'ack:m1')
    box.markAcknowledged('maya', 'ack:m1')
    assert.equal(box.hasAcknowledged('maya', 'ack:m1'), true)
    assert.equal(box.hasAcknowledged('maya', 'ack:m2'), false)
    assert.equal(box.hasAcknowledged('alex', 'ack:m1'), false)
    assert.deepEqual(box.acknowledgedKeys('maya'), ['ack:m1'])
  })

  test('dropWhere removes obsolete queued work and keeps the rest', () => {
    const box = new Mailbox(clock())
    box.enqueue({ roomId: 'r1', agentId: 'maya', kind: 'handoff', summary: 'stale handoff', taskId: 't1' })
    box.enqueue({ roomId: 'r1', agentId: 'maya', kind: 'human_message', summary: 'keep me', taskId: 't1' })
    box.enqueue({ roomId: 'r1', agentId: 'sam', kind: 'handoff', summary: 'other room work', taskId: 't9' })
    const dropped = box.dropWhere('r1', (item) => item.kind === 'handoff' && item.taskId === 't1')
    assert.equal(dropped, 1)
    assert.equal(box.size('maya'), 1)
    assert.equal(box.size('sam'), 1)
  })

  test('clearRoom only drops that room', () => {
    const box = new Mailbox(clock())
    box.enqueue({ roomId: 'r1', agentId: 'maya', kind: 'human_message', summary: 'one' })
    box.enqueue({ roomId: 'r2', agentId: 'maya', kind: 'human_message', summary: 'two' })
    assert.equal(box.roomSize('r1'), 1)
    box.clearRoom('r1')
    assert.equal(box.roomSize('r1'), 0)
    assert.equal(box.size('maya'), 1)
  })

  test('equal priority is served oldest first', () => {
    const box = new Mailbox(clock())
    box.enqueue({ roomId: 'r1', agentId: 'sam', kind: 'human_message', summary: 'first' })
    box.enqueue({ roomId: 'r1', agentId: 'sam', kind: 'human_message', summary: 'second' })
    assert.equal(box.take('sam')?.summary, 'first')
  })

  test('restore puts an item back for the next pass', () => {
    const box = new Mailbox(clock())
    box.enqueue({ roomId: 'r1', agentId: 'sam', kind: 'review_request', summary: 're-test the fix', taskId: 't3' })
    const item = box.take('sam')
    assert.ok(item)
    if (item) box.restore(item)
    assert.equal(box.peek('sam')?.summary, 're-test the fix')
  })
})
