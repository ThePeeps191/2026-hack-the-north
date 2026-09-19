import { useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Agent, ContextRef, Message } from '../../../shared/types'
import { AvatarMark } from './avatars'
import { ReplyQuote } from './Chat'
import { findAgent } from './derive'
import { refLabel, refTitle, roleLabel, truncate } from './format'
import { ChevronDownIcon, CloseIcon, LockIcon, UsersIcon } from './icons'
import { Badge, Button, IconButton } from './ui'

/**
 * The composer.
 *
 * Enter sends, Shift+Enter adds a line, `@` names a teammate, and every chip in
 * the draft comes from a real reference or the reply target. Sending is the only
 * thing this component does - the text lives in the shell so other panels can
 * prefill it.
 */

export interface ComposerModel {
  body: string
  setBody: (value: string) => void
  targets: string[]
  setTargets: (ids: string[]) => void
  refs: ContextRef[]
  removeRef: (index: number) => void
  replyTo: Message | null
  clearReply: () => void
  /** Agent id when the draft goes to a private side channel. */
  privateTo: string | null
  setPrivateTo: (agentId: string | null) => void
  /** Set while the one-on-one view is open; private becomes the default. */
  spotlightAgentId: string | null
  /** Bumped to move focus into the textarea. */
  focusToken: number
  send: () => void
  sending: boolean
}

export interface ComposerProps {
  model: ComposerModel
  agents: Agent[]
}

const MENTION_PATTERN = /@[^\s@]{0,24}$/u

export function Composer({ model, agents }: ComposerProps): JSX.Element {
  const area = useRef<HTMLTextAreaElement | null>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [toMenuOpen, setToMenuOpen] = useState(false)

  useEffect(() => {
    if (model.focusToken === 0) return
    area.current?.focus()
  }, [model.focusToken])

  useEffect(() => {
    if (!toMenuOpen) return
    const onDown = (): void => setToMenuOpen(false)
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [toMenuOpen])

  const targetNames = model.targets
    .map((id) => findAgent(agents, id)?.name ?? null)
    .filter((value): value is string => value !== null)
  const spotlightAgent = findAgent(agents, model.spotlightAgentId)
  const empty = model.body.trim().length === 0
  const sendDisabled = empty || model.sending
  const sendReason = model.sending
    ? 'The previous message is still being sent'
    : empty
      ? 'Type a message first'
      : undefined

  const visibleMentions =
    mentionQuery === null
      ? []
      : agents.filter((agent) =>
          agent.name.toLowerCase().includes(mentionQuery.toLowerCase())
        )

  const applyMention = (agentId: string): void => {
    const node = area.current
    if (node) {
      const caret = node.selectionStart
      const before = model.body.slice(0, caret)
      const match = MENTION_PATTERN.exec(before)
      if (match) {
        const start = caret - match[0].length
        const next = `${model.body.slice(0, start)}${model.body.slice(caret)}`
        model.setBody(next)
        window.requestAnimationFrame(() => {
          node.focus()
          node.setSelectionRange(start, start)
        })
      } else {
        node.focus()
      }
    }
    if (!model.targets.includes(agentId)) model.setTargets([...model.targets, agentId])
    setMentionQuery(null)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      if (mentionQuery !== null) {
        setMentionQuery(null)
        return
      }
      area.current?.blur()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (mentionQuery !== null && visibleMentions.length > 0) {
        applyMention(visibleMentions[0].id)
        return
      }
      if (!empty && !model.sending) model.send()
    }
  }

  return (
    <div className="hs-composer">
      {model.replyTo ? (
        <ReplyQuote message={model.replyTo} agents={agents} onClear={model.clearReply} />
      ) : null}

      {model.refs.length > 0 ? (
        <ul className="hs-attached" aria-label="Attached references">
          {model.refs.map((ref, index) => (
            <li key={`${ref.kind}-${index}`} className="hs-chip is-attached" title={refTitle(ref)}>
              <span>{refLabel(ref, agents)}</span>
              <IconButton
                label={`Remove attached reference ${index + 1}`}
                hint="Detaches this reference from the message"
                size="sm"
                onClick={() => model.removeRef(index)}
              >
                <CloseIcon size={12} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="hs-composer-tools">
        <span className="hs-to">
          <button
            type="button"
            className="hs-to-btn"
            aria-expanded={toMenuOpen}
            aria-haspopup="true"
            title="Address this message to specific teammates"
            onClick={() => setToMenuOpen((open) => !open)}
          >
            <UsersIcon size={13} />
            To: {targetNames.length > 0 ? truncate(targetNames.join(', '), 26) : 'Everyone'}
            <ChevronDownIcon size={13} />
          </button>
          {toMenuOpen ? (
            <ul
              className="hs-to-menu"
              onMouseDown={(event) => event.stopPropagation()}
              role="menu"
              aria-label="Message recipients"
            >
              <li>
                <button
                  type="button"
                  role="menuitem"
                  className="hs-to-item"
                  onClick={() => {
                    model.setTargets([])
                    setToMenuOpen(false)
                    area.current?.focus()
                  }}
                >
                  Everyone in the room
                </button>
              </li>
              {agents.map((agent) => {
                const on = model.targets.includes(agent.id)
                return (
                  <li key={agent.id}>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={on}
                      className={`hs-to-item${on ? ' is-on' : ''}`}
                      onClick={() => {
                        model.setTargets(
                          on
                            ? model.targets.filter((id) => id !== agent.id)
                            : [...model.targets, agent.id]
                        )
                      }}
                    >
                      <AvatarMark avatar={agent.avatar} color={agent.color} size={18} />
                      {agent.name}
                      <span className="hs-to-role">{roleLabel(agent.role)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </span>

        {spotlightAgent ? (
          <span className="hs-scope" role="group" aria-label="Message scope">
            <button
              type="button"
              className={`hs-scope-btn${model.privateTo ? ' is-on' : ''}`}
              aria-pressed={model.privateTo !== null}
              title={`Only ${spotlightAgent.name} sees this`}
              onClick={() => model.setPrivateTo(spotlightAgent.id)}
            >
              <LockIcon size={12} /> Private
            </button>
            <button
              type="button"
              className={`hs-scope-btn${model.privateTo === null ? ' is-on' : ''}`}
              aria-pressed={model.privateTo === null}
              title="The whole room sees this"
              onClick={() => model.setPrivateTo(null)}
            >
              To the room
            </button>
          </span>
        ) : null}
      </div>

      <div className="hs-composer-input">
        {mentionQuery !== null && visibleMentions.length > 0 ? (
          <ul className="hs-mentions" role="listbox" aria-label="Mention a teammate">
            {visibleMentions.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="hs-mention"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    applyMention(agent.id)
                  }}
                >
                  <AvatarMark avatar={agent.avatar} color={agent.color} size={20} />
                  <span className="hs-mention-name">{agent.name}</span>
                  <span className="hs-mention-role">{roleLabel(agent.role)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          ref={area}
          className="hs-composer-area"
          rows={2}
          value={model.body}
          placeholder={
            model.privateTo && spotlightAgent
              ? `Message ${spotlightAgent.name} privately...`
              : 'Say something to the room...'
          }
          aria-label="Message"
          onChange={(event) => {
            const next = event.target.value
            model.setBody(next)
            const caret = event.target.selectionStart
            const match = MENTION_PATTERN.exec(next.slice(0, caret))
            setMentionQuery(match ? match[0].slice(1) : null)
          }}
          onKeyDown={onKeyDown}
        />
        <div className="hs-composer-send">
          <span className="hs-composer-hint" title="Enter sends, Shift+Enter adds a line">
            Enter to send
          </span>
          <Button
            variant="primary"
            onClick={model.send}
            disabled={sendDisabled}
            hint={sendReason ?? 'Sends to the room. Teammates reply out loud as well.'}
          >
            {model.sending ? 'Sending...' : 'Send'}
          </Button>
        </div>
      </div>

      {model.privateTo && spotlightAgent ? (
        <p className="hs-composer-note">
          <LockIcon size={12} /> Private conversation with {spotlightAgent.name}. Any project work
          created from this conversation is shared with the team.
        </p>
      ) : null}
      {!model.privateTo && spotlightAgent ? (
        <p className="hs-composer-note is-room">
          <Badge tone="muted">to the room</Badge> Everyone, including the other teammates, sees this.
        </p>
      ) : null}
    </div>
  )
}

