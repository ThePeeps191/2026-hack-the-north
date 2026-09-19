import { useEffect, useState, type JSX } from 'react'
import type { RecoveryInfo, Room } from '../../../shared/types'

interface RoomHeaderProps {
  room: Room
  recovery?: RecoveryInfo
  onSave: (patch: { name?: string; description?: string }) => Promise<void>
}

export function RoomHeader({ room, recovery, onSave }: RoomHeaderProps): JSX.Element {
  const [name, setName] = useState(room.name)
  const [description, setDescription] = useState(room.description)

  useEffect(() => {
    setName(room.name)
    setDescription(room.description)
  }, [room.id, room.name, room.description])

  async function commitName(): Promise<void> {
    const next = name.trim()
    if (!next || next === room.name) {
      setName(room.name)
      return
    }
    await onSave({ name: next })
  }

  async function commitDescription(): Promise<void> {
    if (description.trim() === room.description) {
      setDescription(room.description)
      return
    }
    await onSave({ description: description.trim() })
  }

  return (
    <header className="room-header">
      {recovery ? (
        <p className="recovery" role="status">
          {recovery.message} Backup: {recovery.backupPath}
        </p>
      ) : null}
      <label className="field">
        <span className="field-label">Room name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => void commitName()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
          }}
          maxLength={80}
        />
      </label>
      <label className="field">
        <span className="field-label">Project description</span>
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => void commitDescription()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
          }}
          placeholder="What is this room for?"
          maxLength={280}
        />
      </label>
    </header>
  )
}
