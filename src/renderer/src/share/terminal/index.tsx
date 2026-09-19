import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { NO_PROJECT_DETAIL, type SurfaceProps } from '../contract.ts'
import type { JobRecord } from '../../../../shared/types.ts'
import '../../styles/terminal.css'

/**
 * The Terminal surface: a viewer of real processes.
 *
 * Every line here comes from a real `spawn`ed process — `job.upserted` and
 * `job.output` runtime events while it runs, and `exec.jobOutput` for the
 * retained output on mount. There is no simulated shell and no fake prompt.
 *
 * Typed input is deliberately disabled and the UI says why: the execution host
 * exposes no stdin channel to a job, so offering a prompt would be theatre. Each
 * running job has a real Cancel button that kills the whole process tree.
 *
 * Job records arrive through `window.huddle.getSnapshot()` (the persisted room
 * state) plus the live event stream, because `SurfaceProps` does not carry the
 * room's jobs and the preload API has no job-list channel.
 */

const OVERLAP_WINDOW = 4096

interface StatusStyle { label: string; tone: string }

function statusStyle(status: JobRecord['status'], exitCode: number | null): StatusStyle {
  if (status === 'running' || status === 'starting') return { label: 'running', tone: 'running' }
  if (status === 'exited') return { label: 'exit 0', tone: 'success' }
  if (status === 'failed') return { label: `exit ${String(exitCode)}`, tone: 'failure' }
  if (status === 'cancelled') return { label: 'cancelled', tone: 'cancelled' }
  return { label: 'unknown', tone: 'unknown' }
}

function elapsed(job: JobRecord): string {
  const start = Date.parse(job.startedAt)
  if (Number.isNaN(start)) return ''
  const end = job.endedAt === null ? Date.now() : Date.parse(job.endedAt)
  if (Number.isNaN(end)) return ''
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** Longest suffix of `written` that `incoming` starts with. Keeps output once. */
function overlapLength(written: string, incoming: string): number {
  const max = Math.min(written.length, incoming.length, OVERLAP_WINDOW)
  for (let length = max; length > 0; length -= 1) {
    if (incoming.startsWith(written.slice(written.length - length))) return length
  }
  return 0
}

export function TerminalSurface(props: SurfaceProps): JSX.Element {
  const { workspace, agent, openReference } = props
  const workspaceId = workspace?.id ?? null

  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [outputNote, setOutputNote] = useState<string | null>(null)
  const [busyJobId, setBusyJobId] = useState<string | null>(null)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const selectedRef = useRef<string | null>(null)
  const pendingRef = useRef<string[]>([])
  const writtenRef = useRef<string>('')

  const selected = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? null,
    [jobs, selectedId]
  )

  /* ---------------- xterm instance ---------------- */
  useEffect(() => {
    if (workspaceId === null || hostRef.current === null) return undefined
    const host = hostRef.current
    const tokens = getComputedStyle(host)
    const terminal = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontSize: 12.2,
      fontFamily: '"Cascadia Mono", "Consolas", ui-monospace, monospace',
      scrollback: 5000,
      theme: {
        background: tokens.getPropertyValue('--bg-inset').trim(),
        foreground: tokens.getPropertyValue('--text').trim(),
        cursor: tokens.getPropertyValue('--accent').trim(),
        selectionBackground: tokens.getPropertyValue('--accent-soft').trim()
      }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    try {
      fit.fit()
    } catch {
      // The host may not be laid out yet; the ResizeObserver below retries.
    }
    terminalRef.current = terminal
    fitRef.current = fit
    terminal.writeln('\x1b[90mHuddle terminal — real process output. Not a shell; typed input is disabled.\x1b[0m')

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // Ignore a fit while the element is hidden.
      }
    })
    observer.observe(host)

    return () => {
      observer.disconnect()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      writtenRef.current = ''
      pendingRef.current = []
    }
  }, [workspaceId])

  /* ---------------- job records ---------------- */
  useEffect(() => {
    if (workspaceId === null) return undefined
    let cancelled = false

    window.huddle
      .getSnapshot()
      .then((snapshot) => {
        if (cancelled) return
        setJobs(snapshot.jobs.filter((job) => job.workspaceId === workspaceId))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadError(error instanceof Error ? error.message : 'Could not read the room snapshot.')
      })

    const unsubscribe = window.huddle.subscribe((event) => {
      if (event.type === 'job.upserted') {
        const updated: JobRecord = event.job
        if (updated.workspaceId !== workspaceId) return
        setJobs((previous) => {
          const index = previous.findIndex((job) => job.id === updated.id)
          if (index === -1) return [...previous, updated]
          const next = [...previous]
          next[index] = updated
          return next
        })
        return
      }
      if (event.type === 'job.output') {
        const chunk: string = event.chunk
        if (selectedRef.current !== event.jobId) return
        const terminal = terminalRef.current
        if (terminal === null) {
          pendingRef.current.push(chunk)
          return
        }
        if (pendingRef.current.length > 0) {
          pendingRef.current.push(chunk)
          return
        }
        writtenRef.current = `${writtenRef.current}${chunk}`.slice(-OVERLAP_WINDOW * 2)
        terminal.write(chunk)
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [workspaceId])

  /* ---------------- selecting a job ---------------- */
  const selectJob = useCallback(
    async (jobId: string): Promise<void> => {
      const terminal = terminalRef.current
      setSelectedId(jobId)
      selectedRef.current = jobId
      pendingRef.current = []
      writtenRef.current = ''
      setOutputNote(null)
      if (terminal === null) return
      terminal.reset()
      terminal.writeln(`\x1b[90m── job ${jobId} output ──\x1b[0m`)
      try {
        const output = await window.huddle.exec.jobOutput(jobId)
        const buffered = pendingRef.current
        pendingRef.current = []
        const incoming = buffered.join('')
        const overlap = incoming.length > 0 ? overlapLength(output.text, incoming) : 0
        const text = `${output.text}${incoming.slice(overlap)}`
        writtenRef.current = text.slice(-OVERLAP_WINDOW * 2)
        if (text.length === 0) {
          terminal.writeln('\x1b[90m(no output captured yet)\x1b[0m')
        } else {
          terminal.write(text)
        }
        if (output.truncated) {
          setOutputNote(
            `Older output was trimmed: Huddle keeps the newest 512 KB of a job. Status ${output.status}, exit code ${String(output.exitCode)}.`
          )
        } else {
          setOutputNote(`Retained output from the real process. Status ${output.status}, exit code ${String(output.exitCode)}.`)
        }
      } catch (error) {
        setOutputNote(error instanceof Error ? error.message : 'Could not read the job output.')
      }
    },
    []
  )

  useEffect(() => {
    if (openReference?.ref.kind !== 'job') return
    void selectJob(openReference.ref.jobId)
  }, [openReference, selectJob])

  const cancel = useCallback(
    async (jobId: string): Promise<void> => {
      setBusyJobId(jobId)
      try {
        await window.huddle.exec.cancelJob(jobId)
        setOutputNote('Cancel requested. Huddle kills the whole process tree and reports the real outcome.')
      } catch (error) {
        setOutputNote(error instanceof Error ? error.message : 'Cancel failed.')
      } finally {
        setBusyJobId(null)
      }
    },
    []
  )

  if (workspace === null) {
    return (
      <div className="ts-empty">
        <h3>No project bound</h3>
        <p>{NO_PROJECT_DETAIL}</p>
        <p className="ts-empty__note">
          There are no simulated logs on this surface: with no workspace there are no processes.
        </p>
      </div>
    )
  }

  return (
    <div className="ts-surface">
      <div className="ts-list">
        <div className="ts-list__head">
          <div className="ts-eyebrow">Jobs</div>
          <div className="ts-meta">
            {agent !== null ? `${agent.name}'s workspace` : 'Team workspace'}
          </div>
        </div>
        <div className="ts-list__scroll" aria-label="Jobs in this workspace">
          {loadError !== null ? (
            <p role="alert" className="ts-state ts-state--error">
              {loadError}
            </p>
          ) : null}
          {jobs.length === 0 && loadError === null ? (
            <p className="ts-state">
              No process has run in this workspace yet. Jobs appear here the moment a real command starts.
            </p>
          ) : null}
          <ul className="ts-jobs">
            {jobs.map((job) => {
              const style = statusStyle(job.status, job.exitCode)
              const isSelected = job.id === selectedId
              return (
                <li key={job.id} className="ts-job">
                  <button
                    type="button"
                    onClick={() => void selectJob(job.id)}
                    aria-current={isSelected ? 'true' : undefined}
                    aria-label={`${job.label}, ${job.command}, ${style.label}`}
                    className={`ts-job__select${isSelected ? ' is-selected' : ''}`}
                  >
                    <div className="ts-job__title">
                      <span className="ts-job__label">
                        {job.label}
                      </span>
                      <span className={`ts-status ts-status--${style.tone}`}>{style.label}</span>
                    </div>
                    <div className="ts-command" title={job.command}>
                      {job.command}
                    </div>
                    <div className="ts-job__meta">
                      <span>pid {job.pid ?? '—'}</span>
                      <span>{elapsed(job)}</span>
                      {job.port !== null ? <span>port {job.port}</span> : null}
                      {job.truncated ? <span>output trimmed</span> : null}
                    </div>
                  </button>
                  {job.status === 'running' || job.status === 'starting' ? (
                    <button
                      type="button"
                      onClick={() => void cancel(job.id)}
                      disabled={busyJobId === job.id}
                      aria-label={`Cancel ${job.label}`}
                      className="ts-cancel"
                    >
                      {busyJobId === job.id ? 'cancelling…' : 'cancel process tree'}
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      </div>

      <div className="ts-output">
        <div className="ts-output__head">
          <span className="ts-output__title">{selected === null ? 'No job selected' : selected.label}</span>
          {selected !== null ? (
            <>
              <span className="ts-command" title={selected.command}>{selected.command}</span>
              <span className="ts-cwd" title={selected.cwd}>
                {selected.cwd}
              </span>
            </>
          ) : null}
          <span className="ts-spacer" />
          {selected !== null ? (
            <>
              <button type="button" className="ts-reload" onClick={() => props.onAttachRef({ kind: 'job', jobId: selected.id })}>
                Attach
              </button>
              <button type="button" className="ts-reload" onClick={() => void selectJob(selected.id)}>
                Reload
              </button>
            </>
          ) : null}
        </div>

        <div className="ts-terminal">
          <div ref={hostRef} className="ts-terminal__host" aria-label="Real job output" role="log" />
        </div>

        <div className="ts-output__foot">
          {outputNote !== null ? (
            <p role="status" className="ts-note">
              {outputNote}
            </p>
          ) : null}
          <div className="ts-readonly">
            <input
              type="text"
              disabled
              aria-label="Command input (disabled)"
              placeholder="Typed input is disabled — Huddle has no stdin channel to a job"
              className="ts-readonly__input"
            />
            <span className="ts-note">
              Output only. Ask a teammate to run a command.
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
