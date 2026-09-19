import type { JSX } from 'react'
import type { Room } from '../../../shared/types'
import { ChevronIcon, MicOffIcon } from './icons'

interface BottomBarProps {
  room: Room
  agentCount: number
  activityOpen: boolean
  onToggleActivity: () => void
}

export function BottomBar({
  room,
  agentCount,
  activityOpen,
  onToggleActivity
}: BottomBarProps): JSX.Element {
  return (
    <footer className="status">
      <div className="status-meta">
        <span>{room.name}</span>
        <span>
          {agentCount} agent{agentCount === 1 ? '' : 's'} configured
        </span>
        <span className="mono">{shortId(room.id)}</span>
      </div>
      <div className="status-actions">
        <button
          type="button"
          className="voice"
          disabled
          aria-disabled="true"
          aria-describedby="voice-help"
          title="Voice is not connected"
        >
          <MicOffIcon />
          Voice unavailable
        </button>
        <p id="voice-help" className="sr-only">
          Microphone and playback are not implemented yet. This control does not capture audio.
        </p>
        <button
          type="button"
          className="ghost"
          aria-expanded={activityOpen}
          onClick={onToggleActivity}
        >
          Activity
          <ChevronIcon className={activityOpen ? 'chevron is-open' : 'chevron'} />
        </button>
      </div>
    </footer>
  )
}

function shortId(id: string): string {
  return id.slice(0, 8)
}
