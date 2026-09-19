import { useEffect, useRef, type FormEvent, type JSX } from 'react'
import type { Message } from '../../../shared/types'

interface ConversationPanelProps {
  messages: Message[]
  draft: string
  sending: boolean
  error: string | null
  onDraftChange: (value: string) => void
  onSend: () => void
}

export function ConversationPanel({
  messages,
  draft,
  sending,
  error,
  onDraftChange,
  onSend
}: ConversationPanelProps): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  function handleSubmit(event: FormEvent): void {
    event.preventDefault()
    onSend()
  }

  return (
    <aside className="conversation">
      <div className="conversation-head">
        <h2>Room conversation</h2>
        <p>Human messages are saved in this room. Agents are not connected yet.</p>
      </div>
      <div className="transcript" aria-live="polite">
        {messages.length === 0 ? (
          <p className="empty-hint">
            No messages yet. Agent replies will appear here after a text agent is connected.
          </p>
        ) : (
          messages.map((message) => (
            <article key={message.id} className="message">
              <header>
                <span>{message.author.type === 'human' ? 'You' : 'Agent'}</span>
                <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
              </header>
              <p>{message.body}</p>
            </article>
          ))
        )}
        {messages.length > 0 ? (
          <p className="empty-hint sticky-hint">
            Agent replies will appear here after a text agent is connected.
          </p>
        ) : null}
        <div ref={endRef} />
      </div>
      <form className="composer" onSubmit={handleSubmit}>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <label className="field">
          <span className="field-label">Message</span>
          <textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                onSend()
              }
            }}
            rows={3}
            placeholder="Write to the room"
            disabled={sending}
          />
        </label>
        <button type="submit" className="primary" disabled={sending || !draft.trim()}>
          {sending ? 'Sending' : 'Send'}
        </button>
      </form>
    </aside>
  )
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
