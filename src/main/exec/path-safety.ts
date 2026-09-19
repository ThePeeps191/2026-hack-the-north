import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { HuddleError } from '../huddle-error.ts'

/**
 * Every path that reaches the execution host from a tool, a model or the
 * renderer crosses this module before it touches the filesystem.
 *
 * The rule is absolute: after resolving symlinks, the target must still live
 * inside the workspace root. `..` segments, absolute escapes and symlinks that
 * point out of the project are all refused with a `HuddleError` that names the
 * offending path, because a silently-clamped path is worse than a refusal.
 */

export interface ResolvedPath {
  /** Canonical absolute path. */
  absolute: string
  /** POSIX-style path relative to the workspace root ('' for the root itself). */
  relative: string
}

/** Windows paths are compared case-insensitively; POSIX paths are not. */
function comparisonKey(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** True when `target` is `root` itself or lives underneath it. */
export function isPathInside(root: string, target: string): boolean {
  if (comparisonKey(root) === comparisonKey(target)) return true
  const rel = relative(comparisonKey(root), comparisonKey(target))
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../')
}

/**
 * Realpath the nearest existing ancestor of `target` and re-append the part
 * that does not exist yet. A file that is about to be created still gets the
 * symlink resolution of its real parent directory, which is where an escape
 * would hide.
 */
export async function realpathExistingAncestor(target: string): Promise<string> {
  let current = target
  const tail: string[] = []
  for (;;) {
    try {
      await realpath(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) return join(current, ...tail.reverse())
      tail.push(basename(current))
      current = parent
      continue
    }
    const resolved = await realpath(current)
    return tail.length > 0 ? join(resolved, ...tail.reverse()) : resolved
  }
}

/** Realpath when the path exists, `null` when it does not. */
export async function canonicalizeExisting(target: string): Promise<string | null> {
  try {
    return await realpath(target)
  } catch {
    return null
  }
}

/**
 * Resolve a caller-supplied path against a workspace root and refuse anything
 * that escapes it.
 *
 * Accepts both relative (`src/App.tsx`) and absolute (`C:\proj\src\App.tsx`)
 * inputs, since a model will happily echo back an absolute path it saw in a
 * listing. Absolute paths are only accepted when they land inside the root.
 */
export async function resolveInsideWorkspace(root: string, candidate: string): Promise<ResolvedPath> {
  if (candidate.includes('\0')) {
    throw new HuddleError('invalid_path', 'The path contains a null byte.', 'Pass a plain relative path.')
  }
  const segments = candidate.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.includes('..')) {
    throw new HuddleError(
      'path_outside_workspace',
      `"${candidate}" tries to leave the workspace root with "..".`,
      'Use a path relative to the project root that stays inside it.'
    )
  }

  const canonicalRoot = await canonicalizeExisting(root)
  if (canonicalRoot === null) {
    throw new HuddleError(
      'workspace_missing',
      `The workspace root ${root} does not exist.`,
      'Re-bind the project folder from the room header.'
    )
  }

  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(canonicalRoot, candidate)
  const resolved = await realpathExistingAncestor(target)
  if (!isPathInside(canonicalRoot, resolved)) {
    throw new HuddleError(
      'path_outside_workspace',
      `"${candidate}" resolves to ${resolved}, which is outside the workspace ${canonicalRoot}.`,
      'Only paths inside the bound project folder are allowed.'
    )
  }

  const rel = relative(canonicalRoot, resolved)
  return { absolute: resolved, relative: rel.split(sep).join('/') }
}

/** Relative POSIX path of `target` from `root`, or null when it is outside. */
export function relativeInside(root: string, target: string): string | null {
  if (!isPathInside(root, target)) return null
  const rel = relative(root, target)
  return rel.split(sep).join('/')
}

/** True when the directory exists on disk. */
export function directoryExists(target: string): boolean {
  return existsSync(target)
}

/**
 * A filename that is safe to write inside one directory: no separators, no
 * traversal, no reserved characters, bounded length.
 */
export function safeFilename(input: string, fallback: string): string {
  const base = basename(input.replace(/[\\/]+/g, '/'))
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '-')
    .replace(/^\.+/, '')
    .trim()
  if (cleaned.length === 0) return fallback
  const withoutTrailingDots = cleaned.replace(/[. ]+$/, '')
  const bounded = withoutTrailingDots.slice(0, 120)
  return bounded.length === 0 ? fallback : bounded
}
