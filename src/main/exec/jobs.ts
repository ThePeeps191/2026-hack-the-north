import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createWriteStream, openSync, closeSync, fstatSync, readSync, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { MAX_JOB_OUTPUT_BYTES, type JobRecord, type JobStatus, type WorkspaceRecord } from '../../shared/types.ts'
import type { JobOutput } from '../../shared/api.ts'
import type { HuddleBus, StartJobInput } from '../contracts.ts'
import { HuddleError } from '../huddle-error.ts'
import { logsDir } from '../paths.ts'
import { resolveInsideWorkspace } from './path-safety.ts'

/**
 * Real child processes.
 *
 * Nothing in this file simulates a command. A job is a `spawn`ed process in the
 * workspace's working directory whose stdout, stderr, pid and exit code are
 * captured as they happen and reported through the bus. Two properties matter
 * more than features here:
 *
 *  - **Every job is killable, including its grandchildren.** On Windows the
 *    whole tree is killed with `taskkill /pid <pid> /T /F`; on POSIX the child
 *    leads its own process group and the group is signalled.
 *  - **Waiting never blocks.** `waitForJob` races a deadline against a promise
 *    the exit handler resolves; nothing spins, so the room stays responsive
 *    while a build runs.
 */

const MAX_JOB_LOG_BYTES = 4 * 1024 * 1024
const LOG_TAIL_READ_BYTES = 512 * 1024
const HEARTBEAT_MS = 15_000
const TERMINAL_STATUSES: readonly JobStatus[] = ['exited', 'failed', 'cancelled', 'unknown']

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/* ------------------------------------------------------------------ *
 * Output retention
 * ------------------------------------------------------------------ */

/** Keeps the newest bytes of a stream and knows how much it had to drop. */
export class OutputBuffer {
  private chunks: string[] = []
  private bytes = 0
  private dropped = 0
  private readonly limit: number

  constructor(limit: number = MAX_JOB_OUTPUT_BYTES) {
    this.limit = limit
  }

  append(text: string): void {
    if (text.length === 0) return
    this.chunks.push(text)
    this.bytes += Buffer.byteLength(text, 'utf8')
    while (this.bytes > this.limit && this.chunks.length > 1) {
      const removed = this.chunks.shift()
      if (removed === undefined) break
      const size = Buffer.byteLength(removed, 'utf8')
      this.bytes -= size
      this.dropped += size
    }
    if (this.bytes > this.limit && this.chunks.length === 1) {
      const only = this.chunks[0] ?? ''
      const excess = this.bytes - this.limit
      this.chunks[0] = only.slice(excess)
      this.bytes -= excess
      this.dropped += excess
    }
  }

  /** Oldest-trimmed output, optionally only the last `maxChars` characters. */
  read(maxChars?: number): { text: string; truncated: boolean } {
    const joined = this.chunks.join('')
    if (maxChars !== undefined && maxChars > 0 && joined.length > maxChars) {
      return { text: joined.slice(-maxChars), truncated: true }
    }
    return { text: joined, truncated: this.dropped > 0 }
  }

  get droppedBytes(): number {
    return this.dropped
  }
}

/** Read the tail of a job's on-disk log synchronously, bounded. */
export function readLogTailSync(path: string, maxChars: number): { text: string; truncated: boolean } | null {
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const wantBytes = Math.min(size, Math.max(LOG_TAIL_READ_BYTES, maxChars * 2))
      const start = Math.max(0, size - wantBytes)
      const buffer = Buffer.alloc(wantBytes)
      const read = readSync(fd, buffer, 0, wantBytes, start)
      const text = buffer.subarray(0, read).toString('utf8')
      return { text, truncated: start > 0 }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Port + process helpers
 * ------------------------------------------------------------------ */

const PORT_PATTERNS = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/i,
  /(?:listening|running|started|serving)[^\d\n]{0,24}(\d{2,5})/i,
  /port\s*[:=]?\s*(\d{2,5})/i
]

/** First plausible local dev-server port mentioned in real process output. */
export function detectPort(text: string): number | null {
  for (const pattern of PORT_PATTERNS) {
    const match = pattern.exec(text)
    if (!match) continue
    const port = Number.parseInt(match[1], 10)
    if (Number.isFinite(port) && port > 0 && port <= 65535) return port
  }
  return null
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

export interface KillOutcome {
  killed: boolean
  detail: string
}

/**
 * Kill a process and everything it started. Resolves only once the pid is gone
 * or we have to admit it is still there.
 */
export async function killProcessTree(pid: number, timeoutMs = 5000): Promise<KillOutcome> {
  const deadline = Date.now() + timeoutMs
  if (!isProcessAlive(pid)) {
    return { killed: true, detail: `pid ${pid} had already exited.` }
  }

  let detail = ''
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    detail =
      result.status === 0
        ? `taskkill /pid ${pid} /T /F reported success.`
        : `taskkill /pid ${pid} /T /F exited ${String(result.status)}${result.error ? ` (${result.error.message})` : ''}.`
    if (result.status !== 0) {
      try {
        process.kill(pid, 'SIGKILL')
        detail += ' Fell back to process.kill.'
      } catch (error) {
        detail += ` process.kill also failed: ${error instanceof Error ? error.message : 'unknown error'}.`
      }
    }
  } else {
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-pid, signal)
      } catch {
        try {
          process.kill(pid, signal)
        } catch {
          // Nothing left to signal.
        }
      }
    }
    signalGroup('SIGTERM')
    detail = `Sent SIGTERM to the process group of ${pid}.`
    while (isProcessAlive(pid) && Date.now() < deadline - 1500) {
      await delay(100)
    }
    if (isProcessAlive(pid)) {
      signalGroup('SIGKILL')
      detail += ' Sent SIGKILL after the grace period.'
    }
  }

  while (isProcessAlive(pid) && Date.now() < deadline) {
    await delay(100)
  }
  const alive = isProcessAlive(pid)
  return {
    killed: !alive,
    detail: alive ? `${detail} pid ${pid} is still alive after ${timeoutMs}ms.` : detail
  }
}

/** Synchronous best-effort kill for `process.on('exit')`. */
export function killProcessTreeSync(pid: number): void {
  if (!isProcessAlive(pid)) return
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    if (result.status === 0) return
  }
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Nothing more we can do without a handle.
    }
  }
}

/* ------------------------------------------------------------------ *
 * The manager
 * ------------------------------------------------------------------ */

interface JobRuntime {
  record: JobRecord
  child: ChildProcess | null
  buffer: OutputBuffer
  decoder: StringDecoder
  log: WriteStream | null
  logBytes: number
  logClosed: boolean
  devServer: boolean
  finished: boolean
  cancelRequested: boolean
  heartbeat: NodeJS.Timeout | null
  port: number | null
}

export interface JobManagerDeps {
  bus: HuddleBus
  workspace(workspaceId: string): WorkspaceRecord | null
  onPortDetected?(record: JobRecord, port: number): void
  onJobFinished?(record: JobRecord): void
}

export class JobManager {
  private readonly deps: JobManagerDeps
  private readonly runtimes = new Map<string, JobRuntime>()
  private readonly records = new Map<string, JobRecord>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly orphanPids = new Map<string, number>()
  private disposed = false

  constructor(deps: JobManagerDeps) {
    this.deps = deps
    registerLiveProcessOwner(this)
  }

  /* ---------------------------------------------------------------- *
   * Queries
   * ---------------------------------------------------------------- */

  getRecord(jobId: string): JobRecord | null {
    return this.records.get(jobId) ?? null
  }

  /** Every record this session knows about for a room, newest first. */
  listRoomJobs(roomId: string): JobRecord[] {
    return [...this.records.values()]
      .filter((record) => record.roomId === roomId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /** True when a job was started as a dev server (even if its port is unknown). */
  isDevServerJob(jobId: string): boolean {
    return this.runtimes.get(jobId)?.devServer === true
  }

  isRunning(jobId: string): boolean {
    const record = this.records.get(jobId)
    return record !== undefined && !isTerminalJobStatus(record.status)
  }

  /** Pids this manager is responsible for keeping dead. */
  livePids(): number[] {
    const pids: number[] = []
    for (const runtime of this.runtimes.values()) {
      if (!runtime.finished && runtime.record.pid !== null) pids.push(runtime.record.pid)
    }
    for (const pid of this.orphanPids.values()) pids.push(pid)
    return pids
  }

  syncKillAll(): void {
    for (const pid of this.livePids()) killProcessTreeSync(pid)
  }

  /* ---------------------------------------------------------------- *
   * Starting
   * ---------------------------------------------------------------- */

  async startJob(input: StartJobInput): Promise<JobRecord> {
    if (this.disposed) {
      throw new HuddleError('host_disposed', 'The execution host is shutting down.', 'Restart Huddle.')
    }
    const workspace = this.deps.workspace(input.workspaceId)
    if (workspace === null) {
      throw new HuddleError(
        'workspace_unknown',
        `No workspace ${input.workspaceId} is registered for this room.`,
        'Bind the project again.'
      )
    }
    if (input.command.trim().length === 0) {
      throw new HuddleError('empty_command', 'The command was empty.', 'Provide a command to run.')
    }

    const cwd = await resolveInsideWorkspace(workspace.rootPath, input.cwd ?? '.')
    if (input.devServer) {
      await this.stopDevServerForWorkspace(workspace.id, input.roomId)
    }

    const bus = this.deps.bus
    const id = bus.newId()
    const startedAt = bus.now()
    const record: JobRecord = {
      id,
      roomId: input.roomId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      label: input.label,
      command: input.command,
      cwd: cwd.absolute,
      status: 'starting',
      exitCode: null,
      pid: null,
      startedAt,
      endedAt: null,
      lastObservedAt: startedAt,
      truncated: false,
      port: null
    }
    this.records.set(id, record)
    bus.upsertJob(record)

    const log = await this.openLog(id)
    const runtime: JobRuntime = {
      record,
      child: null,
      buffer: new OutputBuffer(),
      decoder: new StringDecoder('utf8'),
      log,
      logBytes: 0,
      logClosed: false,
      devServer: input.devServer === true,
      finished: false,
      cancelRequested: false,
      heartbeat: null,
      port: null
    }
    this.runtimes.set(id, runtime)

    let child: ChildProcess
    try {
      child = spawn(input.command, {
        cwd: cwd.absolute,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(input.env ?? {}),
          HUDDLE_ROOM_ID: input.roomId,
          HUDDLE_JOB_ID: id,
          HUDDLE_WORKSPACE_ID: input.workspaceId
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.appendChunk(id, `Could not start "${input.command}": ${message}`, 'stderr')
      this.finishJob(id, null, null)
      return { ...record, status: 'failed', exitCode: null }
    }
    runtime.child = child
    record.pid = child.pid ?? null
    record.status = 'running'
    record.lastObservedAt = bus.now()
    bus.upsertJob({ ...record })

    if (child.pid === undefined || child.pid === null) {
      this.appendChunk(id, `Could not start "${input.command}": no pid was returned.`, 'stderr')
    }

    runtime.heartbeat = setInterval(() => {
      if (runtime.finished) return
      runtime.record.lastObservedAt = bus.now()
      bus.upsertJob({ ...runtime.record })
    }, HEARTBEAT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      this.appendChunk(id, runtime.decoder.write(chunk), 'stdout')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.appendChunk(id, runtime.decoder.write(chunk), 'stderr')
    })

    child.on('error', (error) => {
      this.appendChunk(id, `Failed to run "${input.command}": ${error.message}`, 'stderr')
      this.finishJob(id, null, null)
    })

    child.on('close', (code, signal) => {
      const tail = runtime.decoder.end()
      if (tail.length > 0) this.appendChunk(id, tail, 'stdout')
      this.finishJob(id, code, signal)
    })

    return { ...record }
  }

  private appendChunk(jobId: string, chunk: string, stream: 'stdout' | 'stderr'): void {
    if (chunk.length === 0) return
    const runtime = this.runtimes.get(jobId)
    if (runtime === undefined) return
    runtime.buffer.append(chunk)
    runtime.record.truncated = runtime.buffer.droppedBytes > 0
    runtime.record.lastObservedAt = this.deps.bus.now()
    this.deps.bus.appendJobOutput(runtime.record, chunk, stream)
    this.writeLog(runtime, chunk)

    if (runtime.devServer && runtime.port === null) {
      const port = detectPort(chunk)
      if (port !== null) {
        runtime.port = port
        runtime.record.port = port
        this.deps.bus.upsertJob({ ...runtime.record })
        this.deps.bus.notice(
          runtime.record.roomId,
          'info',
          `${runtime.record.label} is listening on port ${port}.`,
          undefined
        )
        this.deps.onPortDetected?.(runtime.record, port)
      }
    }
  }

  private async openLog(jobId: string): Promise<WriteStream | null> {
    const directory = join(logsDir(), 'jobs')
    try {
      await mkdir(directory, { recursive: true })
      return createWriteStream(join(directory, `${jobId}.log`), { flags: 'a' })
    } catch {
      return null
    }
  }

  private writeLog(runtime: JobRuntime, chunk: string): void {
    if (runtime.log === null || runtime.logClosed) return
    const size = Buffer.byteLength(chunk, 'utf8')
    if (runtime.logBytes + size > MAX_JOB_LOG_BYTES) {
      runtime.logClosed = true
      runtime.log.end(`\n[huddle] log truncated at ${MAX_JOB_LOG_BYTES} bytes\n`)
      runtime.log = null
      return
    }
    runtime.logBytes += size
    runtime.log.write(chunk)
  }

  private finishJob(jobId: string, exitCode: number | null, signal: NodeJS.Signals | null): void {
    const runtime = this.runtimes.get(jobId)
    if (runtime === undefined || runtime.finished) return
    runtime.finished = true

    const status: JobStatus = runtime.cancelRequested ? 'cancelled' : exitCode === 0 ? 'exited' : 'failed'
    const finishedAt = this.deps.bus.now()
    runtime.record.status = status
    runtime.record.exitCode = exitCode
    runtime.record.endedAt = finishedAt
    runtime.record.lastObservedAt = finishedAt
    if (signal !== null) {
      this.deps.bus.appendJobOutput(runtime.record, `\n[huddle] process ended by ${signal}\n`, 'stderr')
    }
    this.deps.bus.upsertJob({ ...runtime.record })

    if (runtime.heartbeat !== null) {
      clearInterval(runtime.heartbeat)
      runtime.heartbeat = null
    }
    if (runtime.log !== null && !runtime.logClosed) {
      runtime.logClosed = true
      runtime.log.end()
    }
    this.orphanPids.delete(jobId)
    this.notifyWaiters(jobId)
    this.deps.onJobFinished?.({ ...runtime.record })
  }

  private notifyWaiters(jobId: string): void {
    const set = this.waiters.get(jobId)
    if (set === undefined) return
    this.waiters.delete(jobId)
    for (const finish of [...set]) finish()
  }

  /* ---------------------------------------------------------------- *
   * Waiting and cancelling
   * ---------------------------------------------------------------- */

  /** Resolves when the job leaves `running`, or at the deadline. Never blocks. */
  async waitForJob(jobId: string, timeoutMs: number): Promise<JobRecord> {
    const initial = this.records.get(jobId)
    if (initial === undefined) {
      throw new HuddleError('job_unknown', `No job ${jobId} is known to this session.`, 'Check the Terminal surface.')
    }
    if (isTerminalJobStatus(initial.status)) return { ...initial }

    await new Promise<void>((resolvePromise) => {
      const waiters = this.waiters.get(jobId) ?? new Set<() => void>()
      const finish = (): void => {
        clearTimeout(timer)
        waiters.delete(finish)
        resolvePromise()
      }
      const timer = setTimeout(finish, Math.max(0, timeoutMs))
      waiters.add(finish)
      this.waiters.set(jobId, waiters)
    })

    return { ...(this.records.get(jobId) ?? initial) }
  }

  /**
   * Stop a job for real and report what actually happened. A job that already
   * finished is reported as such rather than pretending it was killed.
   */
  async cancelJob(jobId: string): Promise<JobRecord> {
    const record = this.records.get(jobId)
    if (record === undefined) {
      throw new HuddleError('job_unknown', `No job ${jobId} is known to this session.`, 'Check the Terminal surface.')
    }
    const runtime = this.runtimes.get(jobId)
    const orphanPid = this.orphanPids.get(jobId)

    // A job adopted after a restart has no runtime handle, but if we verified
    // its pid is alive we can still stop it for real.
    if (runtime === undefined && orphanPid !== undefined) {
      const outcome = await killProcessTree(orphanPid, 8000)
      this.orphanPids.delete(jobId)
      const stoppedAt = this.deps.bus.now()
      record.status = outcome.killed ? 'cancelled' : 'unknown'
      record.endedAt = stoppedAt
      record.lastObservedAt = stoppedAt
      this.deps.bus.upsertJob({ ...record })
      this.deps.bus.notice(
        record.roomId,
        outcome.killed ? 'info' : 'error',
        outcome.killed
          ? `Stopped "${record.label}" (pid ${orphanPid}) left over from a previous session.`
          : `Could not stop "${record.label}" (pid ${orphanPid}): ${outcome.detail}`,
        outcome.killed ? undefined : `Kill pid ${orphanPid} manually, then re-run the command.`
      )
      return { ...record }
    }

    if (isTerminalJobStatus(record.status)) {
      return { ...record }
    }

    if (runtime === undefined) {
      const observedAt = this.deps.bus.now()
      record.status = 'unknown'
      record.endedAt = observedAt
      record.lastObservedAt = observedAt
      this.deps.bus.upsertJob({ ...record })
      return { ...record }
    }

    runtime.cancelRequested = true
    const pid = runtime.record.pid
    if (pid === null) {
      this.finishJob(jobId, null, null)
      return { ...(this.records.get(jobId) ?? record) }
    }

    const outcome = await killProcessTree(pid)
    // The close event normally lands first; if it does not, finish honestly.
    if (!runtime.finished) {
      this.finishJob(jobId, null, null)
    }
    const updated = this.records.get(jobId) ?? record
    updated.status = outcome.killed ? 'cancelled' : 'unknown'
    updated.endedAt = updated.endedAt ?? this.deps.bus.now()
    updated.lastObservedAt = this.deps.bus.now()
    this.deps.bus.upsertJob({ ...updated })
    if (!outcome.killed) {
      this.deps.bus.notice(
        updated.roomId,
        'error',
        `Huddle could not stop "${updated.label}" (${outcome.detail})`,
        `Stop pid ${pid} manually and re-run when the workspace is free.`
      )
    }
    return { ...updated }
  }

  /* ---------------------------------------------------------------- *
   * Output
   * ---------------------------------------------------------------- */

  getJobOutput(jobId: string, maxChars?: number): JobOutput {
    const record = this.records.get(jobId)
    if (record === undefined) {
      throw new HuddleError('job_unknown', `No job ${jobId} is known to this session.`, 'Check the Terminal surface.')
    }
    const runtime = this.runtimes.get(jobId)
    if (runtime !== undefined) {
      const read = runtime.buffer.read(maxChars)
      return {
        jobId,
        text: read.text,
        truncated: read.truncated,
        status: record.status,
        exitCode: record.exitCode
      }
    }
    // After a restart the in-memory buffer is gone but the log tail is real.
    const fromDisk = readLogTailSync(join(logsDir(), 'jobs', `${jobId}.log`), maxChars ?? 0)
    if (fromDisk === null) {
      return { jobId, text: '', truncated: false, status: record.status, exitCode: record.exitCode }
    }
    const text =
      maxChars !== undefined && maxChars > 0 && fromDisk.text.length > maxChars
        ? fromDisk.text.slice(-maxChars)
        : fromDisk.text
    return {
      jobId,
      text,
      truncated: fromDisk.truncated || text.length !== fromDisk.text.length,
      status: record.status,
      exitCode: record.exitCode
    }
  }

  /* ---------------------------------------------------------------- *
   * Dev servers, reconciliation, teardown
   * ---------------------------------------------------------------- */

  async stopDevServerForWorkspace(workspaceId: string, roomId: string): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (record.workspaceId !== workspaceId || record.roomId !== roomId) continue
      const runtime = this.runtimes.get(record.id)
      if (runtime?.devServer !== true || isTerminalJobStatus(record.status)) continue
      await this.cancelJob(record.id)
    }
  }

  /** Adopt persisted records after a restart without assuming anything. */
  async reconcile(jobs: JobRecord[], workspaces: WorkspaceRecord[]): Promise<void> {
    const bus = this.deps.bus
    for (const job of jobs) {
      if (isTerminalJobStatus(job.status)) {
        this.records.set(job.id, { ...job })
        continue
      }
      const pid = job.pid
      const alive = pid !== null && isProcessAlive(pid)
      const now = bus.now()
      const record: JobRecord = {
        ...job,
        status: 'unknown',
        lastObservedAt: now,
        endedAt: alive ? null : now
      }
      this.records.set(record.id, record)
      bus.upsertJob({ ...record })
      if (pid !== null && alive) {
        this.orphanPids.set(record.id, pid)
        bus.notice(
          record.roomId,
          'warn',
          `"${record.label}" (pid ${pid}) is still running from the previous session, but Huddle restarted and can no longer capture its output.`,
          'Stop it from the Terminal surface, or leave it running and start a new one.'
        )
      } else {
        bus.notice(
          record.roomId,
          'warn',
          `"${record.label}" did not survive the Huddle restart; its exit code was never observed, so it is marked unknown.`,
          'Run the command again if you still need the result.'
        )
      }
    }

    for (const workspace of workspaces) {
      if (workspace.devJobId === null) continue
      const record = this.records.get(workspace.devJobId)
      if (record === undefined || isTerminalJobStatus(record.status)) {
        bus.upsertWorkspace({ ...workspace, devJobId: null, devPort: null })
      }
    }
  }

  async disposeRoom(roomId: string): Promise<void> {
    const ids = [...this.records.values()]
      .filter((record) => record.roomId === roomId && !isTerminalJobStatus(record.status))
      .map((record) => record.id)
    for (const id of ids) {
      await this.cancelJob(id)
    }
    for (const [jobId, pid] of [...this.orphanPids]) {
      const record = this.records.get(jobId)
      if (record?.roomId !== roomId) continue
      await killProcessTree(pid, 5000)
      this.orphanPids.delete(jobId)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const ids = [...this.records.values()]
      .filter((record) => !isTerminalJobStatus(record.status))
      .map((record) => record.id)
    await Promise.all(ids.map((id) => this.cancelJob(id).catch(() => undefined)))
    this.syncKillAll()
    unregisterLiveProcessOwner(this)
  }
}

/* ------------------------------------------------------------------ *
 * Process-wide teardown
 * ------------------------------------------------------------------ */

interface LiveProcessOwner {
  syncKillAll(): void
}

const liveOwners = new Set<LiveProcessOwner>()
let exitHookInstalled = false

function registerLiveProcessOwner(owner: LiveProcessOwner): void {
  liveOwners.add(owner)
  if (exitHookInstalled) return
  exitHookInstalled = true
  // Best-effort: on a hard exit all we can do is signal the pids synchronously.
  process.on('exit', () => {
    for (const live of [...liveOwners]) {
      try {
        live.syncKillAll()
      } catch {
        // Never throw from an exit handler.
      }
    }
  })
}

function unregisterLiveProcessOwner(owner: LiveProcessOwner): void {
  liveOwners.delete(owner)
}

/**
 * Used by tests to create the log directory without a full host.
 */
export function jobLogPath(jobId: string): string {
  return join(logsDir(), 'jobs', `${jobId}.log`)
}
