import type { JSX } from 'react'
import type {
  Agent,
  Artifact,
  ContextRef,
  IntegrationAttempt,
  JobRecord,
  ResumableItem
} from '../../../shared/types'
import type { NoticeItem } from '../state/view-model'
import { findAgent } from './derive'
import {
  artifactKindLabel,
  formatBytes,
  formatDuration,
  formatRelative,
  integrationStatus,
  jobStatus,
  shortRevision,
  truncate
} from './format'
import { CheckIcon, CloseIcon, InfoIcon, AlertIcon } from './icons'
import { Badge, Button, SectionLabel } from './ui'

/**
 * Work evidence: integration attempts, real processes, artifacts, interrupted
 * operations and backend notices. Every number here is counted from props.
 */

export interface WorkPanelProps {
  agents: Agent[]
  artifacts: Artifact[]
  jobs: JobRecord[]
  integrations: IntegrationAttempt[]
  resumable: ResumableItem[]
  notices: NoticeItem[]
  now: number
  onRevealPath: (path: string) => void
  onCancelJob: (jobId: string) => void
  onResumeItem: (itemId: string) => void
  onDismissResumable: (itemId: string) => void
  onRunIntegration: () => void
  onAttachRef: (ref: ContextRef) => void
}

export function WorkPanel({
  agents,
  artifacts,
  jobs,
  integrations,
  resumable,
  notices,
  now,
  onRevealPath,
  onCancelJob,
  onResumeItem,
  onDismissResumable,
  onRunIntegration,
  onAttachRef
}: WorkPanelProps): JSX.Element {
  const attempts = [...integrations].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const running = attempts.some((attempt) => attempt.status === 'running')
  const liveJobs = jobs.filter((job) => job.status === 'running' || job.status === 'starting')
  const pastJobs = jobs.filter((job) => job.status !== 'running' && job.status !== 'starting')
  const orderedJobs = [...liveJobs, ...pastJobs]

  return (
    <div className="hs-work">
      <section className="hs-work-section" aria-label="Integration attempts">
        <SectionLabel
          aside={
            <Button
              variant="quiet"
              disabled={running}
              hint={
                running
                  ? 'An integration attempt is running right now'
                  : 'Applies teammate branches to the team workspace and runs its checks'
              }
              onClick={onRunIntegration}
            >
              {running ? 'Integrating…' : 'Run integration'}
            </Button>
          }
        >
          Integration ({integrations.length})
        </SectionLabel>
        {attempts.length === 0 ? (
          <p className="hs-work-empty">No integration has run in this room yet.</p>
        ) : (
          <ul className="hs-attempts">
            {attempts.slice(0, 4).map((attempt) => {
              const status = integrationStatus(attempt.status)
              const passed = attempt.checks.filter((check) => check.status === 'pass').length
              const failed = attempt.checks.filter((check) => check.status === 'fail').length
              const skipped = attempt.checks.filter((check) => check.status === 'skipped').length
              const ranBy = findAgent(agents, attempt.agentId)
              return (
                <li key={attempt.id} className="hs-attempt">
                  <header className="hs-attempt-head">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span className="hs-attempt-branch" title={attempt.targetBranch}>
                      → {attempt.targetBranch}
                    </span>
                    {attempt.revision ? (
                      <span className="hs-attempt-rev" title={attempt.revision}>
                        @{shortRevision(attempt.revision)}
                      </span>
                    ) : (
                      <span className="hs-attempt-rev is-unknown">no revision</span>
                    )}
                    <span className="hs-attempt-time" title={attempt.detail}>
                      {formatRelative(attempt.startedAt, now)}
                    </span>
                  </header>
                  <p className="hs-attempt-detail" title={attempt.detail}>
                    {attempt.detail}
                  </p>
                  <p className="hs-attempt-sources">
                    {attempt.sources.map((source) => (
                      <span
                        key={`${attempt.id}-${source.agentId}`}
                        className="hs-chip is-static"
                        title={`${source.branch} @ ${source.commit}`}
                      >
                        {findAgent(agents, source.agentId)?.name ?? 'teammate'} · {source.branch}
                      </span>
                    ))}
                    {ranBy ? <span className="hs-attempt-by">run by {ranBy.name}</span> : null}
                  </p>
                  {attempt.checks.length > 0 ? (
                    <details className="hs-attempt-checks">
                      <summary>
                        {passed} passed
                        {failed > 0 ? ` · ${failed} failed` : ''}
                        {skipped > 0 ? ` · ${skipped} skipped` : ''}
                      </summary>
                      <ul>
                        {attempt.checks.map((check) => (
                          <li key={`${attempt.id}-${check.name}`}>
                            <span className={`hs-check hs-check--${check.status}`}>
                              {check.status === 'pass' ? (
                                <CheckIcon size={12} />
                              ) : check.status === 'fail' ? (
                                <CloseIcon size={12} />
                              ) : (
                                <InfoIcon size={12} />
                              )}
                              {check.name}
                            </span>
                            <span className="hs-check-command" title={check.command}>
                              {truncate(check.command, 40)}
                            </span>
                            <span className="hs-check-time">
                              {check.exitCode === null ? '' : `exit ${check.exitCode} · `}
                              {formatDuration(check.durationMs)}
                            </span>
                            {check.output ? (
                              <details className="hs-check-output">
                                <summary>output</summary>
                                <pre>{check.output}</pre>
                              </details>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {attempt.conflicts.length > 0 ? (
                    <details className="hs-attempt-conflicts">
                      <summary>{attempt.conflicts.length} conflicting files</summary>
                      <ul>
                        {attempt.conflicts.map((file) => (
                          <li key={`${attempt.id}-${file}`} className="hs-mono" title={file}>
                            {file}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  <span className="hs-attempt-decision" title="Decision revision in force when this ran">
                    decision rev {attempt.decisionRevision}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="hs-work-section" aria-label="Processes">
        <SectionLabel>Processes ({orderedJobs.length})</SectionLabel>
        {orderedJobs.length === 0 ? (
          <p className="hs-work-empty">No processes have been started in this room.</p>
        ) : (
          <ul className="hs-jobs">
            {orderedJobs.slice(0, 8).map((job) => {
              const status = jobStatus(job.status)
              const terminal =
                job.status !== 'running' && job.status !== 'starting' && job.status !== 'unknown'
              const owner = findAgent(agents, job.agentId)
              const duration =
                job.endedAt !== null
                  ? formatDuration(Math.max(0, Date.parse(job.endedAt) - Date.parse(job.startedAt)))
                  : formatRelative(job.startedAt, now)
              return (
                <li key={job.id} className="hs-job">
                  <header className="hs-job-head">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span className="hs-job-label" title={job.label}>
                      {job.label}
                    </span>
                    {owner ? <span className="hs-job-owner">{owner.name}</span> : null}
                    {job.port !== null ? <Badge tone="muted">port {job.port}</Badge> : null}
                    {job.exitCode !== null ? (
                      <span className="hs-job-exit">exit {job.exitCode}</span>
                    ) : null}
                  </header>
                  <p className="hs-job-command hs-mono" title={`${job.command}\n\nin ${job.cwd}`}>
                    {truncate(job.command, 90)}
                  </p>
                  <footer className="hs-job-foot">
                    <span className="hs-job-time" title={job.lastObservedAt}>
                      {duration}
                      {job.truncated ? ' · output trimmed' : ''}
                    </span>
                    <Button
                      variant="ghost"
                      disabled={terminal || job.pid === null}
                      hint={
                        terminal
                          ? 'This process has already finished'
                          : job.pid === null
                            ? 'No live process id is recorded for this job'
                            : 'Kills the whole process tree for this job'
                      }
                      onClick={() => onCancelJob(job.id)}
                    >
                      Cancel
                    </Button>
                  </footer>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="hs-work-section" aria-label="Artifacts">
        <SectionLabel>Artifacts ({artifacts.length})</SectionLabel>
        {artifacts.length === 0 ? (
          <p className="hs-work-empty">Nothing has been captured yet.</p>
        ) : (
          <ul className="hs-artifacts">
            {artifacts.slice(0, 12).map((artifact) => {
              const owner = findAgent(agents, artifact.agentId)
              return (
                <li key={artifact.id} className="hs-artifact">
                  <Badge tone="muted">{artifactKindLabel(artifact.kind)}</Badge>
                  <span className="hs-artifact-title" title={artifact.title}>
                    {artifact.title}
                  </span>
                  <span className="hs-artifact-meta">
                    {owner ? owner.name : 'Room'} ·{' '}
                    {formatBytes(artifact.bytes)}
                  </span>
                  <span className="hs-artifact-actions">
                    <Button
                      variant="ghost"
                      hint="Attaches this artifact as a reference on your next message"
                      onClick={() => onAttachRef({ kind: 'artifact', artifactId: artifact.id })}
                    >
                      Attach
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={artifact.path === null}
                      hint={
                        artifact.path === null
                          ? 'This artifact is stored inline and has no file to reveal'
                          : 'Shows the artifact file in the file manager'
                      }
                      onClick={() => {
                        if (artifact.path) onRevealPath(artifact.path)
                      }}
                    >
                      Reveal
                    </Button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {resumable.length > 0 ? (
        <section className="hs-work-section" aria-label="Interrupted operations">
          <SectionLabel>Interrupted ({resumable.length})</SectionLabel>
          <ul className="hs-resumable">
            {resumable.map((item) => (
              <li key={item.id} className="hs-resumable-item">
                <header>
                  <Badge tone="wait">{item.state === 'interrupted' ? 'Interrupted' : 'Unknown'}</Badge>
                  <span className="hs-resumable-title" title={item.title}>
                    {item.title}
                  </span>
                </header>
                <p className="hs-resumable-detail" title={item.detail}>
                  {item.detail}
                </p>
                <footer>
                  <Button
                    variant="quiet"
                    hint="Restarts this operation from where Huddle can"
                    onClick={() => onResumeItem(item.id)}
                  >
                    Resume
                  </Button>
                  <Button
                    variant="ghost"
                    hint="Clears this item from the list. Nothing is restarted."
                    onClick={() => onDismissResumable(item.id)}
                  >
                    Dismiss
                  </Button>
                </footer>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {notices.length > 0 ? (
        <section className="hs-work-section" aria-label="Notices">
          <SectionLabel>Notices</SectionLabel>
          <ul className="hs-notices">
            {[...notices]
              .reverse()
              .slice(0, 5)
              .map((notice) => (
                <li key={notice.id} className={`hs-notice is-${notice.level}`}>
                  <span className="hs-notice-icon" aria-hidden="true">
                    {notice.level === 'error' ? <AlertIcon size={14} /> : <InfoIcon size={14} />}
                  </span>
                  <div>
                    <p className="hs-notice-text">{notice.text}</p>
                    {notice.fix ? <p className="hs-notice-fix">{notice.fix}</p> : null}
                    <p className="hs-notice-time" title={notice.at}>
                      {formatRelative(notice.at, now)}
                    </p>
                  </div>
                </li>
              ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
