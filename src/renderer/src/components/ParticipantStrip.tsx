import { useEffect, useRef, useState, type JSX } from 'react'
import { AGENT_PRESETS } from '../../../shared/presets'
import { MAX_AGENTS_PER_ROOM, type Agent, type WorkspaceFocus } from '../../../shared/types'
import { PlusIcon } from './icons'

interface ParticipantStripProps {
  agents: Agent[]
  focus: WorkspaceFocus
  onSelectFocus: (focus: WorkspaceFocus) => void
  onAddAgent: (presetId: Agent['presetId']) => Promise<void>
}

export function ParticipantStrip({
  agents,
  focus,
  onSelectFocus,
  onAddAgent
}: ParticipantStripProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const atCap = agents.length >= MAX_AGENTS_PER_ROOM

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  return (
    <section className="participants" aria-label="Participants">
      <button
        type="button"
        className={focus.type === 'team' ? 'person is-selected' : 'person'}
        onClick={() => onSelectFocus({ type: 'team' })}
      >
        <span className="person-name">You</span>
        <span className="person-meta">Human</span>
      </button>
      {agents.map((agent) => {
        const selected = focus.type === 'agent' && focus.agentId === agent.id
        return (
          <button
            key={agent.id}
            type="button"
            className={selected ? 'person is-selected' : 'person'}
            onClick={() => onSelectFocus({ type: 'agent', agentId: agent.id })}
          >
            <span className="person-name">{agent.name}</span>
            <span className="person-meta">{labelRole(agent.role)} · not connected</span>
          </button>
        )
      })}
      <div className="add-agent" ref={menuRef}>
        <button
          type="button"
          className="person add"
          onClick={() => setOpen((value) => !value)}
          disabled={atCap}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <PlusIcon />
          <span>{atCap ? 'Agent limit reached' : 'Add agent'}</span>
        </button>
        {open && !atCap ? (
          <ul className="preset-menu" role="menu" aria-label="Agent presets">
            {AGENT_PRESETS.map((preset) => (
              <li key={preset.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false)
                    void onAddAgent(preset.id)
                  }}
                >
                  <strong>{preset.name}</strong>
                  <span>{preset.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  )
}

function labelRole(role: Agent['role']): string {
  if (role === 'frontend') return 'Frontend'
  if (role === 'systems') return 'Systems'
  return 'QA'
}
