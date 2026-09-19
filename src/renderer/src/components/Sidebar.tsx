import type { JSX } from 'react'
import type { Room } from '../../../shared/types'
import { PlusIcon } from './icons'

interface SidebarProps {
  rooms: Room[]
  selectedRoomId: string | null
  onSelect: (roomId: string) => void
  onCreate: () => void
  creating: boolean
}

export function Sidebar({
  rooms,
  selectedRoomId,
  onSelect,
  onCreate,
  creating
}: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
      <div className="brand">
        <p className="brand-mark">Huddle</p>
        <p className="brand-sub">Desktop room</p>
      </div>
      <div className="sidebar-heading">
        <span>Rooms</span>
        <button
          type="button"
          className="icon-button"
          onClick={onCreate}
          disabled={creating}
          aria-label="Create room"
        >
          <PlusIcon />
        </button>
      </div>
      <ul className="room-list" aria-label="Rooms">
        {rooms.map((room) => {
          const selected = room.id === selectedRoomId
          return (
            <li key={room.id}>
              <button
                type="button"
                className={selected ? 'room-item is-selected' : 'room-item'}
                onClick={() => onSelect(room.id)}
                aria-current={selected ? 'page' : undefined}
              >
                <span className="room-item-name">{room.name}</span>
                <span className="room-item-desc">
                  {room.description.trim() || 'No description'}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
