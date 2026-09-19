import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { Buffer } from 'node:buffer'
import { dirname, extname, join } from 'node:path'
import type { SearchHit, WriteResult } from '../contracts.ts'
import type { DirEntry } from '../../shared/api.ts'
import { HuddleError } from '../huddle-error.ts'
import { resolveInsideWorkspace } from './path-safety.ts'

/**
 * Real filesystem operations inside one workspace root.
 *
 * Every function takes a workspace root plus a caller-supplied path and runs
 * the path through `resolveInsideWorkspace` first, so a traversal attempt fails
 * here instead of reading `C:\Users\...\.ssh`.
 */

export const DEFAULT_MAX_READ_BYTES = 512 * 1024
export const MAX_READ_BYTES = 8 * 1024 * 1024
const DEFAULT_SEARCH_MAX = 200
const MAX_SEARCH_MAX = 1000
const SEARCH_FILE_BYTES_LIMIT = 2 * 1024 * 1024
const SEARCH_FILES_LIMIT = 5000
const SEARCH_TIME_BUDGET_MS = 6000
const MAX_HIT_LINE_LENGTH = 400

/** Directory names that are never worth walking during a text search. */
const SEARCH_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.mypy_cache',
  '.pytest_cache',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.data'
])

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.svg': 'xml',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.env': 'ini',
  '.sh': 'shell',
  '.bash': 'shell',
  '.ps1': 'powershell',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.dockerfile': 'dockerfile',
  '.txt': 'plaintext',
  '.log': 'plaintext',
  '.diff': 'diff',
  '.patch': 'diff'
}

const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'plaintext',
  '.npmrc': 'ini',
  '.editorconfig': 'ini'
}

export function detectLanguage(path: string): string {
  const name = path.split('/').pop() ?? path
  const lower = name.toLowerCase()
  const byName = LANGUAGE_BY_FILENAME[lower]
  if (byName) return byName
  const extension = extname(lower)
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext'
}

/** A NUL byte in the first block is the standard "this is not text" tell. */
export function looksBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, Math.min(buffer.length, 8000))
  return window.includes(0)
}

export interface ReadFileResult {
  text: string
  bytes: number
  truncated: boolean
  modifiedAt: string
}

export async function readWorkspaceFile(
  root: string,
  path: string,
  maxBytes?: number
): Promise<ReadFileResult> {
  const resolved = await resolveInsideWorkspace(root, path)
  const limit = Math.max(1024, Math.min(maxBytes ?? DEFAULT_MAX_READ_BYTES, MAX_READ_BYTES))

  let stats: Stats
  try {
    stats = await stat(resolved.absolute)
  } catch {
    throw new HuddleError(
      'file_not_found',
      `${resolved.relative || path} does not exist in this workspace.`,
      'Pick a file from the tree on the left.'
    )
  }
  if (stats.isDirectory()) {
    throw new HuddleError(
      'path_is_directory',
      `${resolved.relative} is a directory, not a file.`,
      'Open the folder in the Files surface instead.'
    )
  }

  const handle = await readFile(resolved.absolute)
  if (looksBinary(handle)) {
    throw new HuddleError(
      'binary_file',
      `${resolved.relative} looks like a binary file (${stats.size} bytes).`,
      'Open it outside Huddle; the editor only shows text.'
    )
  }

  const slice = handle.subarray(0, limit)
  return {
    text: slice.toString('utf8'),
    bytes: stats.size,
    truncated: stats.size > slice.length,
    modifiedAt: stats.mtime.toISOString()
  }
}

export async function listWorkspaceDir(root: string, path?: string): Promise<DirEntry[]> {
  const resolved = await resolveInsideWorkspace(root, path ?? '.')
  let entries: Dirent[]
  try {
    entries = await readdir(resolved.absolute, { withFileTypes: true })
  } catch {
    throw new HuddleError(
      'dir_not_found',
      `${resolved.relative || path || '.'} is not a readable directory.`,
      'Refresh the tree.'
    )
  }

  const results: DirEntry[] = []
  for (const entry of entries) {
    const childAbsolute = join(resolved.absolute, entry.name)
    const childRelative = resolved.relative.length === 0 ? entry.name : `${resolved.relative}/${entry.name}`

    let kind: DirEntry['kind'] = 'file'
    if (entry.isDirectory()) {
      kind = 'dir'
    } else if (entry.isSymbolicLink()) {
      try {
        const target = await stat(childAbsolute)
        kind = target.isDirectory() ? 'dir' : 'file'
      } catch {
        kind = 'file'
      }
    }

    let bytes: number | null = null
    let modifiedAt: string | null = null
    if (kind === 'file') {
      try {
        const stats = await stat(childAbsolute)
        bytes = stats.size
        modifiedAt = stats.mtime.toISOString()
      } catch {
        bytes = null
        modifiedAt = null
      }
    } else {
      try {
        const stats = await stat(childAbsolute)
        modifiedAt = stats.mtime.toISOString()
      } catch {
        modifiedAt = null
      }
    }

    results.push({ name: entry.name, path: childRelative, kind, bytes, modifiedAt })
  }

  results.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return results
}

export async function writeWorkspaceFile(
  root: string,
  path: string,
  contents: string
): Promise<WriteResult> {
  const resolved = await resolveInsideWorkspace(root, path)
  if (resolved.relative.length === 0) {
    throw new HuddleError('invalid_path', 'A file path is required.', 'Pass a path like src/App.tsx.')
  }

  let created = true
  try {
    const existing = await stat(resolved.absolute)
    if (existing.isDirectory()) {
      throw new HuddleError(
        'path_is_directory',
        `${resolved.relative} is a directory.`,
        'Choose a file name, not a folder.'
      )
    }
    created = false
  } catch (error) {
    if (error instanceof HuddleError) throw error
    created = true
  }

  await mkdir(dirname(resolved.absolute), { recursive: true })
  await writeFile(resolved.absolute, contents, 'utf8')
  return {
    path: resolved.absolute,
    relativePath: resolved.relative,
    created,
    bytes: Buffer.byteLength(contents, 'utf8')
  }
}

/** Translate a glob (`*`, `?`, `**`) into a matcher over POSIX relative paths. */
export function compileGlob(pattern: string): (relativePath: string) => boolean {
  const normalized = pattern.trim().replace(/\\/g, '/')
  if (normalized.length === 0) return () => true
  const directoryPrefix = normalized.endsWith('/')
  let source = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        source += normalized[index + 2] === '/' ? '(?:.*/)?' : '.*'
        index += normalized[index + 2] === '/' ? 2 : 1
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if ('\\^$.|+()[]{}'.includes(char)) {
      source += `\\${char}`
      continue
    }
    source += char
  }
  const full = new RegExp(`^${source}${directoryPrefix ? '(?:/.*)?' : ''}$`)
  const hasPathSeparator = normalized.includes('/')
  return (relativePath: string) => {
    if (full.test(relativePath)) return true
    if (hasPathSeparator) return false
    const base = relativePath.split('/').pop() ?? relativePath
    return full.test(base)
  }
}

export interface SearchOptions {
  glob?: string
  max?: number
  deadlineMs?: number
}

export interface SearchResult {
  hits: SearchHit[]
  /** True when a bound stopped the walk before the tree was exhausted. */
  truncated: boolean
  filesScanned: number
  detail: string
}

export async function searchWorkspace(
  root: string,
  query: string,
  options?: SearchOptions
): Promise<SearchResult> {
  const needle = query.trim()
  if (needle.length === 0) {
    throw new HuddleError('empty_query', 'The search query was empty.', 'Type something to search for.')
  }
  const max = Math.max(1, Math.min(options?.max ?? DEFAULT_SEARCH_MAX, MAX_SEARCH_MAX))
  const matches = options?.glob ? compileGlob(options.glob) : (): boolean => true
  const deadline = Date.now() + (options?.deadlineMs ?? SEARCH_TIME_BUDGET_MS)
  const needleLower = needle.toLowerCase()
  const hits: SearchHit[] = []
  let filesScanned = 0
  let truncated = false

  const rootResolved = await resolveInsideWorkspace(root, '.')

  interface QueueEntry {
    absolute: string
    relative: string
  }
  const queue: QueueEntry[] = [{ absolute: rootResolved.absolute, relative: '' }]

  while (queue.length > 0) {
    if (hits.length >= max) {
      truncated = true
      break
    }
    if (Date.now() > deadline) {
      truncated = true
      break
    }
    if (filesScanned >= SEARCH_FILES_LIMIT) {
      truncated = true
      break
    }

    const current = queue.shift()
    if (current === undefined) break

    let entries: Dirent[]
    try {
      entries = await readdir(current.absolute, { withFileTypes: true })
    } catch {
      continue
    }

    // Depth-first, files before subdirectories, so results follow the tree.
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const relative = current.relative.length === 0 ? entry.name : `${current.relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(entry.name)) continue
        queue.push({ absolute: join(current.absolute, entry.name), relative })
        continue
      }
      if (!entry.isFile()) continue
      if (!matches(relative)) continue
      if (hits.length >= max || filesScanned >= SEARCH_FILES_LIMIT || Date.now() > deadline) {
        truncated = true
        break
      }
      filesScanned += 1
      const absolute = join(current.absolute, entry.name)
      let raw: Buffer
      try {
        const stats = await stat(absolute)
        if (stats.size > SEARCH_FILE_BYTES_LIMIT) continue
        raw = await readFile(absolute)
      } catch {
        continue
      }
      if (looksBinary(raw)) continue
      const lines = raw.toString('utf8').split(/\r?\n/)
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]
        if (!line.toLowerCase().includes(needleLower)) continue
        hits.push({
          path: relative,
          line: lineIndex + 1,
          text: line.length > MAX_HIT_LINE_LENGTH ? `${line.slice(0, MAX_HIT_LINE_LENGTH)}…` : line
        })
        if (hits.length >= max) {
          truncated = true
          break
        }
      }
    }
  }

  return {
    hits,
    truncated,
    filesScanned,
    detail: truncated
      ? `Stopped after ${hits.length} hit(s) and ${filesScanned} file(s); the tree may hold more matches.`
      : `Searched ${filesScanned} file(s); no further matches.`
  }
}
