import { useMemo, useRef, type JSX } from 'react'
import type {
  Agent,
  CallState,
  ContextRef,
  Room,
  ShareSurface,
  WorkspaceRecord
} from '../../shared/types'
import { CallScreen } from './call/index'
import { BrowserSurface } from './share/browser/index'
import { CodeSurface } from './share/code/index'
import type { SurfaceOwner, SurfaceProps } from './share/contract'
import { FilesSurface } from './share/files/index'
import { TerminalSurface } from './share/terminal/index'
import { createActions } from './state/actions'
import { useHuddle } from './useHuddle'

/**
 * The integration lead's shell.
 *
 * It owns everything the call UI is not allowed to own: reading the backend
 * snapshot, building the actions, and deciding which real workspace surface a
 * stage shows. The CallScreen renders what it is given.
 */
const DISCONNECTED: CallState = {
  roomId: null,
  connection: 'disconnected',
  micMuted: false,
  deafened: false,
  micLevel: 0,
  listening: false,
  speakingAgentId: null,
  queuedAgentIds: [],
  error: null
}

export default function App(): JSX.Element {
  const hub = useHuddle()
  const { snapshot, loading, loadError } = hub

  const room: Room | null = useMemo(() => {
    if (!snapshot) return null
    return (
      snapshot.rooms.find((item) => item.id === snapshot.selectedRoomId) ??
      snapshot.rooms[0] ??
      null
    )
  }, [snapshot])

  const roomId = room?.id ?? ''

  // Mic and deafen toggles must read the current call state, not a stale
  // closure, so the actions read it through a ref.
  const callRef = useRef<CallState | null>(snapshot?.call ?? null)
  callRef.current = snapshot?.call ?? null

  const actions = useMemo(
    () => createActions({ roomId, getCall: () => callRef.current ?? DISCONNECTED, setError: hub.setError }),
    [roomId, hub.setError]
  )

  if (loading) {
    return (
      <div className="boot">
        <p>Waking up Huddle…</p>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="boot">
        <h1>Huddle could not start</h1>
        <p>{loadError}</p>
        <p className="boot-hint">
          The room state file lives in the Huddle data folder. Restart Huddle after fixing the
          problem; your previous file is never deleted.
        </p>
      </div>
    )
  }

  if (!snapshot || !room) {
    return (
      <div className="boot">
        <h1>No room yet</h1>
        <p>Huddle could not find a room to open.</p>
      </div>
    )
  }

  const roomScoped = <T extends { roomId: string }>(items: T[]): T[] =>
    items.filter((item) => item.roomId === room.id)

  const agents = roomScoped(snapshot.agents)
  const agentById = new Map(agents.map((agent) => [agent.id, agent]))
  const workspaces = roomScoped(snapshot.workspaces)

  /** Which real workspace a surface shows, and who owns it. */
  const workspaceFor = (owner: SurfaceOwner): WorkspaceRecord | null => {
    if (owner.kind === 'team') {
      return workspaces.find((item) => item.kind === 'team') ?? null
    }
    return workspaces.find((item) => item.agentId === owner.agentId) ?? null
  }

  const openRef = (ref: ContextRef): void => {
    const surface: ShareSurface =
      ref.kind === 'screenshot'
        ? 'browser'
        : ref.kind === 'job'
          ? 'terminal'
          : ref.kind === 'artifact'
            ? 'files'
            : 'code'
    const agentId = ref.kind === 'file' ? ref.agentId : undefined
    void actions.showShare(
      agentId && agentById.has(agentId) ? { kind: 'agent', agentId } : { kind: 'team' },
      surface
    )
  }

  const renderSurface = (args: {
    surface: ShareSurface
    owner: SurfaceOwner
    workspace: WorkspaceRecord | null
    agent: Agent | null
    onAttachRef: (ref: ContextRef) => void
  }): JSX.Element => {
    const props: SurfaceProps = {
      room,
      owner: args.owner,
      workspace: args.workspace,
      agent: args.agent,
      editable: args.owner.kind === 'team',
      onAttachRef: args.onAttachRef,
      onOpenRef: openRef
    }

    switch (args.surface) {
      case 'code':
        return <CodeSurface {...props} />
      case 'terminal':
        return <TerminalSurface {...props} />
      case 'files':
        return <FilesSurface {...props} />
      case 'browser':
        return <BrowserSurface {...props} />
      default:
        return <CodeSurface {...props} />
    }
  }

  return (
    <CallScreen
      snapshot={snapshot}
      room={room}
      rooms={snapshot.rooms}
      agents={agents}
      messages={roomScoped(snapshot.messages)}
      tasks={roomScoped(snapshot.tasks)}
      decisions={roomScoped(snapshot.decisions)}
      jobs={roomScoped(snapshot.jobs)}
      workspaces={workspaces}
      browserSessions={roomScoped(snapshot.browserSessions)}
      artifacts={roomScoped(snapshot.artifacts)}
      integrations={roomScoped(snapshot.integrations)}
      capabilities={snapshot.capabilities}
      resumable={snapshot.resumable}
      settings={snapshot.settings}
      call={snapshot.call}
      human={hub.human}
      liveTranscript={hub.liveTranscript}
      speaking={hub.speaking}
      notices={hub.notices}
      error={hub.error ?? snapshot.call.error}
      actions={actions}
      renderSurface={renderSurface}
    />
  )
}
