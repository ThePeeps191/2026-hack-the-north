import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import { NO_PROJECT_DETAIL, type SurfaceProps } from '../contract.ts'
import type { DirEntry, FileContents } from '../../../../shared/api.ts'
import '../../styles/workspace.css'

const HIDDEN_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'venv', '__pycache__'])
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'Unknown error'
const bytes = (value: number | null): string => value === null ? '—' : value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`
const date = (value: string | null): string => value === null || Number.isNaN(Date.parse(value)) ? '—' : new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const language = (path: string): string => { const name = path.split('/').pop() ?? path; const dot = name.lastIndexOf('.'); return dot <= 0 ? 'text' : name.slice(dot + 1).toLowerCase() }

export function FilesSurface({ workspace, agent, onAttachRef, openReference }: SurfaceProps): JSX.Element {
  const workspaceId = workspace?.id ?? null
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<string[]>([''])
  const [treeError, setTreeError] = useState<string | null>(null)
  const [loading, setLoading] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<FileContents | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [attached, setAttached] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [showGenerated, setShowGenerated] = useState(false)
  const request = useRef(0)
  const workspaceEpoch = useRef(0)

  const loadDir = useCallback(async (path: string): Promise<void> => {
    if (workspaceId === null) return
    const epoch = workspaceEpoch.current
    setLoading((current) => current.includes(path) ? current : [...current, path])
    try { const entries = await window.huddle.exec.listDir({ workspaceId, path: path || undefined }); if (workspaceEpoch.current === epoch) { setChildren((current) => ({ ...current, [path]: entries })); setTreeError(null) } }
    catch (error) { if (workspaceEpoch.current === epoch) setTreeError(errorText(error)) }
    finally { if (workspaceEpoch.current === epoch) setLoading((current) => current.filter((item) => item !== path)) }
  }, [workspaceId])

  useEffect(() => { workspaceEpoch.current += 1; request.current += 1; setChildren({}); setExpanded(['']); setSelected(null); setFile(null); setFileError(null); setTreeError(null); setAttached(null); setFilter(''); if (workspaceId !== null) void loadDir('') }, [loadDir, workspaceId])

  const openFile = useCallback(async (path: string): Promise<void> => {
    if (workspaceId === null) return
    const id = request.current + 1; request.current = id
    setSelected(path); setReading(true); setFileError(null); setAttached(null)
    try { const contents = await window.huddle.exec.readFile({ workspaceId, path }); if (request.current === id) setFile(contents) }
    catch (error) { if (request.current === id) { setFile(null); setFileError(errorText(error)) } }
    finally { if (request.current === id) setReading(false) }
  }, [workspaceId])
  useEffect(() => {
    if (openReference?.ref.kind === 'file') void openFile(openReference.ref.path)
  }, [openFile, openReference])
  const artifactFollow = openReference?.ref.kind === 'artifact'
  const toggle = useCallback((path: string): void => setExpanded((current) => { if (current.includes(path)) return current.filter((item) => item !== path); if (children[path] === undefined) void loadDir(path); return [...current, path] }), [children, loadDir])
  const entriesFor = useCallback((path: string) => { const needle = filter.trim().toLowerCase(); return (children[path] ?? []).filter((entry) => (showGenerated || !HIDDEN_DIRECTORIES.has(entry.name)) && (!needle || entry.path.toLowerCase().includes(needle))) }, [children, filter, showGenerated])
  const loadedCount = useMemo(() => Object.values(children).reduce((total, entries) => total + entries.length, 0), [children])

  if (workspace === null) return <div className="ws-empty"><h3>No project bound</h3><p>{NO_PROJECT_DETAIL}</p><p>The file tree is available after a folder is bound.</p></div>
  const tree = (path: string, depth: number): JSX.Element => {
    const entries = entriesFor(path)
    return <ul className="ws-tree" role="group">
      {entries.length === 0 ? <li className="ws-tree__state">{loading.includes(path) || children[path] === undefined ? 'Reading…' : filter.trim() ? 'No matching files' : path === '' ? 'This folder is empty.' : 'Empty folder'}</li> : null}
      {entries.map((entry) => { const folder = entry.kind === 'dir'; const open = expanded.includes(entry.path); const active = selected === entry.path; const style = { '--ws-tree-indent': `${depth * 12}px` } as CSSProperties
        return <li key={entry.path}><button type="button" className={`ws-tree__item${folder ? ' ws-tree__item--dir' : ''}`} style={style} aria-expanded={folder ? open : undefined} aria-current={active ? 'true' : undefined} title={entry.path} aria-label={folder ? `Folder ${entry.path}` : `File ${entry.path}, ${bytes(entry.bytes)}, modified ${date(entry.modifiedAt)}`} onClick={() => folder ? toggle(entry.path) : void openFile(entry.path)}><span className="ws-tree__glyph" aria-hidden="true">{folder ? (open ? '▾' : '▸') : '·'}</span><span className="ws-tree__name">{entry.name}</span><span className="ws-tree__size">{bytes(entry.bytes)}</span></button>{folder && open ? tree(entry.path, depth + 1) : null}</li>
      })}
    </ul>
  }
  const attach = (): void => { if (selected === null) return; onAttachRef(agent === null ? { kind: 'file', path: selected } : { kind: 'file', path: selected, agentId: agent.id }); setAttached(selected) }
  return <div className="ws-surface ws-layout ws-files"><aside className="ws-sidebar ws-files__sidebar"><div className="ws-sidebar__header ws-files__tools"><div className="ws-row"><span className="ws-eyebrow">{workspace.isWorktree ? `${agent?.name ?? 'Teammate'}’s files` : 'Team files'}</span><span className="ws-spacer" /><button type="button" className="ws-button" onClick={() => void loadDir('')}>Refresh</button></div><label className="ws-search"><span className="ws-sr-only">Filter loaded files</span><input className="ws-control" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter loaded files" /></label><div className="ws-row"><button type="button" className="ws-button" onClick={() => setShowGenerated((current) => !current)}>{showGenerated ? 'Hide generated' : 'Show generated'}</button><span className="ws-meta" title={`${loadedCount} entries loaded`}>{loadedCount} loaded</span></div></div><div className="ws-scroll" aria-label="Project files">{treeError !== null ? <p className="ws-state ws-error" role="alert">{treeError}</p> : null}{tree('', 0)}</div></aside><section className="ws-main"><header className="ws-header"><span className="ws-path" title={selected ?? undefined}>{selected === null ? 'No file selected' : selected.split('/').join(' / ')}</span>{file !== null ? <span className="ws-meta">{language(file.relativePath)} · {bytes(file.bytes)} · {date(file.modifiedAt)}</span> : null}<span className="ws-spacer" /><button type="button" className="ws-button ws-button--primary" disabled={selected === null} onClick={attach}>Attach</button>{attached !== null ? <span className="ws-meta" role="status">Attached {attached.split('/').pop()}</span> : null}</header><main className="ws-content">{fileError !== null ? <div className="ws-state"><h3>Could not read this file</h3><p className="ws-error ws-mono" role="alert">{fileError}</p><p>Binary files and files over 8 MB cannot be previewed.</p></div> : null}{fileError === null && selected === null && artifactFollow ? <div className="ws-state"><h3>This is a saved capture</h3><p>Open it from the Browser surface. The file tree only shows the project folder.</p></div> : null}
{fileError === null && selected === null && !artifactFollow ? <div className="ws-state"><h3>Select a file</h3><p>Select a file to view it.</p></div> : null}{fileError === null && selected !== null && reading ? <p className="ws-state">Reading {selected.split('/').pop()}…</p> : null}{fileError === null && file !== null && !reading ? <div>{file.truncated ? <p className="ws-banner" role="status">Showing the first {file.text.length.toLocaleString()} characters of {bytes(file.bytes)}. The rest was not read into memory.</p> : null}<div className="ws-code"><div className="ws-code__numbers" aria-hidden="true">{file.text.split('\n').map((_, index) => <div key={`n-${index}`}>{index + 1}</div>)}</div><div className="ws-code__text">{file.text.split('\n').map((line, index) => <div className="ws-code__line" key={`l-${index}`}>{line || ' '}</div>)}</div></div></div> : null}</main></section></div>
}
