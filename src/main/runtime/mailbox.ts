/**
 * Per-agent inbox.
 *
 * An agent's inbox holds the things that arrived while it was busy: a new human
 * instruction, a teammate's handoff, a review request, a decision change, or the
 * onboarding pack for a teammate added mid-project. The executor drains the
 * highest-priority item whenever the agent is free.
 *
 * The mailbox also owns the anti-spam ledger: at most one acknowledgement per
 * assignment, and never the same item twice.
 */

import type { GraphClock } from './tasks.ts'

export type MailboxItemKind =
  | 'human_message'
  | 'teammate_message'
  | 'handoff'
  | 'review_request'
  | 'decision_change'
  | 'onboarding'

export const MAILBOX_PRIORITY: Record<MailboxItemKind, number> = {
  human_message: 50,
  handoff: 40,
  review_request: 35,
  decision_change: 30,
  teammate_message: 20,
  onboarding: 10
}

export interface MailboxItem {
  id: string
  roomId: string
  agentId: string
  kind: MailboxItemKind
  /** One line the agent reads first. */
  summary: string
  /** Optional extra detail for the executor's prompt. */
  note: string
  messageId: string | null
  taskId: string | null
  decisionId: string | null
  priority: number
  createdAt: string
}

export interface MailboxInput {
  roomId: string
  agentId: string
  kind: MailboxItemKind
  summary: string
  note?: string
  messageId?: string | null
  taskId?: string | null
  decisionId?: string | null
}

export class Mailbox {
  private readonly queues = new Map<string, MailboxItem[]>()
  private readonly acknowledged = new Map<string, Set<string>>()

  constructor(private readonly clock: GraphClock) {}

  /**
   * Queue an inbox item. Identical pending items for the same agent are
   * collapsed, so a burst of messages cannot produce a burst of work.
   */
  enqueue(input: MailboxInput): MailboxItem {
    const queue = this.queues.get(input.agentId) ?? []
    const duplicate = queue.find(
      (item) =>
        item.kind === input.kind &&
        item.messageId === (input.messageId ?? null) &&
        item.taskId === (input.taskId ?? null) &&
        item.decisionId === (input.decisionId ?? null) &&
        item.summary === input.summary
    )
    if (duplicate) return duplicate

    const item: MailboxItem = {
      id: this.clock.newId(),
      roomId: input.roomId,
      agentId: input.agentId,
      kind: input.kind,
      summary: input.summary.slice(0, 400),
      note: (input.note ?? '').slice(0, 2000),
      messageId: input.messageId ?? null,
      taskId: input.taskId ?? null,
      decisionId: input.decisionId ?? null,
      priority: MAILBOX_PRIORITY[input.kind],
      createdAt: this.clock.now()
    }
    queue.push(item)
    this.queues.set(input.agentId, queue)
    return item
  }

  peek(agentId: string): MailboxItem | null {
    return this.highest(agentId)
  }

  take(agentId: string): MailboxItem | null {
    const item = this.highest(agentId)
    if (!item) return null
    const queue = this.queues.get(agentId) ?? []
    const index = queue.indexOf(item)
    if (index >= 0) queue.splice(index, 1)
    return item
  }

  /** Puts an item back at the front of the queue, preserving its priority. */
  restore(item: MailboxItem): void {
    const queue = this.queues.get(item.agentId) ?? []
    queue.push(item)
    this.queues.set(item.agentId, queue)
  }

  size(agentId: string): number {
    return this.queues.get(agentId)?.length ?? 0
  }

  roomSize(roomId: string): number {
    let total = 0
    for (const queue of this.queues.values()) {
      total += queue.filter((item) => item.roomId === roomId).length
    }
    return total
  }

  items(agentId: string): MailboxItem[] {
    return [...(this.queues.get(agentId) ?? [])]
  }

  clear(agentId: string): void {
    this.queues.delete(agentId)
  }

  clearRoom(roomId: string): void {
    for (const [agentId, queue] of this.queues) {
      const kept = queue.filter((item) => item.roomId !== roomId)
      if (kept.length === 0) this.queues.delete(agentId)
      else this.queues.set(agentId, kept)
    }
  }

  /** Drops pending items matching a predicate, returning how many went. */
  dropWhere(roomId: string, predicate: (item: MailboxItem) => boolean): number {
    let dropped = 0
    for (const [agentId, queue] of this.queues) {
      const kept = queue.filter((item) => {
        if (item.roomId !== roomId) return true
        const remove = predicate(item)
        if (remove) dropped += 1
        return !remove
      })
      if (kept.length === 0) this.queues.delete(agentId)
      else this.queues.set(agentId, kept)
    }
    return dropped
  }

  /** True when this agent already acknowledged this assignment key. */
  hasAcknowledged(agentId: string, key: string): boolean {
    return this.acknowledged.get(agentId)?.has(key) ?? false
  }

  markAcknowledged(agentId: string, key: string): void {
    const set = this.acknowledged.get(agentId) ?? new Set<string>()
    set.add(key)
    this.acknowledged.set(agentId, set)
  }

  acknowledgedKeys(agentId: string): string[] {
    return [...(this.acknowledged.get(agentId) ?? [])]
  }

  private highest(agentId: string): MailboxItem | null {
    const queue = this.queues.get(agentId) ?? []
    if (queue.length === 0) return null
    let best = queue[0]
    for (const item of queue) {
      if (item.priority > best.priority) best = item
      else if (item.priority === best.priority && item.createdAt < best.createdAt) best = item
    }
    return best
  }
}
