import type { JSX } from 'react'
import type { RuntimeEvent } from '../../../shared/types'

interface ActivityPanelProps {
  open: boolean
  events: RuntimeEvent[]
}

export function ActivityPanel({ open, events }: ActivityPanelProps): JSX.Element | null {
  if (!open) {
    return null
  }

  const recent = [...events].reverse()

  return (
    <section className="activity" aria-label="Developer activity">
      <h2>Activity</h2>
      {recent.length === 0 ? (
        <p className="empty-hint">No events yet.</p>
      ) : (
        <ol>
          {recent.map((event) => (
            <li key={event.id}>
              <span className="seq">{event.seq}</span>
              <span className="type">{event.type}</span>
              <time dateTime={event.createdAt}>{formatStamp(event.createdAt)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function formatStamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
