import type { DiffHunk, WorkspaceDiff } from '../../shared/api.ts'
import type { WorkspaceRecord } from '../../shared/types.ts'
import { currentBranch, git, gitAvailable, headCommit, isGitRepo } from './git.ts'

/**
 * Real `git diff` output, parsed into per-file hunks.
 *
 * Nothing here builds a diff by hand: the `patch` field of every `DiffHunk` is
 * the verbatim git output for that file. When a workspace has no git history to
 * compare against, the result says so in `note` instead of inventing changes.
 */

const MAX_DIFF_FILES = 200
const MAX_DIFF_BYTES = 2 * 1024 * 1024

interface DiffSection {
  header: string
  lines: string[]
}

function splitGitDiff(output: string): DiffSection[] {
  const sections: DiffSection[] = []
  let current: DiffSection | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current !== null) sections.push(current)
      current = { header: line, lines: [line] }
      continue
    }
    if (current !== null) current.lines.push(line)
  }
  if (current !== null) sections.push(current)
  return sections
}

function statusOf(section: DiffSection): DiffHunk['status'] {
  const body = section.lines.join('\n')
  if (/^new file mode /m.test(body)) return 'added'
  if (/^deleted file mode /m.test(body)) return 'deleted'
  if (/^rename from /m.test(body)) return 'renamed'
  return 'modified'
}

function pathOf(section: DiffSection): string | null {
  for (const line of section.lines) {
    if (line.startsWith('+++ ')) {
      const candidate = line.slice(4).trim()
      if (candidate === '/dev/null') continue
      return candidate.replace(/^b\//, '').replace(/^"|"$/g, '')
    }
  }
  for (const line of section.lines) {
    if (line.startsWith('--- ')) {
      const candidate = line.slice(4).trim()
      if (candidate === '/dev/null') continue
      return candidate.replace(/^a\//, '').replace(/^"|"$/g, '')
    }
  }
  const gitLine = /^diff --git a\/(.+?) b\/(.+)$/.exec(section.header)
  return gitLine ? gitLine[2] : null
}

function countChanges(section: DiffSection): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  let inHunk = false
  for (const line of section.lines) {
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

/** Where the workspace's changes should be measured from. */
async function diffBase(workspace: WorkspaceRecord): Promise<{ range: string | null; note: string | null }> {
  if (workspace.baseBranch !== null) {
    const verify = await git(workspace.rootPath, ['rev-parse', '--verify', '--quiet', workspace.baseBranch])
    if (verify.code === 0) {
      // `git diff <ref>` compares the working tree (including uncommitted work)
      // against that ref, which is exactly what a shared workspace needs.
      return { range: workspace.baseBranch, note: null }
    }
  }
  const head = await headCommit(workspace.rootPath)
  if (head !== null) return { range: 'HEAD', note: null }
  return { range: null, note: 'The repository has no commits yet, so there is no revision to diff against.' }
}

export async function computeWorkspaceDiff(workspace: WorkspaceRecord): Promise<WorkspaceDiff> {
  const base: WorkspaceDiff = {
    workspaceId: workspace.id,
    branch: workspace.branch,
    baseBranch: workspace.baseBranch,
    revision: null,
    files: [],
    note: null
  }

  if (!(await gitAvailable())) {
    return { ...base, note: 'git is not installed on this machine, so Huddle cannot show a revision diff.' }
  }
  if (!(await isGitRepo(workspace.rootPath))) {
    return {
      ...base,
      note:
        'This folder is not a git repository. There is no revision to compare against, and every agent writes ' +
        'directly into this shared folder.'
    }
  }

  const revision = await headCommit(workspace.rootPath)
  const branch = await currentBranch(workspace.rootPath)
  const selected = await diffBase(workspace)
  if (selected.range === null) {
    return { ...base, branch, revision, note: selected.note }
  }

  const result = await git(workspace.rootPath, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    selected.range,
    '--'
  ])
  if (result.code !== 0 && result.spawnFailed) {
    return { ...base, branch, revision, note: `git diff could not run: ${result.stderr.trim()}` }
  }

  const sections = splitGitDiff(result.stdout)
  const files: DiffHunk[] = []
  let bytes = 0
  for (const section of sections) {
    const path = pathOf(section)
    if (path === null) continue
    const patch = section.lines.join('\n').trimEnd()
    bytes += Buffer.byteLength(patch, 'utf8')
    if (files.length >= MAX_DIFF_FILES || bytes > MAX_DIFF_BYTES) {
      return {
        ...base,
        branch,
        revision,
        files,
        note: `Huddle stopped after ${files.length} changed files (${Math.round(bytes / 1024)} KB of patch) to keep the UI responsive.`
      }
    }
    const counts = countChanges(section)
    files.push({
      path,
      status: statusOf(section),
      patch: patch.length === 0 ? '' : `${patch}\n`,
      additions: counts.additions,
      deletions: counts.deletions
    })
  }

  // Untracked files are real work but git will not diff them without an index
  // entry, so name them instead of pretending they are unchanged.
  const untracked = await git(workspace.rootPath, ['ls-files', '--others', '--exclude-standard'])
  const untrackedFiles =
    untracked.code === 0
      ? untracked.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : []

  const notes: string[] = []
  if (selected.note !== null) notes.push(selected.note)
  if (untrackedFiles.length > 0) {
    notes.push(
      `${untrackedFiles.length} untracked file(s) are not in this diff: ${untrackedFiles.slice(0, 8).join(', ')}` +
        `${untrackedFiles.length > 8 ? ', …' : ''}. git only diffs tracked content.`
    )
  }

  return {
    ...base,
    branch,
    revision,
    files,
    note: notes.length > 0 ? notes.join(' ') : null
  }
}
