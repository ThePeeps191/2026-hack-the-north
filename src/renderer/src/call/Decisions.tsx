import { useEffect, useRef, useState, type JSX } from 'react'
import type { Agent, Decision, Task } from '../../../shared/types'
import { AvatarMark } from './avatars'
import { decisionsNewestFirst, findAgent } from './derive'
import { authorName, formatDateTime, formatRelative, truncate } from './format'
import { HistoryIcon } from './icons'
import { Badge, Button, Empty, SectionLabel } from './ui'

/**
 * Decisions: the room's record of what was settled.
 *
 * Revisions are shown newest first with their supersede links, the tasks each
 * one marked stale, and an inline form for recording the next one.
 */

export interface DecisionsProps {
  decisions: Decision[]
  tasks: Task[]
  agents: Agent[]
  decisionRevision: number
  now: number
  onRecord: (input: {
    title: string
    statement: string
    rationale?: string
    supersedesId?: string | null
  }) => Promise<void> | void
}

export function Decisions({
  decisions,
  tasks,
  agents,
  decisionRevision,
  now,
  onRecord
}: DecisionsProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [statement, setStatement] = useState('')
  const [rationale, setRationale] = useState('')
  const [supersedesId, setSupersedesId] = useState('')
  const [busy, setBusy] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)
  const rows = useRef(new Map<string, HTMLLIElement>())

  const ordered = decisionsNewestFirst(decisions)
  const active = ordered.filter((decision) => decision.status === 'active')
  const canonical = title.trim().length === 0 || statement.trim().length === 0

  useEffect(() => {
    if (!focusId) return
    rows.current.get(focusId)?.scrollIntoView({ block: 'nearest' })
    const timer = window.setTimeout(() => setFocusId(null), 1600)
    return () => window.clearTimeout(timer)
  }, [focusId])

  const submit = (): void => {
    if (canonical) return
    setBusy(true)
    const input: {
      title: string
      statement: string
      rationale?: string
      supersedesId?: string | null
    } = { title: title.trim(), statement: statement.trim() }
    if (rationale.trim()) input.rationale = rationale.trim()
    if (supersedesId) input.supersedesId = supersedesId
    void Promise.resolve(onRecord(input))
      .then(() => {
        setTitle('')
        setStatement('')
        setRationale('')
        setSupersedesId('')
        setOpen(false)
      })
      .catch(() => {
        // The shell surfaces the error. Preserve the decision for correction or retry.
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="hs-decisions">
      <div className="hs-decisions-top">
        <SectionLabel
          aside={
            <Button
              variant={open ? 'ghost' : 'quiet'}
              pressed={open}
              hint="Records a decision everyone can see and work against"
              onClick={() => setOpen((value) => !value)}
            >
              {open ? 'Cancel' : 'Record decision'}
            </Button>
          }
        >
          Decision revision {decisionRevision} in force
        </SectionLabel>
      </div>

      {open ? (
        <div className="hs-decision-form" role="group" aria-label="Record a decision">
          <label className="hs-field">
            <span className="hs-field-label">Title</span>
            <input
              className="hs-input"
              value={title}
              maxLength={120}
              placeholder="e.g. Votes are stored locally, never sent"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="hs-field">
            <span className="hs-field-label">Decision</span>
            <textarea
              className="hs-textarea"
              rows={3}
              value={statement}
              maxLength={1200}
              placeholder="What is settled, in one or two sentences."
              onChange={(event) => setStatement(event.target.value)}
            />
          </label>
          <label className="hs-field">
            <span className="hs-field-label">Why (optional)</span>
            <textarea
              className="hs-textarea"
              rows={2}
              value={rationale}
              maxLength={1200}
              placeholder="The reason the team should remember."
              onChange={(event) => setRationale(event.target.value)}
            />
          </label>
          <label className="hs-field">
            <span className="hs-field-label">Supersedes (optional)</span>
            <select
              className="hs-select"
              value={supersedesId}
              onChange={(event) => setSupersedesId(event.target.value)}
            >
              <option value="">Nothing — this is a new decision</option>
              {active.map((decision) => (
                <option key={decision.id} value={decision.id}>
                  v{decision.revision} · {truncate(decision.title, 60)}
                </option>
              ))}
            </select>
          </label>
          <div className="hs-decision-form-actions">
            <span className="hs-decision-form-note">
              {canonical
                ? 'A title and a statement are needed before this can be recorded.'
                : 'Recording this marks any task planned against an older revision as stale.'}
            </span>
            <Button
              variant="primary"
              onClick={submit}
              disabled={canonical || busy}
              hint={
                canonical
                  ? 'A title and a statement are both required'
                  : 'Records the decision and bumps the room’s decision revision'
              }
            >
              {busy ? 'Recording…' : 'Record'}
            </Button>
          </div>
        </div>
      ) : null}

      {ordered.length === 0 ? (
        <Empty
          title="No decisions recorded yet"
          detail="When you settle something that changes what the team builds, record it here."
        />
      ) : (
        <ul className="hs-decisionlist">
          {ordered.map((decision) => {
            const supersedes = decision.supersedesId
              ? decisions.find((item) => item.id === decision.supersedesId) ?? null
              : null
            const supersededBy = decision.supersededById
              ? decisions.find((item) => item.id === decision.supersededById) ?? null
              : null
            const staleTasks = decision.affectedTaskIds
              .map((id) => tasks.find((task) => task.id === id) ?? null)
              .filter((task): task is Task => task !== null)
            const sourceAgent =
              decision.source.type === 'agent'
                ? findAgent(agents, decision.source.agentId)
                : null
            return (
              <li
                key={decision.id}
                ref={(node) => {
                  if (node) rows.current.set(decision.id, node)
                  else rows.current.delete(decision.id)
                }}
                className={`hs-decision is-${decision.status}${
                  focusId === decision.id ? ' is-focused' : ''
                }`}
              >
                <header className="hs-decision-head">
                  <Badge tone={decision.status === 'active' ? 'accent' : 'muted'}>
                    v{decision.revision}
                  </Badge>
                  <span className="hs-decision-title" title={decision.title}>
                    {decision.title}
                  </span>
                  {decision.status !== 'active' ? (
                    <Badge tone="quiet">{decision.status}</Badge>
                  ) : null}
                </header>
                <p className="hs-decision-statement">{decision.statement}</p>
                {decision.rationale ? (
                  <details className="hs-decision-why">
                    <summary>Why this was decided</summary>
                    <p>{decision.rationale}</p>
                  </details>
                ) : null}
                <footer className="hs-decision-foot">
                  <span className="hs-decision-source" title={formatDateTime(decision.createdAt)}>
                    {sourceAgent ? (
                      <AvatarMark
                        avatar={sourceAgent.avatar}
                        color={sourceAgent.color}
                        size={16}
                      />
                    ) : null}
                    {authorName(decision.source, agents)} · {formatRelative(decision.createdAt, now)}
                  </span>
                  {supersedes ? (
                    <button
                      type="button"
                      className="hs-supersede"
                      title={`Supersedes v${supersedes.revision} — ${supersedes.title}`}
                      onClick={() => setFocusId(supersedes.id)}
                    >
                      <HistoryIcon size={12} /> supersedes v{supersedes.revision}
                    </button>
                  ) : null}
                  {supersededBy ? (
                    <button
                      type="button"
                      className="hs-supersede"
                      title={`Superseded by v${supersededBy.revision} — ${supersededBy.title}`}
                      onClick={() => setFocusId(supersededBy.id)}
                    >
                      <HistoryIcon size={12} /> superseded by v{supersededBy.revision}
                    </button>
                  ) : null}
                  {staleTasks.length > 0 ? (
                    <span
                      className="hs-decision-stale"
                      title={staleTasks.map((task) => task.title).join('\n')}
                    >
                      marked {staleTasks.length} task{staleTasks.length === 1 ? '' : 's'} stale
                    </span>
                  ) : null}
                </footer>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
