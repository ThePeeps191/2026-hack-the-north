import { type JSX } from 'react'
import type {
  Agent,
  ContextRef,
  IntegrationAttempt,
  Room,
  ShareSurface,
  WorkspaceRecord
} from '../../../shared/types'
import { SHARE_SURFACES } from '../../../shared/types'
import type { CallScreenProps, SpeakingState } from '../state/view-model'
import { AvatarMark } from './avatars'
import { findAgent, latestIntegration, ownerLabel, basename } from './derive'
import {
  integrationStatus,
  roleLabel,
  shortRevision,
  surfaceLabel,
  workStateLabel,
  workStateTone
} from './format'
import {
  BranchIcon,
  CheckIcon,
  CodeIcon,
  ExternalIcon,
  FileIcon,
  GlobeIcon,
  GridIcon,
  MonitorIcon,
  TerminalIcon
} from './icons'
import { Badge, Button, Empty, IconButton } from './ui'

/**
 * The share frame.
 *
 * The call UI owns the frame — ownership label, branch, revision and the
 * verified badge — and the integration lead's `renderSurface` supplies the body.
 * Nothing about a workspace is claimed here that is not in the record: an
 * unverified branch says so, and the verified claim names the whole room's
 * latest integration attempt rather than this branch's.
 */

const SURFACE_ICONS: Record<ShareSurface, JSX.Element> = {
  browser: <GlobeIcon size={15} />,
  code: <CodeIcon size={15} />,
  terminal: <TerminalIcon size={15} />,
  files: <FileIcon size={15} />
}

export interface ShareFrameProps {
  room: Room
  agents: Agent[]
  owner: { kind: 'team' } | { kind: 'agent'; agentId: string }
  surface: ShareSurface
  workspace: WorkspaceRecord | null
  integrations: IntegrationAttempt[]
  speaking: Record<string, SpeakingState>
  queuedAgentIds: string[]
  showFilmstrip: boolean
  onSelectSurface: (surface: ShareSurface) => void
  onSelectOwner: (owner: { kind: 'team' } | { kind: 'agent'; agentId: string }) => void
  onOpenSpotlight: (agentId: string) => void
  onShowGallery: () => void
  onRunIntegration: () => void
  onChooseProject: () => void
  onUseDemoProject: () => void
  onReveal: (path: string) => void
  renderSurface: CallScreenProps['renderSurface']
  onAttachRef: (ref: ContextRef) => void
}

export function ShareFrame({
  room,
  agents,
  owner,
  surface,
  workspace,
  integrations,
  speaking,
  queuedAgentIds,
  showFilmstrip,
  onSelectSurface,
  onSelectOwner,
  onOpenSpotlight,
  onShowGallery,
  onRunIntegration,
  onChooseProject,
  onUseDemoProject,
  onReveal,
  renderSurface,
  onAttachRef
}: ShareFrameProps): JSX.Element {
  const agent = owner.kind === 'agent' ? findAgent(agents, owner.agentId) : null
  const latest = latestIntegration(integrations)
  const attempt = integrationStatus(latest ? latest.status : 'failed')
  const integrationRunning = latest?.status === 'running'
  const checksPassed = latest ? latest.checks.filter((check) => check.status === 'pass').length : 0
  const checksFailed = latest ? latest.checks.filter((check) => check.status === 'fail').length : 0
  const verified = workspace?.lastVerifiedRevision ?? null

  return (
    <section className="hs-share" aria-label={`${ownerLabel(owner, agents)} on the stage`}>
      <header className="hs-share-head">
        <div className="hs-share-ident">
          <div className="hs-share-title">
            <span className="hs-share-owner">
              {owner.kind === 'team' ? (
                <AvatarMark avatar="huddle" color="#f0a868" size={22} />
              ) : agent ? (
                <AvatarMark avatar={agent.avatar} color={agent.color} size={22} />
              ) : null}
              <span className="hs-share-name">{ownerLabel(owner, agents)}</span>
            </span>
            {agent ? <Badge tone="muted">{roleLabel(agent.role)}</Badge> : null}
            {owner.kind === 'agent' && agent ? (
              <Badge tone={workStateTone(agent.workState)}>{workStateLabel(agent.workState)}</Badge>
            ) : null}
            {agent && !agent.connected ? <Badge tone="quiet">Offline</Badge> : null}
          </div>

          <div className="hs-share-meta">
            {workspace ? (
              <>
                <span className="hs-share-branch" title={workspace.branch ?? 'No branch recorded'}>
                  <BranchIcon size={13} />
                  {workspace.branch ?? 'no branch'}
                </span>
                {workspace.isWorktree ? <Badge tone="muted">worktree</Badge> : null}
                {workspace.devPort !== null ? (
                  <Badge tone="muted">port {workspace.devPort}</Badge>
                ) : null}
                {verified ? (
                  <Badge
                    tone="done"
                    title={`Last revision verified in this workspace: ${verified}`}
                  >
                    <CheckIcon size={12} /> verified @{shortRevision(verified)}
                  </Badge>
                ) : (
                  <Badge tone="wait" title="No verified revision is recorded for this workspace">
                    not verified
                  </Badge>
                )}
              </>
            ) : (
              <Badge tone="wait">no workspace yet</Badge>
            )}
            <span className="hs-share-integration" title={latest?.detail ?? 'No integration has run in this room yet'}>
              {latest ? (
                <>
                  <Badge tone={attempt.tone}>
                    Team integration · {attempt.label}
                    {latest.revision ? ` @${shortRevision(latest.revision)}` : ''}
                  </Badge>
                  {latest.checks.length > 0 ? (
                    <span className="hs-share-checks">
                      {checksPassed} pass
                      {checksFailed > 0 ? ` · ${checksFailed} fail` : ''}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="hs-share-checks">No integration run yet</span>
              )}
            </span>
          </div>
        </div>

        <div className="hs-share-actions">
          {owner.kind === 'agent' && agent ? (
            <Button
              variant="quiet"
              hint={`Opens a one-on-one view with ${agent.name}`}
              onClick={() => onOpenSpotlight(agent.id)}
            >
              One-on-one
            </Button>
          ) : null}
          {workspace ? (
            <Button
              variant="ghost"
              hint="Opens this workspace folder in the file manager"
              onClick={() => onReveal(workspace.rootPath)}
            >
              <span className="hs-btn-inner">
                <ExternalIcon size={14} /> Reveal
              </span>
            </Button>
          ) : null}
          {owner.kind === 'team' ? (
            <Button
              variant="primary"
              disabled={integrationRunning || !workspace}
              hint={
                integrationRunning
                  ? 'An integration attempt is already running'
                  : !workspace
                    ? 'Bind a project before integrating teammate work'
                    : 'Applies teammate branches to the team workspace and runs its checks'
              }
              onClick={onRunIntegration}
            >
              {integrationRunning ? 'Integrating…' : 'Run integration'}
            </Button>
          ) : null}
          <IconButton
            label="Back to gallery"
            hint="Returns the stage to participant tiles"
            onClick={onShowGallery}
          >
            <GridIcon />
          </IconButton>
        </div>
      </header>

      {room.project === null ? (
        <div className="hs-share-noproject" role="note">
          <p>
            This room has no project bound, so every surface below has nothing real to show.
          </p>
          <span className="hs-share-noproject-actions">
            <Button variant="primary" onClick={onChooseProject} hint="Bind an existing folder to this room">
              Choose folder
            </Button>
            <Button variant="quiet" onClick={onUseDemoProject} hint="Copy the bundled demo project">
              Use demo project
            </Button>
          </span>
        </div>
      ) : null}

      {showFilmstrip ? (
        <Filmstrip
          agents={agents}
          owner={owner}
          speaking={speaking}
          queuedAgentIds={queuedAgentIds}
          onSelectOwner={onSelectOwner}
        />
      ) : null}

      <div className="hs-share-tabs" role="tablist" aria-label="Workspace surface">
        {SHARE_SURFACES.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            className={`hs-sharetab${item === surface ? ' is-selected' : ''}`}
            aria-selected={item === surface}
            tabIndex={item === surface ? 0 : -1}
            onClick={() => onSelectSurface(item)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
              const index = SHARE_SURFACES.indexOf(item)
              const next =
                event.key === 'ArrowRight'
                  ? SHARE_SURFACES[(index + 1) % SHARE_SURFACES.length]
                  : SHARE_SURFACES[(index - 1 + SHARE_SURFACES.length) % SHARE_SURFACES.length]
              if (next) onSelectSurface(next)
            }}
          >
            {SURFACE_ICONS[item]}
            <span className="hs-sharetab-label">{surfaceLabel(item)}</span>
          </button>
        ))}
        <span className="hs-share-tabs-note" title={workspace?.rootPath ?? room.project?.rootPath ?? ''}>
          <MonitorIcon size={13} /> {workspace ? basename(workspace.rootPath) : 'no workspace'}
        </span>
      </div>

      <div className="hs-share-body">
        {workspace === null ? (
          <Empty
            title="No workspace for this owner yet"
            detail={
              room.project === null
                ? 'Bind a project to this room to create real workspaces.'
                : 'This workspace is created when the teammate starts work on a task.'
            }
          />
        ) : null}
        {renderSurface({ surface, owner, workspace, agent, onAttachRef })}
      </div>
    </section>
  )
}

export interface FilmstripProps {
  agents: Agent[]
  owner: { kind: 'team' } | { kind: 'agent'; agentId: string }
  speaking: Record<string, SpeakingState>
  queuedAgentIds: string[]
  onSelectOwner: (owner: { kind: 'team' } | { kind: 'agent'; agentId: string }) => void
}

export function Filmstrip({
  agents,
  owner,
  speaking,
  queuedAgentIds,
  onSelectOwner
}: FilmstripProps): JSX.Element {
  const selectedAgentId = owner.kind === 'agent' ? owner.agentId : null
  return (
    <div className="hs-filmstrip" role="group" aria-label="Switch the shared workspace">
      <button
        type="button"
        className={`hs-film${owner.kind === 'team' ? ' is-selected' : ''}`}
        aria-pressed={owner.kind === 'team'}
        onClick={() => onSelectOwner({ kind: 'team' })}
        title="The shared integration workspace"
      >
        <AvatarMark avatar="huddle" color="#f0a868" size={20} />
        <span>Team</span>
      </button>
      {agents.map((agent) => {
        const live = speaking[agent.id] ?? null
        const queued = !live && queuedAgentIds.includes(agent.id)
        return (
          <button
            key={agent.id}
            type="button"
            className={`hs-film${selectedAgentId === agent.id ? ' is-selected' : ''}${
              live ? ' is-speaking' : ''
            }`}
            aria-pressed={selectedAgentId === agent.id}
            onClick={() => onSelectOwner({ kind: 'agent', agentId: agent.id })}
            title={`${agent.name} · ${workStateLabel(agent.workState)}${queued ? ' · waiting to speak' : ''}`}
          >
            <AvatarMark
              avatar={agent.avatar}
              color={agent.color}
              size={20}
              dim={workStateTone(agent.workState) === 'quiet'}
            />
            <span>{agent.name}</span>
            {live ? <span className="hs-bars is-sm" aria-hidden="true" /> : null}
          </button>
        )
      })}
    </div>
  )
}
