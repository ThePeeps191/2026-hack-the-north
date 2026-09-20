import { useMemo, useRef, useState, type JSX } from 'react'
import type {
  Agent,
  Artifact,
  ContextRef,
  Decision,
  Message,
  MessageAuthor,
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
  truncate
} from './format'
import { Markdown } from './Markdown'
import { blockWeight, parseBlocks } from './markdown-parse'
import { CloseIcon, HistoryIcon, LockIcon, ReplyIcon } from './icons'
import { Empty, IconButton, useStickToBottom } from './ui'

/**
 * The room conversation.
 *
 * Messages are Markdown, so they are rendered as Markdown (see `Markdown.tsx`,
 * which builds elements and never injects HTML). Consecutive messages from one
 * author are grouped under a single name, a long report collapses to a readable
 * height with its full text one click away, and the only properties that get
 * their own mark are the ones that change what the message means: a non-plain
 * kind, a private scope, an addressee, and speech that did not finish playing.
 */

/** Kinds worth naming. A plain `say` needs no label. */
const LABELLED_KINDS = new Set(['question', 'answer', 'handoff', 'decision', 'result'])

/** Audio states worth surfacing: the human may have missed those words. */
const UNFINISHED_SPEECH = new Set(['interrupted', 'unheard', 'cancelled'])

/** Longer than this (in rendered lines) and a message collapses by default. */
const COLLAPSE_OVER = 18

/** Two messages group together inside this window. */
const GROUP_WINDOW_MS = 4 * 60 * 1000

function sameAuthor(a: MessageAuthor, b: MessageAuthor): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'agent' && b.type === 'agent') return a.agentId === b.agentId
  return true
}

export interface ChatProps {
  messages: Message[]
  agents: Agent[]
  tasks: Task[]
  decisions: Decision[]
  artifacts: Artifact[]
  speaking: Record<string, SpeakingState>
  /** True once the human has joined the call and could actually hear speech. */
  inCall: boolean
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
  inCall,
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
    <div
      className="hs-chat"
      ref={scroller}
      role="log"
      aria-label={privateAgentId ? 'Private messages' : 'Room messages'}
    >
      {visible.length === 0 ? (
        <Empty
          title={privateAgentId ? 'No private messages yet' : 'Nothing said yet'}
          detail={emptyDetail}
        />
      ) : (
        visible.map((message, index) => {
          const previous = index > 0 ? visible[index - 1] : null
          const grouped =
            previous !== null &&
            previous.author.type !== 'system' &&
            message.author.type !== 'system' &&
            sameAuthor(previous.author, message.author) &&
            message.replyToId === undefined &&
            Date.parse(message.createdAt) - Date.parse(previous.createdAt) < GROUP_WINDOW_MS
          return (
            <MessageRow
              key={message.id}
              message={message}
              messages={messages}
              agents={agents}
              tasks={tasks}
              decisions={decisions}
              artifacts={artifacts}
              speaking={speaking}
              inCall={inCall}
              grouped={grouped}
              onReplyTo={onReplyTo}
              onOpenRef={onOpenRef}
              onOpenAgent={onOpenAgent}
            />
          )
        })
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
  /** True once the human has joined the call and could actually hear speech. */
  inCall: boolean
  /** True when this follows another message from the same author. */
  grouped: boolean
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
  inCall,
  grouped,
  onReplyTo,
  onOpenRef,
  onOpenAgent
}: MessageRowProps): JSX.Element {
  const name = authorName(message.author, agents)
  const color = authorColor(message.author, agents)
  const isHuman = message.author.type === 'human'
  const isSystem = message.author.type === 'system'
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
  const kind = LABELLED_KINDS.has(message.kind) ? kindLabel(message.kind) : null
  const speech = message.spoken
  /*
   * "Cancelled — the text above is complete" under every message.
   *
   * When nobody has joined the call there is no audio to miss, so noting that
   * each line went unspoken is not honesty, it is three identical warnings
   * about a thing that was never going to happen. The note matters only once
   * the human is in the call and could actually have heard it.
   */
  const unfinished = inCall && speech !== undefined && UNFINISHED_SPEECH.has(speech.state)

  if (isSystem) {
    return (
      <article className="hs-msg is-system">
        <p className="hs-msg-body">{message.body}</p>
        <span className="hs-msg-time" title={formatDateTime(message.createdAt)}>
          {formatClock(message.createdAt)}
        </span>
      </article>
    )
  }

  const classes = [
    'hs-msg',
    isHuman ? 'is-human' : '',
    message.private ? 'is-private' : '',
    grouped ? 'is-grouped' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <article className={classes}>
      <div className="hs-msg-gutter" aria-hidden={grouped ? 'true' : undefined}>
        {grouped ? null : (
          <AvatarMark
            avatar={agentId ? findAgent(agents, agentId)?.avatar ?? 'spark' : HUMAN_AVATAR}
            color={color}
            size={26}
          />
        )}
      </div>

      <div className="hs-msg-col">
        {grouped ? null : (
          <header className="hs-msg-head">
            {agentId ? (
              <button
                type="button"
                className="hs-msg-name"
                onClick={() => onOpenAgent(agentId)}
                title={`Talk to ${name} one on one`}
              >
                {name}
              </button>
            ) : (
              <span className="hs-msg-name is-static">{name}</span>
            )}
            {kind ? <span className={`hs-msg-kind is-${message.kind}`}>{kind}</span> : null}
            {targets.length > 0 ? (
              <span className="hs-msg-to" title={`Addressed to ${targets.join(', ')}`}>
                to {targets.join(', ')}
              </span>
            ) : null}
            {message.private ? (
              <span className="hs-msg-private" title="One-on-one message. Other teammates never receive it.">
                <LockIcon size={11} /> private
              </span>
            ) : null}
            <span className="hs-msg-time" title={formatDateTime(message.createdAt)}>
              {formatClock(message.createdAt)}
            </span>
          </header>
        )}

        {reply ? (
          <p className="hs-msg-reply" title={`${authorName(reply.author, agents)}: ${reply.body}`}>
            <span className="hs-msg-reply-mark" aria-hidden="true">
              ↩
            </span>
            {authorName(reply.author, agents)}: {truncate(reply.body, 80)}
          </p>
        ) : null}

        <MessageBody source={message.body} />

        {linkedDecisions.length > 0 ? (
          <p className="hs-msg-chips">
            {linkedDecisions.map((decision) => (
              <span key={decision.id} className="hs-chip is-static" title={decision.title}>
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

        {unfinished || (liveText.length > 0 && speech?.state === 'speaking') ? (
          <p className="hs-msg-speech">
            {unfinished && speech ? (
              <span
                className="hs-msg-unheard"
                title={
                  speech.playedChars === null
                    ? `Audio state: ${spokenStateLabel(speech.state)}`
                    : `Audio state: ${spokenStateLabel(speech.state)} · ${speech.playedChars} characters played`
                }
              >
                {spokenStateLabel(speech.state)} — the text above is complete
              </span>
            ) : (
              <span className="hs-msg-live">{truncate(liveText, 80)}</span>
            )}
          </p>
        ) : null}
      </div>

      <span className="hs-msg-actions">
        {grouped ? (
          <span className="hs-msg-time is-hover" title={formatDateTime(message.createdAt)}>
            {formatClock(message.createdAt)}
          </span>
        ) : null}
        <IconButton
          label={`Reply to ${name}`}
          hint="Starts a reply in the composer below"
          size="sm"
          onClick={() => onReplyTo(message)}
        >
          <ReplyIcon size={14} />
        </IconButton>
      </span>
    </article>
  )
}

/**
 * A message body. Long reports open collapsed so the conversation stays
 * scannable; the full text is always one click away and never truncated.
 */
function MessageBody({ source }: { source: string }): JSX.Element {
  const long = useMemo(() => blockWeight(parseBlocks(source)) > COLLAPSE_OVER, [source])
  const [expanded, setExpanded] = useState(false)

  if (!long) return <Markdown source={source} className="hs-msg-body" />

  return (
    <div className={`hs-msg-long${expanded ? ' is-open' : ''}`}>
      <Markdown source={source} className="hs-msg-body" />
      <button
        type="button"
        className="hs-msg-more"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
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
 * Reply quote
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
