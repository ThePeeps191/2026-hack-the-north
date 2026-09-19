import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MAX_TOOL_OUTPUT_CHARS,
  type Artifact,
  type CheckResult,
  type IntegrationAttempt,
  type JobRecord,
  type ProjectBinding,
  type WorkspaceRecord
} from '../../shared/types.ts'
import type { HuddleBus, IntegrateInput } from '../contracts.ts'
import { HuddleError } from '../huddle-error.ts'
import {
  agentIdentity,
  commitsAhead,
  conflictedFiles,
  currentBranch,
  git,
  gitAvailable,
  hasCommits,
  headCommit,
  isGitRepo,
  mergeAbort,
  mergeInProgress
} from './git.ts'
import { isTerminalJobStatus, type JobManager } from './jobs.ts'
import { INTEGRATION_BRANCH, WorkspaceManager } from './workspaces.ts'

/**
 * Integration: fold the agents' branches into one Team revision, then verify it
 * with the project's own commands.
 *
 * Three promises this module keeps:
 *
 *  - **Integrations never interleave.** Every run for a room is queued behind
 *    the previous one, so two agents cannot merge into the same working tree at
 *    the same time.
 *  - **Checks are real.** They run through the job machinery (so the Terminal
 *    surface shows the same output the model saw) and the attempt resolves at
 *    the end with the real exit codes.
 *  - **A good verification is never overwritten by a bad one.** The workspace's
 *    `lastVerifiedRevision` only ever moves forward on a run where every check
 *    passed.
 */

export const CHECK_TIMEOUT_MS = 6 * 60 * 1000
const CHECK_OUTPUT_CHARS = MAX_TOOL_OUTPUT_CHARS

export interface DetectedCheck {
  name: string
  command: string
}

const SCRIPT_ORDER = ['typecheck', 'test', 'build'] as const

async function packageManagerFor(rootPath: string): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
  if (existsSync(join(rootPath, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(rootPath, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(rootPath, 'bun.lockb'))) return 'bun'
  return 'npm'
}

async function readPackageJson(rootPath: string): Promise<{ scripts: Record<string, string> } | null> {
  const path = join(rootPath, 'package.json')
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const scripts = (parsed as { scripts?: unknown }).scripts
    if (scripts === null || typeof scripts !== 'object') return { scripts: {} }
    const cleaned: Record<string, string> = {}
    for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof value === 'string') cleaned[name] = value
    }
    return { scripts: cleaned }
  } catch {
    return null
  }
}

/** The project's own verification commands, taken from its real scripts. */
export async function detectProjectChecks(
  rootPath: string
): Promise<{ checks: DetectedCheck[]; detail: string }> {
  const pkg = await readPackageJson(rootPath)
  if (pkg === null) {
    return { checks: [], detail: `No readable package.json was found in ${rootPath}.` }
  }
  const manager = await packageManagerFor(rootPath)
  const checks: DetectedCheck[] = []
  for (const name of SCRIPT_ORDER) {
    if (typeof pkg.scripts[name] !== 'string') continue
    const command =
      manager === 'npm'
        ? name === 'test'
          ? 'npm test'
          : `npm run ${name}`
        : `${manager} run ${name}`
    checks.push({ name, command })
  }
  return {
    checks,
    detail:
      checks.length === 0
        ? `package.json in ${rootPath} has none of the scripts Huddle can verify with (${SCRIPT_ORDER.join(', ')}).`
        : `Using ${manager} scripts: ${checks.map((check) => check.command).join(', ')}.`
  }
}

function tail(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(-maxChars) : text
}

export interface IntegrationDeps {
  bus: HuddleBus
  jobs: JobManager
  workspaces: WorkspaceManager
  project(roomId: string): Promise<ProjectBinding>
  writeArtifact(input: {
    roomId: string
    agentId: string | null
    taskId: string | null
    kind: Artifact['kind']
    title: string
    filename: string
    data: Buffer | string
    mime: string
  }): Promise<Artifact>
}

export class IntegrationRunner {
  private readonly deps: IntegrationDeps
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(deps: IntegrationDeps) {
    this.deps = deps
  }

  /** Serialised per room: the returned promise resolves for that run only. */
  run(input: IntegrateInput): Promise<IntegrationAttempt> {
    return this.enqueue(input.roomId, () => this.runOnce(input))
  }

  private enqueue<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(roomId) ?? Promise.resolve()
    const next = previous.then(task, () => task())
    this.queues.set(
      roomId,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  private async runOnce(input: IntegrateInput): Promise<IntegrationAttempt> {
    const bus = this.deps.bus
    const attempt: IntegrationAttempt = {
      id: bus.newId(),
      roomId: input.roomId,
      agentId: input.agentId,
      sources: [],
      targetBranch: INTEGRATION_BRANCH,
      status: 'running',
      revision: null,
      checks: [],
      conflicts: [],
      decisionRevision: input.decisionRevision,
      detail: 'Integration started.',
      startedAt: bus.now(),
      endedAt: null
    }
    bus.upsertIntegration({ ...attempt })

    try {
      return await this.execute(input, attempt)
    } catch (error) {
      const message =
        error instanceof HuddleError
          ? `${error.message}${error.fix === null ? '' : ` ${error.fix}`}`
          : error instanceof Error
            ? error.message
            : 'Unknown integration failure.'
      attempt.status = 'failed'
      attempt.detail = `Integration failed: ${message}`
      attempt.endedAt = bus.now()
      bus.upsertIntegration({ ...attempt })
      bus.notice(input.roomId, 'error', `Integration failed: ${message}`)
      return attempt
    }
  }

  private async execute(input: IntegrateInput, attempt: IntegrationAttempt): Promise<IntegrationAttempt> {
    const bus = this.deps.bus
    const notes: string[] = []
    const project = await this.deps.project(input.roomId)
    const team = await this.deps.workspaces.ensureTeamWorkspace(input.roomId)
    const rootPath = team.rootPath
    const agentName = bus.getAgent(input.agentId)?.name ?? 'the integrator'

    const gitReady = (await gitAvailable()) && project.isGitRepo && (await isGitRepo(rootPath))
    const hasHistory = gitReady && (await hasCommits(rootPath))

    let teamRecord: WorkspaceRecord = team
    let baseBranch = team.baseBranch ?? (hasHistory ? await currentBranch(rootPath) : null)
    let revision = hasHistory ? await headCommit(rootPath) : null
    let targetBranch = team.branch ?? '(shared folder)'

    if (!gitReady) {
      notes.push(
        `${rootPath} is not a git repository, so there are no agent branches to merge: every agent writes into this folder directly.`
      )
    } else if (!hasHistory) {
      notes.push(`${rootPath} has no commits yet, so there is no revision to merge agent work into.`)
    } else {
      if (await mergeInProgress(rootPath)) {
        await mergeAbort(rootPath)
        notes.push('An unfinished merge from an earlier run was aborted before this integration.')
      }
      const current = await currentBranch(rootPath)
      if (current !== INTEGRATION_BRANCH) {
        const created = await git(rootPath, ['checkout', '-B', INTEGRATION_BRANCH])
        if (created.code !== 0) {
          throw new HuddleError(
            'integration_branch_failed',
            `Could not put ${rootPath} on ${INTEGRATION_BRANCH}: ${(created.stderr || created.stdout).trim()}`,
            'Resolve the working tree state (commit, stash or discard) and integrate again.'
          )
        }
        if (baseBranch === null) baseBranch = current
        notes.push(`Team workspace moved from ${current ?? 'a detached HEAD'} onto ${INTEGRATION_BRANCH}.`)
      }
      targetBranch = INTEGRATION_BRANCH
      teamRecord = this.deps.workspaces.update({
        ...team,
        branch: INTEGRATION_BRANCH,
        baseBranch: baseBranch ?? INTEGRATION_BRANCH
      })
      attempt.targetBranch = INTEGRATION_BRANCH

      const mergeBase = baseBranch ?? INTEGRATION_BRANCH
      const sourceIds =
        input.sourceAgentIds.length > 0
          ? input.sourceAgentIds
          : this.deps.workspaces
              .list(input.roomId)
              .filter((workspace) => workspace.kind === 'agent' && workspace.agentId !== null)
              .map((workspace) => workspace.agentId)
              .filter((agentId): agentId is string => agentId !== null)

      for (const agentId of sourceIds) {
        const name = bus.getAgent(agentId)?.name ?? agentId.slice(0, 6)
        const workspace = await this.deps.workspaces.ensureAgentWorkspace(input.roomId, agentId)
        if (!workspace.isWorktree || workspace.branch === null) {
          notes.push(`${name} has no branch (shared folder), so there was nothing to merge from them.`)
          continue
        }
        const ahead = await commitsAhead(rootPath, mergeBase, workspace.branch)
        if (ahead === 0) {
          notes.push(`${name}'s branch ${workspace.branch} has no commits ahead of ${mergeBase}, so it was skipped.`)
          continue
        }
        const commitResult = await git(rootPath, ['rev-parse', workspace.branch])
        const commit = commitResult.stdout.trim()
        const identity = agentIdentity(`Huddle (${agentName})`)
        const beforeMerge = await headCommit(rootPath)
        const merge = await git(rootPath, [
          '-c',
          `user.name=${identity.name}`,
          '-c',
          `user.email=${identity.email}`,
          'merge',
          '--no-ff',
          '-m',
          `Merge ${workspace.branch} (${name}) into ${INTEGRATION_BRANCH}`,
          workspace.branch
        ])
        if (merge.code !== 0) {
          const conflicts = await conflictedFiles(rootPath)
          const gitOutput = `${merge.stdout.trim()} ${merge.stderr.trim()}`.trim()
          if (conflicts.length > 0) {
            attempt.status = 'conflict'
            attempt.conflicts = conflicts
            await mergeAbort(rootPath)
            attempt.detail =
              `Merging ${workspace.branch} into ${INTEGRATION_BRANCH} conflicts in ${conflicts.length} file(s): ` +
              `${conflicts.join(', ')}. ${gitOutput} Huddle aborted the merge so the Team folder stays usable; ` +
              'resolve the overlap in the agent worktree and submit again.'
            attempt.endedAt = bus.now()
            bus.upsertIntegration({ ...attempt })
            bus.notice(
              input.roomId,
              'error',
              `Integration conflict in ${conflicts.join(', ')}.`,
              `${name} should resolve the overlap on ${workspace.branch}, then submit again.`
            )
            return attempt
          }
          attempt.status = 'failed'
          attempt.detail = `Merging ${workspace.branch} failed: ${gitOutput || 'git merge reported an error.'}`
          attempt.endedAt = bus.now()
          bus.upsertIntegration({ ...attempt })
          bus.notice(input.roomId, 'error', attempt.detail)
          return attempt
        }
        attempt.sources.push({ agentId, branch: workspace.branch, commit })
        const afterMerge = await headCommit(rootPath)
        if (afterMerge !== null && afterMerge === beforeMerge) {
          notes.push(
            `${workspace.branch} was already merged into ${INTEGRATION_BRANCH} (${commit.slice(0, 8)}), so no new commit was created.`
          )
        } else {
          notes.push(
            `Merged ${workspace.branch} (${ahead} commit(s), ${commit.slice(0, 8)}) into ${INTEGRATION_BRANCH}.`
          )
        }
      }

      revision = await headCommit(rootPath)
      attempt.detail = notes.join(' ')
      bus.upsertIntegration({ ...attempt })
    }

    /* -------------------------------------------------------------- *
     * Checks
     * -------------------------------------------------------------- */

    let specs: DetectedCheck[]
    if (input.checks !== undefined && input.checks.length > 0) {
      specs = input.checks.map((check) => ({ name: check.name, command: check.command }))
      notes.push(`Running ${specs.length} requested check(s).`)
    } else {
      const detected = await detectProjectChecks(rootPath)
      specs = detected.checks
      notes.push(detected.detail)
    }

    attempt.revision = revision

    if (specs.length === 0) {
      attempt.status = 'failed'
      attempt.detail =
        `${notes.join(' ')} No check command was available, so this revision is merged but NOT verified. ` +
        'Send an integration with explicit checks to verify it.'
      attempt.endedAt = bus.now()
      bus.upsertIntegration({ ...attempt })
      bus.notice(
        input.roomId,
        'warn',
        `Integration merged${revision === null ? '' : ` ${revision.slice(0, 8)}`} but had no check command to verify it.`,
        'Add a typecheck, test or build script to package.json, or send explicit checks.'
      )
      return attempt
    }

    if (await mergeInProgress(rootPath)) {
      notes.push('A merge was still in progress while checks ran; results describe a partially merged tree.')
    }

    attempt.checks = await this.runChecks(input, teamRecord, specs)
    const failedChecks = attempt.checks.filter((check) => check.status === 'fail')
    const allPassed = failedChecks.length === 0

    if (allPassed) {
      attempt.status = 'verified'
      attempt.detail = `${notes.join(' ')} All ${attempt.checks.length} check(s) passed on ${attempt.revision ?? 'the current revision'}.`
      this.deps.workspaces.update({ ...teamRecord, lastVerifiedRevision: attempt.revision })
      bus.notice(
        input.roomId,
        'info',
        `Integration verified: ${attempt.checks.length} check(s) passed on ${attempt.revision?.slice(0, 8) ?? 'the current revision'}.`
      )
    } else {
      attempt.status = 'checks_failed'
      attempt.detail =
        `${notes.join(' ')} ${failedChecks.length} of ${attempt.checks.length} check(s) failed: ` +
        `${failedChecks.map((check) => `${check.name} (exit ${String(check.exitCode)})`).join(', ')}. ` +
        `The last verified revision ${teamRecord.lastVerifiedRevision?.slice(0, 8) ?? '(none)'} was kept.`
      bus.notice(
        input.roomId,
        'error',
        `Integration checks failed: ${failedChecks.map((check) => check.name).join(', ')}.`,
        'Read the failing output in the Terminal surface, fix it, and integrate again.'
      )
    }
    attempt.endedAt = bus.now()
    bus.upsertIntegration({ ...attempt })
    await this.writeArtifacts(input, attempt, { rootPath, base: baseBranch })
    return attempt
  }

  private async runChecks(
    input: IntegrateInput,
    team: WorkspaceRecord,
    specs: DetectedCheck[]
  ): Promise<CheckResult[]> {
    const results: CheckResult[] = []
    let stopped = false

    for (const spec of specs) {
      if (stopped) {
        results.push({
          name: spec.name,
          command: spec.command,
          status: 'skipped',
          exitCode: null,
          output: '',
          durationMs: 0
        })
        continue
      }
      const startedAt = Date.now()
      let job: JobRecord
      try {
        job = await this.deps.jobs.startJob({
          roomId: input.roomId,
          agentId: input.agentId,
          workspaceId: team.id,
          label: `Check: ${spec.name}`,
          command: spec.command
        })
      } catch (error) {
        results.push({
          name: spec.name,
          command: spec.command,
          status: 'fail',
          exitCode: null,
          output: error instanceof Error ? error.message : 'Could not start the check.',
          durationMs: Date.now() - startedAt
        })
        stopped = true
        continue
      }

      let finished = await this.deps.jobs.waitForJob(job.id, CHECK_TIMEOUT_MS)
      if (!isTerminalJobStatus(finished.status)) {
        const cancelled = await this.deps.jobs.cancelJob(job.id)
        finished = cancelled
        const output = tail(this.deps.jobs.getJobOutput(job.id, CHECK_OUTPUT_CHARS).text, CHECK_OUTPUT_CHARS)
        results.push({
          name: spec.name,
          command: spec.command,
          status: 'fail',
          exitCode: finished.exitCode,
          output: `${output}\n[huddle] ${spec.command} was still running after ${Math.round(CHECK_TIMEOUT_MS / 1000)}s and was cancelled.`,
          durationMs: Date.now() - startedAt
        })
        stopped = true
        continue
      }

      const output = this.deps.jobs.getJobOutput(job.id, CHECK_OUTPUT_CHARS).text
      const passed = finished.exitCode === 0
      if (!passed) stopped = true
      results.push({
        name: spec.name,
        command: spec.command,
        status: passed ? 'pass' : 'fail',
        exitCode: finished.exitCode,
        output: tail(output, CHECK_OUTPUT_CHARS),
        durationMs: Date.now() - startedAt
      })
    }

    return results
  }

  private async writeArtifacts(
    input: IntegrateInput,
    attempt: IntegrationAttempt,
    context: { rootPath: string; base: string | null }
  ): Promise<void> {
    const lines: string[] = [
      `# Integration ${attempt.id.slice(0, 8)}`,
      '',
      `- status: ${attempt.status}`,
      `- started: ${attempt.startedAt}`,
      `- ended: ${attempt.endedAt ?? '(still running)'}`,
      `- target branch: ${attempt.targetBranch}`,
      `- revision: ${attempt.revision ?? '(none — the project has no commits)'}`,
      `- decision revision: ${attempt.decisionRevision}`,
      ''
    ]
    if (attempt.sources.length > 0) {
      lines.push('## Sources', '')
      for (const source of attempt.sources) {
        lines.push(`- ${source.agentId}: ${source.branch} @ ${source.commit}`)
      }
      lines.push('')
    }
    if (attempt.conflicts.length > 0) {
      lines.push('## Conflicts', '', ...attempt.conflicts.map((file) => `- ${file}`), '')
    }
    lines.push('## Checks', '')
    if (attempt.checks.length === 0) {
      lines.push('No check command was available for this revision.', '')
    }
    for (const check of attempt.checks) {
      lines.push(`### ${check.name} — ${check.status} (exit ${String(check.exitCode)}, ${check.durationMs}ms)`)
      lines.push('', `\`\`\`text`, check.output.trimEnd(), '```', '')
    }
    lines.push('## Detail', '', attempt.detail, '')

    try {
      await this.deps.writeArtifact({
        roomId: input.roomId,
        agentId: input.agentId,
        taskId: null,
        kind: 'report',
        title: `Integration report (${attempt.status})`,
        filename: `integration-${attempt.id.slice(0, 8)}.md`,
        data: lines.join('\n'),
        mime: 'text/markdown'
      })
    } catch {
      // An artifact failure must never invalidate a real verification.
    }

    if (context.base === null || attempt.revision === null) return
    try {
      const diff = await git(context.rootPath, [
        'diff',
        '--no-color',
        '--no-ext-diff',
        `${context.base}..${attempt.revision}`
      ])
      if (diff.code !== 0 || diff.stdout.trim().length === 0) return
      await this.deps.writeArtifact({
        roomId: input.roomId,
        agentId: input.agentId,
        taskId: null,
        kind: 'diff',
        title: `Integrated diff ${context.base}..${attempt.revision.slice(0, 8)}`,
        filename: `integration-${attempt.id.slice(0, 8)}.diff`,
        data: diff.stdout,
        mime: 'text/x-diff'
      })
    } catch {
      // Best effort only: the verification stands on its own.
    }
  }
}
