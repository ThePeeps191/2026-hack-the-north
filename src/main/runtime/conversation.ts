/**
 * The responsive path.
 *
 * A short question during a long task must be answered immediately, from the
 * room's real state, while the work loop keeps running untouched. This path:
 *
 *  - never touches the project (it is given no tools at all);
 *  - reads tasks, job records, tool runs and the recent transcript;
 *  - answers with the fast model (`settings.models.conversation`);
 *  - returns a short written answer plus a one-or-two-sentence spoken form;
 *  - refuses to answer when it cannot know, rather than inventing progress.
 *
 * It shares the agent's identity, persona and mailbox with the work loop: the
 * same teammate answers, whichever path produced the turn.
 */

import type { ContextRef } from '../../shared/types.ts'
import type { RuntimeDeps } from '../contracts.ts'
import { toErrorShape } from '../huddle-error.ts'
import { collectRoomState, formatRoomState, type RoomStateSnapshot } from './context.ts'
import type { OpenAiProvider, ProviderInputItem } from './provider.ts'
import { spokenForm } from './speech.ts'
import type { RuntimeBridge } from './types.ts'

export const MAX_OUTPUT_TOKENS_CONVERSATION = 400
export const CONVERSATION_TIMEOUT_MS = 30_000

export interface ConversationRequest {
  roomId: string
  agentId: string
  question: string
  /** The human message being answered. */
  questionMessageId: string | null
  /** Set when the human asked this teammate privately. */
  private?: boolean
  /**
   * Set when this same message was also pushed into the agent's running work
   * loop. The answer then has to be an acknowledgement of a course change, not
   * a status report: the human is watching the work adjust while they listen.
   */
  steered?: boolean
  /** What the agent was doing when it was steered, in its own activity words. */
  steeredFrom?: string | null
  /** Set when the message was said to the whole room rather than to this agent. */
  broadcast?: boolean
}

export interface ConversationReply {
  /** Detailed written answer. */
  body: string
  /** Short spoken form, one or two sentences. */
  spoken: string
  refs: ContextRef[]
  /** Real state the answer was allowed to use, for the activity view. */
  usedState: string[]
}

export interface ConversationOutcome {
  reply: ConversationReply | null
  /** Populated when no answer could be produced. */
  failure: { code: string; message: string; fix: string | null } | null
}

const CONVERSATION_RULES = `
You are answering out loud, in the middle of a live call, while work continues.
- If the human is greeting you or asking whether you can hear them, greet them back as yourself in one short sentence.
- Otherwise answer from the state below only. It is the room's real, current record.
- If the state does not contain the answer, say plainly that you do not know yet and what you would check.
- Never claim progress, results or tests that the state does not show. Never say "probably".
- One or two sentences. Spoken length. No lists, no headings, no markdown.
`.trim()

export class ConversationResponder {
  constructor(
    private readonly deps: RuntimeDeps,
    private readonly provider: OpenAiProvider,
    private readonly bridge: RuntimeBridge
  ) {}

  /** Real state used to answer, so the answer can be audited. */
  snapshot(roomId: string, agentId: string): RoomStateSnapshot | null {
    return collectRoomState(this.deps.bus, roomId, agentId, { messageLimit: 10, toolRunLimit: 8 })
  }

  async respond(request: ConversationRequest): Promise<ConversationOutcome> {
    const bus = this.deps.bus
    const room = bus.getRoom(request.roomId)
    const agent = bus.getAgent(request.agentId)
    if (!room || !agent) {
      return { reply: null, failure: { code: 'room_missing', message: 'That room or teammate is gone.', fix: null } }
    }

    const state = this.snapshot(request.roomId, request.agentId)
    if (!state) {
      return { reply: null, failure: { code: 'state_missing', message: 'Room state is unavailable.', fix: null } }
    }

    const model = this.deps.settings().models.conversation
    const input: ProviderInputItem[] = [
      { kind: 'text', role: 'user', content: `Current room state:\n${formatRoomState(state, 'conversation')}` }
    ]

    if (request.steered) {
      input.push({
        kind: 'text',
        role: 'user',
        content: [
          request.broadcast
            ? 'The human just said this to the whole room while you were working:'
            : 'The human just said this to you while you were working:',
          `"${request.question}"`,
          '',
          request.steeredFrom
            ? `You were in the middle of: ${request.steeredFrom}.`
            : 'You are in the middle of a task.',
          'It has already been delivered into your running work — your loop will act on it at its next step.',
          'Answer out loud in ONE short sentence: say what you are changing, or confirm you are holding it.',
          'Do not promise to start over. Do not repeat the instruction back. Do not ask for permission.'
        ].join('\n')
      })
    } else if (request.broadcast) {
      input.push({
        kind: 'text',
        role: 'user',
        content: [
          `The human said this to the whole room: "${request.question}"`,
          'Answer for yourself only, in one short sentence, as one voice among several.',
          'Do not speak for your teammates and do not repeat what the instruction said.'
        ].join('\n')
      })
    } else {
      input.push({ kind: 'text', role: 'user', content: `The human asks: ${request.question}` })
    }

    const previousWorkState = agent.workState
    const previousActivity = agent.activityLabel
    bus.setAgentActivity(agent.id, 'thinking', 'Answering a question')

    try {
      const turn = await this.provider.complete({
        model,
        instructions: `${agent.persona}\n\n${CONVERSATION_RULES}`,
        input,
        tools: [],
        maxOutputTokens: MAX_OUTPUT_TOKENS_CONVERSATION,
        timeoutMs: CONVERSATION_TIMEOUT_MS,
        onTextDelta: (delta) => {
          bus.emit(room.id, { type: 'agent.stream', agentId: agent.id, taskId: null, delta, done: false })
        }
      })
      const body = turn.text.trim()
      if (!body) {
        return {
          reply: null,
          failure: { code: 'provider_empty', message: `${agent.name} produced no answer.`, fix: 'Ask again; nothing was changed.' }
        }
      }
      return {
        reply: {
          body,
          spoken: spokenForm(body, 240) || `${agent.name} answered in the transcript.`,
          refs: this.replyRefs(state, agent.id),
          usedState: stateRefs(state)
        },
        failure: null
      }
    } catch (error) {
      const shape = toErrorShape(error)
      return { reply: null, failure: { code: shape.code, message: shape.message, fix: shape.fix ?? null } }
    } finally {
      const current = bus.getAgent(agent.id)
      if (current?.activityLabel === 'Answering a question') {
        bus.setAgentActivity(agent.id, previousWorkState, previousActivity)
      }
      bus.emit(room.id, { type: 'agent.stream', agentId: agent.id, taskId: null, delta: '', done: true })
    }
  }

  /** Citations for the reply: what the answer was actually based on. */
  private replyRefs(state: RoomStateSnapshot, agentId: string): ContextRef[] {
    const refs: ContextRef[] = []
    const ownTasks = this.deps.bus
      .getTasks(state.room.id)
      .filter((task) => task.ownerAgentId === agentId && task.status !== 'done')
    for (const task of ownTasks.slice(0, 3)) refs.push({ kind: 'task', taskId: task.id })
    for (const job of this.deps.bus.getJobs(state.room.id).slice(-3)) {
      if (job.status === 'running' || job.status === 'starting') refs.push({ kind: 'job', jobId: job.id })
    }
    return refs
  }
}

function stateRefs(state: RoomStateSnapshot): string[] {
  const used: string[] = []
  if (state.tasks.length > 0) used.push(`${state.tasks.length} task(s)`)
  if (state.jobs.length > 0) used.push(`${state.jobs.length} command record(s)`)
  if (state.toolRuns.length > 0) used.push(`${state.toolRuns.length} tool run(s)`)
  if (state.decisions.length > 0) used.push(`${state.decisions.length} decision(s)`)
  if (state.messages.length > 0) used.push(`${state.messages.length} transcript line(s)`)
  return used
}
