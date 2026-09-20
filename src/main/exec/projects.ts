import { existsSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { ProjectBinding } from '../../shared/types.ts'
import { HuddleError } from '../huddle-error.ts'
import { appRoot, dataRoot, demoProjectsDir, demoTemplatePath } from '../paths.ts'
import { canonicalizeExisting, isPathInside, realpathExistingAncestor } from './path-safety.ts'
import { git, gitAvailable, hasCommits, isDirty, isGitRepo } from './git.ts'
import { linkDependencies } from './deps.ts'

/**
 * Binding a room to a real project directory.
 *
 * Two rules that exist because the alternative is a demo that lies:
 *
 *  - Huddle refuses to work on its own source tree. The team must edit a
 *    project, not the app that is hosting it.
 *  - `kind: 'demo'` copies the packaged template with a real recursive copy and
 *    then makes a real git repository, so worktrees and diffs work from the
 *    first minute.
 */

const COPY_EXCLUDE = new Set(['node_modules', 'dist', '.venv', '.git', '.data', '.DS_Store'])
const TEMPLATE_NAME = 'sketch-night'

export interface Notify {
  (level: 'info' | 'warn' | 'error', text: string, fix?: string): void
}

/** The packaged demo template directory. */
export function demoTemplate(): string {
  return demoTemplatePath()
}

/** A fresh, unused folder under the data root for a new demo project. */
export function suggestDemoPath(roomId: string): string {
  const stem = `${TEMPLATE_NAME}-${roomId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'room'}`
  let candidate = join(demoProjectsDir(), stem)
  let counter = 2
  while (existsSync(candidate)) {
    candidate = join(demoProjectsDir(), `${stem}-${counter}`)
    counter += 1
  }
  return candidate
}

/**
 * Refuse Huddle's own source tree. The data root (`.data`, where demo projects
 * and worktrees live) is explicitly allowed, because that is Huddle's scratch
 * space rather than its source.
 */
export async function assertNotHuddleSource(canonical: string): Promise<void> {
  const candidates = new Set<string>()
  const appRootPath = await canonicalizeExisting(appRoot())
  if (appRootPath !== null) candidates.add(appRootPath)
  const cwdPath = await canonicalizeExisting(process.cwd())
  if (cwdPath !== null) candidates.add(cwdPath)
  // The data root may not exist yet on first launch, so resolve through its
  // nearest existing ancestor. Demo projects live inside it.
  const dataPath = await realpathExistingAncestor(dataRoot())

  for (const root of candidates) {
    if (canonical === root) {
      throw new HuddleError(
        'project_is_huddle',
        `${canonical} is Huddle's own source tree, not a project for the team to work on.`,
        'Pick the folder you actually want the team to edit, or create the demo project instead.'
      )
    }
    if (isPathInside(canonical, root)) {
      throw new HuddleError(
        'project_is_huddle',
        `${canonical} contains Huddle's source tree (${root}), so it cannot be the target project.`,
        'Pick a project folder, or create the demo project instead.'
      )
    }
    if (isPathInside(root, canonical)) {
      const insideData = dataPath !== null && isPathInside(dataPath, canonical)
      if (insideData) continue
      throw new HuddleError(
        'project_is_huddle',
        `${canonical} is inside Huddle's own source tree (${root}). Huddle will not let the team edit itself.`,
        'Pick a project folder outside Huddle, or create the demo project instead.'
      )
    }
  }
}

async function pathIsEmpty(directory: string): Promise<boolean> {
  try {
    const entries = await readdir(directory)
    return entries.length === 0
  } catch {
    return false
  }
}

/** Recursive copy of the demo template, excluding build and install output. */
export async function copyDemoTemplate(
  templatePath: string,
  targetPath: string
): Promise<{ entries: number }> {
  const templateRoot = await canonicalizeExisting(templatePath)
  if (templateRoot === null) {
    throw new HuddleError(
      'demo_template_missing',
      `The packaged demo template is missing (${templatePath}).`,
      'Reinstall Huddle, or bind an existing folder instead.'
    )
  }

  let entries = 0
  await cp(templateRoot, targetPath, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (source) => {
      const name = basename(source)
      if (source === templateRoot) return true
      if (COPY_EXCLUDE.has(name)) return false
      entries += 1
      return true
    }
  })

  /*
   * The template's installed dependencies come across as a link.
   *
   * They are excluded from the copy above (10k small files is slow enough on
   * Windows to look like a hang), but a demo project without them means the
   * team's first move is always `npm install` rather than the work you asked
   * for. Linking is instant and makes `npm test` work in the first minute.
   */
  await linkDependencies(templateRoot, targetPath)

  return { entries }
}

/**
 * Make the copied demo a real git repository with a first commit, so worktrees
 * and diffs work immediately. If git is unavailable this reports that honestly
 * rather than pretending.
 */
export async function initializeRepo(
  targetPath: string
): Promise<{ isGitRepo: boolean; detail: string }> {
  if (!(await gitAvailable())) {
    return {
      isGitRepo: false,
      detail: 'git is not installed, so the demo project has no history and agents share one folder.'
    }
  }

  const init = await git(targetPath, ['init', '-b', 'main'])
  if (init.code !== 0) {
    const fallback = await git(targetPath, ['init'])
    if (fallback.code !== 0) {
      return {
        isGitRepo: false,
        detail: `git init failed: ${(fallback.stderr || init.stderr).trim()}`
      }
    }
    await git(targetPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  }

  await git(targetPath, ['add', '-A'])
  const commit = await git(targetPath, [
    '-c',
    'user.name=Huddle',
    '-c',
    'user.email=huddle@localhost',
    'commit',
    '--no-verify',
    '-m',
    'Initial commit from the Huddle demo template'
  ])
  if (commit.code !== 0 && !(await hasCommits(targetPath))) {
    return { isGitRepo: true, detail: `The initial commit could not be created: ${commit.stderr.trim()}` }
  }
  return { isGitRepo: true, detail: 'git repository initialised with one commit.' }
}

export interface BindProjectOptions {
  kind: 'existing' | 'demo'
  /** Overridable for tests; defaults to the packaged template. */
  templatePath?: string
  notify?: Notify
  now?: () => string
}

export async function bindProjectDirectory(
  rootPath: string,
  options: BindProjectOptions
): Promise<ProjectBinding> {
  if (rootPath.trim().length === 0) {
    throw new HuddleError('invalid_path', 'No project path was given.', 'Choose a folder to bind.')
  }
  const target = resolve(rootPath)
  const notify = options.notify ?? ((): void => undefined)
  const now = options.now ?? ((): string => new Date().toISOString())

  if (options.kind === 'demo') {
    const templatePath = options.templatePath ?? demoTemplate()
    if (existsSync(target)) {
      const targetStat = await stat(target)
      if (!targetStat.isDirectory()) {
        throw new HuddleError(
          'invalid_path',
          `${target} exists and is not a directory.`,
          'Choose a different destination for the demo project.'
        )
      }
      if (!(await pathIsEmpty(target))) {
        throw new HuddleError(
          'demo_target_not_empty',
          `${target} already has files in it, so Huddle will not copy the demo template over them.`,
          'Pick an empty folder or let Huddle suggest one.'
        )
      }
    }

    const canonical = await realpathExistingAncestor(target)
    await assertNotHuddleSource(canonical)

    if (!existsSync(target)) {
      await mkdir(target, { recursive: true })
    }
    const copy = await copyDemoTemplate(templatePath, target)
    notify('info', `Copied the demo template (${copy.entries} entries) into ${target}.`)
    const repo = await initializeRepo(target)
    notify(repo.isGitRepo ? 'info' : 'warn', repo.detail)
    // Says which of the two states the project is really in, rather than
    // promising an install that linking has already made unnecessary.
    const linked = existsSync(join(target, 'node_modules'))
    notify(
      'info',
      linked
        ? `${target} already has its dependencies, so the team can run the project's own checks straight away.`
        : `${target} has no installed dependencies yet, so the first npm install there will take a minute.`
    )
    return {
      rootPath: (await canonicalizeExisting(target)) ?? canonical,
      kind: 'demo',
      isGitRepo: repo.isGitRepo,
      hadDirtyWorkOnBind: false,
      demoTemplate: templatePath,
      boundAt: now()
    }
  }

  let stats: Stats
  try {
    stats = await stat(target)
  } catch {
    throw new HuddleError(
      'project_not_found',
      `${target} does not exist.`,
      'Check the path, or choose the folder with the picker.'
    )
  }
  if (!stats.isDirectory()) {
    throw new HuddleError(
      'project_not_found',
      `${target} is not a directory.`,
      'Choose the project folder itself, not a file inside it.'
    )
  }

  const canonical = (await canonicalizeExisting(target)) ?? target
  await assertNotHuddleSource(canonical)

  const repo = (await gitAvailable()) && (await isGitRepo(canonical))
  const dirty = repo ? await isDirty(canonical) : false
  const commits = repo ? await hasCommits(canonical) : false

  if (repo && dirty) {
    notify(
      'warn',
      `${canonical} has uncommitted changes, so existing edits will show up in the first diff.`,
      'Commit or stash them before the team starts if you want a clean baseline.'
    )
  }
  if (!repo) {
    notify(
      'warn',
      `${canonical} is not a git repository, so agents will share one folder instead of getting isolated branches.`,
      'Run "git init" in that folder before binding if you want per-agent worktrees.'
    )
  } else if (!commits) {
    notify(
      'warn',
      `${canonical} is a git repository with no commits yet, so Huddle cannot create worktrees.`,
      'Make one commit, then re-bind the project to get isolated agent branches.'
    )
  }

  return {
    rootPath: canonical,
    kind: 'existing',
    isGitRepo: repo,
    hadDirtyWorkOnBind: dirty,
    boundAt: now()
  }
}
