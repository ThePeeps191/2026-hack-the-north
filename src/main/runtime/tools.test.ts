import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Decision, Message, Task } from '../../shared/types.ts'
import type { RecordDecisionInput } from '../../shared/api.ts'
import { ToolRegistry, describeToolCall, Semaphore, TOOL_DEFINITIONS } from './tools.ts'
import { applyTaskPatch, buildTask, type TaskPatch } from './tasks.ts'
import type { BridgeNoticeItem, BridgeTaskInput, BridgeTaskResult, BridgeMessageInput, RuntimeBridge, ToolContext } from './types.ts'
import { FakeExec, fakeDeps, makeRoom, type FakeDeps } from './test-hosts.ts'

class FakeBridge implements RuntimeBridge {
  notices: Array<{ agentId: string; item: BridgeNoticeItem }> = []
  messages: Message[] = []
  systemMessages: string[] = []
  kicked = 0
  private readonly acks = new Set<string>()

  constructor(readonly deps: FakeDeps) {}

  notify(agentId: string, item: BridgeNoticeItem): boolean {
    this.notices.push({ agentId, item })
    return true
  }

  createTask(roomId: string, input: BridgeTaskInput, createdBy: Message['author']): BridgeTaskResult {
    const task = buildTask(
      { newId: () => this.deps.bus.newId(), now: () => this.deps.bus.now() },
      {
        roomId,
        title: input.title,
        detail: input.detail,
        ownerAgentId: input.ownerAgentId ?? null,
        createdBy,
        dependsOn: input.dependsOn,
        acceptance: input.acceptance,
        decisionRevision: 0,
        status: input.status
      }
    )
    this.deps.bus.upsertTask(task)
    return { task, notified: [] }
  }

  updateTask(taskId: string, patch: TaskPatch): Task | null {
    const existing = this.deps.bus.getTask(taskId)
    if (!existing) return null
    const next = applyTaskPatch(existing, patch, this.deps.bus.now())
    this.deps.bus.upsertTask(next)
    return next
  }

  getTask(taskId: string): Task | null {
    return this.deps.bus.getTask(taskId)
  }

  message(input: BridgeMessageInput): Message {
    const id = this.deps.bus.newId()
    const message: Message = {
      id,
      roomId: input.roomId,
      author: { type: 'agent', agentId: input.agentId },
      body: input.body,
      createdAt: this.deps.bus.now(),
      clientRequestId: id,
      kind: input.kind,
      to: [...(input.to ?? [])]
    }
    if (input.refs) message.refs = input.refs
    this.deps.bus.addMessage(message)
    this.messages.push(message)
    return message
  }

  systemMessage(roomId: string, body: string): Message | null {
    this.systemMessages.push(body)
    void roomId
    return null
  }

  async recordDecision(roomId: string, agentId: string, input: RecordDecisionInput): Promise<Decision> {
    return this.deps.bus.recordDecision({ ...input, roomId }, { type: 'agent', agentId })
  }

  async ensureWorkspace(roomId: string, agentId: string) {
    return this.deps.exec.ensureAgentWorkspace(roomId, agentId)
  }

  async teamWorkspace(roomId: string) {
    return this.deps.exec.ensureTeamWorkspace(roomId)
  }

  teamRevision(): string | null {
    return null
  }

  kick(): void {
    this.kicked += 1
  }

  alreadyAcknowledged(agentId: string, key: string): boolean {
    return this.acks.has(`${agentId}:${key}`)
  }

  markAcknowledged(agentId: string, key: string): void {
    this.acks.add(`${agentId}:${key}`)
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

function context(deps: FakeDeps, bridge: FakeBridge, over: Partial<ToolContext> = {}): ToolContext {
  return {
    roomId: 'r1',
    agentId: 'maya',
    taskId: null,
    signal: new AbortController().signal,
    deps,
    bridge,
    ...over
  }
}

describe('tool registry', () => {
  test('every tool declares a name, description and object schema', () => {
    const names = new Set<string>()
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(tool.name.length > 0)
      assert.ok(tool.description.length > 20, `${tool.name} needs a real description`)
      assert.equal(tool.parameters['type'], 'object', `${tool.name} schema`)
      assert.ok(tool.parameters['properties'], `${tool.name} schema needs properties`)
      assert.equal(names.has(tool.name), false, `${tool.name} is declared twice`)
      names.add(tool.name)
    }
    assert.ok(names.has('read_file'))
    assert.ok(names.has('write_file'))
    assert.ok(names.has('run_command'))
    assert.ok(names.has('browser_open'))
    assert.ok(names.has('run_integration'))
    assert.ok(names.has('ask_human'))
  })

  test('the registry exposes every tool to the provider with a schema', () => {
    const deps = fakeDeps()
    const registry = new ToolRegistry(undefined, () => deps.settings())
    const definitions = registry.definitions()
    assert.equal(definitions.length, TOOL_DEFINITIONS.length)
    for (const definition of definitions) {
      assert.equal(typeof definition.name, 'string')
      assert.equal(definition.parameters['type'], 'object')
    }
    assert.deepEqual(registry.names().sort(), [...new Set(registry.names())].sort())
  })

  test('malformed arguments are rejected and the validation message goes back to the model', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const bridge = new FakeBridge(deps)
    const registry = new ToolRegistry(undefined, () => deps.settings())

    const result = await registry.execute('read_file', { path: 12 }, context(deps, bridge))
    assert.equal(result.status, 'rejected')
    assert.match(result.content, /Invalid arguments for read_file/)
    assert.match(result.content, /"path" must be a string/)

    // Nothing reached the execution host, and the run is recorded as rejected.
    assert.equal(deps.exec.calls.length, 0)
    const run = deps.bus.getToolRuns('r1').at(-1)
    assert.ok(run)
    assert.equal(run.status, 'rejected')
    assert.ok(run.endedAt)
  })

  test('an unknown tool is rejected with the available names', async () => {
    const deps = fakeDeps()
    const bridge = new FakeBridge(deps)
    const registry = new ToolRegistry(undefined, () => deps.settings())
    const result = await registry.execute('teleport', {}, context(deps, bridge))
    assert.equal(result.status, 'rejected')
    assert.match(result.content, /There is no tool called "teleport"/)
    assert.match(result.content, /read_file/)
  })

  test('reads go through the execution host so path scoping is enforced there', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const bridge = new FakeBridge(deps)
    const registry = new ToolRegistry(undefined, () => deps.settings())
    deps.exec.files.set('src/App.tsx', 'export const App = 1\n')

    const result = await registry.execute('read_file', { path: 'src/App.tsx' }, context(deps, bridge))
    assert.equal(result.status, 'ok')
    const calls = deps.exec.calls.map((call) => call.method)
    assert.ok(calls.includes('ensureAgentWorkspace'))
    assert.ok(calls.includes('readFile'))
    assert.match(result.content, /src\/App\.tsx/)
    assert.match(result.content, /export const App = 1/)

    const run = deps.bus.getToolRuns('r1').at(-1)
    assert.ok(run)
    assert.equal(run.status, 'ok')
    assert.equal(run.refs?.[0]?.kind, 'file')
  })

  test('without a bound project the tools say so instead of guessing', async () => {
    const deps = fakeDeps()
    const bridge = new FakeBridge(deps)
    const registry = new ToolRegistry(undefined, () => deps.settings())
    const result = await registry.execute('list_files', {}, context(deps, bridge))
    assert.equal(result.status, 'error')
    assert.match(result.content, /No project folder is bound/)
    assert.equal(deps.exec.calls.length, 0)
  })

  test('a command is started for real and the model is told to poll it', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const bridge = new FakeBridge(deps)
    const registry = new ToolRegistry(undefined, () => deps.settings())

    const started = await registry.execute(
      'run_command',
      { command: 'npm test', label: 'unit tests' },
      context(deps, bridge)
    )
    assert.equal(started.status, 'ok')
    assert.match(started.content, /started job job-1/i)
    assert.match(started.content, /do not assume it passed/i)

    const output = await registry.execute('get_job_output', { job_id: 'job-1' }, context(deps, bridge))
    assert.equal(output.status, 'ok')
    assert.match(output.content, /All tests passed/)
  })

  test('a tool failure is an error, never a success', async () => {
    class ExplodingExec extends FakeExec {
      async readFile(): Promise<never> {
        throw new Error('path escapes the workspace root')
      }
    }
    const deps = fakeDeps({ exec: new ExplodingExec() })
    boundRoom(deps)
    const bridge = new FakeBridge(deps)
    const registry = new ToolRegistry(undefined, () => deps.settings())

    const result = await registry.execute('read_file', { path: '../secrets' }, context(deps, bridge))
    assert.equal(result.status, 'error')
    assert.match(result.content, /path escapes the workspace root/)
    const run = deps.bus.getToolRuns('r1').at(-1)
    assert.ok(run)
    assert.equal(run.status, 'error')
    assert.match(run.summary, /Failed|error/i)
  })

  test('cancellation is reported as cancelled, not as a failure', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const bridge = new FakeBridge(deps)
    const controller = new AbortController()
    controller.abort()
    const registry = new ToolRegistry(undefined, () => deps.settings())
    const result = await registry.execute(
      'list_files',
      {},
      context(deps, bridge, { signal: controller.signal })
    )
    assert.equal(result.status, 'cancelled')
    assert.equal(deps.exec.calls.length, 0)
  })

  test('browser tools refuse to act without a session', async () => {
    const deps = fakeDeps()
    const bridge = new FakeBridge(deps)
    const registry = new ToolRegistry(undefined, () => deps.settings())
    const result = await registry.execute(
      'browser_act',
      { action: 'click', selector: '#vote' },
      context(deps, bridge)
    )
    assert.equal(result.status, 'error')
    assert.match(result.content, /browser_open/)
    assert.equal(deps.browser.calls.length, 0)
  })

  test('browser actions validate their required fields', async () => {
    const deps = fakeDeps()
    const bridge = new FakeBridge(deps)
    const registry = new ToolRegistry(undefined, () => deps.settings())
    const result = await registry.execute('browser_act', { action: 'type', selector: '#name' }, context(deps, bridge))
    assert.equal(result.status, 'rejected')
    assert.match(result.content, /"type" needs a "selector" and "text"/)
  })

  test('team messages reach the mailbox of the named teammate', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    deps.bus.agents.push({
      ...deps.bus.agents[0],
      id: 'alex',
      presetId: 'alex',
      name: 'Alex',
      role: 'systems'
    })
    const bridge = new FakeBridge(deps)
    const registry = new ToolRegistry(undefined, () => deps.settings())

    const result = await registry.execute(
      'message_teammate',
      { teammate: 'Alex', message: 'What payload shape do you want?', review: true },
      context(deps, bridge)
    )
    assert.equal(result.status, 'ok')
    assert.equal(bridge.notices.length, 1)
    assert.equal(bridge.notices[0].agentId, 'alex')
    assert.equal(bridge.notices[0].item.kind, 'review_request')
    assert.equal(bridge.messages.length, 1)
    assert.deepEqual(bridge.messages[0].to, ['alex'])
  })

  test('an agent cannot message itself', async () => {
    const deps = fakeDeps()
    const bridge = new FakeBridge(deps)
    const registry = new ToolRegistry(undefined, () => deps.settings())
    const result = await registry.execute('message_teammate', { teammate: 'Maya', message: 'hello' }, context(deps, bridge))
    assert.equal(result.status, 'rejected')
    assert.equal(bridge.messages.length, 0)
  })

  test('submit_work refuses a result produced against an older decision revision', async () => {
    const deps = fakeDeps()
    boundRoom(deps)
    const bridge = new FakeBridge(deps)
    const registry = new ToolRegistry(undefined, () => deps.settings())
    const task = buildTask(
      { newId: () => deps.bus.newId(), now: () => deps.bus.now() },
      { roomId: 'r1', title: 'Vote panel', ownerAgentId: 'maya', createdBy: { type: 'human' }, decisionRevision: 1 }
    )
    deps.bus.upsertTask(task)
    if (deps.bus.rooms[0]) deps.bus.rooms[0].decisionRevision = 3

    const result = await registry.execute(
      'submit_work',
      { summary: 'panel done', task_id: task.id },
      context(deps, bridge, { taskId: task.id })
    )
    assert.equal(result.status, 'rejected')
    assert.match(result.content, /revision 1/)
    assert.match(result.content, /revision 3/)
    assert.equal(deps.exec.calls.some((call) => call.method === 'submitWork'), false)
  })

  test('record_decision goes through the bridge and comes back with a revision', async () => {
    const deps = fakeDeps()
    const bridge = new FakeBridge(deps)
    const registry = new ToolRegistry(undefined, () => deps.settings())
    const result = await registry.execute('record_decision', { title: 'Export format', statement: 'Use JSON' }, context(deps, bridge))
    assert.equal(result.status, 'ok')
    assert.match(result.content, /Decision r2 recorded/)
    assert.equal(deps.bus.decisions.length, 1)
    assert.equal(deps.bus.rooms[0]?.decisionRevision, 2)
    assert.equal(result.refs?.[0]?.kind, 'decision')
  })

  test('a bridge failure surfaces as an error, never as a fake success', async () => {
    const deps = fakeDeps()
    const bridge = new FakeBridge(deps)
    bridge.createTask = () => {
      throw new Error('workspace unavailable')
    }
    const registry = new ToolRegistry(undefined, () => deps.settings())
    const result = await registry.execute('create_task', { title: 'Wire the endpoint' }, context(deps, bridge))
    assert.equal(result.status, 'error')
    assert.match(result.content, /workspace unavailable/)
  })
})

describe('tool call activity', () => {
  test('real tool names map to real work states', () => {
    assert.deepEqual(describeToolCall('read_file', { path: 'src/App.tsx' }), {
      state: 'reading',
      surface: 'code',
      label: 'Reading src/App.tsx'
    })
    assert.equal(describeToolCall('run_command', { command: 'npm test' }).state, 'running')
    assert.equal(describeToolCall('browser_screenshot', {}).surface, 'browser')
    assert.equal(describeToolCall('run_integration', {}).state, 'integrating')
    assert.equal(describeToolCall('ask_human', {}).state, 'waiting')
    assert.equal(describeToolCall('mystery_tool', {}).state, 'thinking')
  })

  test('a long argument is shortened for the tile label', () => {
    const label = describeToolCall('read_file', { path: 'a/'.repeat(60) }).label
    assert.ok(label.length < 80)
  })
})

describe('concurrency guard', () => {
  test('the semaphore never exceeds its limit and serves waiters in order', async () => {
    const semaphore = new Semaphore(2)
    const order: string[] = []
    const releaseA = await semaphore.acquire()
    const releaseB = await semaphore.acquire()
    assert.equal(semaphore.inFlight, 2)

    let release: (() => void) | null = null
    const third = { call: (): void => release?.() }
    const pending = semaphore.acquire().then((fn) => {
      order.push('third')
      release = fn
    })
    await Promise.resolve()
    assert.equal(order.length, 0)
    assert.equal(semaphore.queued, 1)

    releaseA()
    await pending
    assert.deepEqual(order, ['third'])
    assert.equal(semaphore.inFlight, 2)
    releaseB()
    third.call()
    assert.equal(semaphore.inFlight, 0)
  })

  test('the registry serialises tool calls per room at the configured limit', async () => {
    class SlowExec extends FakeExec {
      active = 0
      peak = 0
      async listDir(workspaceId: string, path?: string) {
        this.active += 1
        this.peak = Math.max(this.peak, this.active)
        await new Promise((resolve) => setTimeout(resolve, 15))
        this.active -= 1
        return super.listDir(workspaceId, path)
      }
    }
    const exec = new SlowExec()
    const deps = fakeDeps({ exec })
    boundRoom(deps)
    deps.bus.settings.limits.maxConcurrentToolCalls = 1
    const bridge = new FakeBridge(deps)
    const registry = new ToolRegistry(undefined, () => deps.settings())

    await Promise.all([
      registry.execute('list_files', {}, context(deps, bridge)),
      registry.execute('list_files', {}, context(deps, bridge)),
      registry.execute('list_files', {}, context(deps, bridge))
    ])
    assert.equal(exec.peak, 1)
    assert.equal(deps.bus.getToolRuns('r1').length, 3)
    assert.deepEqual(
      deps.bus.getToolRuns('r1').map((run) => run.status),
      ['ok', 'ok', 'ok']
    )
  })
})
