/**
 * The agent runtime.
 *
 * Composition root for everything in `src/main/runtime/`: the OpenAI adapter,
 * the tool registry, the work loop, the responsive conversation path, the
 * mailboxes, the task graph and the speech requests. It implements the
 * `AgentRuntime` contract from `src/main/contracts.ts` and nothing outside it.
 *
 * Behaviour that matters to the product:
 *  - work state and speech state are independent; interrupting speech never
 *    cancels work, and cancelling work never claims a file was reverted;
 *  - a requirement change bumps the decision revision, invalidates queued
 *    speech and marks affected work stale;
 *  - nothing claims to have read, edited, tested or browsed anything that no
 *    tool actually touched;
 *  - with no OpenAI key the room still works: typed messages, room state, tasks
 *    and every other configured capability keep functioning.
 */

import type {
  AgentRuntime,
  CreateAgentRuntime,
  InboundMessage,
  RuntimeDeps,
  SpeechHandle
} from '../contracts.ts'
import type {
  Agent,
  ContextRef,
  Decision,
  Message,
  MessageAuthor,
  Room,
  Task,
  ToolRun,
  WorkspaceRecord
} from '../../shared/types.ts'
import type { RecordDecisionInput } from '../../shared/api.ts'
import type { SpeechReason } from '../../shared/voice.ts'
import { collectRoomState, formatRoomState } from './context.ts'
import { ConversationResponder } from './conversation.ts'
import { RuntimeExecutor, type WorkItem } from './executor.ts'
import { Mailbox, type MailboxItem } from './mailbox.ts'
import { createDefaultProvider, type OpenAiProvider } from './provider.ts'
import { routeMessage, type RouterAgent, type RouterDecision, type RouterMessage } from './router.ts'
import { requestSpeech, speechReasonFor, invalidateSpeechBefore } from './speech.ts'
import {
  applyTaskPatch,
  buildTask,
  dependenciesSatisfied,
  interruptedTasks,
  nextRunnableTask,
  refreshStaleTask,
  staleTask,
  type GraphClock,
  type TaskPatch
} from './tasks.ts'
import { ToolRegistry } from './tools.ts'
import type {
  BridgeMessageInput,
  BridgeNoticeItem,
  BridgeTaskInput,
  BridgeTaskResult,
  RuntimeBridge
} from './types.ts'

/** How many teammates may run a work loop at once in one room. */
export const MAX_PARALLEL_RUNS_PER_ROOM = 2

/** Default task title when a human instruction does not name one. */
function titleFromInstruction(body: string): string {
  const firstSentence = body.split(/[.\n]/)[0]?.trim() ?? body.trim()
  const title = firstSentence.replace(/\s+/g, ' ').slice(0, 120)
  return title || 'Follow up on the latest instruction'
}

function defaultAcceptance(body: string): string[] {
  return [
    `The room's goal is advanced by this change: ${body.trim().slice(0, 140)}`,
    'A real file, command output or artifact backs the result.'
  ]
}

export class HuddleAgentRuntime implements AgentRuntime, RuntimeBridge {
  readonly deps: RuntimeDeps
  private readonly provider: OpenAiProvider
  private readonly tools: ToolRegistry
  private readonly mailbox: Mailbox
  private readonly executor: RuntimeExecutor
  private readonly conversation: ConversationResponder
  private readonly clock: GraphClock
  private readonly attachedRooms = new Set<string>()
  private readonly onboarded = new Set<string>()
  private readonly scheduling = new Set<string>()
  private readonly noKeyWarned = new Set<string>()
  private readonly onboardingInFlight = new Set<string>()
  private disposed = false

  constructor(deps: RuntimeDeps, provider?: OpenAiProvider) {
    this.deps = deps
    this.clock = { newId: () => deps.bus.newId(), now: () => deps.bus.now() }
    this.provider =
      provider ??
      createDefaultProvider({
        onNotice: (level, text, fix) => {
          for (const roomId of this.attachedRooms) deps.bus.notice(roomId, level, text, fix)
        }
      })
    this.tools = new ToolRegistry(undefined, () => deps.settings())
    this.mailbox = new Mailbox(this.clock)
    this.executor = new RuntimeExecutor({
      deps,
      provider: this.provider,
      tools: this.tools,
      bridge: this,
      mailbox: this.mailbox,
      onIdle: (agentId) => {
        const roomId = this.roomOfAgent(agentId)
        if (roomId) this.schedule(roomId)
      }
    })
    this.conversation = new ConversationResponder(deps, this.provider, this)
  }

  /* ---------------------------------------------------------------- *
   * RuntimeBridge
   * ---------------------------------------------------------------- */

  notify(agentId: string, item: BridgeNoticeItem): boolean {
    const agent = this.deps.bus.getAgent(agentId)
    if (!agent) return false
    this.mailbox.enqueue({
      roomId: agent.roomId,
      agentId,
      kind: item.kind,
      summary: item.summary,
      note: item.note,
      messageId: item.messageId,
      taskId: item.taskId,
      decisionId: item.decisionId
    })
    this.schedule(agent.roomId)
    return true
  }

  createTask(roomId: string, input: BridgeTaskInput, createdBy: MessageAuthor): BridgeTaskResult {
    const room = this.deps.bus.getRoom(roomId)
    const task = buildTask(this.clock, {
      roomId,
      title: input.title,
      detail: input.detail,
      ownerAgentId: input.ownerAgentId ?? null,
      createdBy,
      dependsOn: input.dependsOn,
      acceptance: input.acceptance,
      decisionRevision: room?.decisionRevision ?? 0,
      status: input.status
    })
    this.deps.bus.upsertTask(task)

    const notified: string[] = []
    const selfAssigned = createdBy.type === 'agent' && createdBy.agentId === task.ownerAgentId
    if (task.ownerAgentId && input.notifyOwner !== false && !selfAssigned) {
      const owner = this.deps.bus.getAgent(task.ownerAgentId)
      if (owner) {
        this.mailbox.enqueue({
          roomId,
          agentId: owner.id,
          kind: 'handoff',
          summary: `New task for you: ${task.title}`,
          note: `${task.detail}\nAcceptance: ${task.acceptance.join(' | ') || 'not specified'}`,
          taskId: task.id
        })
        notified.push(owner.id)
      }
    }
    this.schedule(roomId)
    return { task, notified }
  }

  updateTask(taskId: string, patch: TaskPatch): Task | null {
    const existing = this.deps.bus.getTask(taskId)
    if (!existing) return null
    const next = applyTaskPatch(existing, patch, this.clock.now())
    this.deps.bus.upsertTask(next)
    if (next.ownerAgentId && (next.status === 'assigned' || next.status === 'proposed' || next.status === 'in_progress')) {
      this.schedule(next.roomId)
    }
    return next
  }

  getTask(taskId: string): Task | null {
    return this.deps.bus.getTask(taskId)
  }

  message(input: BridgeMessageInput): Message {
    const room = this.deps.bus.getRoom(input.roomId)
    const id = this.deps.bus.newId()
    const message: Message = {
      id,
      roomId: input.roomId,
      author: { type: 'agent', agentId: input.agentId },
      body: input.body,
      createdAt: this.deps.bus.now(),
      clientRequestId: id,
      kind: input.kind,
      to: [...(input.to ?? [])],
      decisionRevision: room?.decisionRevision ?? 0
    }
    if (input.refs && input.refs.length > 0) message.refs = input.refs
    if (input.replyToId) message.replyToId = input.replyToId
    if (input.private) message.private = input.private
    const stored = this.deps.bus.addMessage(message)
    this.speakFor(stored, input)
    return stored
  }

  systemMessage(roomId: string, body: string, refs?: ContextRef[]): Message | null {
    if (!this.deps.bus.getRoom(roomId)) return null
    const id = this.deps.bus.newId()
    const message: Message = {
      id,
      roomId,
      author: { type: 'system' },
      body,
      createdAt: this.deps.bus.now(),
      clientRequestId: id,
      kind: 'system',
      to: []
    }
    if (refs && refs.length > 0) message.refs = refs
    return this.deps.bus.addMessage(message)
  }

  async recordDecision(roomId: string, agentId: string, input: RecordDecisionInput): Promise<Decision> {
    const decision = await this.deps.bus.recordDecision(input, { type: 'agent', agentId })
    const affected = this.deps.bus
      .getTasks(roomId)
      .filter((task) => decision.affectedTaskIds.includes(task.id))
    await this.applyDecision(roomId, decision, affected)
    return decision
  }

  async ensureWorkspace(roomId: string, agentId: string): Promise<WorkspaceRecord> {
    const workspace = await this.deps.exec.ensureAgentWorkspace(roomId, agentId)
    this.deps.bus.upsertWorkspace(workspace)
    this.deps.bus.updateAgent(agentId, { workspaceId: workspace.id })
    return workspace
  }

  async teamWorkspace(roomId: string): Promise<WorkspaceRecord> {
    const workspace = await this.deps.exec.ensureTeamWorkspace(roomId)
    this.deps.bus.upsertWorkspace(workspace)
    return workspace
  }

  teamRevision(roomId: string): string | null {
    const team = this.deps.bus.getWorkspaces(roomId).find((workspace) => workspace.kind === 'team')
    return team?.lastVerifiedRevision ?? null
  }

  kick(roomId: string): void {
    this.schedule(roomId)
  }

  alreadyAcknowledged(agentId: string, key: string): boolean {
    return this.mailbox.hasAcknowledged(agentId, key)
  }

  markAcknowledged(agentId: string, key: string): void {
    this.mailbox.markAcknowledged(agentId, key)
  }

  /* ---------------------------------------------------------------- *
   * AgentRuntime
   * ---------------------------------------------------------------- */

  async attachRoom(roomId: string): Promise<void> {
    if (this.disposed) return
    const room = this.deps.bus.getRoom(roomId)
    if (!room) return
    this.attachedRooms.add(roomId)

    for (const agent of this.deps.bus.getAgents(roomId)) {
      // A live session is attached, so the teammate is reachable. Its work state
      // must not keep claiming "offline" next to a "Connected" badge: with a
      // session attached and nothing running, the honest state is idle.
      const workState = agent.workState === 'offline' ? 'idle' : agent.workState
      const activityLabel = agent.workState === 'offline' ? 'Idle — ask me for something' : agent.activityLabel
      this.deps.bus.updateAgent(agent.id, { connected: true, workState, activityLabel })
    }

    // Restarted work: we never claim a run survived, so in-flight tasks are
    // marked blocked with an honest reason rather than silently resumed.
    const now = this.clock.now()
    for (const task of interruptedTasks(this.deps.bus.getTasks(roomId), now)) {
      this.deps.bus.upsertTask(task)
    }

    const capability = this.deps.capability('openai')
    // "Not checked yet" is not a reason to tell the human anything: only a
    // capability we have actually probed and found wanting deserves a warning.
    if (capability.state === 'unavailable' || capability.state === 'error') {
      this.noKeyWarned.add(roomId)
      this.deps.bus.notice(
        roomId,
        'warn',
        `Teammates cannot reason yet: ${capability.detail}. Typed messages, room state, tasks and every other configured capability still work.`,
        capability.fix ?? 'Add OPENAI_API_KEY in Settings.'
      )
    }

    this.schedule(roomId)
    void this.onboardTeam(roomId)
  }

  async detachRoom(roomId: string): Promise<void> {
    this.attachedRooms.delete(roomId)
    this.mailbox.clearRoom(roomId)
    this.tools.releaseRoom(roomId)
    for (const agentId of this.executor.agentsInRoom(roomId)) {
      this.executor.cancelAgent(agentId)
    }
    // No session is attached any more, so the tiles must stop saying otherwise.
    for (const agent of this.deps.bus.getAgents(roomId)) {
      if (agent.workState === 'idle') {
        this.deps.bus.updateAgent(agent.id, {
          connected: false,
          workState: 'offline',
          activityLabel: 'Not connected'
        })
      } else {
        this.deps.bus.updateAgent(agent.id, { connected: false })
      }
    }
  }

  async handleHumanMessage(input: InboundMessage): Promise<void> {
    if (this.disposed) return
    const { roomId, message } = input
    const room = this.deps.bus.getRoom(roomId)
    if (!room) return
    this.attachedRooms.add(roomId)

    const agents = this.deps.bus.getAgents(roomId)
    const decision = routeMessage({
      message: this.routerMessage(message),
      agents: agents.map(routerAgent),
      tasks: this.deps.bus.getTasks(roomId).map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        ownerAgentId: task.ownerAgentId
      })),
      recent: this.deps.bus.getMessages(roomId, 14).map((item) => this.routerMessage(item)),
      busyAgentIds: this.executor.busyAgentIds()
    })

    let targets = decision.targets
    if (targets.length === 0 && input.addressed.length > 0) targets = input.addressed
    if (targets.length === 0) return

    if (!this.provider.configured) {
      for (const targetId of targets) {
        this.mailbox.enqueue({
          roomId,
          agentId: targetId,
          kind: 'human_message',
          summary: message.body.slice(0, 200),
          note: message.body,
          messageId: message.id
        })
      }
      if (!this.noKeyWarned.has(roomId)) {
        this.noKeyWarned.add(roomId)
        this.deps.bus.notice(
          roomId,
          'warn',
          'OpenAI is not configured, so no teammate can reason yet. Your message is recorded and the room state is intact.',
          'Add OPENAI_API_KEY in Settings, then send the message again.'
        )
      }
      return
    }

    for (const targetId of targets) {
      if (decision.kind === 'conversation') {
        await this.answerConversation(roomId, targetId, message)
        continue
      }
      this.enqueueWork(roomId, targetId, message, decision)
    }
    this.schedule(roomId)
  }

  /** Onboard a teammate added mid-project with the real state of the room. */
  async onboardAgent(roomId: string, agentId: string, assignment?: string): Promise<void> {
    const room = this.deps.bus.getRoom(roomId)
    const agent = this.deps.bus.getAgent(agentId)
    if (!room || !agent) return
    if (this.onboarded.has(agentId)) return
    this.onboarded.add(agentId)
    this.tools.releaseRoom(roomId)

    const state = collectRoomState(this.deps.bus, roomId, agentId, { messageLimit: 12, toolRunLimit: 10 })
    const pack = state ? formatRoomState(state, 'onboarding') : 'Room state unavailable.'
    const teamRevision = this.teamRevision(roomId)

    const intro = await this.introduction(agent, room, pack, assignment, teamRevision)
    const introMessage = this.message({
      roomId,
      agentId,
      body: intro.body,
      kind: 'chat',
      speak: true,
      speechReason: 'ack',
      spokenOverride: intro.spoken
    })

    if (intro.taskTitle) {
      const created = this.createTask(
        roomId,
        {
          title: intro.taskTitle,
          detail: assignment ? `${intro.taskTitle}\n(assignment: ${assignment})` : intro.taskTitle,
          ownerAgentId: agentId,
          acceptance: intro.acceptance.length > 0 ? intro.acceptance : defaultAcceptance(room.goal || intro.taskTitle)
        },
        { type: 'agent', agentId }
      )
      this.deps.bus.setAgentActivity(agentId, 'idle', `Accepted "${created.task.title}"`)
    }

    this.mailbox.enqueue({
      roomId,
      agentId,
      kind: 'onboarding',
      summary: `You just joined "${room.name}". Read the state and start your first slice of work.`,
      note: assignment ? `The human added you with this assignment: ${assignment}` : '',
      messageId: introMessage.id,
      decisionId: this.deps.bus.getActiveDecisions(roomId).slice(-1)[0]?.id
    })
    this.schedule(roomId)
  }

  /** Human changed a requirement: steer and re-plan affected work. */
  async applyDecision(roomId: string, decision: Decision, affected: Task[]): Promise<void> {
    const revision = decision.revision
    // Queued speech from before the change is no longer worth saying. Work is
    // untouched by this call: nothing is cancelled and nothing is reverted.
    invalidateSpeechBefore(this.deps.voice, this.deps.bus, roomId, revision)

    const now = this.clock.now()
    const reason = `Requirement change r${revision}: ${decision.title}`
    const byId = new Map(affected.map((task) => [task.id, task]))
    for (const task of this.deps.bus.getTasks(roomId)) {
      if (task.status === 'done' || task.status === 'cancelled' || task.status === 'failed') continue
      const target = byId.get(task.id) ?? task
      if (!byId.has(task.id) && target.decisionRevision >= revision) continue
      this.deps.bus.upsertTask(staleTask(target, revision, reason, now))
    }

    // Obsolete queued work: handoffs and review requests tied to stale work are
    // dropped; the human's own instructions are kept and re-planned.
    const dropped = this.mailbox.dropWhere(roomId, (item) => {
      if (item.kind !== 'handoff' && item.kind !== 'review_request') return false
      if (!item.taskId) return true
      const task = this.deps.bus.getTask(item.taskId)
      return task ? task.decisionRevision < revision || task.staleSince !== null : false
    })

    const owners = new Set<string>()
    for (const task of byId.values()) {
      if (task.ownerAgentId) owners.add(task.ownerAgentId)
    }
    for (const ownerId of owners) {
      this.mailbox.enqueue({
        roomId,
        agentId: ownerId,
        kind: 'decision_change',
        summary: reason,
        note: `${decision.statement}\n\nRe-check the tasks in flight against this and re-plan anything that no longer matches.`,
        decisionId: decision.id
      })
    }

    this.deps.bus.notice(
      roomId,
      'info',
      `Decision r${revision} applied: ${owners.size} teammate(s) notified, ${dropped} queued handoff(s) dropped, stale tasks flagged.`
    )
    this.schedule(roomId)
  }

  async pauseWork(roomId: string, agentId?: string): Promise<void> {
    for (const agent of this.deps.bus.getAgents(roomId)) {
      if (agentId && agent.id !== agentId) continue
      this.executor.pause(agent.id)
      this.deps.bus.setAgentActivity(agent.id, 'paused', agentId ? 'Paused' : 'Room paused')
    }
  }

  async resumeWork(roomId: string, agentId?: string): Promise<void> {
    for (const agent of this.deps.bus.getAgents(roomId)) {
      if (agentId && agent.id !== agentId) continue
      this.executor.resume(agent.id)
      this.deps.bus.setAgentActivity(agent.id, 'idle', 'Available')
    }
    this.schedule(roomId)
  }

  async cancelTask(roomId: string, taskId: string): Promise<void> {
    const task = this.deps.bus.getTask(taskId)
    if (!task) return
    const wasRunning = this.executor.cancelTask(taskId)
    this.updateTask(taskId, {
      status: 'cancelled',
      blockedReason: 'Cancelled by the human.'
    })
    this.mailbox.dropWhere(roomId, (item) => item.taskId === taskId)
    try {
      this.deps.voice.stopSpeaking(roomId, 'current', 'stopSpeaking')
    } catch {
      // A voice host that is not running has nothing to stop.
    }
    if (!wasRunning) {
      this.systemMessage(
        roomId,
        `"${task.title}" was cancelled before any work ran on it, so nothing was changed.`,
        [{ kind: 'task', taskId }]
      )
    } else {
      this.systemMessage(
        roomId,
        `"${task.title}" was cancelled while a run was in progress. Files and commands that already ran are still on disk; nothing was rolled back.`,
        [{ kind: 'task', taskId }]
      )
    }
    if (task.ownerAgentId) this.deps.bus.setAgentActivity(task.ownerAgentId, 'idle', 'Task cancelled')
  }

  async retryTask(taskId: string): Promise<Task> {
    const task = this.deps.bus.getTask(taskId)
    if (!task) {
      throw new Error(`Task ${taskId} no longer exists.`)
    }
    const room = this.deps.bus.getRoom(task.roomId)
    const revision = room?.decisionRevision ?? task.decisionRevision
    const reset = refreshStaleTask(
      applyTaskPatch(task, { status: 'assigned', blockedReason: null, decisionRevision: revision }, this.clock.now()),
      revision,
      this.clock.now()
    )
    this.deps.bus.upsertTask(reset)
    if (reset.ownerAgentId) {
      this.mailbox.enqueue({
        roomId: reset.roomId,
        agentId: reset.ownerAgentId,
        kind: 'human_message',
        summary: `Retry: ${reset.title}`,
        note: 'The human asked for another attempt at this task. Re-read the current state first and do not repeat the previous failing step.',
        taskId: reset.id
      })
    }
    this.schedule(reset.roomId)
    return reset
  }

  listToolRuns(roomId: string): ToolRun[] {
    return this.deps.bus.getToolRuns(roomId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.executor.dispose()
    for (const roomId of this.attachedRooms) {
      this.mailbox.clearRoom(roomId)
      this.tools.releaseRoom(roomId)
    }
    this.attachedRooms.clear()
  }

  /* ---------------------------------------------------------------- *
   * Internal
   * ---------------------------------------------------------------- */

  private routerMessage(message: Message): RouterMessage {
    const router: RouterMessage = {
      id: message.id,
      body: message.body,
      author: message.author,
      to: [...message.to],
      kind: message.kind
    }
    if (message.replyToId) router.replyToId = message.replyToId
    if (message.private) router.private = message.private
    return router
  }

  private roomOfAgent(agentId: string): string | null {
    return this.deps.bus.getAgent(agentId)?.roomId ?? null
  }

  private speakFor(message: Message, input: BridgeMessageInput): SpeechHandle | null {
    if (input.speak === false) return null
    if (!this.deps.settings().voice.enabled) return null
    const reason: SpeechReason = input.speechReason ?? speechReasonFor(message.kind)
    return requestSpeech(this.deps.voice, this.deps.bus, {
      roomId: message.roomId,
      agentId: message.author.type === 'agent' ? message.author.agentId : '',
      written: message.body,
      reason,
      decisionRevision: message.decisionRevision ?? 0,
      messageId: message.id,
      ...(input.spokenOverride ? { spokenOverride: input.spokenOverride } : {})
    })
  }

  private enqueueWork(roomId: string, agentId: string, message: Message, decision: RouterDecision): void {
    const room = this.deps.bus.getRoom(roomId)
    if (!room) return

    let taskId = decision.taskId
    let task = taskId ? this.deps.bus.getTask(taskId) : null

    if (!task) {
      // A work instruction with no matching task becomes a real task, so the
      // board shows who owns what and the run has acceptance criteria. The
      // instruction itself is queued below, so the owner is not notified twice.
      const created = this.createTask(
        roomId,
        {
          title: titleFromInstruction(message.body),
          detail: message.body,
          ownerAgentId: agentId,
          acceptance: defaultAcceptance(message.body),
          notifyOwner: false
        },
        message.author
      )
      task = created.task
      taskId = created.task.id
    } else if (!task.ownerAgentId) {
      const updated = this.updateTask(task.id, { ownerAgentId: agentId })
      if (updated) task = updated
    }

    this.mailbox.enqueue({
      roomId,
      agentId,
      kind: message.author.type === 'human' ? 'human_message' : 'teammate_message',
      summary: message.body.slice(0, 200),
      note: message.body,
      messageId: message.id,
      taskId: taskId ?? undefined
    })
  }

  private async answerConversation(roomId: string, agentId: string, question: Message): Promise<void> {
    const outcome = await this.conversation.respond({
      roomId,
      agentId,
      question: question.body,
      questionMessageId: question.id,
      private: question.private !== undefined
    })
    if (!outcome.reply) {
      const failure = outcome.failure
      this.systemMessage(
        roomId,
        `${this.deps.bus.getAgent(agentId)?.name ?? 'That teammate'} could not answer: ${
          failure?.message ?? 'the provider gave no answer'
        }`
      )
      if (failure?.fix) {
        this.deps.bus.notice(roomId, 'warn', failure.message, failure.fix)
      }
      return
    }
    this.message({
      roomId,
      agentId,
      body: outcome.reply.body,
      kind: 'answer',
      replyToId: question.id,
      refs: outcome.reply.refs,
      speak: true,
      speechReason: 'answer',
      spokenOverride: outcome.reply.spoken,
      // An answer to a one-on-one question stays in that channel.
      ...(question.private ? { private: question.private } : {})
    })
  }

  private schedule(roomId: string): void {
    if (this.disposed) return
    if (this.scheduling.has(roomId)) return
    this.scheduling.add(roomId)
    queueMicrotask(() => {
      this.scheduling.delete(roomId)
      try {
        this.pump(roomId)
      } catch {
        // Scheduling must never break the room.
      }
    })
  }

  /** Picks up whatever each free agent should do next. */
  private pump(roomId: string): void {
    if (this.disposed) return
    const room = this.deps.bus.getRoom(roomId)
    if (!room) return
    let slots = MAX_PARALLEL_RUNS_PER_ROOM - this.executor.agentsInRoom(roomId).length

    for (const agent of this.deps.bus.getAgents(roomId)) {
      if (slots <= 0) return
      if (this.executor.isBusy(agent.id)) continue
      if (this.executor.isPaused(agent.id)) continue

      const item = this.nextItem(room, agent)
      if (!item) continue
      if (this.executor.start(item)) slots -= 1
    }
  }

  private nextItem(room: Room, agent: Agent): WorkItem | null {
    const inbox: MailboxItem | null = this.mailbox.take(agent.id)
    if (inbox) {
      const taskId = inbox.taskId ?? this.matchOpenTask(room.id, inbox)
      const brief = [
        `Instruction for ${agent.name} (${agent.role}) in room "${room.name}".`,
        `Room goal: ${room.goal || '(no goal recorded yet)'}`,
        `Why you are being woken: ${inbox.summary}`,
        inbox.note ? `Details: ${inbox.note}` : '',
        taskId ? `This belongs to task ${taskId}.` : '',
        'Start by checking the real state with your tools, then do the smallest useful step.'
      ]
        .filter((line) => line.length > 0)
        .join('\n')
      if (taskId) {
        const task = this.deps.bus.getTask(taskId)
        if (task && (task.status === 'proposed' || task.status === 'assigned' || task.status === 'blocked')) {
          this.updateTask(task.id, { status: 'in_progress' })
        }
      }
      return {
        roomId: room.id,
        agentId: agent.id,
        taskId: taskId ?? null,
        reason: inbox.summary.slice(0, 160),
        brief,
        inboxMessageId: inbox.messageId ?? undefined,
        ackKey: inbox.messageId ? `ack:${inbox.messageId}` : inbox.taskId ? `ack:${inbox.taskId}` : undefined
      }
    }

    const tasks = this.deps.bus.getTasks(room.id)
    const next = nextRunnableTask(tasks, agent.id)
    if (!next) return null
    if (next.status === 'proposed' || next.status === 'assigned') {
      this.updateTask(next.id, { status: 'in_progress' })
    }
    const current = this.deps.bus.getTask(next.id) ?? next
    return {
      roomId: room.id,
      agentId: agent.id,
      taskId: current.id,
      reason: `task: ${current.title}`,
      brief: [
        `Work on your task in room "${room.name}".`,
        `Room goal: ${room.goal || '(no goal recorded yet)'}`,
        `Task: ${current.title}`,
        current.detail ? `Detail: ${current.detail}` : '',
        current.acceptance.length > 0
          ? `Acceptance criteria:\n${current.acceptance.map((line) => `- ${line}`).join('\n')}`
          : 'Acceptance criteria: none recorded; back whatever you change with evidence.',
        current.staleSince ? `Note: this task is marked stale (${current.staleReason ?? 'a newer decision landed'}). Re-check it against the current decisions first.` : '',
        'Use your tools to observe reality before you touch anything.'
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
      ackKey: `ack:${current.id}`
    }
  }

  private matchOpenTask(roomId: string, item: MailboxItem): string | undefined {
    if (item.decisionId) return undefined
    const open = this.deps.bus
      .getTasks(roomId)
      .filter(
        (task) =>
          (task.status === 'proposed' || task.status === 'assigned' || task.status === 'in_progress') &&
          dependenciesSatisfied(task, this.deps.bus.getTasks(roomId))
      )
    const wordsOf = (text: string): Set<string> =>
      new Set(
        text
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((word) => word.length > 3)
      )
    const wanted = wordsOf(item.summary)
    let best: string | undefined
    let bestScore = 0
    for (const task of open) {
      let score = 0
      for (const word of wordsOf(task.title)) if (wanted.has(word)) score += 1
      if (score > bestScore) {
        bestScore = score
        best = task.id
      }
    }
    return bestScore >= 2 ? best : undefined
  }

  /** One model call for a newcomer's introduction and first responsibility. */
  private async introduction(
    agent: Agent,
    room: Room,
    pack: string,
    assignment: string | undefined,
    teamRevision: string | null
  ): Promise<{ body: string; spoken: string; taskTitle: string | null; acceptance: string[] }> {
    const fallbackTitle =
      agent.role === 'qa'
        ? `Review the requirement "${room.goal || room.name}" for contradictions`
        : agent.role === 'systems'
          ? `Define the interface for "${room.goal || room.name}"`
          : `Build the first visible slice of "${room.goal || room.name}"`

    if (!this.provider.configured) {
      const body = `I'm ${agent.name}, ${agent.summary}. I'll start with: ${assignment || fallbackTitle}.`
      return { body, spoken: body, taskTitle: assignment || fallbackTitle, acceptance: [] }
    }

    const instructions = [
      agent.persona,
      `You have just joined the room "${room.name}". Read the state and state, in one or two short sentences, who you are and what concrete slice of work you are taking.`,
      'Then propose exactly one task you will own, with acceptance criteria you can actually check.',
      'Reply in exactly this shape and nothing else:',
      'INTRO: <one or two sentences>',
      'TASK: <one concrete task title, or NONE>',
      'ACCEPTANCE: <criterion one> | <criterion two>',
      pack
    ].join('\n\n')

    try {
      const turn = await this.provider.complete({
        model: this.deps.settings().models.conversation,
        instructions,
        input: [
          {
            kind: 'text',
            role: 'user',
            content: assignment
              ? `The human added you with this assignment: ${assignment}${teamRevision ? `\nThe last verified integrated revision is ${teamRevision}.` : ''}`
              : `Introduce yourself and take one concrete piece of work.${teamRevision ? ` The last verified integrated revision is ${teamRevision}.` : ''}`
          }
        ],
        tools: [],
        maxOutputTokens: 400,
        timeoutMs: 45_000
      })
      const parsed = parseIntroduction(turn.text)
      const body = parsed.intro || `I'm ${agent.name}, ${agent.summary}. I'll start with: ${assignment || fallbackTitle}.`
      return {
        body,
        spoken: parsed.intro ? parsed.intro.slice(0, 240) : body,
        taskTitle: parsed.taskTitle ?? (assignment || fallbackTitle),
        acceptance: parsed.acceptance
      }
    } catch {
      const body = `I'm ${agent.name}, ${agent.summary}. I'll start with: ${assignment || fallbackTitle}.`
      return { body, spoken: body, taskTitle: assignment || fallbackTitle, acceptance: [] }
    }
  }

  private async onboardTeam(roomId: string): Promise<void> {
    if (this.onboardingInFlight.has(roomId)) return
    this.onboardingInFlight.add(roomId)
    try {
      const room = this.deps.bus.getRoom(roomId)
      if (!room || !room.goal.trim()) return
      const agents = this.deps.bus.getAgents(roomId)
      const spoke = new Set(
        this.deps.bus
          .getMessages(roomId, 200)
          .filter((message) => message.author.type === 'agent')
          .map((message) => (message.author.type === 'agent' ? message.author.agentId : ''))
      )
      for (const agent of agents) {
        if (spoke.has(agent.id)) continue
        if (!this.attachedRooms.has(roomId)) return
        // One introduction at a time, and not while the room is already busy
        // working: three simultaneous voices is not a room.
        await this.waitForRoomSlot(roomId)
        await this.onboardAgent(roomId, agent.id)
      }
    } finally {
      this.onboardingInFlight.delete(roomId)
    }
  }

  private async waitForRoomSlot(roomId: string): Promise<void> {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (!this.attachedRooms.has(roomId)) return
      if (this.executor.agentsInRoom(roomId).length < MAX_PARALLEL_RUNS_PER_ROOM) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function routerAgent(agent: Agent): RouterAgent {
  return { id: agent.id, name: agent.name, role: agent.role }
}

/**
 * Tolerant parse of the onboarding reply. Anything missing is treated as
 * missing — the caller falls back to a truthful preset-derived line rather than
 * inventing a task the model never proposed.
 */
export function parseIntroduction(text: string): {
  intro: string
  taskTitle: string | null
  acceptance: string[]
} {
  const introMatch = /INTRO:\s*(.+?)(?=\n[A-Z]+:|$)/is.exec(text)
  const taskMatch = /TASK:\s*(.+?)(?=\n[A-Z]+:|$)/is.exec(text)
  const acceptanceMatch = /ACCEPTANCE:\s*(.+?)(?=\n[A-Z]+:|$)/is.exec(text)
  const intro = introMatch ? introMatch[1].replace(/\s+/g, ' ').trim() : ''
  const rawTask = taskMatch ? taskMatch[1].replace(/\s+/g, ' ').trim() : ''
  const taskTitle = !rawTask || /^none$/i.test(rawTask) ? null : rawTask.slice(0, 160)
  const acceptance = acceptanceMatch
    ? acceptanceMatch[1]
        .split('|')
        .map((line) => line.trim())
        .filter((line) => line.length > 2)
        .slice(0, 6)
    : []
  return { intro: intro.slice(0, 400), taskTitle, acceptance }
}

export const createAgentRuntime: CreateAgentRuntime = (deps: RuntimeDeps): AgentRuntime =>
  new HuddleAgentRuntime(deps)
