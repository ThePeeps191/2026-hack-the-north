/**
 * Internal seams for the runtime.
 *
 * These types exist so the modules can depend on each other's shapes without
 * depending on each other's implementations: the tool registry knows what the
 * bridge can do, the executor knows what a work item is, and none of them import
 * the composition root (index.ts).
 *
 * Types only — no runtime imports, so importing this file is free.
 */

import type {
  ContextRef,
  Decision,
  Message,
  MessageAuthor,
  MessageKind,
  Task,
  TaskStatus,
  WorkspaceRecord
} from '../../shared/types.ts'
import type { RecordDecisionInput } from '../../shared/api.ts'
import type { SpeechReason } from '../../shared/voice.ts'
import type { RuntimeDeps } from '../contracts.ts'
import type { MailboxItemKind } from './mailbox.ts'
import type { TaskPatch } from './tasks.ts'

/* ------------------------------------------------------------------ *
 * Bridge: what the runtime can do for a tool
 * ------------------------------------------------------------------ */

export interface BridgeTaskInput {
  title: string
  detail?: string
  ownerAgentId?: string | null
  dependsOn?: string[]
  acceptance?: string[]
  status?: TaskStatus
  /**
   * Whether the owner should get an inbox item. False when the caller has
   * already queued the instruction, so one assignment is never announced twice
   * and never produces two acknowledgements.
   */
  notifyOwner?: boolean
}

export interface BridgeTaskResult {
  task: Task
  /** Agents that were notified about the task. */
  notified: string[]
}

export interface BridgeMessageInput {
  roomId: string
  agentId: string
  body: string
  kind: MessageKind
  to?: string[]
  refs?: ContextRef[]
  replyToId?: string
  /** Request speech for this message. Defaults to true for short kinds. */
  speak?: boolean
  speechReason?: SpeechReason
  spokenOverride?: string
}

export interface BridgeNoticeItem {
  kind: MailboxItemKind
  summary: string
  note?: string
  messageId?: string
  taskId?: string
  decisionId?: string
}

/**
 * Implemented by the composition root. Tools call these; they never touch the
 * bus or the hosts directly, so every side effect stays in one place.
 */
export interface RuntimeBridge {
  readonly deps: RuntimeDeps

  notify(agentId: string, item: BridgeNoticeItem): boolean

  createTask(roomId: string, input: BridgeTaskInput, createdBy: MessageAuthor): BridgeTaskResult
  updateTask(taskId: string, patch: TaskPatch): Task | null
  getTask(taskId: string): Task | null

  /** Record an agent-authored message and speak it when useful. */
  message(input: BridgeMessageInput): Message
  systemMessage(roomId: string, body: string, refs?: ContextRef[]): Message | null

  /** Records the decision and applies it to affected work. */
  recordDecision(roomId: string, agentId: string, input: RecordDecisionInput): Promise<Decision>

  ensureWorkspace(roomId: string, agentId: string): Promise<WorkspaceRecord>
  teamWorkspace(roomId: string): Promise<WorkspaceRecord>
  /** Commit last verified in the team workspace, or null when nothing is verified. */
  teamRevision(roomId: string): string | null

  /** Wake the scheduler: an agent may have work now. */
  kick(roomId: string): void

  alreadyAcknowledged(agentId: string, key: string): boolean
  markAcknowledged(agentId: string, key: string): void
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

export interface ToolContext {
  roomId: string
  agentId: string
  taskId: string | null
  /** Aborted when the task is cancelled, the room detaches, or the runtime disposes. */
  signal: AbortSignal
  deps: RuntimeDeps
  bridge: RuntimeBridge
}

export interface ToolOutcome {
  /** One-line truthful outcome recorded on the ToolRun. */
  summary: string
  /** Text handed back to the model. */
  content: string
  refs?: ContextRef[]
  /** Set when the tool ran but failed. Never set for good news. */
  error?: string
  /** Set when the outcome is a refusal the model must work around. */
  rejected?: boolean
}

export interface ToolExecution {
  name: string
  status: 'ok' | 'error' | 'cancelled' | 'rejected'
  /** What the model reads. */
  content: string
  /** One-line summary, mirrored into the ToolRun. */
  summary: string
  /** Real things this call touched, for the message's evidence refs. */
  refs?: ContextRef[]
}
