import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Thin, honest wrapper around the real `git` binary.
 *
 * Nothing here synthesises a result. When git is missing every helper reports
 * that fact so callers can tell the human why isolation is unavailable instead
 * of pretending a worktree exists.
 */

export interface CommandRun {
  /** True when the process could not even be spawned (binary missing). */
  spawnFailed: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  signal: string | null
}

export interface RunOptions {
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  maxBytes?: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/** Spawn a process without a shell and capture bounded stdout/stderr. */
export function runCommand(command: string, args: string[], options: RunOptions): Promise<CommandRun> {
  return new Promise((resolvePromise) => {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolvePromise({
        spawnFailed: true,
        code: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
        signal: null
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        spawnFailed: true,
        code: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut,
        signal: null
      })
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ spawnFailed: false, code, stdout, stderr, timedOut, signal })
    })
  })
}

let gitAvailableCache: boolean | null = null

/** Whether a working `git` binary exists. Detected once per process. */
export async function gitAvailable(): Promise<boolean> {
  if (gitAvailableCache !== null) return gitAvailableCache
  const probeDir = await mkdtemp(join(tmpdir(), 'huddle-git-probe-'))
  try {
    const result = await runCommand('git', ['--version'], { cwd: probeDir, timeoutMs: 10_000 })
    gitAvailableCache = !result.spawnFailed && result.code === 0
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined)
  }
  return gitAvailableCache
}

export async function git(cwd: string, args: string[], options?: { timeoutMs?: number }): Promise<CommandRun> {
  return runCommand('git', args, { cwd, timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS })
}

/** Identity used for commits Huddle makes, so a bare machine still commits. */
export function agentIdentity(name: string): { name: string; email: string } {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '')
  return { name, email: `${slug.length > 0 ? slug : 'agent'}@huddle.local` }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const result = await git(dir, ['rev-parse', '--is-inside-work-tree'])
  return result.code === 0 && result.stdout.trim() === 'true'
}

export async function hasCommits(dir: string): Promise<boolean> {
  const result = await git(dir, ['rev-parse', '--verify', 'HEAD'])
  return result.code === 0
}

/** Current branch name, or null when detached/unavailable. */
export async function currentBranch(dir: string): Promise<string | null> {
  // `symbolic-ref` also answers on an unborn branch, where `rev-parse` cannot.
  const symbolic = await git(dir, ['symbolic-ref', '--short', 'HEAD'])
  if (symbolic.code === 0) {
    const branch = symbolic.stdout.trim()
    if (branch.length > 0) return branch
  }
  const result = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (result.code !== 0) return null
  const branch = result.stdout.trim()
  return branch.length === 0 || branch === 'HEAD' ? null : branch
}

export async function headCommit(dir: string): Promise<string | null> {
  const result = await git(dir, ['rev-parse', 'HEAD'])
  return result.code === 0 ? result.stdout.trim() : null
}

export async function isDirty(dir: string): Promise<boolean> {
  const result = await git(dir, ['status', '--porcelain'])
  return result.code === 0 && result.stdout.trim().length > 0
}

export async function branchExists(dir: string, branch: string): Promise<boolean> {
  const result = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return result.code === 0
}

/** Count of commits reachable from `branch` but not from `base`. */
export async function commitsAhead(dir: string, base: string, branch: string): Promise<number> {
  const result = await git(dir, ['rev-list', '--count', `${base}..${branch}`])
  if (result.code !== 0) return 0
  const parsed = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/** True while a merge is in progress (`MERGE_HEAD` present). */
export async function mergeInProgress(dir: string): Promise<boolean> {
  const result = await git(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
  return result.code === 0
}

export async function conflictedFiles(dir: string): Promise<string[]> {
  const result = await git(dir, ['diff', '--name-only', '--diff-filter=U'])
  if (result.code !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export async function mergeAbort(dir: string): Promise<void> {
  await git(dir, ['merge', '--abort'])
}

export async function gitVersion(dir: string): Promise<string | null> {
  const result = await git(dir, ['--version'])
  return result.code === 0 ? result.stdout.trim() : null
}
