import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { DEFAULT_SETTINGS, type Capability } from '../../shared/types.ts'
import type { ExecutionHost } from '../contracts.ts'
import { createFakeBus, fakeAgent, type FakeBus } from './fake-bus.ts'
import { git, gitAvailable } from './git.ts'
import { createExecutionHost } from './index.ts'
import { computeWorkspaceDiff } from './diff.ts'

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
}

async function makeHarness(options: { git: boolean }): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'huddle-ws-'))
  await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8')
  if (options.git) {
    await git(root, ['init', '-b', 'main'])
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
  }
  const bus = createFakeBus()
  const roomId = 'room-1'
  bus.addRoom(roomId)
  bus.addAgent(fakeAgent(roomId, 'agent-maya', 'Maya'))
  bus.addAgent(fakeAgent(roomId, 'agent-alex', 'Alex'))
  const host = createExecutionHost({ bus, capability, settings: () => DEFAULT_SETTINGS })
  openHosts.push(host)
  const binding = await host.bindProject(roomId, root, 'existing')
  bus.setProject(roomId, binding)
  return { host, bus, roomId, root }
}

describe('team workspace', () => {
  test('is the bound project root on its current branch, never a worktree', async (t) => {
    if (!(await gitAvailable())) {
      t.skip('git is not installed')
      return
    }
    const harness = await makeHarness({ git: true })
    const team = await harness.host.ensureTeamWorkspace(harness.roomId)
    assert.equal(team.kind, 'team')
    assert.equal(team.agentId, null)
    assert.equal(team.isWorktree, false)
    assert.equal(team.branch, 'main')
    assert.equal(team.baseBranch, 'main')
    assert.equal(team.rootPath, harness.root)
    assert.equal(team.lastVerifiedRevision, null)

    const again = await harness.host.ensureTeamWorkspace(harness.roomId)
    assert.equal(again.id, team.id)
    await rm(harness.root, { recursive: true, force: true })
  })

  test('reports no branch when the folder is not a git repository', async () => {
    const harness = await makeHarness({ git: false })
    const team = await harness.host.ensureTeamWorkspace(harness.roomId)
    assert.equal(team.branch, null)
    assert.equal(team.isWorktree, false)
    assert.ok(
      harness.bus.notices.some((notice) => notice.text.includes('not a git repository')),
      'the human must be told why there is no branch'
    )
    await rm(harness.root, { recursive: true, force: true })
  })
})

describe('agent workspaces', () => {
  test('creates a real worktree on a real branch', async (t) => {
    if (!(await gitAvailable())) {
      t.skip('git is not installed')
      return
    }
    const harness = await makeHarness({ git: true })
    const workspace = await harness.host.ensureAgentWorkspace(harness.roomId, 'agent-maya')
    assert.equal(workspace.kind, 'agent')
    assert.equal(workspace.agentId, 'agent-maya')
    assert.equal(workspace.isWorktree, true)
    assert.equal(workspace.branch, 'huddle/maya')
    assert.equal(workspace.baseBranch, 'main')
    assert.equal(workspace.label, "Maya's worktree")
    assert.ok(workspace.rootPath.includes('worktrees'))

    const listed = await git(harness.root, ['worktree', 'list', '--porcelain'])
    assert.match(listed.stdout, /huddle\/maya/)
    assert.ok(
      listed.stdout.toLowerCase().includes(workspace.rootPath.replace(/\\/g, '/').toLowerCase()),
      `git worktree list did not include ${workspace.rootPath}`
    )

    // Real isolation: a file written in the worktree is not in the team root.
    const written = await harness.host.writeFile(workspace.id, 'src/agent-file.ts', 'export const x = 1\n')
    assert.equal(written.created, true)
    const team = await harness.host.ensureTeamWorkspace(harness.roomId)
    const teamListing = await harness.host.listDir(team.id, 'src').catch(() => [])
    assert.equal(teamListing.length, 0)

    const again = await harness.host.ensureAgentWorkspace(harness.roomId, 'agent-maya')
    assert.equal(again.id, workspace.id)
    await rm(harness.root, { recursive: true, force: true })
  })

  test('falls back to the shared folder honestly when there is no git history', async () => {
    const harness = await makeHarness({ git: false })
    const workspace = await harness.host.ensureAgentWorkspace(harness.roomId, 'agent-maya')
    assert.equal(workspace.isWorktree, false)
    assert.equal(workspace.branch, null)
    assert.equal(workspace.baseBranch, null)
    assert.equal(workspace.rootPath, harness.root)
    assert.match(workspace.label, /shared folder/)
    const notice = harness.bus.notices.find((entry) => entry.text.includes('file writes are shared'))
    assert.ok(notice !== undefined, 'a truthful notice must explain the shared folder')
    assert.equal(notice.level, 'warn')
    assert.ok(notice.fix !== null && notice.fix.includes('git init'))
    await rm(harness.root, { recursive: true, force: true })
  })
})

describe('submitWork', () => {
  test('commits real changes and reports the real sha', async (t) => {
    if (!(await gitAvailable())) {
      t.skip('git is not installed')
      return
    }
    const harness = await makeHarness({ git: true })
    const workspace = await harness.host.ensureAgentWorkspace(harness.roomId, 'agent-maya')
    await harness.host.writeFile(workspace.id, 'src/feature.ts', 'export const feature = true\n')

    const result = await harness.host.submitWork({
      roomId: harness.roomId,
      agentId: 'agent-maya',
      workspaceId: workspace.id,
      summary: 'Add the feature flag',
      taskId: 'task-1'
    })
    assert.equal(result.branch, 'huddle/maya')
    assert.match(result.commit, /^[0-9a-f]{40}$/)
    assert.equal(result.filesChanged, 1)

    const head = await git(workspace.rootPath, ['rev-parse', 'HEAD'])
    assert.equal(head.stdout.trim(), result.commit)
    const message = await git(workspace.rootPath, ['log', '-1', '--pretty=%B'])
    assert.match(message.stdout, /Add the feature flag/)
    assert.match(message.stdout, /Huddle-Task: task-1/)
    const author = await git(workspace.rootPath, ['log', '-1', '--pretty=%an'])
    assert.equal(author.stdout.trim(), 'Maya')

    const nothing = await harness.host.submitWork({
      roomId: harness.roomId,
      agentId: 'agent-maya',
      workspaceId: workspace.id,
      summary: 'Nothing changed',
      taskId: null
    })
    assert.equal(nothing.commit, '')
    assert.equal(nothing.filesChanged, 0)
    assert.match(nothing.detail, /Nothing changed/)
    await rm(harness.root, { recursive: true, force: true })
  })

  test('says so when the project is not a git repository', async () => {
    const harness = await makeHarness({ git: false })
    const workspace = await harness.host.ensureAgentWorkspace(harness.roomId, 'agent-maya')
    const result = await harness.host.submitWork({
      roomId: harness.roomId,
      agentId: 'agent-maya',
      workspaceId: workspace.id,
      summary: 'Write a file',
      taskId: null
    })
    assert.equal(result.commit, '')
    assert.equal(result.filesChanged, 0)
    assert.match(result.detail, /not a git repository/)
    await rm(harness.root, { recursive: true, force: true })
  })
})

describe('workspace diff', () => {
  test('produces git patches and reports untracked files honestly', async (t) => {
    if (!(await gitAvailable())) {
      t.skip('git is not installed')
      return
    }
    const harness = await makeHarness({ git: true })
    const workspace = await harness.host.ensureAgentWorkspace(harness.roomId, 'agent-maya')

    await harness.host.writeFile(workspace.id, 'README.md', '# fixture\nchanged\n')
    await harness.host.writeFile(workspace.id, 'brand-new.ts', 'export const brandNew = 1\n')

    const diff = await harness.host.diff(workspace.id)
    assert.equal(diff.workspaceId, workspace.id)
    assert.equal(diff.branch, 'huddle/maya')
    const readme = diff.files.find((file) => file.path === 'README.md')
    assert.ok(readme !== undefined, `expected README.md in ${JSON.stringify(diff.files.map((f) => f.path))}`)
    assert.equal(readme.status, 'modified')
    assert.match(readme.patch, /^diff --git /m)
    assert.match(readme.patch, /^@@ /m)
    assert.equal(readme.additions, 1)
    assert.ok(diff.note !== null && diff.note.includes('untracked'))
    await rm(harness.root, { recursive: true, force: true })
  })

  test('a non-git workspace says there is nothing to diff against', async () => {
    const harness = await makeHarness({ git: false })
    const team = await harness.host.ensureTeamWorkspace(harness.roomId)
    const diff = await harness.host.diff(team.id)
    assert.equal(diff.files.length, 0)
    assert.ok(diff.note !== null && diff.note.includes('not a git repository'))
    assert.equal(diff.revision, null)
    await rm(harness.root, { recursive: true, force: true })
  })

  test('computeWorkspaceDiff is honest for a missing folder', async () => {
    const diff = await computeWorkspaceDiff({
      id: 'workspace-x',
      roomId: 'room-x',
      agentId: null,
      kind: 'team',
      label: 'Team',
      rootPath: join(tmpdir(), 'huddle-missing-workspace-xyz'),
      branch: null,
      baseBranch: null,
      isWorktree: false,
      devPort: null,
      devJobId: null,
      createdAt: new Date().toISOString(),
      lastVerifiedRevision: null
    })
    assert.equal(diff.files.length, 0)
    assert.ok(diff.note !== null)
  })
})
