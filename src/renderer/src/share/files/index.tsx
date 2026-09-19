import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { NO_PROJECT_DETAIL, type SurfaceProps } from '../contract.ts'
import type { DirEntry, FileContents } from '../../../../shared/api.ts'

/**
 * The Files surface: the real project tree and the real bytes of a file.
 *
 * Everything is read through `window.huddle.exec` — the same execution host the
 * agents use, so what a judge sees here is exactly what a tool would read. The
 * tree is lazy (one directory per request), the preview is truncated at the
 * host's read limit and says so, and the search box filters the paths that are
 * actually loaded because the preload API exposes no whole-project search
 * channel. It never shows a file it did not read.
 */

const MUTED = 'var(--muted, #a39b8f)'
const LINE = 'var(--line, rgba(232, 226, 214, 0.1))'
const RAISED = 'var(--bg-raised, #1b1f26)'
const INSET = 'var(--bg-inset, #101217)'
const TEXT = 'var(--text, #ece7dc)'
const ACCENT = 'var(--accent, #d4a054)'
const DANGER = 'var(--danger, #e08a7a)'
const MONO = 'var(--font-mono, ui-monospace, monospace)'

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatWhen(iso: string | null): string {
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

function languageHint(path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'text'
  return name.slice(dot + 1).toLowerCase()
}

export function FilesSurface(props: SurfaceProps): JSX.Element {
  const { workspace, agent, onAttachRef } = props
  const workspaceId = workspace?.id ?? null

  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<string[]>([''])
  const [treeError, setTreeError] = useState<string | null>(null)
  const [loadingDirs, setLoadingDirs] = useState<string[]>([])

  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<FileContents | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [attached, setAttached] = useState<string | null>(null)

  const [filter, setFilter] = useState('')
  const requestRef = useRef(0)

  const describeError = useCallback((error: unknown): string => {
    return error instanceof Error ? error.message : 'Unknown error'
  }, [])

  const loadDir = useCallback(
    async (path: string): Promise<void> => {
      if (workspaceId === null) return
      setLoadingDirs((previous) => (previous.includes(path) ? previous : [...previous, path]))
      try {
        const entries = await window.huddle.exec.listDir({
          workspaceId,
          path: path.length === 0 ? undefined : path
        })
        setChildren((previous) => ({ ...previous, [path]: entries }))
        setTreeError(null)
      } catch (error) {
        setTreeError(describeError(error))
      } finally {
        setLoadingDirs((previous) => previous.filter((entry) => entry !== path))
      }
    },
    [describeError, workspaceId]
  )

  useEffect(() => {
    setChildren({})
    setExpanded([''])
    setSelected(null)
    setFile(null)
    setFileError(null)
    setTreeError(null)
    setAttached(null)
    setFilter('')
    if (workspaceId !== null) void loadDir('')
  }, [loadDir, workspaceId])

  const openFile = useCallback(
    async (path: string): Promise<void> => {
      if (workspaceId === null) return
      const request = requestRef.current + 1
      requestRef.current = request
      setSelected(path)
      setFileLoading(true)
      setFileError(null)
      setAttached(null)
      try {
        const contents = await window.huddle.exec.readFile({ workspaceId, path })
        if (requestRef.current !== request) return
        setFile(contents)
      } catch (error) {
        if (requestRef.current !== request) return
        setFile(null)
        setFileError(describeError(error))
      } finally {
        if (requestRef.current === request) setFileLoading(false)
      }
    },
    [describeError, workspaceId]
  )

  const toggleDir = useCallback(
    (path: string): void => {
      setExpanded((previous) => {
        if (previous.includes(path)) return previous.filter((entry) => entry !== path)
        if (children[path] === undefined) void loadDir(path)
        return [...previous, path]
      })
    },
    [children, loadDir]
  )

  const visibleEntries = useCallback(
    (path: string): DirEntry[] => {
      const entries = children[path] ?? []
      const needle = filter.trim().toLowerCase()
      if (needle.length === 0) return entries
      return entries.filter((entry) => entry.path.toLowerCase().includes(needle))
    },
    [children, filter]
  )

  const loadedCount = useMemo(
    () => Object.values(children).reduce((total, entries) => total + entries.length, 0),
    [children]
  )

  if (workspace === null) {
    return (
      <div style={{ padding: '28px 24px', maxWidth: 620 }}>
        <h3 style={{ fontSize: 15, marginBottom: 8 }}>No project bound</h3>
        <p style={{ color: MUTED }}>{NO_PROJECT_DETAIL}</p>
        <p style={{ color: MUTED, marginTop: 8, fontSize: 12 }}>
          The file tree reads a real folder through the execution host; with no binding there is nothing to list.
        </p>
      </div>
    )
  }

  const renderTree = (path: string, depth: number): JSX.Element => {
    const entries = visibleEntries(path)
    const isLoading = loadingDirs.includes(path)
    return (
      <ul role="group" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {path === '' && entries.length === 0 && isLoading ? (
          <li style={{ padding: '4px 10px', color: MUTED, fontSize: 12 }}>Reading the folder…</li>
        ) : null}
        {path !== '' && entries.length === 0 ? (
          <li style={{ padding: '4px 10px', color: MUTED, fontSize: 12 }}>[empty]</li>
        ) : null}
        {entries.map((entry) => {
          const isDir = entry.kind === 'dir'
          const isOpen = expanded.includes(entry.path)
          const isSelected = selected === entry.path
          return (
            <li key={entry.path}>
              <button
                type="button"
                aria-expanded={isDir ? isOpen : undefined}
                aria-current={isSelected ? 'true' : undefined}
                aria-label={
                  isDir
                    ? `Folder ${entry.path}`
                    : `File ${entry.path}, ${formatBytes(entry.bytes)}, modified ${formatWhen(entry.modifiedAt)}`
                }
                title={entry.path}
                onClick={() => {
                  if (isDir) toggleDir(entry.path)
                  else void openFile(entry.path)
                }}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '12px minmax(0, 1fr) auto',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  textAlign: 'left',
                  padding: `3px 8px 3px ${8 + depth * 12}px`,
                  borderRadius: 6,
                  background: isSelected ? 'rgba(212, 160, 84, 0.16)' : 'transparent',
                  color: isSelected ? TEXT : isDir ? TEXT : MUTED,
                  fontFamily: isDir ? 'inherit' : MONO,
                  fontSize: 12.5
                }}
              >
                <span aria-hidden="true" style={{ color: MUTED }}>
                  {isDir ? (isOpen ? '▾' : '▸') : '·'}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.name}
                </span>
                <span style={{ color: MUTED, fontSize: 11 }}>{formatBytes(entry.bytes)}</span>
              </button>
              {isDir && isOpen ? renderTree(entry.path, depth + 1) : null}
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 300px) minmax(0, 1fr)', height: '100%', minHeight: 0 }}>
      <div style={{ borderRight: `1px solid ${LINE}`, background: RAISED, display: 'grid', gridTemplateRows: 'auto auto minmax(0, 1fr)', minHeight: 0 }}>
        <div style={{ padding: '8px 10px', borderBottom: `1px solid ${LINE}` }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: MUTED }}>
              {workspace.isWorktree ? `${agent?.name ?? 'Agent'}'s worktree` : 'Team project'}
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => void loadDir('')}
              aria-label="Reload the project tree"
              style={{ fontSize: 11.5, color: MUTED }}
            >
              reload
            </button>
          </div>
          <label style={{ display: 'block', marginTop: 6 }}>
            <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
              Filter loaded paths
            </span>
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter loaded paths…"
              style={{
                width: '100%',
                fontFamily: MONO,
                fontSize: 12,
                padding: '4px 8px',
                borderRadius: 8,
                border: `1px solid ${LINE}`,
                background: INSET,
                color: TEXT
              }}
            />
          </label>
          <p style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
            {loadedCount} path(s) loaded from disk. This filters what is loaded; ask an agent to search the whole
            project.
          </p>
        </div>
        <div />
        <div style={{ overflow: 'auto', minHeight: 0 }} aria-label="Project files">
          {treeError !== null ? (
            <p role="alert" style={{ padding: 12, color: DANGER, fontSize: 12 }}>
              {treeError}
            </p>
          ) : null}
          {renderTree('', 0)}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', minHeight: 0, minWidth: 0 }}>
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
          <span style={{ fontFamily: MONO, fontSize: 12 }}>{selected ?? 'no file selected'}</span>
          {file !== null ? (
            <>
              <span style={{ fontSize: 11.5, color: MUTED }}>
                {languageHint(file.relativePath)} · {formatBytes(file.bytes)} · {formatWhen(file.modifiedAt)}
              </span>
            </>
          ) : null}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            disabled={selected === null}
            onClick={() => {
              if (selected === null) return
              const ref = { kind: 'file' as const, path: selected }
              onAttachRef(agent !== null ? { ...ref, agentId: agent.id } : ref)
              setAttached(selected)
            }}
            style={{
              padding: '3px 10px',
              borderRadius: 999,
              fontSize: 12,
              background: selected === null ? 'transparent' : ACCENT,
              color: selected === null ? MUTED : 'var(--accent-text, #1a140c)'
            }}
            aria-label="Attach this file to the composer"
          >
            Attach
          </button>
          {attached !== null ? (
            <span role="status" style={{ fontSize: 11.5, color: MUTED }}>
              attached {attached}
            </span>
          ) : null}
        </div>

        <div style={{ minHeight: 0, overflow: 'auto', background: INSET }}>
          {fileError !== null ? (
            <div style={{ padding: 20 }}>
              <h3 style={{ fontSize: 14, marginBottom: 6 }}>Could not read this file</h3>
              <p role="alert" style={{ color: DANGER, fontFamily: MONO, fontSize: 12.5 }}>
                {fileError}
              </p>
              <p style={{ color: MUTED, marginTop: 8, fontSize: 12 }}>
                Huddle refuses binary files and files above 8 MB instead of showing an empty preview.
              </p>
            </div>
          ) : null}
          {fileError === null && selected === null ? (
            <div style={{ padding: 20, color: MUTED }}>
              <h3 style={{ fontSize: 14, marginBottom: 6, color: TEXT }}>Pick a file</h3>
              <p>Folders expand one level at a time, straight from disk.</p>
            </div>
          ) : null}
          {fileError === null && selected !== null && fileLoading ? (
            <p style={{ padding: 20, color: MUTED }}>Reading {selected}…</p>
          ) : null}
          {fileError === null && file !== null && !fileLoading ? (
            <div>
              {file.truncated ? (
                <p role="status" style={{ padding: '6px 12px', background: 'rgba(212, 160, 84, 0.12)', fontSize: 12 }}>
                  Truncated preview: showing the first {file.text.length.toLocaleString()} characters of{' '}
                  {formatBytes(file.bytes)}. The rest was not read into memory.
                </p>
              ) : null}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'fit-content(6ch) minmax(0, 1fr)',
                  fontFamily: MONO,
                  fontSize: 12.5,
                  lineHeight: 1.55
                }}
              >
                <div aria-hidden="true" style={{ padding: '10px 8px 10px 12px', color: MUTED, textAlign: 'right', userSelect: 'none' }}>
                  {file.text.split('\n').map((_, index) => (
                    <div key={`n-${index}`}>{index + 1}</div>
                  ))}
                </div>
                <div style={{ padding: '10px 12px 10px 0' }}>
                  {file.text.split('\n').map((line, index) => (
                    <div key={`l-${index}`} style={{ whiteSpace: 'pre', color: TEXT }}>
                      {line.length === 0 ? ' ' : line}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
