import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { DEFAULT_SETTINGS, type Capability, type JobRecord, type WorkspaceRecord } from '../../shared/types.ts'
import type { ExecutionHost } from '../contracts.ts'
import { createFakeBus, type FakeBus } from './fake-bus.ts'
import { createExecutionHost } from './index.ts'
import { isProcessAlive } from './jobs.ts'

// Keep Huddle's own data directory out of the repository while testing.
process.env.HUDDLE_DATA_ROOT = join(mkdtempSync(join(tmpdir(), 'huddle-data-')), 'data')

const openHosts: ExecutionHost[] = []
const openChildren: Array<ReturnType<typeof spawn>> = []

after(async () => {
  for (const host of openHosts) await host.dispose()
  for (const child of openChildren) {
    if (child.pid !== undefined && isProcessAlive(child.pid)) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
})

function capability(id: Capability['id']): Capability {
  return {
    id,
    label: id,
    state: 'ready',
    detail: 'test capability',
    fix: null,
    checkedAt: new Date().toISOString()
  }
}

interface Harness {
  host: ExecutionHost
  bus: FakeBus
  roomId: string
  team: WorkspaceRecord
  root: string
}

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'huddle-jobs-'))
  await writeFile(join(root, 'README.md'), 'fixture project\n', 'utf8')
  const bus = createFakeBus()
  const roomId = 'room-1'
  bus.addRoom(roomId)
  const host = createExecutionHost({ bus, capability, settings: () => DEFAULT_SETTINGS })
  openHosts.push(host)
  const binding = await host.bindProject(roomId, root, 'existing')
  bus.setProject(roomId, binding)
  const team = await host.ensureTeamWorkspace(roomId)
  return { host, bus, roomId, team, root }
}

async function writeScript(directory: string, name: string, source: string): Promise<string> {
  const path = join(directory, name)
  await writeFile(path, source, 'utf8')
  return path
}

describe('JobManager: real processes', () => {
  test('captures real stdout, stderr and the exit code', async () => {
    const harness = await makeHarness()
    const script = await writeScript(
      harness.root,
      'exit3.js',
      ["console.log('hello from job')", "console.error('warning line')", 'process.exit(3)', ''].join('\n')
    )

    const job = await harness.host.startJob({
      roomId: harness.roomId,
      agentId: 'agent-1',
      workspaceId: harness.team.id,
      label: 'Fail on purpose',
      command: `node "${script}"`
    })
    assert.equal(job.status, 'running')
    assert.ok(job.pid !== null && job.pid > 0)

    const finished = await harness.host.waitForJob(job.id, 20_000)
    assert.equal(finished.status, 'failed')
    assert.equal(finished.exitCode, 3)
    assert.ok(finished.endedAt !== null)

    const output = harness.host.getJobOutput(job.id)
    assert.match(output.text, /hello from job/)
    assert.match(output.text, /warning line/)
    assert.equal(output.exitCode, 3)
    assert.equal(output.truncated, false)

    const stored = harness.bus.jobs.get(job.id)
    assert.ok(stored !== undefined)
    assert.equal(stored.status, 'failed')
    assert.equal(stored.exitCode, 3)

    const streamed = harness.bus.events
      .filter((event) => event.type === 'job.output')
      .map((event) => (event.type === 'job.output' ? event.chunk : ''))
      .join('')
    assert.match(streamed, /hello from job/)

    await harness.host.dispose()
    await rm(harness.root, { recursive: true, force: true })
  })

  test('a successful job reports exited with code 0', async () => {
    const harness = await makeHarness()
    const script = await writeScript(harness.root, 'ok.js', "console.log(process.cwd())\n")
    const job = await harness.host.startJob({
      roomId: harness.roomId,
      agentId: 'agent-1',
      workspaceId: harness.team.id,
      label: 'Print cwd',
      command: `node "${script}"`
    })
    const finished = await harness.host.waitForJob(job.id, 20_000)
    assert.equal(finished.status, 'exited')
    assert.equal(finished.exitCode, 0)
    assert.equal(harness.host.getJobOutput(job.id).text.trim(), harness.root)
    await harness.host.dispose()
    await rm(harness.root, { recursive: true, force: true })
  })

  test('runs in a requested subdirectory and refuses to leave the workspace', async () => {
    const harness = await makeHarness()
    await mkdir(join(harness.root, 'sub'), { recursive: true })
    const script = await writeScript(harness.root, 'cwd.js', "console.log(process.cwd())\n")
    const job = await harness.host.startJob({
      roomId: harness.roomId,
      agentId: 'agent-1',
      workspaceId: harness.team.id,
      label: 'Print sub cwd',
      command: `node "${script}"`,
      cwd: 'sub'
    })
    const finished = await harness.host.waitForJob(job.id, 20_000)
    assert.equal(finished.exitCode, 0)
    assert.equal(harness.host.getJobOutput(job.id).text.trim(), join(harness.root, 'sub'))

    await assert.rejects(
      () =>
        harness.host.startJob({
          roomId: harness.roomId,
          agentId: 'agent-1',
          workspaceId: harness.team.id,
          label: 'Escape attempt',
          command: 'node -e "console.log(1)"',
          cwd: '../../..'
        }),
      (error: unknown) => error instanceof Error && error.name === 'HuddleError'
    )
    await harness.host.dispose()
    await rm(harness.root, { recursive: true, force: true })
  })

  test('waitForJob returns at the deadline without blocking anything', async () => {
    const harness = await makeHarness()
    const script = await writeScript(harness.root, 'long.js', 'setInterval(() => {}, 1000)\n')
    const job = await harness.host.startJob({
      roomId: harness.roomId,
      agentId: 'agent-1',
      workspaceId: harness.team.id,
      label: 'Long runner',
      command: `node "${script}"`
    })

    const startedAt = Date.now()
    const still = await harness.host.waitForJob(job.id, 300)
    const elapsed = Date.now() - startedAt
    assert.equal(still.status, 'running')
    assert.ok(elapsed < 5000, `deadline wait took ${elapsed}ms`)

    // The room is still responsive while the job runs: another job starts fine.
    const quick = await harness.host.startJob({
      roomId: harness.roomId,
      agentId: 'agent-1',
      workspaceId: harness.team.id,
      label: 'Quick one',
      command: 'node -e "console.log(42)"'
    })
    const quickDone = await harness.host.waitForJob(quick.id, 20_000)
    assert.equal(quickDone.exitCode, 0)

    const cancelled = await harness.host.cancelJob(job.id)
    assert.equal(cancelled.status, 'cancelled')
    await harness.host.dispose()
    await rm(harness.root, { recursive: true, force: true })
  })

  test('cancel kills the whole process tree', async () => {
    const harness = await makeHarness()
    const script = await writeScript(
      harness.root,
      'tree.js',
      [
        "const { spawn } = require('node:child_process')",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
        "console.log('CHILD_PID=' + child.pid)",
        'setInterval(() => {}, 1000)',
        ''
      ].join('\n')
    )
    const job = await harness.host.startJob({
      roomId: harness.roomId,
      agentId: 'agent-1',
      workspaceId: harness.team.id,
      label: 'Tree runner',
      command: `node "${script}"`
    })

    let childPid: number | null = null
    for (let attempt = 0; attempt < 60 && childPid === null; attempt += 1) {
      const match = /CHILD_PID=(\d+)/.exec(harness.host.getJobOutput(job.id).text)
      if (match) childPid = Number.parseInt(match[1], 10)
      else await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.ok(childPid !== null, 'the grandchild pid was never printed')
    const parentPid = job.pid
    assert.ok(parentPid !== null)
    assert.equal(isProcessAlive(childPid), true)

    const record = await harness.host.cancelJob(job.id)
    assert.equal(record.status, 'cancelled')

    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(isProcessAlive(parentPid), false, `parent pid ${parentPid} survived the cancel`)
    assert.equal(isProcessAlive(childPid), false, `grandchild pid ${childPid} survived the cancel`)

    // Cancelling twice is honest, not a crash.
    const again = await harness.host.cancelJob(job.id)
    assert.equal(again.status, 'cancelled')
    await harness.host.dispose()
    await rm(harness.root, { recursive: true, force: true })
  })

  test('tracks a dev server port from real output and keeps one per workspace', async () => {
    const harness = await makeHarness()
    const script = await writeScript(
      harness.root,
      'dev.js',
      [
        "const http = require('node:http')",
        "const server = http.createServer((req, res) => { res.end('ok') })",
        "server.listen(0, '127.0.0.1', () => {",
        "  console.log('Local: http://127.0.0.1:' + server.address().port + '/')",
        '})',
        ''
      ].join('\n')
    )
    const job = await harness.host.startJob({
      roomId: harness.roomId,
      agentId: 'agent-1',
      workspaceId: harness.team.id,
      label: 'Dev server',
      command: `node "${script}"`,
      devServer: true
    })

    let port: number | null = null
    for (let attempt = 0; attempt < 50 && port === null; attempt += 1) {
      const record = harness.bus.jobs.get(job.id)
      if (record !== undefined && record.port !== null) port = record.port
      else await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.ok(port !== null, 'no port was detected from the dev server output')
    assert.ok(port > 0 && port < 65536)

    const workspace = harness.bus.workspaces.get(harness.team.id)
    assert.ok(workspace !== undefined)
    assert.equal(workspace.devPort, port)
    assert.equal(workspace.devJobId, job.id)

    // Starting a second dev server for the same workspace replaces the first.
    const second = await harness.host.startJob({
      roomId: harness.roomId,
      agentId: 'agent-1',
      workspaceId: harness.team.id,
      label: 'Dev server',
      command: `node "${script}"`,
      devServer: true
    })
    const firstRecord = harness.bus.jobs.get(job.id)
    assert.ok(firstRecord !== undefined)
    assert.equal(firstRecord.status, 'cancelled')

    await harness.host.cancelJob(second.id)
    await harness.host.dispose()
    await rm(harness.root, { recursive: true, force: true })
  })

  test('disposeRoom stops that room processes and leaves nothing behind', async () => {
    const harness = await makeHarness()
    const script = await writeScript(harness.root, 'long2.js', 'setInterval(() => {}, 1000)\n')
    const job = await harness.host.startJob({
      roomId: harness.roomId,
      agentId: 'agent-1',
      workspaceId: harness.team.id,
      label: 'Room job',
      command: `node "${script}"`
    })
    assert.ok(job.pid !== null)
    await harness.host.disposeRoom(harness.roomId)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(isProcessAlive(job.pid), false)
    assert.equal(harness.host.getJobOutput(job.id).status, 'cancelled')
    await harness.host.dispose()
    await rm(harness.root, { recursive: true, force: true })
  })

  test('reconcile never assumes a persisted running job survived', async () => {
    const harness = await makeHarness()

    // A real long-running process owned by this test, pretending to be a job
    // from a previous session.
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    openChildren.push(orphan)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.ok(orphan.pid !== undefined)

    const finished = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    await new Promise((resolve) => finished.on('exit', resolve))
    assert.ok(finished.pid !== undefined)

    const base = {
      roomId: harness.roomId,
      agentId: 'agent-1',
      workspaceId: harness.team.id,
      label: 'Old job',
      command: 'node whatever.js',
      cwd: harness.root,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: null,
      truncated: false,
      port: null
    }
    const aliveJob: JobRecord = {
      ...base,
      id: 'old-alive',
      status: 'running',
      exitCode: null,
      pid: orphan.pid ?? null,
      lastObservedAt: new Date(Date.now() - 60_000).toISOString()
    }
    const deadJob: JobRecord = {
      ...base,
      id: 'old-dead',
      status: 'running',
      exitCode: null,
      pid: finished.pid ?? null,
      lastObservedAt: new Date(Date.now() - 60_000).toISOString()
    }

    await harness.host.reconcile([aliveJob, deadJob], [])

    const reconciledAlive = harness.bus.jobs.get('old-alive')
    const reconciledDead = harness.bus.jobs.get('old-dead')
    assert.ok(reconciledAlive !== undefined && reconciledDead !== undefined)
    assert.equal(reconciledAlive.status, 'unknown')
    assert.equal(reconciledDead.status, 'unknown')
    assert.equal(reconciledDead.endedAt !== null, true)
    assert.ok(
      harness.bus.notices.some((notice) => notice.text.includes('still running from the previous session')),
      'the surviving process must be reported'
    )
    assert.ok(
      harness.bus.notices.some((notice) => notice.text.includes('did not survive')),
      'the dead process must be reported honestly'
    )

    // The orphan is still killable through the job machinery.
    const cancelled = await harness.host.cancelJob('old-alive')
    assert.equal(cancelled.status, 'cancelled')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(isProcessAlive(orphan.pid ?? 0), false)

    await harness.host.dispose()
    await rm(harness.root, { recursive: true, force: true })
  })
})
