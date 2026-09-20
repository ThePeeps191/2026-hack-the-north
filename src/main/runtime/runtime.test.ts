import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Decision, Message } from '../../shared/types.ts'
import { HuddleAgentRuntime, createAgentRuntime } from './index.ts'
import type { OpenAiProvider, ProviderRequest, ProviderStatus, ProviderToolCall, ProviderTransport, ProviderTurn } from './provider.ts'
import { HuddleError } from '../huddle-error.ts'
import { buildTask } from './tasks.ts'
import { fakeDeps, makeAgent, makeRoom, type FakeDeps } from './test-hosts.ts'

/** A provider that replays a script: no network, no key, fully deterministic. */
class ScriptedProvider implements OpenAiProvider {
  readonly configured: boolean
  requests: ProviderRequest[] = []
  private readonly script: Array<ProviderTurn | 'hang'>

  constructor(script: Array<ProviderTurn | 'hang'> = [], configured = true) {
    this.script = [...script]
    this.configured = configured
  }

  transport(): ProviderTransport {
    return 'responses'
  }

  status(): ProviderStatus {
    return { configured: this.configured, transport: 'responses', detail: 'scripted', lastError: null }
  }

  setTransport(): void {}

  async listModels(): Promise<string[]> {
    return []
  }

  async probe(): Promise<{ ok: boolean; detail: string; toolCalling: boolean }> {
    return { ok: true, detail: 'scripted', toolCalling: true }
  }

  async complete(request: ProviderRequest): Promise<ProviderTurn> {
    this.requests.push(request)
    const next = this.script.shift()
    if (next === 'hang') {
      // A provider that never answers until the work is cancelled.
      return await new Promise<ProviderTurn>((_resolve, reject) => {
        if (!request.signal) return
        if (request.signal.aborted) {
          reject(new HuddleError('openai_aborted', 'cancelled'))
          return
        }
        request.signal.addEventListener('abort', () => reject(new HuddleError('openai_aborted', 'cancelled')), {
          once: true
        })
      })
    }
    const result = next ?? turn({ text: 'Nothing further is needed.' })
    if (result.text && request.onTextDelta) request.onTextDelta(result.text)
    return result
  }
}

function turn(over: Partial<ProviderTurn> = {}): ProviderTurn {
  return {
    text: '',
    toolCalls: [],
    finishReason: 'stop',
    model: 'gpt-5.6-luna',
    transport: 'responses',
    usage: { inputTokens: 10, outputTokens: 10 },
    latencyMs: 5,
    ...over
  }
}

function call(id: string, name: string, args: Record<string, unknown>): ProviderToolCall {
  return { id, name, arguments: JSON.stringify(args) }
}

function humanMessage(body: string, over: Partial<Message> = {}): Message {
  return {
    id: 'm-human',
    roomId: 'r1',
    author: { type: 'human' },
    body,
    createdAt: '2026-01-01T00:00:00.000Z',
    clientRequestId: 'req-1',
    kind: 'chat',
    to: [],
    ...over
  }
}

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 4000,
  diagnose?: () => string
): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}${diagnose ? ` — ${diagnose()}` : ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function boundRoom(deps: FakeDeps): void {
  deps.bus.rooms = [
    makeRoom({
      project: {
        rootPath: 'C:\\project',
        kind: 'existing',
        isGitRepo: true,
        hadDirtyWorkOnBind: false,
        boundAt: '2026-01-01T00:00:00.000Z'
      }
    })
  ]
}

function agentMessages(deps: FakeDeps): Message[] {
  return deps.bus.messages.filter((message) => message.author.type === 'agent')
}

describe('work path', () => {
  test('an instruction becomes a task, runs real tools, and ends in a written report', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const provider = new ScriptedProvider([
      turn({
        toolCalls: [
          call('c1', 'write_file', {
            path: 'src/Vote.tsx',
            contents: 'export const Vote = () => null\n',
            reason: 'first slice'
          })
        ]
      }),
      turn({ text: 'I built the first slice of the vote panel in src/Vote.tsx. I have not run the tests yet.' })
    ])
    const runtime = new HuddleAgentRuntime(deps, provider)

    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Build the vote panel with a percentage'),
      addressed: []
    })

    await waitFor(() => deps.bus.messages.some((message) => message.kind === 'result'), 'the result message')

    // A real task exists, owned by the teammate the router picked.
    const task = deps.bus.tasks[0]
    assert.ok(task)
    assert.equal(task.ownerAgentId, 'maya')
    assert.equal(task.title, 'Build the vote panel with a percentage')
    assert.equal(deps.bus.getTask(task.id)?.status, 'awaiting_review')

    // The write really went through the execution host.
    assert.ok(deps.exec.calls.some((entry) => entry.method === 'writeFile'))
    assert.equal(deps.exec.files.get('src/Vote.tsx'), 'export const Vote = () => null\n')

    // The tool run is recorded truthfully.
    const run = deps.bus.getToolRuns('r1').find((entry) => entry.name === 'write_file')
    assert.ok(run)
    assert.equal(run.status, 'ok')
    assert.equal(run.taskId, task.id)

    // The written message carries the evidence, the spoken form does not.
    const result = agentMessages(deps).find((message) => message.kind === 'result')
    assert.ok(result)
    assert.match(result.body, /first slice of the vote panel/)
    assert.ok(result.refs?.some((ref) => ref.kind === 'file' && ref.path === 'src/Vote.tsx'))
    assert.equal(result.decisionRevision, deps.bus.rooms[0]?.decisionRevision)

    const spoken = deps.voice.spoken.at(-1)
    assert.ok(spoken)
    assert.notEqual(spoken.text, result.body)
    assert.equal(spoken.text.includes('src/Vote.tsx'), false)
    assert.match(spoken.text, /the file/)

    // Activity came from real actions and settled back to idle.
    assert.ok(deps.bus.activities.some((entry) => entry.state === 'editing'))
    assert.ok(deps.bus.activities.some((entry) => entry.state === 'running' || entry.state === 'thinking'))
    assert.equal(deps.bus.agents[0]?.workState, 'idle')
  })

  test('an acknowledgement is spoken once per assignment', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const provider = new ScriptedProvider([turn({ text: 'Done with the first pass.' })])
    const runtime = new HuddleAgentRuntime(deps, provider)

    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Fix the header spacing'),
      addressed: []
    })
    await waitFor(() => agentMessages(deps).some((message) => message.kind === 'result'), 'the result message')

    const first = agentMessages(deps)[0]
    assert.equal(first.kind, 'chat')
    assert.match(first.body, /^On it — /)

    // A second instruction in the same room still gets exactly one ack for its own message.
    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Now fix the footer too', { id: 'm-human-2' }),
      addressed: []
    })
    await waitFor(() => agentMessages(deps).filter((message) => message.kind === 'result').length >= 2, 'the second result')
    const acks = agentMessages(deps).filter((message) => message.body.startsWith('On it — '))
    assert.equal(acks.length, 2)
  })

  test('a failing tool is fed back to the model instead of being reported as success', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const provider = new ScriptedProvider([
      turn({ toolCalls: [call('c1', 'read_file', { path: 'not-there.ts' })] }),
      turn({ text: 'That file is not readable, so I stopped.' })
    ])
    const runtime = new HuddleAgentRuntime(deps, provider)

    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Read the missing file'),
      addressed: []
    })
    await waitFor(
      () => agentMessages(deps).some((message) => message.kind === 'result'),
      'the report',
      4000,
      () =>
        `messages=[${deps.bus.messages
          .map((message) => `${message.author.type}:${message.kind}:${message.body.slice(0, 40)}`)
          .join(' | ')}] requests=${provider.requests.length} runs=[${deps.bus
          .getToolRuns('r1')
          .map((run) => `${run.name}=${run.status}${run.error ? `(${run.error.slice(0, 80)})` : ''}`)
          .join(' ')}] notices=[${deps.bus.notices.map((notice) => `${notice.level}:${notice.text.slice(0, 80)}`).join(' | ')}]`
    )

    const secondRequest = provider.requests.find((request) => request.input.some((item) => item.kind === 'result'))
    assert.ok(secondRequest)
    const resultItem = secondRequest.input.find((item) => item.kind === 'result')
    assert.ok(resultItem)
    if (resultItem && resultItem.kind === 'result') {
      assert.match(resultItem.output, /not-there\.ts|No project|failed/i)
    }
  })
})

describe('conversation path', () => {
  test('a short question is answered from real state with no tools at all', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    deps.bus.tasks.push(
      buildTask(
        { newId: () => deps.bus.newId(), now: () => deps.bus.now() },
        {
          roomId: 'r1',
          title: 'Build the vote panel',
          ownerAgentId: 'maya',
          createdBy: { type: 'human' },
          decisionRevision: 1,
          status: 'in_progress'
        }
      )
    )
    const provider = new ScriptedProvider([
      turn({ text: 'I am reading the vote panel. Nothing is verified yet.' })
    ])
    const runtime = new HuddleAgentRuntime(deps, provider)

    const question = humanMessage('What are you checking right now?', { id: 'm-question' })
    await runtime.handleHumanMessage({ roomId: 'r1', message: question, addressed: [] })

    assert.equal(provider.requests.length, 1)
    const request = provider.requests[0]
    assert.equal(request.tools.length, 0)
    assert.equal(request.model, deps.bus.settings.models.conversation)
    assert.match(request.instructions, /answer from the state below only/i)

    const reply = deps.bus.messages.find((message) => message.kind === 'answer')
    assert.ok(reply)
    assert.equal(reply.replyToId, 'm-question')
    assert.equal(reply.author.type, 'agent')
    assert.ok(reply.refs?.some((ref) => ref.kind === 'task'))
    assert.ok(deps.voice.spoken.some((entry) => entry.reason === 'answer'))
  })

  test('a question is answered even while a long task is running', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const provider = new ScriptedProvider([
      turn({ toolCalls: [call('c1', 'list_files', {})] }),
      'hang',
      turn({ text: 'I am listing the workspace and then reading the panel.' })
    ])
    const runtime = new HuddleAgentRuntime(deps, provider)

    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Build something big'),
      addressed: []
    })
    // Wait until the work loop is genuinely blocked inside its second model
    // turn (the scripted "hang"), so this measures whether a question can be
    // answered *while* a task is stuck, not before it starts.
    await waitFor(() => provider.requests.length >= 2, 'the hanging model turn')

    const question = humanMessage('What are you checking right now?', { id: 'm-q2' })
    await runtime.handleHumanMessage({ roomId: 'r1', message: question, addressed: [] })
    const reply = deps.bus.messages.find((message) => message.kind === 'answer')
    assert.ok(
      reply,
      `messages=[${deps.bus.messages
        .map((message) => `${message.author.type}:${message.kind}:${message.body.slice(0, 70)}`)
        .join(' | ')}] requests=${provider.requests.length}`
    )
    assert.match(reply.body, /listing the workspace/)
    assert.notEqual(deps.bus.agents[0]?.activityLabel, 'Answering a question')

    const task = deps.bus.tasks[0]
    assert.ok(task)
    await runtime.cancelTask('r1', task.id)
  })
})

describe('cancellation', () => {
  test('a cancelled run says what already happened and never claims an undo', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const provider = new ScriptedProvider([
      turn({
        toolCalls: [
          call('c1', 'write_file', { path: 'src/Partial.tsx', contents: 'partial', reason: 'start' })
        ]
      }),
      'hang'
    ])
    const runtime = new HuddleAgentRuntime(deps, provider)

    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Write a large component'),
      addressed: []
    })
    await waitFor(() => deps.bus.getToolRuns('r1').length > 0, 'the write')

    const task = deps.bus.tasks[0]
    assert.ok(task)
    await runtime.cancelTask('r1', task.id)
    await waitFor(
      () => deps.bus.messages.some((message) => message.body.includes('Stopped as asked')),
      'the cancellation notice'
    )

    const stop = deps.bus.messages.find((message) => message.body.includes('Stopped as asked'))
    assert.ok(stop)
    assert.match(stop.body, /not claiming anything was undone/)
    assert.match(stop.body, /write_file/)
    assert.equal(deps.bus.getTask(task.id)?.status, 'cancelled')
    assert.ok(deps.voice.stopped.some((entry) => entry.scope === 'current'))
    // The file it already wrote is still there: we do not pretend otherwise.
    assert.equal(deps.exec.files.get('src/Partial.tsx'), 'partial')
  })

  test('pausing stops the loop and resuming lets it finish', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const provider = new ScriptedProvider([
      turn({ toolCalls: [call('c1', 'list_files', {})] }),
      turn({ text: 'All done.' })
    ])
    const runtime = new HuddleAgentRuntime(deps, provider)

    await runtime.pauseWork('r1')
    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Fix the header'),
      addressed: []
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(agentMessages(deps).length, 0)
    assert.equal(deps.bus.agents[0]?.workState, 'paused')

    await runtime.resumeWork('r1')
    await waitFor(() => agentMessages(deps).some((message) => message.kind === 'result'), 'the report after resume')
  })
})

describe('decisions', () => {
  test('a requirement change drops stale speech, flags work and notifies owners', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const provider = new ScriptedProvider([])
    const runtime = new HuddleAgentRuntime(deps, provider)
    const task = buildTask(
      { newId: () => deps.bus.newId(), now: () => deps.bus.now() },
      {
        roomId: 'r1',
        title: 'Build the vote panel',
        ownerAgentId: 'maya',
        createdBy: { type: 'human' },
        decisionRevision: 1,
        status: 'in_progress'
      }
    )
    deps.bus.upsertTask(task)
    const decision: Decision = {
      id: 'd1',
      roomId: 'r1',
      revision: 2,
      title: 'No timer on the vote screen',
      statement: 'The timer is cut from scope.',
      rationale: '',
      source: { type: 'human' },
      status: 'active',
      supersedesId: null,
      supersededById: null,
      affectedTaskIds: [task.id],
      originMessageId: null,
      createdAt: '2026-01-01T00:00:00.000Z'
    }

    await runtime.applyDecision('r1', decision, [task])

    assert.deepEqual(deps.voice.invalidated, [{ roomId: 'r1', revision: 2 }])
    const updated = deps.bus.getTask(task.id)
    assert.ok(updated?.staleSince)
    assert.match(updated?.staleReason ?? '', /No timer on the vote screen/)
    assert.ok(deps.bus.notices.some((notice) => /Decision r2 applied/.test(notice.text)))
    // Nothing was cancelled or edited by the decision itself.
    assert.equal(deps.exec.calls.length, 0)
    await runtime.dispose()
  })

  test('retryTask re-queues work against the current revision', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    if (deps.bus.rooms[0]) deps.bus.rooms[0].decisionRevision = 3
    const provider = new ScriptedProvider([])
    const runtime = new HuddleAgentRuntime(deps, provider)
    const task = buildTask(
      { newId: () => deps.bus.newId(), now: () => deps.bus.now() },
      {
        roomId: 'r1',
        title: 'Build the vote panel',
        ownerAgentId: 'maya',
        createdBy: { type: 'human' },
        decisionRevision: 1,
        status: 'blocked'
      }
    )
    deps.bus.upsertTask(task)

    const retried = await runtime.retryTask(task.id)
    assert.equal(retried.status, 'assigned')
    assert.equal(retried.decisionRevision, 3)
    assert.equal(retried.staleSince, null)
    await runtime.dispose()
  })
})

describe('degraded mode', () => {
  test('with no OpenAI key the room still records work and explains the fix', async () => {
    const deps = fakeDeps({ capability: { state: 'disabled', detail: 'No OpenAI API key', fix: 'Add OPENAI_API_KEY in Settings.' } })
    boundRoom(deps)
    const provider = new ScriptedProvider([], false)
    const runtime = new HuddleAgentRuntime(deps, provider)

    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Fix the header spacing'),
      addressed: []
    })

    assert.equal(agentMessages(deps).length, 0)
    assert.equal(deps.voice.spoken.length, 0)
    const notice = deps.bus.notices.find((entry) => /OpenAI is not configured/.test(entry.text))
    assert.ok(notice)
    assert.match(notice.fix ?? '', /OPENAI_API_KEY in Settings/)
    await runtime.dispose()
  })

  test('without a project, a work instruction still produces a task and no false file claims', async () => {
    const deps = fakeDeps()
    const provider = new ScriptedProvider([turn({ text: 'I cannot start: no project folder is bound.' })])
    const runtime = new HuddleAgentRuntime(deps, provider)

    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Build the vote panel'),
      addressed: []
    })
    await waitFor(() => agentMessages(deps).some((message) => message.kind === 'result'), 'the report')

    assert.equal(deps.bus.tasks.length, 1)
    assert.equal(deps.exec.files.size, 0)
    assert.equal(deps.exec.calls.length, 0)
    await runtime.dispose()
  })
})

describe('onboarding', () => {
  test('a newcomer introduces itself and takes one concrete piece of work', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    deps.bus.agents = [makeAgent(), makeAgent({ id: 'sam', presetId: 'sam', name: 'Sam', role: 'qa' })]
    const provider = new ScriptedProvider([
      turn({
        text: 'INTRO: I am Maya, I own the interface. I am taking the vote panel first.\nTASK: Build the vote panel\nACCEPTANCE: the panel renders | the percentage is shown'
      })
    ])
    const runtime = new HuddleAgentRuntime(deps, provider)

    await runtime.onboardAgent('r1', 'maya')

    const intro = agentMessages(deps)[0]
    assert.ok(intro)
    assert.match(intro.body, /I am Maya/)
    const task = deps.bus.tasks[0]
    assert.ok(task)
    assert.equal(task.ownerAgentId, 'maya')
    assert.equal(task.title, 'Build the vote panel')
    assert.deepEqual(task.acceptance, ['the panel renders', 'the percentage is shown'])
    assert.ok(deps.voice.spoken.length >= 1)
    // The prompt carried the room's real state, not a fabricated summary.
    assert.match(provider.requests[0].instructions, /Huddle demo/)
    await runtime.dispose()
  })

  test('an unparseable introduction still produces a truthful, preset-derived line', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const provider = new ScriptedProvider([turn({ text: 'hello' })])
    const runtime = new HuddleAgentRuntime(deps, provider)

    await runtime.onboardAgent('r1', 'maya')

    const intro = agentMessages(deps)[0]
    assert.ok(intro)
    assert.match(intro.body, /I'm Maya/)
    const task = deps.bus.tasks[0]
    assert.ok(task)
    assert.equal(task.ownerAgentId, 'maya')
    await runtime.dispose()
  })
})

describe('room lifecycle', () => {
  test('attachRoom marks interrupted work honestly and detachRoom cleans up', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const provider = new ScriptedProvider([])
    const runtime = new HuddleAgentRuntime(deps, provider)
    const task = buildTask(
      { newId: () => deps.bus.newId(), now: () => deps.bus.now() },
      {
        roomId: 'r1',
        title: 'Build the vote panel',
        ownerAgentId: 'maya',
        createdBy: { type: 'human' },
        decisionRevision: 1,
        status: 'in_progress'
      }
    )
    deps.bus.upsertTask(task)

    await runtime.attachRoom('r1')
    const reconciled = deps.bus.getTask(task.id)
    assert.equal(reconciled?.status, 'blocked')
    assert.match(reconciled?.blockedReason ?? '', /Interrupted/)

    await runtime.detachRoom('r1')
    await runtime.dispose()
    assert.deepEqual(runtime.listToolRuns('r1'), [])
  })

  test('createAgentRuntime builds the whole runtime from the frozen contract', async () => {
    const deps = fakeDeps()
    const runtime = createAgentRuntime(deps)
    assert.equal(typeof runtime.attachRoom, 'function')
    assert.equal(typeof runtime.detachRoom, 'function')
    assert.equal(typeof runtime.handleHumanMessage, 'function')
    assert.equal(typeof runtime.onboardAgent, 'function')
    assert.equal(typeof runtime.applyDecision, 'function')
    assert.equal(typeof runtime.pauseWork, 'function')
    assert.equal(typeof runtime.resumeWork, 'function')
    assert.equal(typeof runtime.cancelTask, 'function')
    assert.equal(typeof runtime.retryTask, 'function')
    assert.equal(typeof runtime.listToolRuns, 'function')
    await runtime.dispose()
  })
})

/* ------------------------------------------------------------------ *
 * Live steering and broadcast
 *
 * These are the two behaviours a voice room implies and a queue cannot give
 * you: everybody hears what is said to the room, and something said to a
 * teammate who is already working reaches that work while it is running.
 * ------------------------------------------------------------------ */

function threeAgents(deps: FakeDeps): void {
  deps.bus.agents = [
    makeAgent(),
    makeAgent({ id: 'alex', presetId: 'alex', name: 'Alex', role: 'systems' }),
    makeAgent({ id: 'sam', presetId: 'sam', name: 'Sam', role: 'qa' })
  ]
}

describe('a message said to the room', () => {
  test('reaches every teammate, not the best-matching one', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    threeAgents(deps)
    const provider = new ScriptedProvider([
      turn({ text: 'Maya here. I own the vote panel.' }),
      turn({ text: 'Alex here. I own the server contract.' }),
      turn({ text: 'Sam here. I own verification.' })
    ])
    const runtime = new HuddleAgentRuntime(deps, provider)

    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Everyone, if you can hear me, say your name and one thing you will own.'),
      addressed: []
    })

    await waitFor(
      () => new Set(agentMessages(deps).map((message) => (message.author as { agentId: string }).agentId)).size === 3,
      'all three teammates to answer',
      6000,
      () => `answers from: ${agentMessages(deps).map((m) => (m.author as { agentId: string }).agentId).join(', ')}`
    )

    // Nobody started a run: a room-wide question is answered, not worked on.
    assert.equal(deps.bus.tasks.length, 0)
  })

  test('a standing constraint is recorded for the room, not consumed by one turn', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    threeAgents(deps)
    const runtime = new HuddleAgentRuntime(
      deps,
      new ScriptedProvider([turn({ text: 'Understood.' }), turn({ text: 'Understood.' }), turn({ text: 'Understood.' })])
    )

    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Everyone, keep API costs while testing under $5.'),
      addressed: []
    })

    await waitFor(() => deps.bus.getMemories('r1').length > 0, 'the constraint to be recorded')
    const constraint = deps.bus.getMemories('r1').find((memory) => memory.kind === 'constraint')
    assert.ok(constraint, 'a constraint memory was recorded')
    assert.match(constraint.body, /under \$5/)
  })
})

describe('steering a teammate that is already working', () => {
  test('the instruction reaches the running loop instead of queueing behind it', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    let released = (): void => {}
    const gate = new Promise<void>((resolve) => {
      released = resolve
    })

    // Turn 1 blocks until the test has sent the second instruction, so the
    // steer provably lands *during* the run rather than after it.
    const provider = new ScriptedProvider()
    let turnIndex = 0
    const seen: string[] = []
    provider.complete = async (request) => {
      turnIndex += 1
      for (const item of request.input) {
        if (item.kind === 'text' && typeof item.content === 'string') seen.push(item.content)
      }
      if (turnIndex === 1) {
        await gate
        return turn({ toolCalls: [call('c1', 'list_files', { path: '.' })] })
      }
      return turn({ text: 'Switched to reading the code first, as asked. No files written.' })
    }

    const runtime = new HuddleAgentRuntime(deps, provider)
    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Maya, implement anonymous voting.'),
      addressed: []
    })
    await waitFor(() => turnIndex >= 1, 'the run to reach its first model turn')

    // Said while Maya is mid-run.
    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Maya, actually research it first before you write any code.', { id: 'm-steer' }),
      addressed: []
    })
    released()

    await waitFor(() => deps.bus.messages.some((message) => message.kind === 'result'), 'the redirected report')

    const injected = seen.find((text) => text.includes('LIVE INTERRUPTION'))
    assert.ok(injected, 'the instruction was injected into the running loop')
    assert.match(injected, /research it first/)

    // One task, not two: the redirect changed the work rather than forking it.
    assert.equal(deps.bus.tasks.length, 1)

    // The report says it was redirected, so the human can audit the claim.
    const result = deps.bus.messages.find((message) => message.kind === 'result')
    assert.ok(result)
    assert.match(result.body, /Redirected 1 time mid-run/)
  })

  test('a teammate that is not running gets the instruction the ordinary way', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const provider = new ScriptedProvider([turn({ text: 'Read the notes; nothing changed.' })])
    const runtime = new HuddleAgentRuntime(deps, provider)

    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Maya, read FEATURE_NOTES.md and tell me what it says.'),
      addressed: []
    })

    await waitFor(() => deps.bus.messages.some((message) => message.kind === 'result'), 'the report')
    const injected = provider.requests
      .flatMap((request) => request.input)
      .some((item) => item.kind === 'text' && String(item.content).includes('LIVE INTERRUPTION'))
    assert.equal(injected, false, 'an idle teammate is not told it was interrupted')
  })
})

describe('what a teammate says when it picks work up', () => {
  test('the acknowledgement never reads out the runtime’s own wake-up text', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const runtime = new HuddleAgentRuntime(deps, new ScriptedProvider([turn({ text: 'Done.' })]))

    await runtime.handleHumanMessage({
      roomId: 'r1',
      message: humanMessage('Maya, fix the vote panel layout.'),
      addressed: []
    })
    await waitFor(() => deps.bus.messages.some((message) => message.kind === 'result'), 'the report')

    for (const spoken of deps.voice.spoken) {
      assert.doesNotMatch(spoken.text, /Read the state and start your first slice of work/)
      assert.doesNotMatch(spoken.text, /You just joined/)
      assert.doesNotMatch(spoken.text, /Why you are being woken/)
    }
  })
})
