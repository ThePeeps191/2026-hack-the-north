import { existsSync } from 'node:fs'
import { lstat, symlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Makes an already-installed `node_modules` visible inside a workspace.
 *
 * Every teammate works in its own git worktree, and `node_modules` is
 * gitignored, so a fresh worktree has no dependencies at all. The first thing
 * each teammate did was therefore discover that `npm run dev` fails with
 * "'concurrently' is not recognized", work out that it had to install, and
 * spend a turn doing it — three teammates, three times, every run. On stage
 * that is a minute of nothing happening followed by a red "the dev server
 * exited with code 1" banner, which reads as a broken app rather than a
 * missing install.
 *
 * A directory junction (Windows) or symlink (elsewhere) costs no disk and is
 * instant, so `npm test`, `npm run typecheck` and `npm run dev` work in a
 * worktree from the moment it exists.
 *
 * The tradeoff, stated plainly: every workspace linked to the same source
 * shares one real `node_modules`, so a teammate that installs a *new* package
 * changes it for the others. That is the right trade here — the alternative is
 * copying ~100 MB of small files per worktree, which on Windows takes long
 * enough to look like a hang — and the source is always restorable with a
 * plain `npm install`.
 */
export async function linkDependencies(
  sourceRoot: string,
  targetRoot: string
): Promise<'linked' | 'already-present' | 'no-source' | 'failed'> {
  const source = join(sourceRoot, 'node_modules')
  const target = join(targetRoot, 'node_modules')

  if (!existsSync(source)) return 'no-source'

  // `existsSync` follows links, so a dangling link from an earlier run would
  // read as absent; `lstat` sees the link itself and leaves it alone.
  try {
    await lstat(target)
    return 'already-present'
  } catch {
    // Not there, which is the case worth acting on.
  }

  try {
    // 'junction' is ignored off Windows, where a plain directory symlink is
    // used. Junctions matter because they need no developer mode or admin.
    await symlink(source, target, 'junction')
    return 'linked'
  } catch {
    // Never fatal: without this the workspace still works, it just has to
    // install first, which is exactly the behaviour we had before.
    return 'failed'
  }
}
