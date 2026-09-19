import { useRef, type JSX } from 'react'
import type {
  Agent,
  Artifact,
  ContextRef,
  Decision,
  Message,
  ShareSurface,
  Task
} from '../../../shared/types'
import { HUMAN_AVATAR } from '../../../shared/presets'
import type { SpeakingState } from '../state/view-model'
import { AvatarMark } from './avatars'
import { findAgent } from './derive'
import {
  authorColor,
  authorName,
  formatClock,
  formatDateTime,
  kindLabel,
  refLabel,
  refSurface,
  refTitle,
  spokenStateLabel,
  truncate,
  type Tone
} from './format'
import { CloseIcon, HistoryIcon, LockIcon, ReplyIcon, SpeechIcon } from './icons'
import { Badge, Empty, IconButton, useStickToBottom } from './ui'

/**
 * The room chat: the conversation of record, kept quieter than the call.
 *
 * Every badge is read from the message itself — kind, addressee, spoken state,
 * attached references. Nothing is inferred from the text.
 */

const KIND_TONES: Record<string, Tone | 'accent' | 'muted'> = {
  question: 'accent',
  answer: 'live',
  handoff: 'wait',
  decision: 'accent',
  result: 'done',
  system: 'muted'
}

const SPOKEN_TONES: Record<string, Tone | 'accent' | 'muted'> = {
  queued: 'wait',
  speaking: 'live',
  played: 'quiet',
  interrupted: 'stop',
  unheard: 'stop',
  cancelled: 'quiet'
}

export interface ChatProps {
  messages: Message[]
  agents: Agent[]
  tasks: Task[]
  decisions: Decision[]
  artifacts: Artifact[]
  speaking: Record<string, SpeakingState>
  /** When set, only the private channel with this agent is shown. */
  privateAgentId: string | null
  emptyDetail: string
  onReplyTo: (message: Message) => void
  onOpenRef: (ref: ContextRef, surface: ShareSurface) => void
  onOpenAgent: (agentId: string) => void
}

export function Chat({
  messages,
  agents,
  tasks,
  decisions,
  artifacts,
  speaking,
  privateAgentId,
  emptyDetail,
  onReplyTo,
  onOpenRef,
  onOpenAgent
}: ChatProps): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)
  useStickToBottom(scroller, messages.length)

  const visible = messages.filter((message) =>
    privateAgentId === null
      ? message.private === undefined
      : message.private?.agentId === privateAgentId
  )

  return (
    <div className="hs-chat" ref={scroller} role="log" aria-label={privateAgentId ? 'Private messages' : 'Room messages'}>
      {visible.length === 0 ? (
        <Empty
          title={privateAgentId ? 'No private messages yet' : 'Nothing said yet'}
          detail={emptyDetail}
        />
      ) : (
        visible.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            messages={messages}
            agents={agents}
            tasks={tasks}
            decisions={decisions}
            artifacts={artifacts}
            speaking={speaking}
            privateChannel={privateAgentId !== null}
            onReplyTo={onReplyTo}
            onOpenRef={onOpenRef}
            onOpenAgent={onOpenAgent}
          />
        ))
      )}
    </div>
  )
}

interface MessageRowProps {
  message: Message
  messages: Message[]
  agents: Agent[]
  tasks: Task[]
  decisions: Decision[]
  artifacts: Artifact[]
  speaking: Record<string, SpeakingState>
  privateChannel: boolean
  onReplyTo: (message: Message) => void
  onOpenRef: (ref: ContextRef, surface: ShareSurface) => void
  onOpenAgent: (agentId: string) => void
}

function MessageRow({
  message,
  messages,
  agents,
  tasks,
  decisions,
  artifacts,
  speaking,
  privateChannel,
  onReplyTo,
  onOpenRef,
  onOpenAgent
}: MessageRowProps): JSX.Element {
  const name = authorName(message.author, agents)
  const color = authorColor(message.author, agents)
  const isHuman = message.author.type === 'human'
  const isSystem = message.author.type === 'system'
  const kind = kindLabel(message.kind)
  const agentId = message.author.type === 'agent' ? message.author.agentId : null
  const liveText = agentId ? speaking[agentId]?.text ?? '' : ''
  const reply = message.replyToId
    ? messages.find((item) => item.id === message.replyToId) ?? null
    : null
  const targets = message.to
    .map((id) => findAgent(agents, id)?.name ?? null)
    .filter((value): value is string => value !== null)
  const linkedDecisions =
    message.kind === 'decision'
      ? decisions.filter((decision) => decision.originMessageId === message.id)
      : []

  if (isSystem) {
    return (
      <article className="hs-msg is-system">
        <p className="hs-msg-body">
          {message.body}
          <span className="hs-msg-time" title={formatDateTime(message.createdAt)}>
            {formatClock(message.createdAt)}
          </span>
        </p>
      </article>
    )
  }

  return (
    <article className={`hs-msg${isHuman ? ' is-human' : ''}${message.private ? ' is-private' : ''}`}>
      <header className="hs-msg-head">
        {agentId ? (
          <button
            type="button"
            className="hs-msg-who"
            onClick={() => onOpenAgent(agentId)}
            aria-label={`Open one-on-one with ${name}`}
            title={`Talk to ${name} one on one`}
          >
            <AvatarMark
              avatar={findAgent(agents, agentId)?.avatar ?? 'spark'}
              color={color}
              size={20}
            />
            <span className="hs-msg-name">{name}</span>
          </button>
        ) : (
          <span className="hs-msg-who is-static">
            <AvatarMark avatar={HUMAN_AVATAR} color={color} size={20} />
            <span className="hs-msg-name">{name}</span>
          </span>
        )}
        {kind ? <Badge tone={KIND_TONES[message.kind] ?? 'muted'}>{kind}</Badge> : null}
        {targets.length > 0 ? (
          <span className="hs-msg-to" title={`Addressed to ${targets.join(', ')}`}>
            → {targets.join(', ')}
          </span>
        ) : null}
        {message.private ? (
          <Badge tone="accent" title="Private side channel with one teammate">
            <LockIcon size={11} /> private
          </Badge>
        ) : null}
        {message.kind === 'handoff' && targets.length === 0 ? (
          <Badge tone="wait">handoff</Badge>
        ) : null}
        <span className="hs-msg-time" title={formatDateTime(message.createdAt)}>
          {formatClock(message.createdAt)}
        </span>
      </header>

      {reply ? (
        <p className="hs-msg-reply" title={`${authorName(reply.author, agents)}: ${reply.body}`}>
          <span className="hs-msg-reply-mark">↩</span>
          {authorName(reply.author, agents)}: {truncate(reply.body, 80)}
        </p>
      ) : null}

      <p className="hs-msg-body" title={message.body}>
        {message.body}
      </p>

      {linkedDecisions.length > 0 ? (
        <p className="hs-msg-chips">
          {linkedDecisions.map((decision) => (
            <span
              key={decision.id}
              className="hs-chip is-static"
              title={decision.title}
            >
              <HistoryIcon size={12} /> v{decision.revision} · {truncate(decision.title, 34)}
            </span>
          ))}
        </p>
      ) : null}

      {message.refs && message.refs.length > 0 ? (
        <p className="hs-msg-chips">
          {message.refs.map((ref, index) => (
            <RefChip
              key={`${message.id}-${index}`}
              refItem={ref}
              agents={agents}
              tasks={tasks}
              decisions={decisions}
              artifacts={artifacts}
              onOpenRef={onOpenRef}
            />
          ))}
        </p>
      ) : null}

      <footer className="hs-msg-foot">
        {message.spoken ? (
          <span
            className="hs-msg-spoken"
            title={
              message.spoken.playedChars === null
                ? `Audio state: ${spokenStateLabel(message.spoken.state)}`
                : `Audio state: ${spokenStateLabel(message.spoken.state)} · ${message.spoken.playedChars} characters played`
            }
          >
            <Badge tone={SPOKEN_TONES[message.spoken.state] ?? 'muted'}>
              <SpeechIcon size={11} /> {spokenStateLabel(message.spoken.state)}
            </Badge>
            {liveText && message.spoken.state === 'speaking' ? (
              <span className="hs-msg-live">{truncate(liveText, 60)}</span>
            ) : null}
          </span>
        ) : null}
        <span className="hs-msg-actions">
          <IconButton
            label={`Reply to ${name}`}
            hint="Starts a reply in the composer below"
            size="sm"
            onClick={() => onReplyTo(message)}
          >
            <ReplyIcon size={14} />
          </IconButton>
        </span>
      </footer>
    </article>
  )
}

interface RefChipProps {
  refItem: ContextRef
  agents: Agent[]
  tasks: Task[]
  decisions: Decision[]
  artifacts: Artifact[]
  onOpenRef: (ref: ContextRef, surface: ShareSurface) => void
}

export function RefChip({ refItem, agents, tasks, decisions, artifacts, onOpenRef }: RefChipProps): JSX.Element {
  const surface = refSurface(refItem)
  const label = chipLabel(refItem, tasks, decisions, artifacts, agents)
  const title = refTitle(refItem)

  if (!surface) {
    return (
      <span className="hs-chip is-static" title={title}>
        {label}
      </span>
    )
  }

  return (
    <button
      type="button"
      className="hs-chip"
      title={`${title} — opens this on the stage`}
      onClick={() => onOpenRef(refItem, surface)}
      aria-label={`Open reference on the stage: ${label}`}
    >
      {label}
    </button>
  )
}

function chipLabel(
  refItem: ContextRef,
  tasks: Task[],
  decisions: Decision[],
  artifacts: Artifact[],
  agents: Agent[]
): string {
  if (refItem.kind === 'task') {
    const task = tasks.find((item) => item.id === refItem.taskId)
    return task ? `Task · ${truncate(task.title, 34)}` : 'Task reference'
  }
  if (refItem.kind === 'decision') {
    const decision = decisions.find((item) => item.id === refItem.decisionId)
    return decision
      ? `Decision v${decision.revision} · ${truncate(decision.title, 30)}`
      : 'Decision reference'
  }
  if (refItem.kind === 'artifact') {
    const artifact = artifacts.find((item) => item.id === refItem.artifactId)
    return artifact ? `Artifact · ${truncate(artifact.title, 30)}` : 'Artifact reference'
  }
  if (refItem.kind === 'job') {
    return `Job output${refItem.fromLine === undefined ? '' : `:${refItem.fromLine}`}`
  }
  return refLabel(refItem, agents)
}

/* ------------------------------------------------------------------ *
 * Reply quote + reference chips
 * ------------------------------------------------------------------ */

/** Compact quote of the message the composer is replying to. */
export function ReplyQuote({
  message,
  agents,
  onClear
}: {
  message: Message
  agents: Agent[]
  onClear: () => void
}): JSX.Element {
  const name = authorName(message.author, agents)
  return (
    <p className="hs-quote" title={message.body}>
      <span className="hs-quote-who">Replying to {name}</span>
      <span className="hs-quote-text">{truncate(message.body, 90)}</span>
      <IconButton label="Cancel reply" hint="Drops the reply target" size="sm" onClick={onClear}>
        <CloseIcon size={13} />
      </IconButton>
    </p>
  )
}
