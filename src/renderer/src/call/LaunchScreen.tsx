import { useState, type JSX } from 'react'
import type { Room } from '../../../shared/types'
import { CreateRoomDialog } from './CreateRoomDialog'

export interface LaunchScreenProps {
  rooms: Room[]
  onCreate: (name: string, agentCount: number) => Promise<void> | void
  onOpen: (roomId: string) => void
}

export function LaunchScreen({ rooms, onCreate, onOpen }: LaunchScreenProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <div className="hs-launch">
      <div className="hs-launch-card">
        <p className="hs-launch-kicker">Huddle</p>
        <h1>Start a room</h1>
        <p>A live voice meeting with teammates who do real work. Nothing is running until you create a room.</p>
        <CreateRoomDialog
          busy={busy}
          onCreate={(name, agentCount) => {
            setBusy(true)
            void Promise.resolve(onCreate(name, agentCount)).finally(() => setBusy(false))
          }}
        />
        {rooms.length > 0 ? (
          <section className="hs-launch-saved" aria-label="Saved rooms">
            <h2>Saved rooms</h2>
            <ul>
              {rooms.map((room) => (
                <li key={room.id}>
                  <button type="button" onClick={() => onOpen(room.id)}>
                    <span>{room.name}</span>
                    <span>{room.goal || 'No goal yet'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  )
}
