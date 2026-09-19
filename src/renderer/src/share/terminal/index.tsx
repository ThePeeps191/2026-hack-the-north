import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { NO_PROJECT_DETAIL, type SurfaceProps } from '../contract.ts'
import type { JobRecord } from '../../../../shared/types.ts'

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

const MUTED = 'var(--muted, #a39b8f)'
const LINE = 'var(--line, rgba(232, 226, 214, 0.1))'
const RAISED = 'var(--bg-raised, #1b1f26)'
const INSET = 'var(--bg-inset, #101217)'
const TEXT = 'var(--text, #ece7dc)'
const ACCENT = 'var(--accent, #d4a054)'
const DANGER = 'var(--danger, #e08a7a)'
const MONO = 'var(--font-mono, ui-monospace, monospace)'
const OVERLAP_WINDOW = 4096

interface StatusStyle {
  label: string
  color: string
}

function statusStyle(status: JobRecord['status'], exitCode: number | null): StatusStyle {
  if (status === 'running' || status === 'starting') return { label: 'running', color: ACCENT }
  if (status === 'exited') return { label: 'exit 0', color: '#8fbf7f' }
  if (status === 'failed') return { label: `exit ${String(exitCode)}`, color: DANGER }
  if (status === 'cancelled') return { label: 'cancelled', color: '#9db4d8' }
  return { label: 'unknown', color: MUTED }
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
  const { workspace, agent } = props
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
    const terminal = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontSize: 12.2,
      fontFamily: '"Cascadia Mono", "Consolas", ui-monospace, monospace',
      scrollback: 5000,
      theme: {
        background: '#101217',
        foreground: '#ece7dc',
        cursor: '#d4a054',
        selectionBackground: 'rgba(212, 160, 84, 0.3)'
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
      <div style={{ padding: '28px 24px', maxWidth: 620 }}>
        <h3 style={{ fontSize: 15, marginBottom: 8 }}>No project bound</h3>
        <p style={{ color: MUTED }}>{NO_PROJECT_DETAIL}</p>
        <p style={{ color: MUTED, marginTop: 8, fontSize: 12 }}>
          There are no simulated logs on this surface: with no workspace there are no processes.
        </p>
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 300px) minmax(0, 1fr)', height: '100%', minHeight: 0 }}>
      <div style={{ borderRight: `1px solid ${LINE}`, background: RAISED, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', minHeight: 0 }}>
        <div style={{ padding: '8px 10px', borderBottom: `1px solid ${LINE}` }}>
          <div style={{ fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: MUTED }}>Jobs</div>
          <div style={{ fontSize: 11.5, color: MUTED, marginTop: 4 }}>
            {agent !== null ? `${agent.name}'s workspace` : 'Team workspace'}
          </div>
        </div>
        <div style={{ overflow: 'auto', minHeight: 0 }} aria-label="Jobs in this workspace">
          {loadError !== null ? (
            <p role="alert" style={{ padding: 12, color: DANGER, fontSize: 12 }}>
              {loadError}
            </p>
          ) : null}
          {jobs.length === 0 && loadError === null ? (
            <p style={{ padding: 12, color: MUTED, fontSize: 12 }}>
              No process has run in this workspace yet. Jobs appear here the moment a real command starts.
            </p>
          ) : null}
          <ul style={{ listStyle: 'none', margin: 0, padding: 4 }}>
            {jobs.map((job) => {
              const style = statusStyle(job.status, job.exitCode)
              const isSelected = job.id === selectedId
              return (
                <li key={job.id} style={{ marginBottom: 4 }}>
                  <button
                    type="button"
                    onClick={() => void selectJob(job.id)}
                    aria-current={isSelected ? 'true' : undefined}
                    aria-label={`${job.label}, ${job.command}, ${style.label}`}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 8px',
                      borderRadius: 8,
                      background: isSelected ? 'rgba(212, 160, 84, 0.16)' : 'transparent',
                      border: `1px solid ${isSelected ? 'rgba(212, 160, 84, 0.4)' : 'transparent'}`
                    }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <span style={{ fontSize: 12.5, color: TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {job.label}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span style={{ fontSize: 11, color: style.color }}>{style.label}</span>
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 11.5, color: MUTED, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {job.command}
                    </div>
                    <div style={{ fontSize: 11, color: MUTED, marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
                      style={{
                        marginTop: 4,
                        marginLeft: 8,
                        fontSize: 11.5,
                        color: busyJobId === job.id ? MUTED : DANGER
                      }}
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

      <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', minHeight: 0, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            padding: '8px 12px',
            borderBottom: `1px solid ${LINE}`,
            background: RAISED,
            flexWrap: 'wrap'
          }}
        >
          <span style={{ fontSize: 12.5 }}>{selected === null ? 'No job selected' : selected.label}</span>
          {selected !== null ? (
            <>
              <span style={{ fontFamily: MONO, fontSize: 11.5, color: MUTED }}>{selected.command}</span>
              <span style={{ fontFamily: MONO, fontSize: 11.5, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {selected.cwd}
              </span>
            </>
          ) : null}
          <span style={{ flex: 1 }} />
          {selected !== null ? (
            <button type="button" onClick={() => void selectJob(selected.id)} style={{ fontSize: 11.5, color: MUTED }}>
              reload output
            </button>
          ) : null}
        </div>

        <div style={{ minHeight: 0, background: INSET, padding: '4px 6px' }}>
          <div ref={hostRef} style={{ height: '100%', width: '100%' }} aria-label="Real job output" role="log" />
        </div>

        <div style={{ borderTop: `1px solid ${LINE}`, background: RAISED, padding: '6px 12px', display: 'grid', gap: 6 }}>
          {outputNote !== null ? (
            <p role="status" style={{ fontSize: 11.5, color: MUTED }}>
              {outputNote}
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              disabled
              aria-label="Command input (disabled)"
              placeholder="Typed input is disabled — Huddle has no stdin channel to a job"
              style={{
                flex: 1,
                fontFamily: MONO,
                fontSize: 12,
                padding: '4px 8px',
                borderRadius: 8,
                border: `1px solid ${LINE}`,
                background: 'transparent',
                color: MUTED
              }}
            />
            <span style={{ fontSize: 11.5, color: MUTED }}>
              Ask an agent to run a command, or use the Files/Code surfaces. Nothing here is a real shell.
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
