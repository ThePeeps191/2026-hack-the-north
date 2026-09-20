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
  AgentPresetId,
  AgentRole,
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
import {
  hasWorkVerb,
  pickOwner,
  routeMessage,
  type RouterAgent,
  type RouterDecision,
  type RouterMessage
} from './router.ts'
import {
  defaultRoster,
  heuristicRoster,
  parseRoster,
  rosterInstructions,
  ROSTER_TIMEOUT_MS
} from './roster.ts'
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
/**
 * A room is a team, not a queue. Every teammate present can be running at the
 * same time, which is what makes the stage worth looking at — and what makes
 * "ask one of them something while the others keep going" a real behaviour
 * rather than a claim. The ceiling only stops an unbounded roster.
 */
export const MAX_PARALLEL_RUNS_PER_ROOM = 5

/**
 * How long the team waits for a project folder before introducing itself.
 *
 * Long enough for a human to click "Use the demo project" after creating the
 * room; short enough that a room which will never have one is not left silent.
 */
export const ONBOARDING_PROJECT_GRACE_MS = 20_000

/**
 * A task title from a spoken instruction.
 *
 * People do not speak in task titles. "Maya, actually stop and do some research
 * first before you write any code" is an instruction to Maya, not the name of a
 * piece of work, and a board full of raw sentences is unreadable. This strips
 * the address, the hedges and the politeness, and keeps the verb phrase.
 */
function titleFromInstruction(body: string): string {
  let text = body.split(/[.\n?!]/)[0]?.trim() ?? body.trim()
  // "Maya, ..." / "hey Sam - ..." — drop the person being addressed.
  text = text.replace(
    /^\s*(hi|hey|hello|ok|okay|so|right|alright|please)?[\s,]*[A-Z][a-z]{1,15}\s*[,:—-]\s*/,
    ''
  )
  // "actually", "can you", "could you just", "I want you to" — drop the run-up.
  text = text.replace(
    /^\s*(actually|actually,|just|quickly|now)?\s*(can|could|would|will)?\s*(you|we)?\s*(please\s+)?(just\s+)?(go\s+ahead\s+and\s+)?(i\s+(want|need)\s+you\s+to\s+)?/i,
    ''
  )
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return 'Follow up on the latest instruction'
  const title = text.slice(0, 96).replace(/[\s,;:-]+$/, '')
  return title.charAt(0).toUpperCase() + title.slice(1)
}

/**
 * The line a teammate says out loud when it picks something up.
 *
 * It has to sound like a person on a call. The runtime's own wake-up text
 * ("You just joined the room. Read the state and start your first slice of
 * work.") is plumbing: reading it aloud made the team sound like a job queue,
 * so those cases stay silent and let the real first message carry the turn.
 */
function ackLineFor(item: MailboxItem, taskTitle: string | null): string | null {
  switch (item.kind) {
    case 'onboarding':
      // The introduction message already spoke. Anything more is noise.
      return null
    case 'handoff':
    case 'review_request':
      return taskTitle ? `Picking up ${lowerFirst(taskTitle)}.` : null
    case 'decision_change':
      return 'Re-checking my work against that change.'
    case 'human_message':
    case 'teammate_message':
      return taskTitle ? `On it — ${lowerFirst(taskTitle)}.` : 'On it.'
    default:
      return null
  }
}

function lowerFirst(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/, '')
  if (!trimmed) return trimmed
  // Leave acronyms and proper nouns alone: "API contract", not "aPI contract".
  if (/^[A-Z]{2,}/.test(trimmed)) return trimmed
  return trimmed[0].toLowerCase() + trimmed.slice(1)
}

/**
 * The first slice of work a role takes when the model has not named one.
 *
 * Every one of these is an honest opening move for that role and is short
 * enough to read on a tile. It is a fallback, not a script: once a teammate can
 * reason it proposes its own first task.
 */
function firstSliceFor(role: AgentRole, room: Room): string {
  const subject = room.goal.trim() || room.name
  switch (role) {
    case 'qa':
      return 'Review the requirements for contradictions'
    case 'systems':
      return 'Define the data shape and server contract'
    case 'frontend':
      return 'Build the first visible slice'
    case 'research':
      return `Gather what is already known about ${lowerFirst(subject)}`
    case 'design':
      return 'Set the visual direction'
    default:
      return 'Read the project and take the most useful gap'
  }
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

  /**
   * Picks the roster for a room that does not exist yet.
   *
   * One cheap model call against the fast conversation model, bounded by
   * `ROSTER_TIMEOUT_MS`, with a keyword reading of the goal underneath it. The
   * call is worth making because a goal is a sentence, not a set of keywords —
   * "find out whether we should migrate off Postgres" needs research, and no
   * word list gets that right — but nothing about opening a room may depend on
   * a provider being reachable.
   */
  async planRoster(goal: string, count: number): Promise<AgentPresetId[]> {
    const wanted = Math.max(1, count)
    const trimmed = goal.trim()
    const fallback = trimmed ? heuristicRoster(trimmed, wanted) : defaultRoster(wanted)
    if (!trimmed || !this.provider.configured) return fallback

    try {
      const turn = await this.provider.complete({
        model: this.deps.settings().models.conversation,
        instructions: rosterInstructions(wanted),
        input: [{ kind: 'text', role: 'user', content: `Goal: ${trimmed.slice(0, 600)}` }],
        tools: [],
        maxOutputTokens: 60,
        timeoutMs: ROSTER_TIMEOUT_MS
      })
      const picked = parseRoster(turn.text, wanted)
      if (!picked) return fallback
      // A short answer is still an answer; pad rather than discard it.
      while (picked.length < wanted) picked.push('nova')
      return picked.slice(0, wanted)
    } catch {
      // Unreachable, slow or unhappy: the goal still reads the same way.
      return fallback
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

    // A standing constraint is recorded once, for the whole room, before anyone
    // reacts to it — so a teammate who starts work an hour from now is still
    // bound by it rather than relying on a transcript that has scrolled away.
    if (decision.standing) this.recordDirective(roomId, message)

    if (decision.kind === 'broadcast') {
      await this.broadcast(roomId, targets, message, decision)
      this.schedule(roomId)
      return
    }

    await Promise.all(
      targets.map(async (targetId) => {
        // The agent is already running. The instruction goes *into* the run
        // rather than behind it, and the agent answers out loud without its
        // work stopping. This is the behaviour a call implies and a queue
        // cannot give you.
        if (this.deliverToRunningAgent(roomId, targetId, message, 'direct')) {
          await this.answerConversation(roomId, targetId, message, { steered: true })
          return
        }
        if (decision.kind === 'conversation') {
          await this.answerConversation(roomId, targetId, message)
          return
        }
        this.enqueueWork(roomId, targetId, message, decision)
      })
    )
    this.schedule(roomId)
  }

  /**
   * One message, every teammate.
   *
   * Whoever is working hears it inside their run; whoever is free answers or
   * picks it up. Nobody is silently skipped, and the room does not start three
   * competing runs on the same piece of work: a broadcast that is plain work
   * still gets exactly one owner, and everyone else is told what was decided.
   */
  private async broadcast(
    roomId: string,
    targets: string[],
    message: Message,
    decision: RouterDecision
  ): Promise<void> {
    const work = decision.kind === 'broadcast' && !decision.standing && hasWorkVerb(message.body)
    const owner = work
      ? pickOwner({
          agents: this.deps.bus.getAgents(roomId).map(routerAgent),
          tasks: this.deps.bus.getTasks(roomId).map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            ownerAgentId: task.ownerAgentId
          })),
          recent: [],
          body: message.body,
          busyAgentIds: this.executor.busyAgentIds()
        }).agent
      : null

    await Promise.all(
      targets.map(async (targetId) => {
        const delivered = this.deliverToRunningAgent(roomId, targetId, message, 'broadcast')
        if (owner && owner.id === targetId) {
          if (!delivered) this.enqueueWork(roomId, targetId, message, decision)
          else await this.answerConversation(roomId, targetId, message, { steered: true })
          return
        }
        // Everyone else answers rather than starting a run, so a room-wide
        // sentence does not fan out into three edits of the same file.
        await this.answerConversation(roomId, targetId, message, {
          steered: delivered,
          broadcast: true
        })
      })
    )
  }

  /**
   * Hands a message to an agent that is mid-run. Returns false when the agent
   * is idle, so the caller falls back to the normal path.
   */
  private deliverToRunningAgent(
    roomId: string,
    agentId: string,
    message: Message,
    scope: 'direct' | 'broadcast'
  ): boolean {
    const from = message.author.type === 'human' ? 'The human' : this.nameOf(message.author)
    const delivered = this.executor.interject(agentId, { text: message.body, from, scope })
    if (delivered) {
      this.deps.bus.emit(roomId, {
        type: 'agent.steered',
        agentId,
        messageId: message.id,
        scope
      })
    }
    return delivered
  }

  /** Records a room-wide standing constraint so it outlives this turn. */
  private recordDirective(roomId: string, message: Message): void {
    const text = message.body.trim().slice(0, 400)
    if (!text) return
    const title = titleFromInstruction(text)
    this.deps.bus.addMemory({
      id: this.deps.bus.newId(),
      roomId,
      kind: 'constraint',
      title,
      body: text,
      decisionRevision: this.deps.bus.getRoom(roomId)?.decisionRevision ?? 0,
      source: message.author,
      createdAt: this.deps.bus.now(),
      supersededById: null
    })
    this.deps.bus.notice(
      roomId,
      'info',
      `Standing rule recorded for the room: "${title}". Every teammate carries it from here, including ones added later.`
    )
  }

  private nameOf(author: MessageAuthor): string {
    if (author.type === 'human') return 'The human'
    if (author.type === 'agent') return this.deps.bus.getAgent(author.agentId)?.name ?? 'A teammate'
    return 'The room'
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

  private async answerConversation(
    roomId: string,
    agentId: string,
    question: Message,
    options: { steered?: boolean; broadcast?: boolean } = {}
  ): Promise<void> {
    const outcome = await this.conversation.respond({
      roomId,
      agentId,
      question: question.body,
      questionMessageId: question.id,
      private: question.private !== undefined,
      ...(options.steered ? { steered: true, steeredFrom: this.executor.currentActivity(agentId) } : {}),
      ...(options.broadcast ? { broadcast: true } : {})
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
    const roster = this.deps.bus.getAgents(roomId)
    let slots =
      Math.min(MAX_PARALLEL_RUNS_PER_ROOM, Math.max(1, roster.length)) -
      this.executor.agentsInRoom(roomId).length

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
      const item: WorkItem = {
        roomId: room.id,
        agentId: agent.id,
        taskId: taskId ?? null,
        reason: inbox.summary.slice(0, 160),
        brief,
        inboxMessageId: inbox.messageId ?? undefined,
        ackKey: inbox.messageId ? `ack:${inbox.messageId}` : inbox.taskId ? `ack:${inbox.taskId}` : undefined
      }
      const ack = ackLineFor(inbox, this.deps.bus.getTask(taskId ?? '')?.title ?? null)
      if (ack) item.ackText = ack
      return item
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
    // Only used when the model cannot be reached or answers unparseably. Kept
    // short because it lands on a tile, where a title wrapping the whole room
    // goal in quotes reads as filler rather than as a piece of work.
    const fallbackTitle = assignment || firstSliceFor(agent.role, room)

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

      // Give the human a moment to bind a project before anyone speaks.
      //
      // The natural flow is: create the room, then choose the folder. Without
      // this, the team introduced itself in the half-second between the two and
      // every teammate opened with "I need this room bound to a repo" about a
      // repo it was handed a second later. Bounded, so a room that never gets a
      // project still gets its introductions.
      await this.waitForProject(roomId)

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

  /**
   * Waits for a project binding, up to `ONBOARDING_PROJECT_GRACE_MS`.
   *
   * Returns as soon as one appears, and returns anyway once the grace is spent
   * — a room with no project is a legitimate room, and the team says so rather
   * than waiting silently for something that is never coming.
   */
  private async waitForProject(roomId: string): Promise<void> {
    const deadline = Date.now() + ONBOARDING_PROJECT_GRACE_MS
    while (Date.now() < deadline) {
      if (!this.attachedRooms.has(roomId)) return
      if (this.deps.bus.getRoom(roomId)?.project) return
      // Anything already queued means the room is in use; stop stalling.
      const waiting = this.deps.bus
        .getAgents(roomId)
        .some((agent) => this.mailbox.size(agent.id) > 0)
      if (waiting) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  private async waitForRoomSlot(roomId: string): Promise<void> {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (!this.attachedRooms.has(roomId)) return
      const capacity = Math.min(MAX_PARALLEL_RUNS_PER_ROOM, Math.max(1, this.deps.bus.getAgents(roomId).length))
      if (this.executor.agentsInRoom(roomId).length < capacity) return
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
