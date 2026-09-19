import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { tmpdir as tmpDir } from 'node:os'
import { HuddleError } from '../huddle-error.ts'
import {
  isPathInside,
  realpathExistingAncestor,
  relativeInside,
  resolveInsideWorkspace,
  safeFilename
} from './path-safety.ts'
import { bindProjectDirectory } from './projects.ts'

let root = ''
let outside = ''

// Keep Huddle-owned writes out of the repository while testing.
process.env.HUDDLE_DATA_ROOT = joinPath(
  mkdtempSync(joinPath(tmpDir(), 'huddle-data-')),
  'data'
)

before(async () => {
  const base = await mkdtemp(join(tmpdir(), 'huddle-paths-'))
  root = join(base, 'project')
  outside = join(base, 'outside')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(root, 'src', 'App.tsx'), 'export const App = 1\n', 'utf8')
  await writeFile(join(outside, 'secret.txt'), 'top secret\n', 'utf8')
})

after(async () => {
  if (root.length > 0) await rm(resolve(root, '..'), { recursive: true, force: true })
})

describe('resolveInsideWorkspace', () => {
  test('accepts a relative path inside the root', async () => {
    const resolved = await resolveInsideWorkspace(root, 'src/App.tsx')
    assert.equal(resolved.relative, 'src/App.tsx')
    assert.ok(existsSync(resolved.absolute))
  })

  test('accepts an absolute path inside the root', async () => {
    const resolved = await resolveInsideWorkspace(root, join(root, 'src', 'App.tsx'))
    assert.equal(resolved.relative, 'src/App.tsx')
  })

  test('refuses a ../ traversal', async () => {
    await assert.rejects(
      () => resolveInsideWorkspace(root, '../outside/secret.txt'),
      (error: unknown) => error instanceof HuddleError && error.code === 'path_outside_workspace'
    )
  })

  test('refuses a nested traversal that would escape', async () => {
    await assert.rejects(
      () => resolveInsideWorkspace(root, 'src/../../outside/secret.txt'),
      (error: unknown) => error instanceof HuddleError && error.code === 'path_outside_workspace'
    )
  })

  test('refuses an absolute path outside the root', async () => {
    await assert.rejects(
      () => resolveInsideWorkspace(root, join(outside, 'secret.txt')),
      (error: unknown) => error instanceof HuddleError && error.code === 'path_outside_workspace'
    )
  })

  test('refuses a null byte', async () => {
    await assert.rejects(
      () => resolveInsideWorkspace(root, 'src/App.tsx\u0000.png'),
      (error: unknown) => error instanceof HuddleError && error.code === 'invalid_path'
    )
  })

  test('refuses a symlink that points out of the workspace', async () => {
    const linkPath = join(root, 'escape-link')
    try {
      await symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // Windows without developer mode cannot create symlinks; the guard is
      // still exercised by the traversal tests above.
      return
    }
    await assert.rejects(
      () => resolveInsideWorkspace(root, 'escape-link/secret.txt'),
      (error: unknown) => error instanceof HuddleError && error.code === 'path_outside_workspace'
    )
  })

  test('resolves a new file through its real parent directory', async () => {
    const resolved = await resolveInsideWorkspace(root, 'src/hooks/useThing.ts')
    assert.equal(resolved.relative, 'src/hooks/useThing.ts')
    assert.ok(resolved.absolute.endsWith(join('src', 'hooks', 'useThing.ts')))
    assert.equal(existsSync(resolved.absolute), false)
  })

  test('a missing workspace root is reported as such', async () => {
    await assert.rejects(
      () => resolveInsideWorkspace(join(root, 'nope'), 'a.ts'),
      (error: unknown) => error instanceof HuddleError && error.code === 'workspace_missing'
    )
  })
})

describe('path helpers', () => {
  test('isPathInside is true for the root and children only', () => {
    assert.equal(isPathInside(root, root), true)
    assert.equal(isPathInside(root, join(root, 'src')), true)
    assert.equal(isPathInside(root, outside), false)
    assert.equal(isPathInside(join(root, 'src'), root), false)
  })

  test('relativeInside normalises separators', () => {
    assert.equal(relativeInside(root, join(root, 'src', 'App.tsx')), 'src/App.tsx')
    assert.equal(relativeInside(root, outside), null)
  })

  test('realpathExistingAncestor keeps the non-existent tail', async () => {
    const resolved = await realpathExistingAncestor(join(root, 'src', 'brand', 'new.ts'))
    assert.ok(resolved.endsWith(join('src', 'brand', 'new.ts')))
  })

  test('safeFilename strips traversal and separators', () => {
    assert.equal(safeFilename('../../etc/passwd', 'fallback.txt'), 'passwd')
    assert.equal(safeFilename('..\\..\\windows\\system32\\cmd.exe', 'fallback.txt'), 'cmd.exe')
    assert.equal(safeFilename('report: final?.md', 'fallback.txt'), 'report- final-.md')
    assert.equal(safeFilename('   ', 'fallback.txt'), 'fallback.txt')
  })
})

describe('bindProjectDirectory', () => {
  test('refuses Huddle\'s own source tree', async () => {
    await assert.rejects(
      () => bindProjectDirectory(process.cwd(), { kind: 'existing' }),
      (error: unknown) => error instanceof HuddleError && error.code === 'project_is_huddle'
    )
  })

  test('refuses a folder that does not exist', async () => {
    await assert.rejects(
      () => bindProjectDirectory(join(tmpdir(), 'huddle-does-not-exist-xyz'), { kind: 'existing' }),
      (error: unknown) => error instanceof HuddleError && error.code === 'project_not_found'
    )
  })

  test('binds an existing non-git folder honestly', async () => {
    const target = join(root, 'plain')
    await mkdir(target, { recursive: true })
    const binding = await bindProjectDirectory(target, { kind: 'existing' })
    assert.equal(binding.kind, 'existing')
    assert.equal(binding.isGitRepo, false)
    assert.equal(binding.hadDirtyWorkOnBind, false)
    assert.ok(binding.rootPath.endsWith('plain'))
  })
})
