import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { NO_PROJECT_DETAIL, type SurfaceOwner, type SurfaceProps } from '../contract.ts'
import type { NetworkEntry, PreviewInfo, ScreenshotResult } from '../../../../shared/api.ts'
import type { Agent, Artifact, BrowserSessionRecord, Capability, ContextRef } from '../../../../shared/types.ts'

/**
 * The Browser surface: one teammate's real remote browser.
 *
 * What it shows is what the backend reported — a Browserbase session that is
 * really running, its live-view link, screenshots captured from that session
 * (written as artifacts and shown from the returned data URL), the responses
 * that session actually produced and the preview URL it was pointed at. When
 * there is no session, or Browserbase is not configured, or the preview is not
 * reachable from the cloud, it says so and offers the next step instead of
 * showing a plausible-looking fake.
 *
 * A screenshot region is referenced by coordinates in the captured image's real
 * pixels. The remote page is not embedded here and its DOM is not readable
 * across origins, so the surface never pretends to know an element by selector.
 */

const MUTED = 'var(--muted, #a39b8f)'
const LINE = 'var(--line, rgba(232, 226, 214, 0.1))'
const RAISED = 'var(--bg-raised, #1b1f26)'
const INSET = 'var(--bg-inset, #101217)'
const TEXT = 'var(--text, #ece7dc)'
const ACCENT = 'var(--accent, #d4a054)'
const DANGER = 'var(--danger, #e08a7a)'

const CLICK_REGION_PX = 48
const MAX_CAPTURES = 12

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Size {
  width: number
  height: number
}

interface Point {
  x: number
  y: number
}

interface UiError {
  message: string
  fix: string | null
  code: string | null
}

interface Capture {
  result: ScreenshotResult
  at: string
  /** Real pixel size of the PNG, measured from the returned data URL. */
  imageSize: Size | null
  /** What was attached from this capture, in captured-image pixels. */
  selection: Rect | null
  note: string | null
}

function describeError(error: unknown): UiError {
  if (error instanceof Error) {
    const extra = error as Error & { fix?: unknown; code?: unknown }
    return {
      message: error.message,
      fix: typeof extra.fix === 'string' && extra.fix.length > 0 ? extra.fix : null,
      code: typeof extra.code === 'string' ? extra.code : null
    }
  }
  return { message: 'Something went wrong, and it was not an Error.', fix: null, code: null }
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatClock(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatStamp(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** The pixel size the host wrote into the artifact title when it saved the PNG. */
function dimensionsFrom(title: string): Size | null {
  const match = /(\d{3,5})×(\d{3,5})/.exec(title)
  if (match === null) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  return { width, height }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

function ownerLabel(owner: SurfaceOwner, agent: Agent | null): string {
  if (owner.kind === 'team') return 'the Team view'
  return agent?.name ?? 'that teammate'
}

function isOpen(record: BrowserSessionRecord | null): boolean {
  return record !== null && (record.status === 'live' || record.status === 'starting')
}

function statusTone(status: BrowserSessionRecord['status']): string {
  if (status === 'live') return ACCENT
  if (status === 'failed') return DANGER
  return MUTED
}

/** A teammate a session can belong to. QA and systems agents are the usual testers. */
function candidateAgents(agents: Agent[], ownerAgentId: string | null): Agent[] {
  if (ownerAgentId !== null) {
    const mine = agents.filter((item) => item.id === ownerAgentId)
    if (mine.length > 0) return mine
  }
  const qa = agents.filter((item) => item.role === 'qa')
  const systems = agents.filter((item) => item.role === 'systems')
  const rest = agents.filter((item) => item.role !== 'qa' && item.role !== 'systems')
  return [...qa, ...systems, ...rest]
}

/** Measure a returned data URL so the pixel size shown is the image's own. */
function measureImage(dataUrl: string): Promise<Size | null> {
  return new Promise<Size | null>((resolve) => {
    const image = new Image()
    image.onload = () => {
      resolve(
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : null
      )
    }
    image.onerror = () => {
      resolve(null)
    }
    image.src = dataUrl
  })
}

export function BrowserSurface(props: SurfaceProps): JSX.Element {
  const { room, owner, workspace, agent, onAttachRef } = props

  const ownerKind = owner.kind
  const ownerAgentId = owner.kind === 'agent' ? owner.agentId : null
  const ownerKey = ownerKind === 'team' ? `team:${room.id}` : `agent:${String(ownerAgentId)}`
  const agentId = agent?.id ?? null
  const agentSessionId = agent?.browserSessionId ?? null

  const [session, setSession] = useState<BrowserSessionRecord | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [capability, setCapability] = useState<Capability | null>(null)
  const [preview, setPreview] = useState<PreviewInfo | null>(null)
  const [captures, setCaptures] = useState<Capture[]>([])
  const [network, setNetwork] = useState<NetworkEntry[] | null>(null)
  const [networkFilter, setNetworkFilter] = useState('')
  const [busy, setBusy] = useState<'opening' | 'closing' | 'capturing' | 'network' | 'preview' | null>(null)
  const [error, setError] = useState<UiError | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const imageRef = useRef<HTMLImageElement | null>(null)
  const dragging = useRef(false)
  /** The press point, kept in a ref so a fast click cannot read stale state. */
  const dragOrigin = useRef<Point | null>(null)
  const [dragFrom, setDragFrom] = useState<Point | null>(null)
  const [dragTo, setDragTo] = useState<Point | null>(null)

  const currentCapture = captures.length > 0 ? captures[0] : null

  /* ------------------------------------------------------------------ *
   * Real backend state
   *
   * The surface contract hands over the room, the owner and the workspace but
   * not the room's sessions or artifacts, so the reads below are the narrowest
   * way to show the records the backend already produced. Nothing is inferred:
   * a session appears only because the backend said one exists, and the status
   * it shows is the status the browser host published.
   * ------------------------------------------------------------------ */

  const refreshArtifacts = useCallback(async (): Promise<void> => {
    const snapshot = await window.huddle.getSnapshot()
    setArtifacts(snapshot.artifacts.filter((item) => item.roomId === room.id && item.kind === 'screenshot'))
  }, [room.id])

  const matches = useCallback(
    (record: BrowserSessionRecord): boolean =>
      ownerAgentId === null ? true : record.agentId === ownerAgentId,
    [ownerAgentId]
  )

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const snapshot = await window.huddle.getSnapshot()
        if (cancelled) return
        setAgents(snapshot.agents.filter((item) => item.roomId === room.id))
        setCapability(snapshot.capabilities.find((item) => item.id === 'browserbase') ?? null)
        setArtifacts(
          snapshot.artifacts.filter((item) => item.roomId === room.id && item.kind === 'screenshot')
        )
        const mine = snapshot.browserSessions
          .filter((item) => item.roomId === room.id && matches(item))
          .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        setSession((current) => {
          if (current !== null) {
            const fresh = mine.find((item) => item.id === current.id)
            if (fresh !== undefined) return fresh
          }
          return mine[0] ?? null
        })
      } catch (caught) {
        if (!cancelled) setError(describeError(caught))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [room.id, ownerKey, ownerAgentId, agentId, agentSessionId, matches])

  // The browser host publishes every record change, so status flips arrive on
  // their own instead of being polled or guessed at.
  useEffect(() => {
    const unsubscribe = window.huddle.subscribe((event) => {
      if (event.type !== 'browser.upserted') return
      const record = event.session
      if (record.roomId !== room.id) return
      if (ownerAgentId !== null && record.agentId !== ownerAgentId) return
      setSession((current) => (current === null || current.id === record.id ? record : current))
    })
    return unsubscribe
  }, [room.id, ownerAgentId])

  useEffect(() => {
    setCaptures([])
    setNetwork(null)
    setNetworkFilter('')
    setError(null)
    setNote(null)
    setPreview(null)
    setDragFrom(null)
    setDragTo(null)
  }, [ownerKey, room.id])

  const candidates = useMemo(() => candidateAgents(agents, ownerAgentId), [agents, ownerAgentId])

  const sessionAgent = useMemo(() => {
    if (ownerAgentId !== null) return agent ?? agents.find((item) => item.id === ownerAgentId) ?? null
    if (session !== null) {
      const found = agents.find((item) => item.id === session.agentId)
      if (found !== undefined) return found
    }
    return candidates[0] ?? null
  }, [agents, agent, candidates, ownerAgentId, session])

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  const openSession = useCallback(async (): Promise<void> => {
    const target = agent ?? candidates[0] ?? null
    if (target === null) {
      setError({
        message: 'No teammate is in this room who could own a browser session.',
        fix: 'Add Maya, Alex or Sam from the participant strip first.',
        code: null
      })
      return
    }
    setBusy('opening')
    setError(null)
    setNote(null)
    try {
      const record = await window.huddle.browser.open({ roomId: room.id, agentId: target.id })
      setSession(record)
      setNote(record.detail)
      await refreshArtifacts()
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(null)
    }
  }, [agent, candidates, refreshArtifacts, room.id])

  const closeSession = useCallback(async (): Promise<void> => {
    if (session === null) return
    setBusy('closing')
    setError(null)
    try {
      await window.huddle.browser.close(session.id)
      setSession((current) => (current === null ? current : { ...current, status: 'closed' }))
      setNote('Huddle dropped the connection and asked Browserbase to end the session; the session detail says what it answered.')
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(null)
    }
  }, [session])

  const capture = useCallback(async (): Promise<void> => {
    if (session === null) return
    setBusy('capturing')
    setError(null)
    try {
      const result = await window.huddle.browser.screenshot(session.id)
      const imageSize = await measureImage(result.dataUrl)
      setCaptures((current) =>
        [
          { result, at: new Date().toISOString(), imageSize, selection: null, note: null },
          ...current
        ].slice(0, MAX_CAPTURES)
      )
      await refreshArtifacts()
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(null)
    }
  }, [refreshArtifacts, session])

  const readNetwork = useCallback(async (): Promise<void> => {
    if (session === null) return
    setBusy('network')
    setError(null)
    try {
      const trimmed = networkFilter.trim()
      const entries = await window.huddle.browser.network(
        session.id,
        trimmed.length > 0 ? trimmed : undefined
      )
      setNetwork(entries)
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(null)
    }
  }, [networkFilter, session])

  const startPreview = useCallback(async (): Promise<void> => {
    if (workspace === null) return
    setBusy('preview')
    setError(null)
    try {
      setPreview(await window.huddle.exec.startPreview(room.id, workspace.id))
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(null)
    }
  }, [room.id, workspace])

  /**
   * A pointer position turned into a coordinate in the captured image's own
   * pixel space, using the image's natural size rather than its displayed size.
   */
  const imagePoint = useCallback((clientX: number, clientY: number, fallback: Size): Point => {
    const image = imageRef.current
    if (image === null) return { x: 0, y: 0 }
    const box = image.getBoundingClientRect()
    const naturalWidth = image.naturalWidth > 0 ? image.naturalWidth : fallback.width
    const naturalHeight = image.naturalHeight > 0 ? image.naturalHeight : fallback.height
    const scaleX = naturalWidth / Math.max(1, box.width)
    const scaleY = naturalHeight / Math.max(1, box.height)
    return {
      x: clamp((clientX - box.left) * scaleX, 0, naturalWidth),
      y: clamp((clientY - box.top) * scaleY, 0, naturalHeight)
    }
  }, [])

  const finishSelection = useCallback(
    (from: Point, end: Point): void => {
      const captureValue = currentCapture
      if (captureValue === null) return
      const image = imageRef.current
      const fallback = captureValue.imageSize ?? captureValue.result.viewport
      const naturalWidth = image !== null && image.naturalWidth > 0 ? image.naturalWidth : fallback.width
      const naturalHeight = image !== null && image.naturalHeight > 0 ? image.naturalHeight : fallback.height

      const draggedWidth = Math.abs(end.x - from.x)
      const draggedHeight = Math.abs(end.y - from.y)
      const left = Math.min(from.x, end.x)
      const top = Math.min(from.y, end.y)

      let rect: Rect
      let how: string
      if (draggedWidth < 6 || draggedHeight < 6) {
        rect = {
          x: clamp(Math.round(left - CLICK_REGION_PX / 2), 0, Math.max(0, naturalWidth - CLICK_REGION_PX)),
          y: clamp(Math.round(top - CLICK_REGION_PX / 2), 0, Math.max(0, naturalHeight - CLICK_REGION_PX)),
          width: Math.min(CLICK_REGION_PX, naturalWidth),
          height: Math.min(CLICK_REGION_PX, naturalHeight)
        }
        how = 'clicked point'
      } else {
        rect = {
          x: Math.round(left),
          y: Math.round(top),
          width: Math.max(1, Math.round(draggedWidth)),
          height: Math.max(1, Math.round(draggedHeight))
        }
        how = 'dragged region'
      }

      const ref: ContextRef = {
        kind: 'screenshot',
        artifactId: captureValue.result.artifact.id,
        rect,
        viewport: captureValue.result.viewport,
        url: captureValue.result.url
      }
      onAttachRef(ref)

      const summary =
        `Attached the ${how}: ${String(rect.width)}×${String(rect.height)} px at (${String(rect.x)}, ${String(rect.y)}) ` +
        `of the real ${String(naturalWidth)}×${String(naturalHeight)} px capture of ${captureValue.result.url}. ` +
        `The page was captured at a ${String(captureValue.result.viewport.width)}×${String(captureValue.result.viewport.height)} viewport.`

      setCaptures((items) =>
        items.map((item) => (item.at === captureValue.at ? { ...item, selection: rect, note: summary } : item))
      )
      setNote(summary)
      setDragFrom(null)
      setDragTo(null)
      dragOrigin.current = null
    },
    [currentCapture, onAttachRef]
  )

  /* ------------------------------------------------------------------ *
   * Honest states
   * ------------------------------------------------------------------ */

  if (workspace === null) {
    return (
      <div style={{ padding: '4px 0', maxWidth: 620 }}>
        <h3 style={{ fontSize: 15, marginBottom: 8 }}>No project bound</h3>
        <p style={{ color: MUTED }}>{NO_PROJECT_DETAIL}</p>
        <p style={{ color: MUTED, marginTop: 8, fontSize: 12 }}>
          A remote browser exists to check a running app, so there is nothing for it to load yet.
        </p>
      </div>
    )
  }

  const blocked =
    capability !== null && (capability.state === 'unavailable' || capability.state === 'disabled')
      ? capability
      : null
  const liveViewAvailable = session !== null && session.liveViewUrl !== null
  const priorArtifacts = artifacts
    .filter((artifact) => !captures.some((item) => item.result.artifact.id === artifact.id))
    .slice(0, 12)
  const dragBox: Rect | null =
    dragFrom === null || dragTo === null
      ? null
      : Math.abs(dragTo.x - dragFrom.x) < 2 || Math.abs(dragTo.y - dragFrom.y) < 2
        ? null
        : {
            x: Math.min(dragFrom.x, dragTo.x),
            y: Math.min(dragFrom.y, dragTo.y),
            width: Math.abs(dragTo.x - dragFrom.x),
            height: Math.abs(dragTo.y - dragFrom.y)
          }
  const displayedSize: Size | null =
    imageRef.current !== null && imageRef.current.naturalWidth > 0
      ? { width: imageRef.current.naturalWidth, height: imageRef.current.naturalHeight }
      : currentCapture !== null
        ? (currentCapture.imageSize ?? currentCapture.result.viewport)
        : null

  const overlay = (rect: Rect, dashed: boolean): JSX.Element | null => {
    if (displayedSize === null || displayedSize.width < 1 || displayedSize.height < 1) return null
    return (
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: `${String((rect.x / displayedSize.width) * 100)}%`,
          top: `${String((rect.y / displayedSize.height) * 100)}%`,
          width: `${String((rect.width / displayedSize.width) * 100)}%`,
          height: `${String((rect.height / displayedSize.height) * 100)}%`,
          border: `1px ${dashed ? 'dashed' : 'solid'} ${ACCENT}`,
          background: dashed ? 'transparent' : 'rgba(212, 160, 84, 0.18)',
          pointerEvents: 'none'
        }}
      />
    )
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: 'auto minmax(0, 1fr)',
        gap: 12,
        height: '100%',
        minHeight: 0
      }}
    >
      {/* ---------------- header ---------------- */}
      <div
        style={{
          display: 'grid',
          gap: 8,
          background: RAISED,
          border: `1px solid ${LINE}`,
          borderRadius: 10,
          padding: '10px 12px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: MUTED }}>
            {ownerLabel(owner, agent)} remote browser
          </span>
          {session !== null ? (
            <span
              style={{
                fontSize: 11.5,
                borderRadius: 999,
                padding: '2px 8px',
                border: `1px solid ${statusTone(session.status)}`,
                color: statusTone(session.status)
              }}
            >
              {session.status}
              {session.remoteId !== null ? ` · ${session.remoteId.slice(0, 8)}` : ''}
            </span>
          ) : (
            <span
              style={{
                fontSize: 11.5,
                color: MUTED,
                borderRadius: 999,
                padding: '2px 8px',
                border: `1px solid ${LINE}`
              }}
            >
              no session
            </span>
          )}
          <span style={{ flex: 1 }} />
          {liveViewAvailable && session !== null ? (
            <a
              href={session.liveViewUrl ?? ''}
              target="_blank"
              rel="noreferrer"
              style={{ color: ACCENT, fontSize: 12.5 }}
              title={session.liveViewUrl ?? ''}
            >
              Open the live view of this session ↗
            </a>
          ) : session !== null ? (
            <span style={{ color: MUTED, fontSize: 12 }}>
              Browserbase returned no live-view URL for this session
            </span>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {isOpen(session) ? (
            <button
              type="button"
              className="primary"
              onClick={() => void closeSession()}
              disabled={busy !== null}
              style={{ justifySelf: 'start' }}
            >
              {busy === 'closing' ? 'Closing…' : 'Close the session'}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={() => void openSession()}
              disabled={busy !== null}
              style={{ justifySelf: 'start' }}
              title="Creates a real Browserbase session and points it at the project's reachable preview URL"
            >
              {busy === 'opening'
                ? 'Opening a real session…'
                : `Open a session for ${sessionAgent?.name ?? 'a teammate'}`}
            </button>
          )}
          <button
            type="button"
            className="ghost"
            onClick={() => void capture()}
            disabled={!isOpen(session) || busy !== null}
          >
            {busy === 'capturing' ? 'Capturing…' : 'Capture a screenshot'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => void readNetwork()}
            disabled={session === null || busy !== null}
            title="Reads the responses this remote session actually produced"
          >
            {busy === 'network' ? 'Reading…' : 'Read the network'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => void startPreview()}
            disabled={busy !== null}
            title="Starts (or reuses) the project's dev server and exposes a URL a cloud browser can reach"
          >
            {busy === 'preview' ? 'Starting the preview…' : 'Start / check the preview'}
          </button>
          {session !== null && session.currentUrl !== null ? (
            <span className="mono" style={{ color: MUTED, fontSize: 11.5 }}>
              {session.currentUrl}
            </span>
          ) : null}
        </div>

        {session !== null ? (
          <p style={{ fontSize: 12, color: MUTED }}>
            {session.title !== null && session.title.length > 0 ? `“${session.title}” — ` : ''}
            {session.detail}
          </p>
        ) : (
          <p style={{ fontSize: 12, color: MUTED }}>
            No remote browser is attached to {ownerLabel(owner, agent)} right now. A session is a real Chromium in
            Browserbase&apos;s cloud: it runs on another machine, so it can only load a URL that machine can reach.
            Huddle points it at the project&apos;s tunnel URL, never at this laptop&apos;s localhost.
          </p>
        )}

        {preview !== null ? (
          <p style={{ fontSize: 12, color: preview.publicUrl === null ? DANGER : MUTED }}>
            Preview {preview.state} ({preview.mode}): {preview.publicUrl ?? 'no reachable public URL'}. {preview.detail}
          </p>
        ) : null}

        {blocked !== null ? (
          <div
            role="status"
            style={{ background: INSET, border: `1px solid ${LINE}`, borderRadius: 8, padding: '8px 10px' }}
          >
            <strong style={{ fontSize: 12.5 }}>{blocked.label} is not ready.</strong>
            <p style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{blocked.detail}</p>
            {blocked.fix !== null ? (
              <p style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{blocked.fix}</p>
            ) : null}
          </div>
        ) : null}

        {error !== null ? (
          <div
            role="alert"
            style={{ background: INSET, border: `1px solid ${DANGER}`, borderRadius: 8, padding: '8px 10px' }}
          >
            <strong style={{ fontSize: 12.5, color: DANGER }}>
              {error.code !== null ? `${error.code}: ` : ''}
              {error.message}
            </strong>
            {error.fix !== null ? (
              <p style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{error.fix}</p>
            ) : null}
          </div>
        ) : null}

        {note !== null ? (
          <p role="status" style={{ fontSize: 12, color: MUTED }}>
            {note}
          </p>
        ) : null}
      </div>

      {/* ---------------- body ---------------- */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(240px, 340px)',
          gap: 12,
          minHeight: 0
        }}
      >
        <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', gap: 8, minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {currentCapture !== null ? (
              <span style={{ fontSize: 12, color: MUTED }}>
                captured {formatClock(currentCapture.at)} · captured at{' '}
                {String(currentCapture.result.viewport.width)}×{String(currentCapture.result.viewport.height)} (the
                remote page&apos;s viewport)
                {currentCapture.imageSize !== null
                  ? ` · image ${String(currentCapture.imageSize.width)}×${String(currentCapture.imageSize.height)} px`
                  : ''}
              </span>
            ) : (
              <span style={{ fontSize: 12, color: MUTED }}>
                Screenshots come from the live session, not from a preview image.
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="ghost"
              onClick={() => void capture()}
              disabled={!isOpen(session) || busy !== null}
            >
              capture again
            </button>
          </div>

          <div
            style={{
              background: INSET,
              border: `1px solid ${LINE}`,
              borderRadius: 10,
              overflow: 'auto',
              minHeight: 0,
              padding: 10
            }}
          >
            {currentCapture === null ? (
              <div style={{ padding: 18, color: MUTED, maxWidth: 640 }}>
                <h3 style={{ fontSize: 14, color: TEXT, marginBottom: 6 }}>No screenshot yet</h3>
                <p style={{ fontSize: 12.5 }}>
                  {isOpen(session)
                    ? 'The session is live. Capture a screenshot to see exactly what the remote browser is showing right now.'
                    : 'Open a session and capture a screenshot. What appears here is the real PNG that remote browser produced.'}
                </p>
                <p style={{ fontSize: 12.5, marginTop: 8 }}>
                  Drag a box (or click a point) on a capture to attach that region to the composer. Coordinates are
                  recorded in the captured image&apos;s pixels; the remote page is not embedded here and its DOM is
                  not readable from Huddle.
                </p>
              </div>
            ) : (
              <div
                style={{
                  position: 'relative',
                  display: 'inline-block',
                  maxWidth: '100%',
                  cursor: 'crosshair',
                  touchAction: 'none'
                }}
                onPointerDown={(event) => {
                  if (currentCapture === null) return
                  const fallback = currentCapture.imageSize ?? currentCapture.result.viewport
                  const point = imagePoint(event.clientX, event.clientY, fallback)
                  dragging.current = true
                  dragOrigin.current = point
                  setDragFrom(point)
                  setDragTo(point)
                  event.currentTarget.setPointerCapture(event.pointerId)
                }}
                onPointerMove={(event) => {
                  if (!dragging.current || currentCapture === null) return
                  const fallback = currentCapture.imageSize ?? currentCapture.result.viewport
                  setDragTo(imagePoint(event.clientX, event.clientY, fallback))
                }}
                onPointerUp={(event) => {
                  if (!dragging.current) return
                  dragging.current = false
                  if (currentCapture === null) return
                  const fallback = currentCapture.imageSize ?? currentCapture.result.viewport
                  const end = imagePoint(event.clientX, event.clientY, fallback)
                  const from = dragOrigin.current ?? end
                  setDragTo(end)
                  event.currentTarget.releasePointerCapture(event.pointerId)
                  finishSelection(from, end)
                }}
                onPointerCancel={() => {
                  dragging.current = false
                  dragOrigin.current = null
                  setDragFrom(null)
                  setDragTo(null)
                }}
              >
                <img
                  ref={imageRef}
                  src={currentCapture.result.dataUrl}
                  alt={`Remote browser screenshot of ${currentCapture.result.url}`}
                  style={{ display: 'block', maxWidth: '100%', height: 'auto', borderRadius: 6, userSelect: 'none' }}
                  draggable={false}
                />
                {dragBox !== null ? overlay(dragBox, false) : null}
                {dragBox === null && currentCapture.selection !== null
                  ? overlay(currentCapture.selection, true)
                  : null}
              </div>
            )}
          </div>

          <div
            style={{
              background: RAISED,
              border: `1px solid ${LINE}`,
              borderRadius: 10,
              padding: '8px 10px',
              maxHeight: 240,
              overflow: 'auto'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: MUTED }}>
                Real responses from this session
              </span>
              <span style={{ flex: 1 }} />
              <input
                type="search"
                value={networkFilter}
                onChange={(event) => setNetworkFilter(event.target.value)}
                placeholder="filter by URL…"
                aria-label="Filter captured responses by URL"
                style={{
                  width: 160,
                  fontSize: 12,
                  padding: '3px 8px',
                  borderRadius: 8,
                  border: `1px solid ${LINE}`,
                  background: INSET,
                  color: TEXT
                }}
              />
              <button
                type="button"
                className="ghost"
                onClick={() => void readNetwork()}
                disabled={session === null || busy !== null}
              >
                read
              </button>
            </div>

            {network === null ? (
              <p style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                Huddle records the responses this remote session produced, with a size-bounded body, so a QA agent can
                compare a payload with what the UI actually shows. Press <em>read</em> to load them; the agents read
                the same captures through their browser tool.
              </p>
            ) : network.length === 0 ? (
              <p style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                Nothing captured matched{networkFilter.trim().length > 0 ? ` “${networkFilter.trim()}”` : ' this session'} yet.
                Navigate or reload in the session and read again.
              </p>
            ) : (
              <ol style={{ listStyle: 'none', display: 'grid', gap: 6, marginTop: 6 }}>
                {network
                  .slice()
                  .reverse()
                  .map((entry, index) => (
                    <li key={`${entry.url}-${String(index)}`} style={{ display: 'grid', gap: 2 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
                        <span
                          className="mono"
                          style={{ fontSize: 11.5, color: entry.status >= 400 ? DANGER : ACCENT }}
                        >
                          {entry.status}
                        </span>
                        <span className="mono" style={{ fontSize: 11.5, color: MUTED }}>
                          {entry.method}
                        </span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 11.5,
                            color: TEXT,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                          title={entry.url}
                        >
                          {entry.url}
                        </span>
                      </div>
                      {entry.body.length > 0 ? (
                        <details>
                          <summary style={{ fontSize: 11.5, color: MUTED, cursor: 'pointer' }}>
                            body · {formatBytes(entry.body.length)}
                          </summary>
                          <pre
                            className="mono"
                            style={{
                              fontSize: 11.5,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              background: INSET,
                              borderRadius: 6,
                              padding: 8,
                              marginTop: 4,
                              maxHeight: 200,
                              overflow: 'auto'
                            }}
                          >
                            {entry.body}
                          </pre>
                        </details>
                      ) : (
                        <span style={{ fontSize: 11.5, color: MUTED }}>no body was captured for this response</span>
                      )}
                    </li>
                  ))}
              </ol>
            )}
          </div>
        </div>

        {/* ---------------- evidence ---------------- */}
        <div style={{ display: 'grid', gap: 8, alignContent: 'start', minHeight: 0 }}>
          <div style={{ background: RAISED, border: `1px solid ${LINE}`, borderRadius: 10, padding: '8px 10px' }}>
            <span style={{ fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: MUTED }}>
              Screenshot evidence
            </span>
            {captures.length === 0 && priorArtifacts.length === 0 ? (
              <p style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                No screenshot artifact exists for {ownerLabel(owner, agent)} yet. Every capture is written to the
                room&apos;s artifact folder with its real pixel size, which is what makes it evidence rather than a
                claim.
              </p>
            ) : (
              <ol style={{ listStyle: 'none', display: 'grid', gap: 10, marginTop: 6 }}>
                {captures.map((item) => {
                  const size = item.imageSize ?? item.result.viewport
                  return (
                    <li key={item.at} style={{ display: 'grid', gap: 2 }}>
                      <span style={{ fontSize: 12 }}>
                        {String(size.width)}×{String(size.height)} px ·{' '}
                        {formatBytes(item.result.artifact.bytes)} · {formatClock(item.at)}
                      </span>
                      <span className="mono" style={{ fontSize: 11, color: MUTED, wordBreak: 'break-all' }}>
                        {item.result.artifact.path !== null
                          ? basename(item.result.artifact.path)
                          : 'no file path was recorded'}
                      </span>
                      <span style={{ fontSize: 11.5, color: MUTED, wordBreak: 'break-all' }}>
                        {item.result.url}
                      </span>
                      {item.note !== null ? (
                        <span style={{ fontSize: 11.5, color: ACCENT }}>{item.note}</span>
                      ) : null}
                    </li>
                  )
                })}
                {priorArtifacts.map((artifact) => {
                  const size = dimensionsFrom(artifact.title)
                  return (
                    <li key={artifact.id} style={{ display: 'grid', gap: 2 }}>
                      <span style={{ fontSize: 12 }}>
                        {size !== null
                          ? `${String(size.width)}×${String(size.height)} px · `
                          : 'pixel size not recorded · '}
                        {formatBytes(artifact.bytes)} · {formatStamp(artifact.createdAt)}
                      </span>
                      <span style={{ fontSize: 11.5, color: MUTED }} title={artifact.title}>
                        {artifact.title}
                      </span>
                      {artifact.path !== null ? (
                        <button
                          type="button"
                          className="ghost"
                          style={{ justifySelf: 'start', fontSize: 11.5 }}
                          onClick={() => void window.huddle.settings.revealPath(artifact.path ?? '')}
                          title={artifact.path}
                        >
                          show {basename(artifact.path)} in the folder
                        </button>
                      ) : null}
                    </li>
                  )
                })}
              </ol>
            )}
          </div>

          <div style={{ background: RAISED, border: `1px solid ${LINE}`, borderRadius: 10, padding: '8px 10px' }}>
            <span style={{ fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: MUTED }}>
              What this session is
            </span>
            <ul style={{ listStyle: 'none', display: 'grid', gap: 4, marginTop: 6, fontSize: 12, color: MUTED }}>
              <li>Started {formatStamp(session?.startedAt ?? null)}</li>
              <li>Owner: {sessionAgent?.name ?? 'no teammate'}</li>
              <li>Provider session: {session?.remoteId ?? 'none yet'}</li>
              <li>Live view: {liveViewAvailable ? 'available' : 'not provided'}</li>
              <li>
                Reachable from Browserbase&apos;s cloud, not this laptop, so a localhost URL can never work here.
              </li>
              <li>The page never receives Huddle&apos;s preload API, a file path or a credential.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
