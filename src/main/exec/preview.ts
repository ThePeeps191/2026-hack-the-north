import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { AppSettings, JobRecord, WorkspaceRecord } from '../../shared/types.ts'
import type { PreviewInfo } from '../../shared/api.ts'
import type { HuddleBus } from '../contracts.ts'
import { HuddleError } from '../huddle-error.ts'
import { isTerminalJobStatus, type JobManager } from './jobs.ts'
import localtunnel, { type Tunnel } from 'localtunnel'

/**
 * The dev-server preview.
 *
 * Huddle starts the project's own dev command as a real job, waits until the
 * port actually answers, and only then reports a URL. The `publicUrl` is what a
 * *remote* browser can reach: a localtunnel URL in `tunnel` mode, the machine's
 * LAN address in `lan` mode, and nothing at all in `off` mode — where the record
 * says so instead of handing out a URL that will not work.
 */

const DEV_SCRIPT_ORDER = ['dev', 'start', 'serve', 'preview'] as const
const READY_TIMEOUT_MS = 60_000
const READY_POLL_MS = 700
const PROBE_TIMEOUT_MS = 2000
const TUNNEL_TIMEOUT_MS = 30_000

interface PreviewRecord extends PreviewInfo {
  jobId: string | null
  port: number | null
  tunnel: Tunnel | null
  stopped: boolean
}

export interface PreviewDeps {
  bus: HuddleBus
  jobs: JobManager
  workspace(workspaceId: string): WorkspaceRecord | null
  settings(): AppSettings
  updateWorkspace(record: WorkspaceRecord): WorkspaceRecord
}

function key(roomId: string, workspaceId: string): string {
  return `${roomId}::${workspaceId}`
}

function firstLanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    if (addresses === undefined) continue
    for (const address of addresses) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (/^169\.254\./.test(address.address)) continue
      return address.address
    }
  }
  return null
}

/** A real HTTP request: any response, even a 404, means something is listening. */
function probe(url: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const req = request(url, { method: 'GET', timeout: PROBE_TIMEOUT_MS }, (response) => {
      response.resume()
      resolvePromise(true)
    })
    req.on('timeout', () => {
      req.destroy()
      resolvePromise(false)
    })
    req.on('error', () => {
      resolvePromise(false)
    })
    req.end()
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

export class PreviewManager {
  private readonly deps: PreviewDeps
  private readonly records = new Map<string, PreviewRecord>()

  constructor(deps: PreviewDeps) {
    this.deps = deps
  }

  /** Called by the host when any job finishes, so a dead server is visible. */
  onJobFinished(record: JobRecord): void {
    for (const preview of this.records.values()) {
      if (preview.jobId !== record.id) continue
      if (preview.state === 'ready' || preview.state === 'starting') {
        preview.state = 'failed'
        preview.detail =
          `The dev server (${record.label}) exited with code ${String(record.exitCode)}. ` +
          'Run the dev command again from the Terminal surface to see the error output.'
        preview.publicUrl = null
        this.closeTunnel(preview)
      }
    }
  }

  getPreview(roomId: string, workspaceId: string): PreviewInfo | null {
    const record = this.records.get(key(roomId, workspaceId))
    if (record === undefined) return null
    if (record.jobId !== null) {
      const job = this.deps.jobs.getRecord(record.jobId)
      if (job !== null && isTerminalJobStatus(job.status) && record.state === 'ready') {
        record.state = 'failed'
        record.publicUrl = null
        record.detail = `The dev server exited with code ${String(job.exitCode)}; the preview is no longer live.`
        this.closeTunnel(record)
      }
    }
    return this.toInfo(record)
  }

  private toInfo(record: PreviewRecord): PreviewInfo {
    return {
      roomId: record.roomId,
      workspaceId: record.workspaceId,
      publicUrl: record.publicUrl,
      localUrl: record.localUrl,
      mode: record.mode,
      state: record.state,
      detail: record.detail
    }
  }

  private closeTunnel(record: PreviewRecord): void {
    if (record.tunnel === null) return
    try {
      record.tunnel.close()
    } catch {
      // The tunnel may already be gone.
    }
    record.tunnel = null
  }

  private async detectDevCommand(rootPath: string): Promise<{ command: string; script: string } | null> {
    const path = join(rootPath, 'package.json')
    if (!existsSync(path)) return null
    let scripts: Record<string, string> = {}
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') {
        const raw = (parsed as { scripts?: unknown }).scripts
        if (raw !== null && typeof raw === 'object') {
          for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof value === 'string') scripts[name] = value
          }
        }
      }
    } catch {
      return null
    }
    const manager = existsSync(join(rootPath, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(rootPath, 'yarn.lock'))
        ? 'yarn'
        : 'npm'
    for (const script of DEV_SCRIPT_ORDER) {
      if (typeof scripts[script] !== 'string') continue
      const command = manager === 'npm' ? `npm run ${script}` : `${manager} run ${script}`
      return { command, script }
    }
    return null
  }

  async startPreview(roomId: string, workspaceId: string): Promise<PreviewInfo> {
    const bus = this.deps.bus
    const settings = this.deps.settings()
    const workspace = this.deps.workspace(workspaceId)
    if (workspace === null) {
      throw new HuddleError(
        'workspace_unknown',
        `No workspace ${workspaceId} is registered for this room.`,
        'Bind the project again, then start the preview.'
      )
    }

    const existing = this.records.get(key(roomId, workspaceId))
    if (existing !== undefined && existing.state === 'ready' && existing.jobId !== null) {
      const job = this.deps.jobs.getRecord(existing.jobId)
      if (job !== null && !isTerminalJobStatus(job.status)) return this.toInfo(existing)
    }

    if (settings.preview.mode === 'off') {
      const off: PreviewRecord = {
        roomId,
        workspaceId,
        publicUrl: null,
        localUrl: '',
        mode: 'off',
        state: 'off',
        detail:
          'Preview exposure is off in settings, so Huddle did not start a dev server. Set preview mode to "tunnel" or "lan" to expose it for the remote browser.',
        jobId: existing?.jobId ?? null,
        port: null,
        tunnel: null,
        stopped: false
      }
      this.records.set(key(roomId, workspaceId), off)
      return this.toInfo(off)
    }

    const dev = await this.detectDevCommand(workspace.rootPath)
    if (dev === null) {
      const failed: PreviewRecord = {
        roomId,
        workspaceId,
        publicUrl: null,
        localUrl: '',
        mode: settings.preview.mode,
        state: 'failed',
        detail: `No dev script was found in ${join(workspace.rootPath, 'package.json')}. Huddle looked for ${DEV_SCRIPT_ORDER.join(', ')}.`,
        jobId: existing?.jobId ?? null,
        port: null,
        tunnel: null,
        stopped: false
      }
      this.records.set(key(roomId, workspaceId), failed)
      bus.notice(
        roomId,
        'error',
        failed.detail,
        'Add a dev script to package.json, or start the server yourself and share the URL.'
      )
      return this.toInfo(failed)
    }

    const running: PreviewRecord = {
      roomId,
      workspaceId,
      publicUrl: null,
      localUrl: '',
      mode: settings.preview.mode,
      state: 'starting',
      detail: `Starting ${dev.command} in ${workspace.rootPath}…`,
      jobId: null,
      port: null,
      tunnel: null,
      stopped: false
    }
    this.records.set(key(roomId, workspaceId), running)
    this.closeTunnel(existing ?? running)

    let job: JobRecord
    try {
      job = await this.deps.jobs.startJob({
        roomId,
        agentId: 'system',
        workspaceId,
        label: 'Dev server',
        command: dev.command,
        devServer: true
      })
    } catch (error) {
      running.state = 'failed'
      running.detail = `Could not start ${dev.command}: ${error instanceof Error ? error.message : 'unknown error'}`
      bus.notice(roomId, 'error', running.detail)
      return this.toInfo(running)
    }
    running.jobId = job.id
    this.deps.updateWorkspace({ ...workspace, devJobId: job.id, devPort: null })

    /* --- wait for the port to really answer --- */
    const deadline = Date.now() + READY_TIMEOUT_MS
    let port: number | null = job.port
    while (Date.now() < deadline) {
      const current = this.deps.jobs.getRecord(job.id)
      if (current !== null && isTerminalJobStatus(current.status)) {
        const output = this.deps.jobs.getJobOutput(job.id, 4000).text.trim()
        running.state = 'failed'
        running.detail =
          `${dev.command} exited with code ${String(current.exitCode)} before the server was reachable. Output tail: ` +
          `${output.length > 0 ? output : '(no output)'}`
        this.deps.updateWorkspace({ ...workspace, devJobId: null, devPort: null })
        bus.notice(roomId, 'error', `The dev server exited with code ${String(current.exitCode)}.`, 'Read the Terminal surface for the full output.')
        return this.toInfo(running)
      }
      if (port === null && current !== null && current.port !== null) port = current.port
      if (port !== null) {
        const local = `http://127.0.0.1:${port}`
        if (await probe(local)) {
          running.port = port
          running.localUrl = local
          this.deps.updateWorkspace({ ...workspace, devJobId: job.id, devPort: port })
          break
        }
      }
      await delay(READY_POLL_MS)
    }

    if (running.localUrl.length === 0) {
      running.state = 'failed'
      running.detail =
        port === null
          ? `${dev.command} never printed a local port within ${Math.round(READY_TIMEOUT_MS / 1000)}s. Huddle cannot guess the port; open the Terminal surface to see what the server said.`
          : `Port ${port} was detected but http://127.0.0.1:${port} never answered within ${Math.round(READY_TIMEOUT_MS / 1000)}s.`
      bus.notice(
        roomId,
        'error',
        `Preview failed: ${running.detail}`,
        'Check the dev server output in the Terminal surface.'
      )
      return this.toInfo(running)
    }

    /* --- expose it --- */
    if (settings.preview.mode === 'lan') {
      const host = settings.preview.lanHost ?? firstLanAddress()
      if (host === null) {
        running.state = 'failed'
        running.detail =
          `The dev server is live at ${running.localUrl}, but no LAN address was found and none is configured, so a remote browser cannot reach it.`
        bus.notice(
          roomId,
          'error',
          'Preview failed: no LAN address could be determined.',
          'Set the LAN host in settings, or switch the preview mode to "tunnel".'
        )
        return this.toInfo(running)
      }
      this.deps.updateWorkspace({ ...workspace, devJobId: job.id, devPort: running.port ?? port })
      running.state = 'ready'
      running.publicUrl = `http://${host}:${String(running.port ?? port)}`
      running.detail =
        `Serving from ${running.localUrl}, reachable on your network at ${running.publicUrl}. ` +
        (settings.preview.lanHost === null ? 'The LAN address was detected automatically. ' : '') +
        'A browser on another network cannot reach this URL.'
      return this.toInfo(running)
    }

    const subdomain = `huddle-${roomId.replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase()}`
    const tunnelResult = await this.openTunnel(port ?? 0, subdomain)
    if (tunnelResult === null) {
      const lanHost = firstLanAddress()
      running.publicUrl = lanHost === null ? null : `http://${lanHost}:${String(running.port ?? port)}`
      running.state = running.publicUrl === null ? 'failed' : 'ready'
      running.detail =
        `The dev server is live at ${running.localUrl}, but the localtunnel request failed (no internet, or localtunnel.me unreachable). ` +
        (running.publicUrl === null
          ? 'No fallback address is available either, so only this machine can open the preview.'
          : `Falling back to the local network address ${running.publicUrl} — a browser on another network cannot reach it.`)
      bus.notice(
        roomId,
        running.state === 'ready' ? 'warn' : 'error',
        running.detail,
        'Check the internet connection, or set preview mode to "lan" and configure the host.'
      )
      return this.toInfo(running)
    }

    running.tunnel = tunnelResult.tunnel
    running.publicUrl = tunnelResult.url
    running.state = 'ready'
    running.detail =
      `Dev server live at ${running.localUrl}; public URL ${tunnelResult.url}. ` +
      'A remote browser must send the header "Bypass-Tunnel-Reminder: true" on the first request, otherwise localtunnel shows its own reminder page. ' +
      'Through localtunnel the "Host" header is rewritten by the tunnel edge, so a dev server that enforces allowed hosts may reject the request.'
    bus.notice(roomId, 'info', `Preview ready for the remote browser at ${tunnelResult.url}`)
    return this.toInfo(running)
  }

  private async openTunnel(
    port: number,
    subdomain: string
  ): Promise<{ url: string; tunnel: Tunnel } | null> {
    if (port <= 0) return null
    const withSubdomain = await this.tryTunnel(port, subdomain)
    if (withSubdomain !== null) return withSubdomain
    return this.tryTunnel(port, undefined)
  }

  private async tryTunnel(port: number, subdomain: string | undefined): Promise<{ url: string; tunnel: Tunnel } | null> {
    try {
      const tunnel = await Promise.race([
        subdomain === undefined ? localtunnel(port) : localtunnel(port, { subdomain }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`localtunnel did not answer within ${TUNNEL_TIMEOUT_MS}ms`)), TUNNEL_TIMEOUT_MS)
        })
      ])
      return { url: tunnel.url, tunnel }
    } catch {
      return null
    }
  }

  async stopPreview(roomId: string): Promise<void> {
    const stoppedJobs = new Set<string>()
    for (const [recordKey, record] of [...this.records]) {
      if (record.roomId !== roomId) continue
      const workspace = this.deps.workspace(record.workspaceId)
      if (workspace !== null && (workspace.devJobId !== null || workspace.devPort !== null)) {
        this.deps.updateWorkspace({ ...workspace, devJobId: null, devPort: null })
      }
      if (record.jobId !== null) {
        stoppedJobs.add(record.jobId)
        try {
          await this.deps.jobs.cancelJob(record.jobId)
        } catch {
          // The job may already be gone; the dev server is stopped either way.
        }
      }
      this.closeTunnel(record)
      record.state = 'off'
      record.publicUrl = null
      record.detail = 'The preview was stopped and its dev server was shut down.'
      this.records.delete(recordKey)
    }

    // Belt and braces: a dev server started outside startPreview still has to go,
    // otherwise it keeps hold of the port the next preview needs.
    for (const job of this.deps.jobs.listRoomJobs(roomId)) {
      if (stoppedJobs.has(job.id)) continue
      if (isTerminalJobStatus(job.status)) continue
      if (!this.deps.jobs.isDevServerJob(job.id) && job.port === null) continue
      const workspace = this.deps.workspace(job.workspaceId)
      if (workspace !== null) this.deps.updateWorkspace({ ...workspace, devJobId: null, devPort: null })
      await this.deps.jobs.cancelJob(job.id).catch(() => undefined)
    }
  }

  disposeRoom(roomId: string): void {
    for (const [recordKey, record] of [...this.records]) {
      if (record.roomId !== roomId) continue
      this.closeTunnel(record)
      this.records.delete(recordKey)
    }
  }

  dispose(): void {
    for (const record of this.records.values()) this.closeTunnel(record)
    this.records.clear()
  }
}
