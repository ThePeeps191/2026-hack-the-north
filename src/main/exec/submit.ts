import type { SubmitResult } from '../contracts.ts'
import { HuddleError } from '../huddle-error.ts'
import { agentIdentity, currentBranch, git, gitAvailable, hasCommits, isGitRepo } from './git.ts'

/**
 * Committing an agent's work on its own branch.
 *
 * Huddle only reports a commit when git actually created one. "Nothing changed"
 * is a real answer and is reported as such.
 */

export interface CommitOptions {
  summary: string
  agentName: string
  agentId: string
  taskId: string | null
}

export async function commitWorkspace(rootPath: string, workspaceIsShared: boolean, options: CommitOptions): Promise<SubmitResult> {
  const branch = (await currentBranch(rootPath)) ?? ''

  if (!(await gitAvailable())) {
    return {
      commit: '',
      branch,
      filesChanged: 0,
      detail: `git is not installed, so Huddle could not commit anything. The files written in ${rootPath} are still on disk.`
    }
  }
  if (!(await isGitRepo(rootPath))) {
    return {
      commit: '',
      branch,
      filesChanged: 0,
      detail: workspaceIsShared
        ? `The project is not a git repository, so there is no branch to commit to. Every agent writes directly into ${rootPath} and the edits are already saved there.`
        : `The project is not a git repository, so there is no branch to commit to. The edits are already saved in ${rootPath}.`
    }
  }

  const first = !(await hasCommits(rootPath))
  const add = await git(rootPath, ['add', '-A'])
  if (add.code !== 0) {
    throw new HuddleError(
      'git_add_failed',
      `git add -A failed in ${rootPath}: ${(add.stderr || add.stdout).trim()}`,
      'Check file permissions and the git index, then submit again.'
    )
  }

  const staged = await git(rootPath, ['diff', '--cached', '--quiet'])
  if (staged.code === 0 && !first) {
    return {
      commit: '',
      branch,
      filesChanged: 0,
      detail: `Nothing changed in ${branch === '' ? rootPath : branch}: there were no new edits to commit.`
    }
  }

  const identity = agentIdentity(options.agentName)
  const trailers = [`Huddle-Agent: ${options.agentId}`]
  if (options.taskId !== null) trailers.push(`Huddle-Task: ${options.taskId}`)
  const message = options.summary.trim().length > 0 ? options.summary.trim() : 'Work in progress'
  const args = [
    '-c',
    `user.name=${identity.name}`,
    '-c',
    `user.email=${identity.email}`,
    'commit',
    '--no-verify',
    '-m',
    message,
    '-m',
    trailers.join('\n')
  ]
  const commit = await git(rootPath, args)
  if (commit.code !== 0) {
    throw new HuddleError(
      'git_commit_failed',
      `git commit failed in ${rootPath}: ${(commit.stderr || commit.stdout).trim()}`,
      'Check the repository state (hooks, index lock) and submit again.'
    )
  }

  const sha = (await git(rootPath, ['rev-parse', 'HEAD'])).stdout.trim()
  const files = await git(rootPath, ['show', '--name-only', '--format=', '--no-renames', 'HEAD'])
  const filesChanged = files.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length

  return {
    commit: sha,
    branch: (await currentBranch(rootPath)) ?? branch,
    filesChanged,
    detail: `${first ? 'Created the first commit' : 'Committed'} ${filesChanged} file(s) on ${branch || '(detached HEAD)'} as ${options.agentName}.`
  }
}
