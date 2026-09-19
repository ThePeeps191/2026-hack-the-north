import type { JSX } from 'react'
import type { Agent, WorkspaceSelection } from '../../../shared/types'

const TABS: Array<{ id: WorkspaceSelection['tab']; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'browser', label: 'Browser' },
  { id: 'code', label: 'Code' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'files', label: 'Files' }
]

interface WorkspaceStageProps {
  workspace: WorkspaceSelection
  agents: Agent[]
  onChange: (workspace: WorkspaceSelection) => void
}

export function WorkspaceStage({ workspace, agents, onChange }: WorkspaceStageProps): JSX.Element {
  let selectedAgent: Agent | undefined
  if (workspace.focus.type === 'agent') {
    const agentId = workspace.focus.agentId
    selectedAgent = agents.find((agent) => agent.id === agentId)
  }
  const title = selectedAgent ? `${selectedAgent.name}'s workspace` : 'Team view'

  return (
    <main className="stage">
      <div className="stage-toolbar">
        <h2>{title}</h2>
        <div className="tabs" role="tablist" aria-label="Workspace">
          {TABS.map((tab) => {
            const selected = workspace.tab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={selected ? 'tab is-selected' : 'tab'}
                onClick={() => onChange({ ...workspace, tab: tab.id })}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="stage-body" role="tabpanel">
        <WorkspaceEmpty tab={workspace.tab} agent={selectedAgent} agentCount={agents.length} />
      </div>
    </main>
  )
}

function WorkspaceEmpty({
  tab,
  agent,
  agentCount
}: {
  tab: WorkspaceSelection['tab']
  agent: Agent | undefined
  agentCount: number
}): JSX.Element {
  if (tab === 'overview') {
    return (
      <div className="empty">
        <h3>{agent ? agent.name : 'Team'}</h3>
        {agent ? (
          <>
            <p>
              {agent.name} is configured as a {agent.role} agent. Work and speech are both not
              connected; no execution provider is attached yet.
            </p>
            <p>{agent.summary}</p>
          </>
        ) : (
          <p>
            {agentCount === 0
              ? 'This room has no agents yet. Add a preset from the participant strip when you want one configured.'
              : `${agentCount} agent${agentCount === 1 ? '' : 's'} configured in this room. None are connected to a model, voice, or tool runtime.`}
          </p>
        )}
      </div>
    )
  }

  const copy = emptyCopy(tab, agent?.name)
  return (
    <div className="empty">
      <h3>{copy.title}</h3>
      <p>{copy.body}</p>
    </div>
  )
}

function emptyCopy(
  tab: Exclude<WorkspaceSelection['tab'], 'overview'>,
  agentName: string | undefined
): { title: string; body: string } {
  const who = agentName ?? 'this room'
  if (tab === 'browser') {
    return {
      title: 'Browser',
      body: `A live browser session for ${who} will appear here after that integration is connected. Nothing is being browsed right now.`
    }
  }
  if (tab === 'code') {
    return {
      title: 'Code',
      body: `The coding workspace for ${who} will open here after a project folder and editor session are connected. This is not a fake editor.`
    }
  }
  if (tab === 'terminal') {
    return {
      title: 'Terminal',
      body: `A terminal for ${who} will appear here after a runtime is connected. There are no simulated logs.`
    }
  }
  return {
    title: 'Files',
    body: 'Project files will list here after a user-selected coding workspace is connected. That folder is separate from Huddle application storage.'
  }
}
