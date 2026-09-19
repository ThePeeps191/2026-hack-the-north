import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'
import Editor, { loader } from '@monaco-editor/react'
/**
 * Monaco is imported from `editor/editor.api` rather than the package root.
 *
 * The published `monaco-editor` ESM entry (`esm/vs/index.js`) imports
 * `../external/monaco-lsp-client/out/index.js`, a directory that this npm
 * release does not ship, so `import * as monaco from 'monaco-editor'` cannot be
 * resolved by the bundler. `editor.api` is the core editor (the same namespace
 * `@monaco-editor/loader` types `config({ monaco })` against) and the register
 * file adds every grammar. Grammars are loaded lazily, so the editor still
 * starts even if a grammar chunk never arrives.
 */
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/languages/definitions/register.all.js'
import { NO_PROJECT_DETAIL, type SurfaceProps } from '../contract.ts'
import type { DirEntry, FileContents, WorkspaceDiff } from '../../../../shared/api.ts'

/**
 * The Code surface: the real file on disk, the real diff, and real paths.
 *
 * Monaco is bundled locally (`loader.config({ monaco })`) instead of being
 * fetched from a CDN, because the renderer runs sandboxed and may have no
 * network at all. If Monaco still cannot come up — no workers in the sandbox, a
 * CSP that blocks blob URLs, a slow first paint — the surface degrades to a real
 * read-only `<pre>` viewer with line numbers and says so in a visible note. It
 * never render an empty box that looks like a broken editor.
 */

loader.config({ monaco })

const MUTED = 'var(--muted, #a39b8f)'
const LINE = 'var(--line, rgba(232, 226, 214, 0.1))'
const RAISED = 'var(--bg-raised, #1b1f26)'
const INSET = 'var(--bg-inset, #101217)'
const TEXT = 'var(--text, #ece7dc)'
const ACCENT = 'var(--accent, #d4a054)'
const DANGER = 'var(--danger, #e08a7a)'
const MONO = 'var(--font-mono, ui-monospace, monospace)'
const MONACO_READY_TIMEOUT_MS = 5000

interface MonacoBoundaryState {
  failed: boolean
}

/** Catches a throw from Monaco and reports it instead of killing the stage. */
class MonacoErrorBoundary extends Component<
  { onFailure: () => void; children: ReactNode },
  MonacoBoundaryState
> {
  state: MonacoBoundaryState = { failed: false }

  static getDerivedStateFromError(): MonacoBoundaryState {
    return { failed: true }
  }

  componentDidCatch(): void {
    this.props.onFailure()
  }

  render(): ReactNode {
    if (this.state.failed) return null
    return this.props.children
  }
}

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
  return date.toLocaleString()
}

/** One truthful line about the diff actually loaded, never an estimate. */
function diffLabel(diff: WorkspaceDiff | null): string {
  if (!diff) return 'no diff loaded'
  if (diff.files.length === 0) return diff.note ?? 'no changes'
  const additions = diff.files.reduce((total, file) => total + file.additions, 0)
  const deletions = diff.files.reduce((total, file) => total + file.deletions, 0)
  return `${diff.files.length} file${diff.files.length === 1 ? '' : 's'} changed, +${additions} −${deletions}`
}

function statusColor(status: WorkspaceDiff['files'][number]['status']): string {
  if (status === 'added') return '#8fbf7f'
  if (status === 'deleted') return DANGER
  if (status === 'renamed') return '#9db4d8'
  return ACCENT
}

/** Real text with line numbers, used when Monaco cannot render. */
function PlainTextViewer({ text, highlight }: { text: string; highlight?: [number, number] }): JSX.Element {
  const lines = text.split('\n')
  const [from, to] = highlight ?? [0, 0]
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'fit-content(6ch) minmax(0, 1fr)',
        gap: 0,
        fontFamily: MONO,
        fontSize: 12.5,
        lineHeight: 1.55,
        overflow: 'auto',
        height: '100%',
        background: INSET
      }}
    >
      <div aria-hidden="true" style={{ padding: '8px 8px 8px 12px', color: MUTED, textAlign: 'right', userSelect: 'none' }}>
        {lines.map((_, index) => (
          <div key={`n-${index}`}>{index + 1}</div>
        ))}
      </div>
      <div style={{ padding: '8px 12px' }}>
        {lines.map((line, index) => {
          const number = index + 1
          const selected = from > 0 && number >= from && number <= to
          return (
            <div
              key={`l-${index}`}
              style={{
                whiteSpace: 'pre',
                background: selected ? 'rgba(212, 160, 84, 0.14)' : 'transparent',
                color: TEXT
              }}
            >
              {line.length === 0 ? ' ' : line}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function EmptyState({ title, body, fix }: { title: string; body: string; fix?: string }): JSX.Element {
  return (
    <div style={{ padding: '28px 24px', maxWidth: 620 }}>
      <h3 style={{ fontSize: 15, marginBottom: 8 }}>{title}</h3>
      <p style={{ color: MUTED }}>{body}</p>
      {fix !== undefined ? (
        <p style={{ color: MUTED, marginTop: 8, fontFamily: MONO, fontSize: 12 }}>{fix}</p>
      ) : null}
    </div>
  )
}

export function CodeSurface(props: SurfaceProps): JSX.Element {
  const { workspace, agent, editable, onAttachRef } = props

  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<string[]>([''])
  const [treeError, setTreeError] = useState<string | null>(null)
  const [treeLoading, setTreeLoading] = useState(false)

  const [file, setFile] = useState<FileContents | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const [view, setView] = useState<'file' | 'diff'>('file')
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffPath, setDiffPath] = useState<string | null>(null)

  const [editorMode, setEditorMode] = useState<'monaco' | 'plain'>('monaco')
  const [monacoState, setMonacoState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [monacoKey, setMonacoKey] = useState(0)
  const [selection, setSelection] = useState<{ startLine: number; endLine: number } | null>(null)
  const fileRevision = useRef(0)

  const workspaceId = workspace?.id ?? null

  const describeError = useCallback((error: unknown): string => {
    if (error instanceof Error) {
      return error.name !== 'Error' && error.name.length > 0
        ? `${error.name}: ${error.message}`
        : error.message
    }
    return 'Unknown error'
  }, [])

  const loadDir = useCallback(
    async (path: string): Promise<void> => {
      if (workspaceId === null) return
      setTreeLoading(true)
      try {
        const entries = await window.huddle.exec.listDir({ workspaceId, path: path.length === 0 ? undefined : path })
        setChildren((previous) => ({ ...previous, [path]: entries }))
        setTreeError(null)
      } catch (error) {
        setTreeError(describeError(error))
      } finally {
        setTreeLoading(false)
      }
    },
    [describeError, workspaceId]
  )

  useEffect(() => {
    setChildren({})
    setExpanded([''])
    setTreeError(null)
    setFile(null)
    setSelectedPath(null)
    setFileError(null)
    setDiff(null)
    setDiffError(null)
    setDiffPath(null)
    setSelection(null)
    if (workspaceId !== null) void loadDir('')
  }, [loadDir, workspaceId])

  useEffect(() => {
    if (monacoState !== 'loading' || editorMode !== 'monaco') return undefined
    const timer = setTimeout(() => {
      setMonacoState((current) => (current === 'loading' ? 'failed' : current))
    }, MONACO_READY_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [editorMode, monacoState, monacoKey])

  const openFile = useCallback(
    async (path: string): Promise<void> => {
      if (workspaceId === null) return
      setSelectedPath(path)
      setView('file')
      setFileLoading(true)
      setFileError(null)
      setSelection(null)
      const revision = fileRevision.current + 1
      fileRevision.current = revision
      try {
        const contents = await window.huddle.exec.readFile({ workspaceId, path })
        if (fileRevision.current !== revision) return
        setFile(contents)
      } catch (error) {
        if (fileRevision.current !== revision) return
        setFile(null)
        setFileError(describeError(error))
      } finally {
        if (fileRevision.current === revision) setFileLoading(false)
      }
    },
    [describeError, workspaceId]
  )

  const loadDiff = useCallback(async (): Promise<void> => {
    if (workspaceId === null) return
    setDiffError(null)
    setView('diff')
    try {
      const result = await window.huddle.exec.diff(workspaceId)
      setDiff(result)
      setDiffPath((current) => {
        if (current !== null && result.files.some((entry) => entry.path === current)) return current
        return result.files[0]?.path ?? null
      })
    } catch (error) {
      setDiff(null)
      setDiffError(describeError(error))
    }
  }, [describeError, workspaceId])

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

  const attachSelection = useCallback((): void => {
    if (selectedPath === null) return
    const ref: {
      kind: 'file'
      path: string
      startLine?: number
      endLine?: number
      agentId?: string
      excerpt?: string
    } = { kind: 'file', path: selectedPath }
    if (selection !== null) {
      ref.startLine = selection.startLine
      ref.endLine = selection.endLine
      if (file !== null) {
        const lines = file.text.split('\n').slice(selection.startLine - 1, selection.endLine)
        ref.excerpt = lines.join('\n').slice(0, 2000)
      }
    }
    if (agent !== null) ref.agentId = agent.id
    onAttachRef(ref)
  }, [agent, file, onAttachRef, selectedPath, selection])

  if (workspace === null) {
    return (
      <EmptyState
        title="No project bound"
        body={NO_PROJECT_DETAIL}
        fix="Nothing is being faked here: the editor has no workspace to read from."
      />
    )
  }

  const renderTree = (path: string, depth: number): JSX.Element => {
    const entries = children[path] ?? []
    return (
      <ul role="group" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {entries.map((entry) => {
          const isDir = entry.kind === 'dir'
          const isOpen = expanded.includes(entry.path)
          const isSelected = selectedPath === entry.path
          return (
            <li key={entry.path}>
              <button
                type="button"
                aria-expanded={isDir ? isOpen : undefined}
                aria-current={isSelected ? 'true' : undefined}
                aria-label={isDir ? `${entry.name}, folder` : `${entry.name}, file, ${formatBytes(entry.bytes)}`}
                title={entry.path}
                onClick={() => {
                  if (isDir) toggleDir(entry.path)
                  else void openFile(entry.path)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  textAlign: 'left',
                  padding: '3px 8px 3px ' + `${8 + depth * 12}px`,
                  borderRadius: 6,
                  background: isSelected ? 'rgba(212, 160, 84, 0.16)' : 'transparent',
                  color: isSelected ? TEXT : isDir ? TEXT : MUTED,
                  fontFamily: isDir ? 'inherit' : MONO,
                  fontSize: 12.5
                }}
              >
                <span aria-hidden="true" style={{ width: 12, color: MUTED }}>
                  {isDir ? (isOpen ? '▾' : '▸') : '·'}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {entry.name}
                </span>
                {!isDir && entry.bytes !== null ? (
                  <span style={{ color: MUTED, fontSize: 11 }}>{formatBytes(entry.bytes)}</span>
                ) : null}
              </button>
              {isDir && isOpen ? renderTree(entry.path, depth + 1) : null}
            </li>
          )
        })}
      </ul>
    )
  }

  const monacoUsable = editorMode === 'monaco' && monacoState !== 'failed'
  const plainHighlight: [number, number] =
    selection !== null ? [selection.startLine, selection.endLine] : [0, 0]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 260px) minmax(0, 1fr)', height: '100%', minHeight: 0 }}>
      <div
        style={{ borderRight: `1px solid ${LINE}`, overflow: 'auto', background: RAISED, minHeight: 0 }}
        aria-label="Project files"
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', borderBottom: `1px solid ${LINE}` }}>
          <span style={{ fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase', color: MUTED }}>
            {workspace.isWorktree ? agent?.name ?? 'Agent' : 'Team'} files
          </span>
          <button
            type="button"
            onClick={() => void loadDir('')}
            aria-label="Refresh file list"
            style={{ color: MUTED, fontSize: 11.5 }}
          >
            {treeLoading ? 'loading…' : 'refresh'}
          </button>
        </div>
        {treeError !== null ? (
          <p role="alert" style={{ padding: '10px 12px', color: DANGER, fontSize: 12 }}>
            Could not list {workspace.rootPath}: {treeError}
          </p>
        ) : null}
        {children[''] === undefined && treeError === null ? (
          <p style={{ padding: '10px 12px', color: MUTED, fontSize: 12 }}>Reading the folder…</p>
        ) : null}
        {children['']?.length === 0 && treeError === null ? (
          <p style={{ padding: '10px 12px', color: MUTED, fontSize: 12 }}>This folder is empty.</p>
        ) : null}
        {renderTree('', 0)}
      </div>

      <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', minHeight: 0, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
            borderBottom: `1px solid ${LINE}`,
            background: RAISED,
            flexWrap: 'wrap'
          }}
        >
          <div role="tablist" aria-label="Code view" style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'file'}
              onClick={() => setView('file')}
              style={{
                padding: '3px 10px',
                borderRadius: 999,
                fontSize: 12,
                background: view === 'file' ? 'rgba(212, 160, 84, 0.18)' : 'transparent',
                color: view === 'file' ? TEXT : MUTED
              }}
            >
              File
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'diff'}
              onClick={() => void loadDiff()}
              style={{
                padding: '3px 10px',
                borderRadius: 999,
                fontSize: 12,
                background: view === 'diff' ? 'rgba(212, 160, 84, 0.18)' : 'transparent',
                color: view === 'diff' ? TEXT : MUTED
              }}
            >
              Diff
            </button>
          </div>
          <span style={{ color: MUTED, fontSize: 12, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {view === 'file' ? selectedPath ?? 'pick a file' : diffLabel(diff)}
          </span>
          <span style={{ flex: 1 }} />
          {view === 'file' ? (
            <>
              <button
                type="button"
                onClick={attachSelection}
                disabled={selectedPath === null}
                style={{
                  padding: '3px 10px',
                  borderRadius: 999,
                  fontSize: 12,
                  background: selectedPath === null ? 'transparent' : 'var(--accent, #d4a054)',
                  color: selectedPath === null ? MUTED : 'var(--accent-text, #1a140c)'
                }}
                title="Attach this file (or the selected lines) to the composer"
              >
                Attach
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditorMode(editorMode === 'monaco' ? 'plain' : 'monaco')
                  if (editorMode === 'plain') {
                    setMonacoState('loading')
                    setMonacoKey((current) => current + 1)
                  }
                }}
                style={{ fontSize: 11.5, color: MUTED }}
                aria-label={editorMode === 'monaco' ? 'Switch to the plain text viewer' : 'Try the Monaco editor again'}
              >
                {editorMode === 'monaco' ? 'plain viewer' : 'editor'}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => void loadDiff()} style={{ fontSize: 11.5, color: MUTED }}>
              refresh diff
            </button>
          )}
        </div>

        <div style={{ minHeight: 0, overflow: 'hidden', background: INSET }}>
          {view === 'file' ? (
            <FilePane
              file={file}
              error={fileError}
              loading={fileLoading}
              hasSelection={selectedPath !== null}
              monacoUsable={monacoUsable}
              monacoKey={monacoKey}
              plainHighlight={plainHighlight}
              onMonacoReady={() => setMonacoState('ready')}
              onMonacoFailure={() => setMonacoState('failed')}
              onSelection={(selectionLines) => setSelection(selectionLines)}
            />
          ) : (
            <DiffPane
              diff={diff}
              error={diffError}
              activePath={diffPath}
              onSelectPath={setDiffPath}
              onAttach={(path) => {
                const ref = { kind: 'file' as const, path }
                if (agent !== null) onAttachRef({ ...ref, agentId: agent.id })
                else onAttachRef(ref)
              }}
            />
          )}
        </div>

        <div
          style={{
            borderTop: `1px solid ${LINE}`,
            padding: '6px 12px',
            fontSize: 11.5,
            color: MUTED,
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            background: RAISED
          }}
        >
          <span>{workspace.rootPath}</span>
          <span>{workspace.isWorktree ? 'agent worktree' : 'shared workspace'}</span>
          <span>{workspace.branch === null ? 'no branch (not a git repository)' : `branch ${workspace.branch}`}</span>
          {editable ? <span>writes go through the team integrator</span> : null}
          {file !== null && view === 'file' ? <span>modified {formatWhen(file.modifiedAt)}</span> : null}
        </div>
      </div>
    </div>
  )
}

function FilePane({
  file,
  error,
  loading,
  hasSelection,
  monacoUsable,
  monacoKey,
  plainHighlight,
  onMonacoReady,
  onMonacoFailure,
  onSelection
}: {
  file: FileContents | null
  error: string | null
  loading: boolean
  hasSelection: boolean
  monacoUsable: boolean
  monacoKey: number
  plainHighlight: [number, number]
  onMonacoReady: () => void
  onMonacoFailure: () => void
  onSelection: (selection: { startLine: number; endLine: number } | null) => void
}): JSX.Element {
  if (error !== null) {
    return (
      <div style={{ padding: '24px' }}>
        <h3 style={{ fontSize: 14, marginBottom: 6 }}>Could not read this file</h3>
        <p role="alert" style={{ color: DANGER, fontFamily: MONO, fontSize: 12.5 }}>
          {error}
        </p>
        <p style={{ color: MUTED, marginTop: 8, fontSize: 12 }}>
          Binary files and files over 8 MB are refused by the execution host. Nothing is shown that was not read.
        </p>
      </div>
    )
  }
  if (!hasSelection) {
    return (
      <div style={{ padding: '24px', color: MUTED }}>
        <h3 style={{ fontSize: 14, marginBottom: 6, color: 'var(--text, #ece7dc)' }}>Pick a file</h3>
        <p>The list on the left is the real folder on disk. Choose a file to read its bytes.</p>
      </div>
    )
  }
  if (loading) {
    return <p style={{ padding: '24px', color: MUTED }}>Reading the file…</p>
  }
  if (file === null) {
    return <p style={{ padding: '24px', color: MUTED }}>No file loaded.</p>
  }

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', height: '100%', minHeight: 0 }}>
      {file.truncated ? (
        <p
          role="status"
          style={{ padding: '6px 12px', background: 'rgba(212, 160, 84, 0.12)', color: TEXT, fontSize: 12 }}
        >
          Showing the first {file.text.length.toLocaleString()} characters of {formatBytes(file.bytes)}. The editor
          is not pretending the rest is empty.
        </p>
      ) : null}
      <div style={{ minHeight: 0 }}>
        {monacoUsable ? (
          <MonacoErrorBoundary
            key={monacoKey}
            onFailure={() => {
              onMonacoFailure()
            }}
          >
            <Editor
              key={`${file.relativePath}-${monacoKey}`}
              height="100%"
              theme="vs-dark"
              language={file.language}
              value={file.text}
              loading={<p style={{ padding: 16, color: MUTED }}>Starting the Monaco editor…</p>}
              onMount={(editor) => {
                onMonacoReady()
                editor.onDidChangeCursorSelection(() => {
                  const current = editor.getSelection()
                  if (current === null) {
                    onSelection(null)
                    return
                  }
                  onSelection({
                    startLine: current.startLineNumber,
                    endLine: current.endLineNumber
                  })
                })
              }}
              options={{
                readOnly: true,
                domReadOnly: true,
                minimap: { enabled: false },
                lineNumbers: 'on',
                fontSize: 12.5,
                scrollBeyondLastLine: false,
                renderWhitespace: 'selection',
                automaticLayout: true,
                contextmenu: false,
                wordWrap: 'off'
              }}
            />
          </MonacoErrorBoundary>
        ) : (
          <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', height: '100%', minHeight: 0 }}>
            <p style={{ padding: '6px 12px', color: MUTED, fontSize: 11.5 }}>
              Monaco did not start in this renderer, so this is the real file text with line numbers — a plain
              read-only viewer, not a simulated editor.
            </p>
            <PlainTextViewer text={file.text} highlight={plainHighlight} />
          </div>
        )}
      </div>
    </div>
  )
}

function DiffPane({
  diff,
  error,
  activePath,
  onSelectPath,
  onAttach
}: {
  diff: WorkspaceDiff | null
  error: string | null
  activePath: string | null
  onSelectPath: (path: string) => void
  onAttach: (path: string) => void
}): JSX.Element {
  if (error !== null) {
    return (
      <div style={{ padding: 24 }}>
        <h3 style={{ fontSize: 14, marginBottom: 6 }}>Could not compute the diff</h3>
        <p role="alert" style={{ color: DANGER, fontFamily: MONO, fontSize: 12.5 }}>{error}</p>
      </div>
    )
  }
  if (diff === null) {
    return <p style={{ padding: 24, color: MUTED }}>Reading git…</p>
  }
  const active = diff.files.find((entry) => entry.path === activePath) ?? null

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', height: '100%', minHeight: 0 }}>
      {diff.note !== null ? (
        <p style={{ padding: '6px 12px', background: 'rgba(212, 160, 84, 0.12)', fontSize: 12 }} role="status">
          {diff.note}
        </p>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 240px) minmax(0, 1fr)', minHeight: 0 }}>
        <div style={{ borderRight: `1px solid ${LINE}`, overflow: 'auto', background: RAISED }}>
          {diff.files.length === 0 ? (
            <p style={{ padding: 12, color: MUTED, fontSize: 12 }}>
              No tracked changes{diff.revision === null ? '' : ` against ${diff.baseBranch ?? 'HEAD'}`} right now.
            </p>
          ) : null}
          <ul style={{ listStyle: 'none', margin: 0, padding: 4 }}>
            {diff.files.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  aria-current={entry.path === activePath ? 'true' : undefined}
                  onClick={() => onSelectPath(entry.path)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '48px minmax(0, 1fr)',
                    gap: 6,
                    width: '100%',
                    textAlign: 'left',
                    padding: '4px 6px',
                    borderRadius: 6,
                    background: entry.path === activePath ? 'rgba(212, 160, 84, 0.16)' : 'transparent',
                    fontFamily: MONO,
                    fontSize: 12
                  }}
                >
                  <span style={{ color: statusColor(entry.status) }}>
                    {entry.status === 'added'
                      ? 'new'
                      : entry.status === 'deleted'
                        ? 'del'
                        : entry.status === 'renamed'
                          ? 'ren'
                          : 'mod'}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.path}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div style={{ minHeight: 0, overflow: 'auto' }}>
          {active === null ? (
            <p style={{ padding: 16, color: MUTED, fontSize: 12.5 }}>
              Select a changed file to read its real <code>git diff</code> output.
            </p>
          ) : (
            <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', height: '100%', minHeight: 0 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '6px 10px', borderBottom: `1px solid ${LINE}` }}>
                <span style={{ fontFamily: MONO, fontSize: 12 }}>{active.path}</span>
                <span style={{ color: '#8fbf7f', fontSize: 12 }}>+{active.additions}</span>
                <span style={{ color: DANGER, fontSize: 12 }}>-{active.deletions}</span>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={() => onAttach(active.path)} style={{ fontSize: 11.5, color: ACCENT }}>
                  attach file
                </button>
              </div>
              <PlainTextViewer text={active.patch} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
