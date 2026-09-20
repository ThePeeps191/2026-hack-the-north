/**
 * The executor: one agent, one piece of work, bounded turns.
 *
 * It is a loop over real observations, not a chat: the model picks a tool, the
 * tool runs against the real project, the real result goes back into the
 * context, and the loop continues until the agent answers, the turn budget runs
 * out, the provider fails, or the human cancels. Every state it reports —
 * thinking / reading / editing / running / browsing / testing / integrating /
 * waiting / blocked / paused — comes from a specific action that actually
 * happened.
 *
 * It stops with a grounded summary rather than looping forever: a run always
 * ends with either a report, a recorded failure with a fix, or an honest note
 * that it was cancelled or ran out of turns.
 */

import type { Agent, ContextRef, Room, ShareSurface } from '../../shared/types.ts'
import type { RuntimeDeps } from '../contracts.ts'
import { toErrorShape } from '../huddle-error.ts'
import { redact } from '../config/secrets.ts'
import { collectRoomState, formatRoomState } from './context.ts'
import type { Mailbox } from './mailbox.ts'
import type { OpenAiProvider, ProviderInputItem, ProviderTurn } from './provider.ts'
import { describeToolCall, type ToolRegistry } from './tools.ts'
import type { RuntimeBridge, ToolContext } from './types.ts'

/** Output ceiling for one contributor turn. */
export const MAX_OUTPUT_TOKENS_WORK = 2400
/** Provider failures tolerated inside one run before it gives up honestly. */
export const MAX_MODEL_ATTEMPTS = 3
/** Consecutive failing tool calls tolerated before the loop stops. */
export const MAX_TOOL_FAILURES = 4
/** How many provider input items a run may carry before older ones are dropped. */
export const MAX_CONTEXT_ITEMS = 40

export interface WorkItem {
  roomId: string
  agentId: string
  taskId: string | null
  /** Why this run exists, in one line. */
  reason: string
  /** The instruction the model starts from. */
  brief: string
  /** Set when this run answers an inbox item, for acknowledgement bookkeeping. */
  inboxMessageId?: string
  /** Mailbox assignment key: one acknowledgement per assignment. */
  ackKey?: string
  /**
   * The exact line the agent says when it picks this up, written for a human
   * ear. Omitted when picking work up silently is the honest thing to do.
   */
  ackText?: string
  refs?: ContextRef[]
}

export interface ExecutorDeps {
  deps: RuntimeDeps
  provider: OpenAiProvider
  tools: ToolRegistry
  bridge: RuntimeBridge
  mailbox: Mailbox
  /** Called when a run finishes so the scheduler can pick up the next thing. */
  onIdle(agentId: string): void
}

/** Something said to an agent *while* it was already working. */
export interface Interjection {
  /** What was said, verbatim. */
  text: string
  /** Who said it: the human, or a teammate's name. */
  from: string
  /** Room-wide instructions are phrased differently from a direct one. */
  scope: 'direct' | 'broadcast'
  at: number
}

interface RunHandle {
  roomId: string
  agentId: string
  taskId: string | null
  controller: AbortController
  startedAt: number
  /** Last surface this run already proposed, so the stage is not yanked twice. */
  lastSurface: ShareSurface | null
  /**
   * Instructions that arrived after this run started and have not reached the
   * model yet. Drained before every model turn and after every tool call, so
   * the human can redirect work in flight instead of waiting for it to finish.
   */
  pending: Interjection[]
  /** A one-line description of what the run was doing when it was redirected. */
  lastActivity: string
}

export class PauseGate {
  private paused = false
  private readonly waiters: Array<() => void> = []

  get isPaused(): boolean {
    return this.paused
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    const waiters = this.waiters.splice(0, this.waiters.length)
    for (const waiter of waiters) waiter()
  }

  /** Resolves immediately unless the agent is paused. Never throws. */
  async wait(signal: AbortSignal, onPaused: () => void): Promise<void> {
    if (!this.paused) return
    onPaused()
    await new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener('abort', done)
        resolve()
      }
      this.waiters.push(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }
}

export class RuntimeExecutor {
  private readonly runs = new Map<string, RunHandle>()
  private readonly taskRuns = new Map<string, AbortController>()
  private readonly gates = new Map<string, PauseGate>()
  private disposed = false

  constructor(private readonly d: ExecutorDeps) {}

  isBusy(agentId: string): boolean {
    return this.runs.has(agentId)
  }

  busyAgentIds(): string[] {
    return [...this.runs.keys()]
  }

  runningTaskIds(): string[] {
    return [...this.taskRuns.keys()]
  }

  isPaused(agentId: string): boolean {
    return this.gates.get(agentId)?.isPaused ?? false
  }

  pause(agentId: string): void {
    const gate = this.gates.get(agentId) ?? new PauseGate()
    gate.pause()
    this.gates.set(agentId, gate)
    const run = this.runs.get(agentId)
    const agent = run ? this.d.deps.bus.getAgent(agentId) : null
    this.d.deps.bus.setAgentActivity(agentId, 'paused', agent ? `Paused during "${agent.activityLabel}"` : 'Paused')
  }

  resume(agentId: string): void {
    this.gates.get(agentId)?.resume()
  }

  /** Aborts the run for a task. Work stops; nothing already written is undone. */
  cancelTask(taskId: string): boolean {
    const controller = this.taskRuns.get(taskId)
    if (!controller) return false
    controller.abort()
    return true
  }

  /**
   * Hands a running agent something the human just said.
   *
   * This is the difference between a batch job and a teammate: the instruction
   * lands inside the loop that is already running, before its next model turn,
   * so the agent adjusts without losing the work it has already verified.
   * Returns false when the agent is not running anything — the caller then
   * queues the instruction normally.
   */
  interject(agentId: string, item: Omit<Interjection, 'at'>): boolean {
    const run = this.runs.get(agentId)
    if (!run) return false
    run.pending.push({ ...item, at: Date.now() })
    const agent = this.d.deps.bus.getAgent(agentId)
    if (agent) run.lastActivity = agent.activityLabel
    this.d.deps.bus.setAgentActivity(agentId, agent?.workState ?? 'thinking', 'Heard you — adjusting')
    return true
  }

  /** What a running agent is doing, for an answer given while it keeps working. */
  currentActivity(agentId: string): string | null {
    const run = this.runs.get(agentId)
    if (!run) return null
    return this.d.deps.bus.getAgent(agentId)?.activityLabel ?? run.lastActivity
  }

  /** Aborts whatever this agent is running. */
  cancelAgent(agentId: string): boolean {
    const run = this.runs.get(agentId)
    if (!run) return false
    run.controller.abort()
    return true
  }

  /** Agent ids currently running a work loop in this room. */
  agentsInRoom(roomId: string): string[] {
    const out: string[] = []
    for (const run of this.runs.values()) {
      if (run.roomId === roomId) out.push(run.agentId)
    }
    return out
  }

  dispose(): void {
    this.disposed = true
    for (const run of this.runs.values()) run.controller.abort()
    this.runs.clear()
    this.taskRuns.clear()
  }

  /** Starts a run. Returns false when that agent is already working. */
  start(item: WorkItem): boolean {
    if (this.disposed) return false
    if (this.runs.has(item.agentId)) return false
    const controller = new AbortController()
    const handle: RunHandle = {
      roomId: item.roomId,
      agentId: item.agentId,
      taskId: item.taskId,
      controller,
      startedAt: Date.now(),
      lastSurface: null,
      pending: [],
      lastActivity: ''
    }
    this.runs.set(item.agentId, handle)
    if (item.taskId) this.taskRuns.set(item.taskId, controller)
    void this.runWork(item, handle)
      .catch((error: unknown) => {
        const shape = toErrorShape(error)
        this.d.deps.bus.notice(item.roomId, 'error', `A teammate's work loop failed: ${shape.message}`, shape.fix ?? undefined)
      })
      .finally(() => {
        this.runs.delete(item.agentId)
        if (item.taskId) this.taskRuns.delete(item.taskId)
        try {
          this.d.onIdle(item.agentId)
        } catch {
          // The scheduler owns its own failures.
        }
      })
    return true
  }

  /* ---------------------------------------------------------------- *
   * The loop
   * ---------------------------------------------------------------- */

  private async runWork(item: WorkItem, handle: RunHandle): Promise<void> {
    const { deps, provider, tools, bridge } = this.d
    const bus = deps.bus
    const signal = handle.controller.signal
    const room = bus.getRoom(item.roomId)
    const agent = bus.getAgent(item.agentId)
    if (!room || !agent) return

    const gate = this.gates.get(item.agentId) ?? new PauseGate()
    this.gates.set(item.agentId, gate)

    const settings = deps.settings()
    const model = agent.model || settings.models.contributor
    const maxTurns = Math.max(1, settings.limits.maxModelTurnsPerTask)
    const definitions = tools.definitions()
    const input: ProviderInputItem[] = [{ kind: 'text', role: 'user', content: item.brief }]
    const evidence: ContextRef[] = []
    let toolFailures = 0
    let modelAttempts = 0
    let turns = 0
    let stop: 'replied' | 'cancelled' | 'turns' | 'error' | 'stuck' = 'turns'
    let finalText = ''
    let redirects = 0

    /**
     * Moves anything said to this agent since the last check into the model's
     * input. Returns true when something landed, so the caller can cut a tool
     * batch short rather than finish work the human has just redirected.
     */
    const drain = (droppedCalls: number): boolean => {
      if (handle.pending.length === 0) return false
      const taken = handle.pending.splice(0, handle.pending.length)
      redirects += taken.length
      for (const said of taken) {
        const who = said.scope === 'broadcast' ? `${said.from} (to the whole room)` : said.from
        input.push({
          kind: 'text',
          role: 'user',
          content: [
            `[LIVE INTERRUPTION — ${who} said this while you were mid-task. It outranks your current plan.]`,
            said.text,
            '',
            'Act on it now. Keep everything you have already verified — do not start over and do not re-read',
            'files you already read. If it changes what you should be doing, change course; if it is a standing',
            'constraint, hold it for the rest of this run. Open your next message with one short line telling the',
            'human what you changed, then carry on.',
            droppedCalls > 0
              ? `(${droppedCalls} tool call${droppedCalls === 1 ? '' : 's'} you had queued were not run, so you can choose differently.)`
              : ''
          ]
            .filter((piece) => piece.length > 0)
            .join('\n')
        })
      }
      bus.setAgentActivity(agent.id, 'thinking', 'Taking the new instruction')
      return true
    }

    try {
      await this.acknowledge(item, agent, room)

      while (turns < maxTurns) {
        if (signal.aborted) {
          stop = 'cancelled'
          break
        }
        await gate.wait(signal, () => bus.setAgentActivity(agent.id, 'paused', 'Paused'))
        if (signal.aborted) {
          stop = 'cancelled'
          break
        }

        // Anything the human said since the last turn reaches the model before
        // it decides what to do next.
        drain(0)

        turns += 1
        bus.setAgentActivity(
          agent.id,
          'thinking',
          item.taskId ? 'Working out the next step' : 'Reading the room'
        )

        const state = collectRoomState(bus, item.roomId, agent.id, { messageLimit: 10, toolRunLimit: 10 })
        const instructions = state
          ? workInstructions(agent, room, item, state, turns)
          : `${agent.persona}\n\nWork on: ${item.brief}`

        let turn: ProviderTurn
        const toolStartedMs = Date.now()
        try {
          turn = await provider.complete({
            model,
            instructions,
            input: boundInput(input),
            tools: definitions,
            maxOutputTokens: MAX_OUTPUT_TOKENS_WORK,
            signal,
            onTextDelta: (delta) => {
              bus.emit(room.id, { type: 'agent.stream', agentId: agent.id, taskId: item.taskId, delta, done: false })
            }
          })
          modelAttempts = 0
        } catch (error) {
          if (signal.aborted) {
            stop = 'cancelled'
            break
          }
          modelAttempts += 1
          const shape = toErrorShape(error)
          if (modelAttempts >= MAX_MODEL_ATTEMPTS) {
            stop = 'error'
            bus.notice(
              room.id,
              'error',
              `${agent.name} could not continue: ${shape.message}`,
              shape.fix ?? undefined
            )
            break
          }
          input.push({
            kind: 'text',
            role: 'user',
            content: `That attempt failed at the provider level (${shape.message}). It was not your fault and nothing was changed. Try a different, smaller step.`
          })
          continue
        }

        if (turn.text.trim()) input.push({ kind: 'text', role: 'assistant', content: turn.text })

        if (turn.toolCalls.length === 0) {
          finalText = turn.text.trim()
          stop = finalText ? 'replied' : 'stuck'
          break
        }

        for (const [index, call] of turn.toolCalls.entries()) {
          if (signal.aborted) {
            stop = 'cancelled'
            break
          }
          // A turn can ask for several tools at once. If the human spoke while
          // the previous one ran, stop here: the rest of the batch was planned
          // against instructions that no longer hold. Nothing half-written is
          // left behind, because each call is only sent to the model together
          // with its own result.
          if (handle.pending.length > 0) {
            drain(turn.toolCalls.length - index)
            break
          }
          await gate.wait(signal, () => bus.setAgentActivity(agent.id, 'paused', 'Paused'))
          if (signal.aborted) {
            stop = 'cancelled'
            break
          }

          input.push({ kind: 'call', callId: call.id, name: call.name, arguments: call.arguments })
          const parsed = safeParse(call.arguments)
          const described = describeToolCall(call.name, parsed)
          bus.setAgentActivity(agent.id, described.state, described.label)
          if (described.surface) this.proposeStage(handle, described.surface, call.name, toolStartedMs)

          const ctx: ToolContext = {
            roomId: item.roomId,
            agentId: agent.id,
            taskId: item.taskId,
            signal,
            deps,
            bridge
          }
          const execution = await tools.execute(call.name, parsed, ctx)
          input.push({ kind: 'result', callId: call.id, name: call.name, output: execution.content })
          if (execution.refs) evidence.push(...execution.refs.slice(0, 6))
          if (execution.status === 'ok') toolFailures = 0
          else toolFailures += 1
        }

        if (stop === 'cancelled') break
        if (toolFailures >= MAX_TOOL_FAILURES) {
          stop = 'stuck'
          input.push({
            kind: 'text',
            role: 'user',
            content:
              'Several tool calls in a row failed. Stop calling tools, and answer with what you know for certain, what failed, and what you need.'
          })
          const closing = await this.closingText(provider, model, instructions, input, signal, agent)
          if (closing) finalText = closing
          break
        }
        if (turns >= maxTurns) {
          const closing = await this.closingText(provider, model, instructions, input, signal, agent)
          if (closing) finalText = closing
        }
      }
    } finally {
      bus.emit(room.id, { type: 'agent.stream', agentId: agent.id, taskId: item.taskId, delta: '', done: true })
      await this.settle(item, agent, stop, finalText, evidence, turns, redirects)
      bus.setAgentActivity(agent.id, 'idle', 'Available')
    }

    if (this.disposed) return
  }

  /**
   * One short acknowledgement per assignment, never repeated.
   *
   * It says what the agent is picking up in its own words. It must never echo
   * the runtime's internal wake-up text ("You just joined the room. Read the
   * state and start your first slice of work") — that is plumbing, and reading
   * it out loud made the team sound like a queue rather than colleagues.
   */
  private async acknowledge(item: WorkItem, agent: Agent, room: Room): Promise<void> {
    if (!item.ackKey || !item.inboxMessageId) return
    if (!item.ackText) return
    const { bridge } = this.d
    if (bridge.alreadyAcknowledged(agent.id, item.ackKey)) return
    bridge.markAcknowledged(agent.id, item.ackKey)
    const line = item.ackText.trim().slice(0, 160)
    if (!line) return
    bridge.message({
      roomId: room.id,
      agentId: agent.id,
      body: line,
      kind: 'chat',
      speak: true,
      speechReason: 'ack',
      spokenOverride: line
    })
  }

  /** A last model turn with tools removed, so a stuck run still says something true. */
  private async closingText(
    provider: OpenAiProvider,
    model: string,
    instructions: string,
    input: ProviderInputItem[],
    signal: AbortSignal,
    agent: Agent
  ): Promise<string> {
    if (signal.aborted) return ''
    try {
      const turn = await provider.complete({
        model,
        instructions,
        input: [
          ...boundInput(input),
          {
            kind: 'text',
            role: 'user',
            content:
              'Tools are disabled now. In three sentences or fewer, state what you did, what you verified, and what is still open. Do not claim anything you did not actually do.'
          }
        ],
        tools: [],
        maxOutputTokens: 500,
        timeoutMs: 45_000
      })
      return turn.text.trim()
    } catch {
      this.d.deps.bus.setAgentActivity(agent.id, 'blocked', 'Could not summarise')
      return ''
    }
  }

  /** The written message, always grounded in what actually happened. */
  private async settle(
    item: WorkItem,
    agent: Agent,
    stop: 'replied' | 'cancelled' | 'turns' | 'error' | 'stuck',
    finalText: string,
    evidence: ContextRef[],
    turns: number,
    /** How many times the human redirected this run while it was running. */
    redirects: number
  ): Promise<void> {
    const { deps, bridge } = this.d
    const bus = deps.bus
    const room = bus.getRoom(item.roomId)
    if (!room) return
    const task = item.taskId ? bus.getTask(item.taskId) : null
    const refs = dedupeRefs(evidence).slice(0, 12)
    const realRuns = bus
      .getToolRuns(item.roomId)
      .filter((run) => run.agentId === agent.id && (item.taskId === null || run.taskId === item.taskId))
      .slice(-12)

    if (stop === 'cancelled') {
      const effects = realRuns.filter((run) => run.status === 'ok' && isSideEffect(run.name))
      const lines = effects.map((run) => `- ${run.name}: ${run.summary}`)
      bridge.message({
        roomId: room.id,
        agentId: agent.id,
        body:
          `Stopped as asked${task ? ` on "${task.title}"` : ''} after ${turns} turn(s). I am not claiming anything was undone.\n` +
          (lines.length > 0
            ? `Changes that already happened:\n${lines.join('\n')}`
            : 'No file or command effects were recorded before stopping.'),
        kind: 'system',
        refs,
        speak: true,
        speechReason: 'status',
        spokenOverride: `Stopped${task ? ` on ${task.title}` : ''}. Nothing was rolled back.`
      })
      if (task) bridge.updateTask(task.id, { status: 'cancelled' })
      return
    }

    if (!finalText) {
      const reason =
        stop === 'error'
          ? 'the provider failed'
          : stop === 'turns'
            ? 'the turn limit was reached'
            : 'the model produced nothing usable'
      bridge.systemMessage(
        room.id,
        `${agent.name} stopped without a report because ${reason}. Last recorded tool activity: ${
          realRuns.length > 0 ? realRuns.map((run) => `${run.name} ${run.status}`).join(', ') : 'none'
        }.`
      )
      if (task) bridge.updateTask(task.id, { status: 'blocked', blockedReason: `Run stopped: ${reason}.` })
      return
    }

    const notes: string[] = []
    if (redirects > 0) {
      notes.push(
        `Redirected ${redirects} time${redirects === 1 ? '' : 's'} mid-run; this report is against the latest instruction.`
      )
    }
    if (stop === 'turns') {
      notes.push(`Stopped at the ${turns}-turn limit for this task, so this is where the work stands. Reply to continue.`)
    }
    const body = notes.length > 0 ? `${finalText}\n\n[${notes.join(' ')}]` : finalText

    const message = bridge.message({
      roomId: room.id,
      agentId: agent.id,
      body,
      kind: task ? 'result' : 'chat',
      refs,
      speak: true,
      speechReason: task ? 'result' : 'explain'
    })

    if (task) {
      bridge.updateTask(task.id, {
        status: 'awaiting_review',
        evidence: dedupeRefs([...task.evidence, ...refs]).slice(0, 12)
      })
      // Only a different owner is asked to review. Notifying the agent that
      // just finished would put its own report back in its inbox and start a
      // loop that never ends.
      if (task.ownerAgentId && task.ownerAgentId !== agent.id) {
        bridge.notify(task.ownerAgentId, {
          kind: 'review_request',
          summary: `${agent.name} reported on "${task.title}"`,
          note: message.body.slice(0, 400),
          messageId: message.id,
          taskId: task.id
        })
      }
    }
  }

  private proposeStage(handle: RunHandle, surface: ShareSurface, toolName: string, toolStartedMs: number): void {
    if (handle.lastSurface === surface) return
    handle.lastSurface = surface
    const bus = this.d.deps.bus
    bus.recordTimings([
      {
        label: 'toolCallToStageUpdate',
        ms: Math.max(0, Date.now() - toolStartedMs),
        at: bus.now(),
        detail: `${surface} via ${toolName}`
      }
    ])
    bus.proposeStage(handle.roomId, handle.agentId, surface)
  }
}

/* ------------------------------------------------------------------ *
 * Prompt building
 * ------------------------------------------------------------------ */

const WORK_RULES = `
How to work in this loop:
- You have real tools. Use them; never describe what a file or command probably contains.
- One step at a time: call at most a few tools per turn, then read their results.
- A command is not finished until you have read its output with get_job_output or wait_for_job.
- If a tool fails, read why and change your approach; do not repeat the same failing call.
- If you are blocked by a decision only the human can make, use ask_human instead of guessing.
- If work belongs to a teammate, use message_teammate or assign_task instead of doing it yourself.

When you are done, write one message for the human:
- What you did, in plain language.
- Evidence: the files you touched, the command you ran and its exit status, or the artifact you produced.
- What is still open or unverified.
- No enthusiasm padding, no restating the goal, no claims you cannot point at evidence for.
`.trim()

function workInstructions(
  agent: Agent,
  room: Room,
  item: WorkItem,
  state: ReturnType<typeof collectRoomState>,
  turn: number
): string {
  const task = item.taskId ? state?.tasks.find((candidate) => candidate.id === item.taskId) : undefined
  const stateText = state ? formatRoomState(state, 'work') : 'Room state unavailable.'
  const taskText = task
    ? `Task: ${task.title} [${task.status}] owner=${task.ownerName}\nAcceptance criteria:\n${
        task.acceptance.length > 0 ? task.acceptance.map((line) => `- ${line}`).join('\n') : '- none recorded; write evidence for whatever you change'
      }${task.stale ? `\nThis task is marked STALE: re-check it against the current decisions before continuing.` : ''}`
    : `You are not working on a task right now. Reason for this turn: ${item.reason}`

  return [
    agent.persona,
    WORK_RULES,
    `You are ${agent.name} in the room "${room.name}". Decision revision in force: ${room.decisionRevision}.`,
    taskText,
    `Why this turn exists: ${item.reason}`,
    `Turn ${turn}. Every claim you make must match the state below.`,
    stateText
  ].join('\n\n')
}

function safeParse(text: string): unknown {
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { __unparsable: redact(text).slice(0, 400) }
  }
}

/** Keeps the first item (the brief) plus the newest items. */
/**
 * Keeps the brief plus the newest items, without ever splitting a tool call
 * from its result.
 *
 * A `result` item becomes a `tool` message, which is only valid immediately
 * after the assistant message that requested it. Slicing blindly could make the
 * window start on an orphaned result, and every provider rejects that with a
 * 400 — which is what made long runs end with "stopped without a report"
 * instead of a summary: the closing turn is the one with the longest context,
 * so it failed the most reliably. A trailing call with no result yet is dropped
 * for the same reason.
 */
export function boundInput(input: ProviderInputItem[]): ProviderInputItem[] {
  if (input.length <= MAX_CONTEXT_ITEMS) return input
  const first = input[0]

  let start = input.length - (MAX_CONTEXT_ITEMS - 1)
  // Walk forward past any result whose call is on the other side of the cut.
  while (start < input.length && input[start].kind === 'result') start += 1

  let end = input.length
  // A call whose result has not been pushed yet would be left unanswered.
  while (end > start && input[end - 1].kind === 'call') end -= 1

  const recent = input.slice(start, end)
  const dropped = input.length - recent.length - 1
  if (dropped <= 0) return input
  const marker: ProviderInputItem = {
    kind: 'text',
    role: 'user',
    content: `[${dropped} earlier items were dropped to keep this context small. Use list_tasks, get_job_output or read_file again if you need them.]`
  }
  return [first, marker, ...recent]
}

function dedupeRefs(refs: readonly ContextRef[]): ContextRef[] {
  const seen = new Set<string>()
  const out: ContextRef[] = []
  for (const ref of refs) {
    const key = refKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

function refKey(ref: ContextRef): string {
  switch (ref.kind) {
    case 'file':
      return `file:${ref.path}:${ref.startLine ?? ''}-${ref.endLine ?? ''}`
    case 'task':
      return `task:${ref.taskId}`
    case 'job':
      return `job:${ref.jobId}`
    case 'artifact':
      return `artifact:${ref.artifactId}`
    case 'screenshot':
      return `screenshot:${ref.artifactId}`
    case 'decision':
      return `decision:${ref.decisionId}`
    default:
      return 'ref'
  }
}

function isSideEffect(name: string): boolean {
  return (
    name === 'write_file' ||
    name === 'apply_patch' ||
    name === 'run_command' ||
    name === 'submit_work' ||
    name === 'start_preview' ||
    name === 'browser_act'
  )
}
