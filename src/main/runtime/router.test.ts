import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isAcknowledgement, routeMessage, type RouterAgent, type RouterInput, type RouterMessage } from './router.ts'

const AGENTS: RouterAgent[] = [
  { id: 'maya', name: 'Maya', role: 'frontend' },
  { id: 'alex', name: 'Alex', role: 'systems' },
  { id: 'sam', name: 'Sam', role: 'qa' }
]

function human(body: string, extra: Partial<RouterMessage> = {}): RouterMessage {
  return { id: 'm1', body, author: { type: 'human' }, to: [], kind: 'chat', ...extra }
}

function agentMessage(agentId: string, body: string, to: string[] = []): RouterMessage {
  return { id: 'a1', body, author: { type: 'agent', agentId }, to, kind: 'chat' }
}

function input(message: RouterMessage, extra: Partial<RouterInput> = {}): RouterInput {
  return { message, agents: AGENTS, tasks: [], recent: [], busyAgentIds: [], ...extra }
}

describe('routeMessage', () => {
  test('a named teammate owns the turn', () => {
    const decision = routeMessage(input(human('Sam, check the vote flow in the browser')))
    assert.equal(decision.kind, 'work')
    assert.deepEqual(decision.targets, ['sam'])
    assert.match(decision.reason, /Sam/)
  })

  test('a room-wide instruction goes to exactly one owner, never all three', () => {
    const decision = routeMessage(input(human('Please fix the layout of the results screen')))
    assert.equal(decision.kind, 'work')
    assert.equal(decision.targets.length, 1)
    assert.deepEqual(decision.targets, ['maya'])
  })

  test('a question is answered on the responsive path', () => {
    const decision = routeMessage(input(human('What are you checking right now?')))
    assert.equal(decision.kind, 'conversation')
    assert.equal(decision.targets.length, 1)
  })

  test('a greeting to the room is conversation for every teammate', () => {
    const decision = routeMessage(input(human('hi agents respond with a greeting if you can hear me')))
    assert.equal(decision.kind, 'conversation')
    assert.deepEqual(decision.targets.slice().sort(), ['alex', 'maya', 'sam'])
  })

  test('an owner already working on the topic keeps it', () => {
    const decision = routeMessage(
      input(human('Can you extend the vote panel with a percentage?'), {
        tasks: [{ id: 't1', title: 'Build the vote panel', status: 'in_progress', ownerAgentId: 'maya' }]
      })
    )
    assert.deepEqual(decision.targets, ['maya'])
    assert.equal(decision.taskId, 't1')
  })

  test('an agent message is never routed back to its own author', () => {
    const decision = routeMessage(input(agentMessage('maya', 'I need the API shape', ['maya'])))
    assert.equal(decision.kind, 'ignore')
    assert.deepEqual(decision.targets, [])
  })

  test('an agent message without a recipient produces nothing', () => {
    const decision = routeMessage(input(agentMessage('maya', 'Vote panel is done, tests pass')))
    assert.equal(decision.kind, 'ignore')
  })

  test('an explicit teammate handoff is delivered to the target only', () => {
    const decision = routeMessage(input(agentMessage('maya', '@Alex here is the payload shape', ['alex'])))
    assert.equal(decision.kind, 'handoff')
    assert.deepEqual(decision.targets, ['alex'])
  })

  test('a bare acknowledgement produces no turn at all', () => {
    const decision = routeMessage(input(human('ok')))
    assert.equal(decision.kind, 'ignore')
    assert.equal(decision.reason, 'a bare acknowledgement needs no turn')
  })

  test('a private message only reaches the agent it was sent to', () => {
    const decision = routeMessage(input(human('how is it going', { private: { agentId: 'sam' } })))
    assert.deepEqual(decision.targets, ['sam'])
  })

  test('a reply to a teammate goes back to that teammate', () => {
    const recent: RouterMessage[] = [agentMessage('alex', 'Do you want JSON or CSV export?')]
    recent[0].id = 'q1'
    const decision = routeMessage(
      input(human('JSON please', { replyToId: 'q1' }), { recent })
    )
    assert.deepEqual(decision.targets, ['alex'])
    assert.equal(decision.kind, 'conversation')
  })

  test('reply detection does not route to an agent message in another room', () => {
    const decision = routeMessage(input(human('no, do it differently', { replyToId: 'missing' })))
    assert.equal(decision.targets.length, 1)
    assert.notEqual(decision.kind, 'ignore')
  })

  test('a busy owner still gets the work, but an idle teammate is preferred on a tie', () => {
    const decision = routeMessage(
      input(human('review this please'), { busyAgentIds: ['sam'] })
    )
    assert.equal(decision.targets.length, 1)
    assert.notEqual(decision.targets[0], 'sam')
  })

  test('a room with no teammates routes nowhere', () => {
    const decision = routeMessage(input(human('fix the layout'), { agents: [] }))
    assert.equal(decision.kind, 'ignore')
    assert.deepEqual(decision.targets, [])
  })

  test('system messages never start a turn', () => {
    const decision = routeMessage(
      input({ id: 's1', body: 'Task cancelled', author: { type: 'system' }, to: [], kind: 'system' })
    )
    assert.equal(decision.kind, 'ignore')
  })
})

describe('acknowledgement detection', () => {
  test('short acknowledgements are recognised', () => {
    for (const text of ['ok', 'Got it', 'thanks', 'sounds good', 'sure!', 'lgtm']) {
      assert.equal(isAcknowledgement(text), true, text)
    }
  })

  test('a sentence that carries information is not an acknowledgement', () => {
    for (const text of ['ok but change the copy', 'thanks, now please fix the header', 'sure, what about the timer?']) {
      assert.equal(isAcknowledgement(text), false, text)
    }
  })
})
