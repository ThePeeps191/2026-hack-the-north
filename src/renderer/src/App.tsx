import { useMemo, useState, type JSX } from 'react'
import type {
  AgentPresetId,
  UpdateRoomInput,
  WorkspaceFocus,
  WorkspaceSelection
} from '../../shared/types'
import { ActivityPanel } from './components/ActivityPanel'
import { BottomBar } from './components/BottomBar'
import { ConversationPanel } from './components/ConversationPanel'
import { ParticipantStrip } from './components/ParticipantStrip'
import { RoomHeader } from './components/RoomHeader'
import { Sidebar } from './components/Sidebar'
import { WorkspaceStage } from './components/WorkspaceStage'
import { useHuddle } from './useHuddle'

export default function App(): JSX.Element {
  const { snapshot, loading, loadError } = useHuddle()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [creating, setCreating] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)

  const selectedRoom = useMemo(() => {
    if (!snapshot) {
      return null
    }
    return snapshot.rooms.find((room) => room.id === snapshot.selectedRoomId) ?? snapshot.rooms[0] ?? null
  }, [snapshot])

  const roomAgents = useMemo(() => {
    if (!snapshot || !selectedRoom) {
      return []
    }
    return snapshot.agents.filter((agent) => agent.roomId === selectedRoom.id)
  }, [snapshot, selectedRoom])

  const roomMessages = useMemo(() => {
    if (!snapshot || !selectedRoom) {
      return []
    }
    return snapshot.messages.filter((message) => message.roomId === selectedRoom.id)
  }, [snapshot, selectedRoom])

  if (loading) {
    return (
      <div className="boot">
        <p>Loading Huddle</p>
      </div>
    )
  }

  if (loadError || !snapshot || !selectedRoom) {
    return (
      <div className="boot">
        <p>{loadError ?? 'Huddle could not load a room.'}</p>
      </div>
    )
  }

  const room = selectedRoom
  const draft = drafts[room.id] ?? ''
  const workspace = sanitizeWorkspace(room.workspace, roomAgents)

  async function run(action: () => Promise<void>): Promise<void> {
    try {
      await action()
      setActionError(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Something went wrong.')
    }
  }

  async function handleCreateRoom(): Promise<void> {
    setCreating(true)
    try {
      await run(async () => {
        await window.huddle.createRoom()
      })
    } finally {
      setCreating(false)
    }
  }

  async function handleSelectRoom(roomId: string): Promise<void> {
    if (roomId === room.id) {
      return
    }
    await run(async () => {
      await window.huddle.selectRoom(roomId)
    })
  }

  async function handleSaveRoom(patch: { name?: string; description?: string }): Promise<void> {
    await run(async () => {
      await window.huddle.updateRoom({ id: room.id, ...patch })
    })
  }

  async function handleWorkspace(next: WorkspaceSelection): Promise<void> {
    const input: UpdateRoomInput = { id: room.id, workspace: next }
    await run(async () => {
      await window.huddle.updateRoom(input)
    })
  }

  async function handleFocus(focus: WorkspaceFocus): Promise<void> {
    await handleWorkspace({ ...workspace, focus })
  }

  async function handleAddAgent(presetId: AgentPresetId): Promise<void> {
    await run(async () => {
      await window.huddle.addAgent({ roomId: room.id, presetId })
    })
  }

  async function handleSend(): Promise<void> {
    const body = draft.trim()
    if (!body || sending) {
      return
    }
    setSending(true)
    try {
      await window.huddle.sendMessage({
        roomId: room.id,
        body,
        clientRequestId: crypto.randomUUID()
      })
      setDrafts((current) => ({ ...current, [room.id]: '' }))
      setActionError(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not send message.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="shell">
      <Sidebar
        rooms={snapshot.rooms}
        selectedRoomId={room.id}
        onSelect={(roomId) => void handleSelectRoom(roomId)}
        onCreate={() => void handleCreateRoom()}
        creating={creating}
      />
      <RoomHeader
        room={room}
        recovery={snapshot.recovery}
        onSave={handleSaveRoom}
      />
      <ParticipantStrip
        agents={roomAgents}
        focus={workspace.focus}
        onSelectFocus={(focus) => void handleFocus(focus)}
        onAddAgent={handleAddAgent}
      />
      <WorkspaceStage
        workspace={workspace}
        agents={roomAgents}
        onChange={(next) => void handleWorkspace(next)}
      />
      <ConversationPanel
        messages={roomMessages}
        draft={draft}
        sending={sending}
        error={actionError}
        onDraftChange={(value) =>
          setDrafts((current) => ({ ...current, [room.id]: value }))
        }
        onSend={() => void handleSend()}
      />
      <ActivityPanel open={activityOpen} events={snapshot.events} />
      <BottomBar
        room={room}
        agentCount={roomAgents.length}
        activityOpen={activityOpen}
        onToggleActivity={() => setActivityOpen((value) => !value)}
      />
    </div>
  )
}

function sanitizeWorkspace(
  workspace: WorkspaceSelection,
  agents: { id: string }[]
): WorkspaceSelection {
  if (workspace.focus.type === 'agent') {
    const agentId = workspace.focus.agentId
    if (!agents.some((agent) => agent.id === agentId)) {
      return { ...workspace, focus: { type: 'team' } }
    }
  }
  return workspace
}
