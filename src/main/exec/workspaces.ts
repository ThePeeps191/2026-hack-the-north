import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectBinding, WorkspaceRecord } from '../../shared/types.ts'
import type { HuddleBus } from '../contracts.ts'
import { worktreesDir } from '../paths.ts'
import {
  branchExists,
  currentBranch,
  git,
  gitAvailable,
  hasCommits,
  isGitRepo
} from './git.ts'
import { canonicalizeExisting } from './path-safety.ts'

/**
 * Workspace records for the Team integration workspace and for each agent.
 *
 * The Team workspace is the bound project folder itself; it is never a worktree,
 * because integration has to happen where the human can see it. An agent
 * workspace is a real `git worktree` on a real `huddle/<agent>` branch — or,
 * when the project is not a git repository, a truthful record that points at
 * the shared folder with `branch: null` and a notice explaining that writes are
 * shared. There is no third option in which Huddle pretends.
 */

export interface WorkspaceManagerDeps {
  bus: HuddleBus
  /** The room's bound project; throws `HuddleError` when nothing is bound. */
  project(roomId: string): Promise<ProjectBinding>
}

export const INTEGRATION_BRANCH = 'huddle/integration'

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug.length > 0 ? slug : fallback
}

export class WorkspaceManager {
  private readonly deps: WorkspaceManagerDeps
  private readonly byId = new Map<string, WorkspaceRecord>()

  constructor(deps: WorkspaceManagerDeps) {
    this.deps = deps
  }

  get(workspaceId: string): WorkspaceRecord | null {
    return this.byId.get(workspaceId) ?? null
  }

  remember(record: WorkspaceRecord): void {
    this.byId.set(record.id, record)
  }

  /** Update a workspace record and report it to the room. */
  update(record: WorkspaceRecord): WorkspaceRecord {
    this.byId.set(record.id, record)
    this.deps.bus.upsertWorkspace(record)
    return record
  }

  list(roomId?: string): WorkspaceRecord[] {
    const all = [...this.byId.values()]
    return roomId === undefined ? all : all.filter((workspace) => workspace.roomId === roomId)
  }

  private find(roomId: string, agentId: string | null, kind: WorkspaceRecord['kind']): WorkspaceRecord | null {
    for (const record of this.byId.values()) {
      if (record.roomId !== roomId) continue
      if (record.kind !== kind) continue
      if (record.agentId !== agentId) continue
      return record
    }
    return null
  }

  /**
   * The Team integration workspace is the bound project root, on whatever branch
   * the human left it on. Never a worktree.
   */
  async ensureTeamWorkspace(roomId: string): Promise<WorkspaceRecord> {
    const bus = this.deps.bus
    const project = await this.deps.project(roomId)
    const rootPath = (await canonicalizeExisting(project.rootPath)) ?? project.rootPath

    const existing = this.find(roomId, null, 'team')
    if (existing !== null && existsSync(existing.rootPath)) {
      if (existing.rootPath !== rootPath) {
        const moved: WorkspaceRecord = {
          ...existing,
          rootPath,
          branch: await this.branchOf(rootPath),
          lastVerifiedRevision: null
        }
        return this.update(moved)
      }
      return existing
    }

    const repo = project.isGitRepo && (await gitAvailable()) && (await isGitRepo(rootPath))
    const branch = repo ? await this.branchOf(rootPath) : null
    const record: WorkspaceRecord = {
      id: bus.newId(),
      roomId,
      agentId: null,
      kind: 'team',
      label: 'Team',
      rootPath,
      branch,
      baseBranch: branch,
      isWorktree: false,
      devPort: null,
      devJobId: null,
      createdAt: bus.now(),
      lastVerifiedRevision: null
    }
    this.byId.set(record.id, record)
    bus.upsertWorkspace(record)
    if (!repo) {
      bus.notice(
        roomId,
        'warn',
        `The Team workspace is ${rootPath}, which is not a git repository, so there is no branch history to verify against.`,
        'Run "git init" and make one commit in that folder, then re-bind the project.'
      )
    }
    return record
  }

  private async branchOf(rootPath: string): Promise<string | null> {
    return currentBranch(rootPath)
  }

  /**
   * A real worktree on a real branch, or an honest shared-folder record.
   */
  async ensureAgentWorkspace(roomId: string, agentId: string): Promise<WorkspaceRecord> {
    const bus = this.deps.bus
    const project = await this.deps.project(roomId)
    const rootPath = (await canonicalizeExisting(project.rootPath)) ?? project.rootPath
    const agent = bus.getAgent(agentId)
    const displayName = agent?.name ?? agentId.slice(0, 6)
    const slug = slugify(displayName, agentId.slice(0, 8))

    const existing = this.find(roomId, agentId, 'agent')
    if (existing !== null && existsSync(existing.rootPath)) return existing

    const gitReady = (await gitAvailable()) && project.isGitRepo && (await isGitRepo(rootPath))
    const commits = gitReady && (await hasCommits(rootPath))
    const baseBranch = commits ? await currentBranch(rootPath) : null

    if (!gitReady || !commits) {
      const reason = !gitReady
        ? 'this project is not a git repository'
        : 'this repository has no commits yet'
      const shared: WorkspaceRecord = {
        id: existing?.id ?? bus.newId(),
        roomId,
        agentId,
        kind: 'agent',
        label: `${displayName} (shared folder)`,
        rootPath,
        branch: null,
        baseBranch: null,
        isWorktree: false,
        devPort: null,
        devJobId: null,
        createdAt: existing?.createdAt ?? bus.now(),
        lastVerifiedRevision: existing?.lastVerifiedRevision ?? null
      }
      this.byId.set(shared.id, shared)
      bus.upsertWorkspace(shared)
      bus.notice(
        roomId,
        'warn',
        `${displayName} works directly in ${rootPath} because ${reason}: file writes are shared with the whole team and there is no per-agent branch.`,
        'Run "git init" and make one commit in the project folder, then re-bind the project to give each agent its own worktree.'
      )
      return shared
    }

    const branchName = `huddle/${slug}`
    const worktreesRoot = worktreesDir(roomId)
    await mkdir(worktreesRoot, { recursive: true })

    let worktreePath = join(worktreesRoot, slug)
    let suffix = 2
    while (existsSync(worktreePath) && !(await isRegisteredWorktree(rootPath, worktreePath))) {
      worktreePath = join(worktreesRoot, `${slug}-${suffix}`)
      suffix += 1
    }

    if (!existsSync(worktreePath)) {
      const hasBranch = await branchExists(rootPath, branchName)
      const startPoint = baseBranch ?? 'HEAD'
      const args = hasBranch
        ? ['worktree', 'add', worktreePath, branchName]
        : ['worktree', 'add', '-b', branchName, worktreePath, startPoint]
      const created = await git(rootPath, args)
      if (created.code !== 0) {
        const shared: WorkspaceRecord = {
          id: existing?.id ?? bus.newId(),
          roomId,
          agentId,
          kind: 'agent',
          label: `${displayName} (shared folder)`,
          rootPath,
          branch: null,
          baseBranch: null,
          isWorktree: false,
          devPort: null,
          devJobId: null,
          createdAt: existing?.createdAt ?? bus.now(),
          lastVerifiedRevision: existing?.lastVerifiedRevision ?? null
        }
        this.byId.set(shared.id, shared)
        bus.upsertWorkspace(shared)
        bus.notice(
          roomId,
          'error',
          `Could not create a worktree for ${displayName}: ${(created.stderr || created.stdout).trim().split('\n').slice(0, 3).join(' ')}`,
          `Fix the git worktree problem in ${rootPath}, or work in the shared folder instead.`
        )
        return shared
      }
    }

    const canonicalWorktree = (await canonicalizeExisting(worktreePath)) ?? worktreePath
    const branch = (await currentBranch(canonicalWorktree)) ?? branchName
    const record: WorkspaceRecord = {
      id: existing?.id ?? bus.newId(),
      roomId,
      agentId,
      kind: 'agent',
      label: `${displayName}'s worktree`,
      rootPath: canonicalWorktree,
      branch,
      baseBranch,
      isWorktree: true,
      devPort: existing?.devPort ?? null,
      devJobId: existing?.devJobId ?? null,
      createdAt: existing?.createdAt ?? bus.now(),
      lastVerifiedRevision: existing?.lastVerifiedRevision ?? null
    }
    this.byId.set(record.id, record)
    bus.upsertWorkspace(record)
    bus.notice(
      roomId,
      'info',
      `${displayName} works in ${canonicalWorktree} on branch ${branch} (worktree off ${baseBranch ?? 'HEAD'}).`
    )
    return record
  }

  async removeAgentWorkspace(record: WorkspaceRecord): Promise<void> {
    if (!record.isWorktree) return
    await git(record.rootPath, ['worktree', 'remove', '--force', record.rootPath])
  }
}

async function isRegisteredWorktree(repoRoot: string, path: string): Promise<boolean> {
  const result = await git(repoRoot, ['worktree', 'list', '--porcelain'])
  if (result.code !== 0) return false
  const wanted = path.replace(/\\/g, '/').toLowerCase()
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue
    const listed = line.slice('worktree '.length).trim().replace(/\\/g, '/').toLowerCase()
    if (listed === wanted) return true
  }
  return false
}
