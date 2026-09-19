import type { Agent, ContextRef, Room, WorkspaceRecord } from '../../../shared/types.ts'

/**
 * Contract between the integration lead and the shared-attention surfaces
 * (code, terminal, files, browser).
 *
 * A surface renders the *real* resources of one owner: an agent's worktree or
 * the Team integration workspace. It never fabricates activity, and it never
 * talks to `window.huddle` for state — it reads what it is given and calls back.
 *
 * Owned by the integration lead. Specialists import it and do not edit it.
 */

export type SurfaceOwner = { kind: 'team' } | { kind: 'agent'; agentId: string }

export interface SurfaceProps {
  /** Room currently on the stage. */
  room: Room
  /** Whose workspace this is. */
  owner: SurfaceOwner
  /** Workspace backing this surface; null when the room has no project bound. */
  workspace: WorkspaceRecord | null
  /** The agent whose workspace is shown, when the owner is an agent. */
  agent: Agent | null
  /** True when the human may run things here (Team workspace). */
  editable: boolean
  /** A clicked reference, including a token so clicking it again refocuses it. */
  openReference?: { ref: ContextRef; token: number }
  /** Attach a reference to the composer: code span, screenshot region, job line. */
  onAttachRef: (ref: ContextRef) => void
  /** Follow a reference to wherever it lives. */
  onOpenRef: (ref: ContextRef) => void
}

export type SurfaceComponent = (props: SurfaceProps) => React.ReactNode

/** Shown by every surface when the room has no project bound yet. */
export const NO_PROJECT_DETAIL =
  'No project is bound to this room yet. Bind a folder or create the demo project to give the team something real to work on.'
