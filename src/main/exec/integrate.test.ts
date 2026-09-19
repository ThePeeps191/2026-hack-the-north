import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { DEFAULT_SETTINGS, type Capability, type WorkspaceRecord } from '../../shared/types.ts'
import type { ExecutionHost } from '../contracts.ts'
import { createFakeBus, fakeAgent, type FakeBus } from './fake-bus.ts'
import { git, gitAvailable, mergeInProgress } from './git.ts'
import { createExecutionHost } from './index.ts'

process.env.HUDDLE_DATA_ROOT = join(mkdtempSync(join(tmpdir(), 'huddle-data-')), 'data')

const openHosts: ExecutionHost[] = []

after(async () => {
  for (const host of openHosts) await host.dispose()
})

function capability(id: Capability['id']): Capability {
  return { id, label: id, state: 'ready', detail: 'test', fix: null, checkedAt: new Date().toISOString() }
}

interface Harness {
  host: ExecutionHost
  bus: FakeBus
  roomId: string
  root: string
  team: WorkspaceRecord
}

async function makeGitHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'huddle-integrate-'))
  await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {} }, null, 2), 'utf8')
  await git(root, ['init', '-b', 'main'])
  // Windows git defaults to core.autocrlf=true, which would turn this test into
  // an assertion about the platform's line endings rather than the merge.
  await git(root, ['config', 'core.autocrlf', 'false'])
  await git(root, ['config', 'core.eol', 'lf'])
  await git(root, ['add', '-A'])
  await git(root, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'initial commit'
  ])

  const bus = createFakeBus()
  const roomId = 'room-1'
  bus.addRoom(roomId)
  bus.addAgent(fakeAgent(roomId, 'agent-maya', 'Maya'))
  bus.addAgent(fakeAgent(roomId, 'agent-alex', 'Alex'))
  const host = createExecutionHost({ bus, capability, settings: () => DEFAULT_SETTINGS })
  openHosts.push(host)
  const binding = await host.bindProject(roomId, root, 'existing')
  bus.setProject(roomId, binding)
  const team = await host.ensureTeamWorkspace(roomId)
  return { host, bus, roomId, root, team }
}

const PASS_CHECK = { name: 'pass', command: 'node -e "console.log(\'ok\')"' }
const FAIL_CHECK = { name: 'fail', command: 'node -e "process.exit(2)"' }

describe('integrate', () => {
  test('merges agent branches into an integration branch and verifies the revision', async (t) => {
    if (!(await gitAvailable())) {
      t.skip('git is not installed')
      return
    }
    const harness = await makeGitHarness()
    const maya = await harness.host.ensureAgentWorkspace(harness.roomId, 'agent-maya')
    await harness.host.writeFile(maya.id, 'src/maya.ts', 'export const maya = 1\n')
    const submission = await harness.host.submitWork({
      roomId: harness.roomId,
      agentId: 'agent-maya',
      workspaceId: maya.id,
      summary: 'Maya adds her module',
      taskId: null
    })
    assert.match(submission.commit, /^[0-9a-f]{40}$/)

    const attempt = await harness.host.integrate({
      roomId: harness.roomId,
      agentId: 'agent-alex',
      sourceAgentIds: ['agent-maya'],
      decisionRevision: 1,
      checks: [PASS_CHECK]
    })

    assert.equal(attempt.status, 'verified')
    assert.equal(attempt.targetBranch, 'huddle/integration')
    assert.equal(attempt.sources.length, 1)
    assert.equal(attempt.sources[0].branch, 'huddle/maya')
    assert.equal(attempt.sources[0].commit, submission.commit)
    assert.equal(attempt.checks.length, 1)
    assert.equal(attempt.checks[0].status, 'pass')
    assert.equal(attempt.checks[0].exitCode, 0)
    assert.match(attempt.checks[0].output, /ok/)
    assert.ok(attempt.revision !== null && /^[0-9a-f]{40}$/.test(attempt.revision))
    assert.ok(attempt.endedAt !== null)

    // The team folder really carries the merged file and the integration branch.
    const team = await harness.host.ensureTeamWorkspace(harness.roomId)
    assert.equal(team.branch, 'huddle/integration')
    assert.equal(team.baseBranch, 'main')
    assert.equal(team.lastVerifiedRevision, attempt.revision)
    const branch = await git(harness.root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    assert.equal(branch.stdout.trim(), 'huddle/integration')
    const file = await harness.host.readFile(team.id, 'src/maya.ts')
    assert.equal(file.text, 'export const maya = 1\n')

    // A real report artifact with the real output is written.
    assert.ok(harness.bus.artifacts.length >= 1)
    const report = harness.bus.artifacts[0]
    assert.equal(report.kind, 'report')
    assert.ok(report.bytes !== null && report.bytes > 0)
    assert.ok(report.path !== null)

    await rm(harness.root, { recursive: true, force: true })
  })

  test('a failing check keeps the previously verified revision visible', async (t) => {
    if (!(await gitAvailable())) {
      t.skip('git is not installed')
      return
    }
    const harness = await makeGitHarness()
    const maya = await harness.host.ensureAgentWorkspace(harness.roomId, 'agent-maya')
    await harness.host.writeFile(maya.id, 'src/one.ts', 'export const one = 1\n')
    await harness.host.submitWork({
      roomId: harness.roomId,
      agentId: 'agent-maya',
      workspaceId: maya.id,
      summary: 'First change',
      taskId: null
    })

    const good = await harness.host.integrate({
      roomId: harness.roomId,
      agentId: 'agent-alex',
      sourceAgentIds: ['agent-maya'],
      decisionRevision: 1,
      checks: [PASS_CHECK]
    })
    assert.equal(good.status, 'verified')
    const verifiedRevision = good.revision
    assert.ok(verifiedRevision !== null)
    const afterGood = await harness.host.ensureTeamWorkspace(harness.roomId)
    assert.equal(afterGood.lastVerifiedRevision, verifiedRevision)

    await harness.host.writeFile(maya.id, 'src/two.ts', 'export const two = 2\n')
    await harness.host.submitWork({
      roomId: harness.roomId,
      agentId: 'agent-maya',
      workspaceId: maya.id,
      summary: 'Second change',
      taskId: null
    })

    const bad = await harness.host.integrate({
      roomId: harness.roomId,
      agentId: 'agent-alex',
      sourceAgentIds: ['agent-maya'],
      decisionRevision: 1,
      checks: [FAIL_CHECK, PASS_CHECK]
    })

    assert.equal(bad.status, 'checks_failed')
    assert.equal(bad.checks.length, 2)
    assert.equal(bad.checks[0].status, 'fail')
    assert.equal(bad.checks[0].exitCode, 2)
    assert.equal(bad.checks[1].status, 'skipped')
    assert.ok(bad.revision !== null && bad.revision !== verifiedRevision)
    assert.match(bad.detail, /The last verified revision/)

    const afterBad = await harness.host.ensureTeamWorkspace(harness.roomId)
    assert.equal(
      afterBad.lastVerifiedRevision,
      verifiedRevision,
      'a failed verification must never overwrite the good revision'
    )
    await rm(harness.root, { recursive: true, force: true })
  })

  test('two integrations for one room never interleave', async (t) => {
    if (!(await gitAvailable())) {
      t.skip('git is not installed')
      return
    }
    const harness = await makeGitHarness()
    const maya = await harness.host.ensureAgentWorkspace(harness.roomId, 'agent-maya')
    await harness.host.writeFile(maya.id, 'src/one.ts', 'export const one = 1\n')
    await harness.host.submitWork({
      roomId: harness.roomId,
      agentId: 'agent-maya',
      workspaceId: maya.id,
      summary: 'Maya work',
      taskId: null
    })
    const alex = await harness.host.ensureAgentWorkspace(harness.roomId, 'agent-alex')
    await harness.host.writeFile(alex.id, 'src/two.ts', 'export const two = 2\n')
    await harness.host.submitWork({
      roomId: harness.roomId,
      agentId: 'agent-alex',
      workspaceId: alex.id,
      summary: 'Alex work',
      taskId: null
    })

    const slowCheck = { name: 'slow', command: 'node -e "setTimeout(() => {}, 700)"' }
    const first = harness.host.integrate({
      roomId: harness.roomId,
      agentId: 'agent-alex',
      sourceAgentIds: ['agent-maya'],
      decisionRevision: 1,
      checks: [slowCheck]
    })
    const second = harness.host.integrate({
      roomId: harness.roomId,
      agentId: 'agent-alex',
      sourceAgentIds: ['agent-alex'],
      decisionRevision: 1,
      checks: [slowCheck]
    })
    const [firstResult, secondResult] = await Promise.all([first, second])
    assert.equal(firstResult.status, 'verified')
    assert.equal(secondResult.status, 'verified')

    const log = harness.bus.integrationLog
    assert.ok(log.length >= 4)
    const firstId = firstResult.id
    const secondId = secondResult.id
    const lastFirstIndex = log.map((entry) => entry.id).lastIndexOf(firstId)
    const firstSecondIndex = log.map((entry) => entry.id).indexOf(secondId)
    assert.ok(
      firstSecondIndex > lastFirstIndex,
      `integrations interleaved: ${JSON.stringify(log.map((entry) => `${entry.id}:${entry.status}`))}`
    )
    assert.equal(log.filter((entry) => entry.status === 'running').length, 4)
    assert.equal(log[log.length - 1].status, 'verified')
    assert.equal(await mergeInProgress(harness.root), false)
    await rm(harness.root, { recursive: true, force: true })
  })

  test('stops on a real conflict and reports the conflicted files', async (t) => {
    if (!(await gitAvailable())) {
      t.skip('git is not installed')
      return
    }
    const harness = await makeGitHarness()
    const maya = await harness.host.ensureAgentWorkspace(harness.roomId, 'agent-maya')
    const alex = await harness.host.ensureAgentWorkspace(harness.roomId, 'agent-alex')

    // Both agents rewrite the same line of the same file.
    await harness.host.writeFile(maya.id, 'README.md', '# fixture by maya\n')
    await harness.host.submitWork({
      roomId: harness.roomId,
      agentId: 'agent-maya',
      workspaceId: maya.id,
      summary: 'Maya rewrites the heading',
      taskId: null
    })
    await harness.host.writeFile(alex.id, 'README.md', '# fixture by alex\n')
    await harness.host.submitWork({
      roomId: harness.roomId,
      agentId: 'agent-alex',
      workspaceId: alex.id,
      summary: 'Alex rewrites the heading',
      taskId: null
    })

    const attempt = await harness.host.integrate({
      roomId: harness.roomId,
      agentId: 'agent-alex',
      sourceAgentIds: ['agent-maya', 'agent-alex'],
      decisionRevision: 1,
      checks: [PASS_CHECK]
    })

    assert.equal(attempt.status, 'conflict')
    assert.deepEqual(attempt.conflicts, ['README.md'])
    assert.equal(attempt.checks.length, 0)
    assert.match(attempt.detail, /conflicts in 1 file/)
    assert.match(attempt.detail, /aborted the merge/)
    // The team folder stays usable: no half-finished merge left behind.
    assert.equal(await mergeInProgress(harness.root), false)
    assert.ok(
      harness.bus.notices.some((notice) => notice.level === 'error' && notice.text.includes('conflict')),
      'the room must be told about the conflict'
    )
    await rm(harness.root, { recursive: true, force: true })
  })

  test('a project without git or checks is reported honestly, never as verified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'huddle-integrate-plain-'))
    await writeFile(join(root, 'notes.txt'), 'plain folder\n', 'utf8')
    const bus = createFakeBus()
    const roomId = 'room-plain'
    bus.addRoom(roomId)
    bus.addAgent(fakeAgent(roomId, 'agent-maya', 'Maya'))
    const host = createExecutionHost({ bus, capability, settings: () => DEFAULT_SETTINGS })
    openHosts.push(host)
    const binding = await host.bindProject(roomId, root, 'existing')
    bus.setProject(roomId, binding)
    await host.ensureTeamWorkspace(roomId)

    const attempt = await host.integrate({
      roomId,
      agentId: 'agent-maya',
      sourceAgentIds: ['agent-maya'],
      decisionRevision: 1
    })

    assert.equal(attempt.status, 'failed')
    assert.equal(attempt.revision, null)
    assert.match(attempt.detail, /not a git repository/)
    assert.match(attempt.detail, /NOT verified/)
    await rm(root, { recursive: true, force: true })
  })

  test('a non-git project with an explicit passing check is verified against no revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'huddle-integrate-plain2-'))
    await writeFile(join(root, 'notes.txt'), 'plain folder\n', 'utf8')
    const bus = createFakeBus()
    const roomId = 'room-plain2'
    bus.addRoom(roomId)
    bus.addAgent(fakeAgent(roomId, 'agent-maya', 'Maya'))
    const host = createExecutionHost({ bus, capability, settings: () => DEFAULT_SETTINGS })
    openHosts.push(host)
    const binding = await host.bindProject(roomId, root, 'existing')
    bus.setProject(roomId, binding)
    await host.ensureTeamWorkspace(roomId)

    const attempt = await host.integrate({
      roomId,
      agentId: 'agent-maya',
      sourceAgentIds: [],
      decisionRevision: 1,
      checks: [PASS_CHECK]
    })
    assert.equal(attempt.status, 'verified')
    assert.equal(attempt.revision, null)
    assert.equal(attempt.checks[0].status, 'pass')
    assert.match(attempt.detail, /not a git repository/)
    await rm(root, { recursive: true, force: true })
  })
})
