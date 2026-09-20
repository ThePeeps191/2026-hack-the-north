import { useState, type JSX } from 'react'
import { MAX_AGENTS_PER_ROOM } from '../../../shared/types'
import { Button } from './ui'

export interface CreateRoomDialogProps {
  onCreate: (name: string, agentCount: number) => void
  onCancel?: () => void
  busy?: boolean
}

export function CreateRoomDialog({ onCreate, onCancel, busy }: CreateRoomDialogProps): JSX.Element {
  const [name, setName] = useState('')
  const [count, setCount] = useState(3)
  return (
    <form
      className="hs-create-room"
      onSubmit={(event) => {
        event.preventDefault()
        onCreate(name.trim(), count)
      }}
    >
      <h2>New room</h2>
      <p>Pick how many teammates join. They start with names; they take on titles once work begins.</p>
      <label className="hs-field">
        <span className="hs-field-label">Room name</span>
        <input
          className="hs-input"
          value={name}
          maxLength={60}
          placeholder="Optional"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <fieldset className="hs-create-room-count">
        <legend>Teammates</legend>
        <div className="hs-create-room-picks">
          {Array.from({ length: MAX_AGENTS_PER_ROOM }, (_, index) => index + 1).map((value) => (
            <button
              key={value}
              type="button"
              className={value === count ? 'is-selected' : undefined}
              aria-pressed={value === count}
              onClick={() => setCount(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="hs-create-room-actions">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          variant="primary"
          disabled={busy}
          type="submit"
          onClick={() => undefined}
        >
          {busy ? 'Creating...' : `Create with ${count} teammate${count === 1 ? '' : 's'}`}
        </Button>
      </div>
    </form>
  )
}
