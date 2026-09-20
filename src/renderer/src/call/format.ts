import { HUMAN_COLOR, ROLE_LABELS } from '../../../shared/presets'
import type {
  Agent,
  AgentRole,
  AgentSpeechState,
  AgentWorkState,
  Artifact,
  ContextRef,
  IntegrationStatus,
  JobRecord,
  Message,
  MessageAuthor,
  MessageKind,
  ShareSurface,
  SpokenState,
  TaskStatus
} from '../../../shared/types'

/**
 * Presentation helpers for the call UI.
 *
 * Everything here is pure formatting of values that already exist in props —
 * no helper invents state, counts, or activity of its own.
 */

export function agentDisplayName(agent: { name: string; title?: string }): string {
  const title = agent.title?.trim()
  return title ? `${agent.name} (${title})` : agent.name
}

const SURFACE_LABELS: Record<ShareSurface, string> = {
  browser: 'Browser',
  code: 'Code',
  terminal: 'Terminal',
  files: 'Files'
}

const WORK_STATE_LABELS: Record<AgentWorkState, string> = {
  offline: 'Offline',
  idle: 'Idle',
  thinking: 'Thinking',
  reading: 'Reading',
  editing: 'Editing',
  running: 'Running',
  browsing: 'Browsing',
  testing: 'Testing',
  integrating: 'Integrating',
  waiting: 'Waiting',
  blocked: 'Blocked',
  paused: 'Paused',
  error: 'Error'
}

const SPEECH_LABELS: Record<AgentSpeechState, string> = {
  silent: 'Silent',
  queued: 'Queued to speak',
  speaking: 'Speaking',
  interrupted: 'Interrupted'
}

const SPOKEN_STATE_LABELS: Record<SpokenState, string> = {
  queued: 'Queued',
  speaking: 'Speaking now',
  played: 'Heard',
  interrupted: 'Interrupted',
  unheard: 'Not heard',
  cancelled: 'Cancelled'
}

const KIND_LABELS: Record<MessageKind, string | null> = {
  chat: null,
  question: 'Question',
  answer: 'Answer',
  handoff: 'Handoff',
  decision: 'Decision',
  result: 'Result',
  system: 'System'
}

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  proposed: 'Proposed',
  assigned: 'Assigned',
  in_progress: 'In progress',
  blocked: 'Blocked',
  awaiting_review: 'Awaiting review',
  submitted: 'Submitted',
  done: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed'
}

export type Tone = 'live' | 'quiet' | 'wait' | 'stop' | 'done'

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null
  const value = Date.parse(iso)
  return Number.isNaN(value) ? null : value
}

/** Locale short clock time, e.g. "14:05" or "2:05 PM". */
export function formatClock(iso: string): string {
  const value = parse(iso)
  if (value === null) return ''
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** Full locale date + time, used as the `title` of every timestamp. */
export function formatDateTime(iso: string): string {
  const value = parse(iso)
  if (value === null) return ''
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium'
  })
}

export function formatDay(iso: string): string {
  const value = parse(iso)
  if (value === null) return ''
  return new Date(value).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
}

/** Compact relative age. `now` is passed in so callers can refresh on a tick. */
export function formatRelative(iso: string, now: number): string {
  const value = parse(iso)
  if (value === null) return ''
  const seconds = Math.round((now - value) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatDay(iso)
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return ''
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function shortRevision(revision: string | null): string {
  if (!revision) return ''
  return revision.length > 8 ? revision.slice(0, 7) : revision
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Bounded, single-line text. Full text always stays available via `title`. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function initials(text: string): string {
  const parts = text.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase()
}

export function roleLabel(role: AgentRole): string {
  return ROLE_LABELS[role] ?? role
}

export function workStateLabel(state: AgentWorkState): string {
  return WORK_STATE_LABELS[state] ?? state
}

/** Which visual weight a work state earns. Idle and offline stay quiet. */
export function workStateTone(state: AgentWorkState): Tone {
  switch (state) {
    case 'offline':
    case 'idle':
      return 'quiet'
    case 'waiting':
    case 'paused':
      return 'wait'
    case 'blocked':
    case 'error':
      return 'stop'
    default:
      return 'live'
  }
}

export function speechLabel(state: AgentSpeechState): string {
  return SPEECH_LABELS[state] ?? state
}

export function spokenStateLabel(state: SpokenState): string {
  return SPOKEN_STATE_LABELS[state] ?? state
}

export function kindLabel(kind: MessageKind): string | null {
  return KIND_LABELS[kind] ?? null
}

export function taskStatusLabel(status: TaskStatus): string {
  return TASK_STATUS_LABELS[status] ?? status
}

export function taskStatusTone(status: TaskStatus): Tone {
  switch (status) {
    case 'done':
      return 'done'
    case 'in_progress':
    case 'awaiting_review':
    case 'submitted':
      return 'live'
    case 'blocked':
    case 'failed':
      return 'stop'
    default:
      return 'quiet'
  }
}

export function surfaceLabel(surface: ShareSurface): string {
  return SURFACE_LABELS[surface]
}

export function jobStatus(status: JobRecord['status']): { label: string; tone: Tone } {
  switch (status) {
    case 'starting':
      return { label: 'Starting', tone: 'wait' }
    case 'running':
      return { label: 'Running', tone: 'live' }
    case 'exited':
      return { label: 'Exited 0', tone: 'done' }
    case 'cancelled':
      return { label: 'Cancelled', tone: 'quiet' }
    case 'failed':
      return { label: 'Failed', tone: 'stop' }
    default:
      return { label: 'Unknown', tone: 'wait' }
  }
}

export function integrationStatus(status: IntegrationStatus): { label: string; tone: Tone } {
  switch (status) {
    case 'running':
      return { label: 'Running', tone: 'wait' }
    case 'verified':
      return { label: 'Verified', tone: 'done' }
    case 'conflict':
      return { label: 'Conflict', tone: 'stop' }
    case 'checks_failed':
      return { label: 'Checks failed', tone: 'stop' }
    case 'cancelled':
      return { label: 'Cancelled', tone: 'quiet' }
    default:
      return { label: 'Failed', tone: 'stop' }
  }
}

export function agentById(agents: Agent[], agentId: string | null | undefined): Agent | null {
  if (!agentId) return null
  return agents.find((agent) => agent.id === agentId) ?? null
}

export function authorName(author: MessageAuthor, agents: Agent[]): string {
  if (author.type === 'human') return 'You'
  if (author.type === 'system') return 'Huddle'
  return agentById(agents, author.agentId)?.name ?? 'Unknown teammate'
}

export function authorColor(author: MessageAuthor, agents: Agent[]): string {
  if (author.type === 'human') return HUMAN_COLOR
  if (author.type === 'system') return 'var(--muted)'
  return agentById(agents, author.agentId)?.color ?? 'var(--muted)'
}

export function authorAvatar(author: MessageAuthor, agents: Agent[]): string {
  if (author.type === 'human') return 'human'
  if (author.type === 'system') return 'huddle'
  return agentById(agents, author.agentId)?.avatar ?? 'spark'
}

/** One-line description of a context reference, and where it lives. */
export function refLabel(ref: ContextRef, agents: Agent[]): string {
  switch (ref.kind) {
    case 'file': {
      const name = ref.path.split(/[\\/]/).pop() ?? ref.path
      const range =
        ref.startLine === undefined
          ? ''
          : ref.endLine !== undefined && ref.endLine !== ref.startLine
            ? `:${ref.startLine}-${ref.endLine}`
            : `:${ref.startLine}`
      const owner = agentById(agents, ref.agentId)?.name
      return owner ? `${name}${range} · ${owner}` : `${name}${range}`
    }
    case 'screenshot':
      return ref.url ? `Screenshot · ${hostOf(ref.url)}` : 'Screenshot region'
    case 'task':
      return 'Task reference'
    case 'decision':
      return 'Decision reference'
    case 'job': {
      const range =
        ref.fromLine === undefined
          ? ''
          : ref.toLine !== undefined && ref.toLine !== ref.fromLine
            ? `:${ref.fromLine}-${ref.toLine}`
            : `:${ref.fromLine}`
      return `Job output${range}`
    }
    default:
      return 'Artifact reference'
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return truncate(url, 40)
  }
}

export function refTitle(ref: ContextRef): string {
  switch (ref.kind) {
    case 'file':
      return ref.path
    case 'screenshot':
      return ref.url ? `${ref.url}\n${ref.rect.width}×${ref.rect.height} at ${ref.rect.x},${ref.rect.y}` : 'Browser screenshot region'
    case 'task':
      return `Task ${ref.taskId}`
    case 'decision':
      return `Decision ${ref.decisionId}`
    case 'job':
      return `Job ${ref.jobId}`
    default:
      return `Artifact ${ref.artifactId}`
  }
}

/** Which real surface a reference lives in. `null` means it has no stage home. */
export function refSurface(ref: ContextRef): ShareSurface | null {
  switch (ref.kind) {
    case 'file':
      return 'code'
    case 'screenshot':
      return 'browser'
    case 'job':
      return 'terminal'
    case 'artifact':
      return 'files'
    default:
      return null
  }
}

/** The owner whose workspace a reference points at. */
export function refOwner(
  ref: ContextRef,
  agents: Agent[]
): { kind: 'team' } | { kind: 'agent'; agentId: string } {
  if (ref.kind === 'file') {
    const owner = agentById(agents, ref.agentId)
    if (owner) return { kind: 'agent', agentId: owner.id }
  }
  return { kind: 'team' }
}

export function artifactKindLabel(kind: Artifact['kind']): string {
  switch (kind) {
    case 'screenshot':
      return 'Screenshot'
    case 'file':
      return 'File'
    case 'diff':
      return 'Diff'
    case 'report':
      return 'Report'
    case 'log':
      return 'Log'
    default:
      return 'Image'
  }
}

export function messagePreview(message: Message, agents: Agent[]): string {
  return `${authorName(message.author, agents)}: ${truncate(message.body, 90)}`
}

/** The question a message answers, when it is an answer with a reply target. */
export function findReply(message: Message, messages: Message[]): Message | null {
  if (!message.replyToId) return null
  return messages.find((item) => item.id === message.replyToId) ?? null
}

export function unansweredQuestions(messages: Message[]): Message[] {
  const answered = new Set<string>()
  for (const message of messages) {
    if (message.replyToId) answered.add(message.replyToId)
  }
  return messages
    .filter((message) => message.kind === 'question' && !answered.has(message.id))
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
