import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { HuddleError } from '../huddle-error.ts'
import { git, gitAvailable } from './git.ts'
import { applyUnifiedPatch, parseUnifiedDiff, type PatchTargets } from './patch.ts'

interface MemoryTargets {
  targets: PatchTargets
  files: Map<string, string>
  writes: string[]
  removals: string[]
}

function memoryTargets(initial: Record<string, string>): MemoryTargets {
  const files = new Map<string, string>(Object.entries(initial))
  const writes: string[] = []
  const removals: string[] = []
  return {
    files,
    writes,
    removals,
    targets: {
      read: async (path) => files.get(path) ?? null,
      write: async (path, contents) => {
        writes.push(path)
        files.set(path, contents)
        return Buffer.byteLength(contents, 'utf8')
      },
      remove: async (path) => {
        removals.push(path)
        files.delete(path)
      }
    }
  }
}

const THREE_LINES = ['one', 'two', 'three', ''].join('\n')

const MODIFY_PATCH = [
  '--- a/sample.txt',
  '+++ b/sample.txt',
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+two changed',
  '+two and a half',
  ' three',
  ''
].join('\n')

describe('parseUnifiedDiff', () => {
  test('parses a single-file patch with one hunk', () => {
    const parsed = parseUnifiedDiff(MODIFY_PATCH)
    assert.deepEqual(parsed.errors, [])
    assert.equal(parsed.files.length, 1)
    const file = parsed.files[0]
    assert.equal(file.oldPath, 'sample.txt')
    assert.equal(file.newPath, 'sample.txt')
    assert.equal(file.hunks.length, 1)
    assert.equal(file.hunks[0].oldStart, 1)
    assert.equal(file.hunks[0].oldCount, 3)
    assert.equal(file.hunks[0].newCount, 4)
    assert.equal(file.hunks[0].body.length, 5)
  })

  test('parses a new file section', () => {
    const parsed = parseUnifiedDiff(
      ['--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,2 @@', '+const a = 1', '+const b = 2', ''].join('\n')
    )
    assert.deepEqual(parsed.errors, [])
    assert.equal(parsed.files[0].oldPath, null)
    assert.equal(parsed.files[0].newPath, 'src/new.ts')
    assert.equal(parsed.files[0].hunks[0].oldStart, 0)
  })

  test('reports a malformed hunk instead of guessing', () => {
    const parsed = parseUnifiedDiff(
      ['--- a/x.txt', '+++ b/x.txt', '@@ -1,3 +1,3 @@', ' one', ' two', ''].join('\n')
    )
    assert.equal(parsed.files[0].hunks[0].malformed, true)
    assert.ok(parsed.errors.some((error) => error.includes('declares 3 old')))
  })

  test('rejects a patch with no file headers', () => {
    const parsed = parseUnifiedDiff('@@ -1,1 +1,1 @@\n-a\n+b\n')
    assert.ok(parsed.errors.length > 0)
    assert.equal(parsed.files.length, 0)
  })
})

describe('applyUnifiedPatch', () => {
  test('applies a hunk and reports real additions and deletions', async () => {
    const memory = memoryTargets({ 'sample.txt': THREE_LINES })
    const result = await applyUnifiedPatch(MODIFY_PATCH, memory.targets)
    assert.equal(result.applied, true)
    assert.deepEqual(result.files, ['sample.txt'])
    assert.deepEqual(result.rejected, [])
    assert.equal(memory.files.get('sample.txt'), ['one', 'two changed', 'two and a half', 'three', ''].join('\n'))
    assert.match(result.detail, /\+2\/-1/)
  })

  test('creates a new file', async () => {
    const memory = memoryTargets({})
    const patch = [
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+const a = 1',
      '+const b = 2',
      ''
    ].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, true)
    assert.equal(memory.files.get('src/new.ts'), 'const a = 1\nconst b = 2\n')
  })

  test('deletes a file when the content matches', async () => {
    const memory = memoryTargets({ 'gone.txt': 'a\nb\n' })
    const patch = ['--- a/gone.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b', ''].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, true)
    assert.deepEqual(memory.removals, ['gone.txt'])
    assert.equal(memory.files.has('gone.txt'), false)
  })

  test('refuses a mismatched hunk with a precise detail and writes nothing', async () => {
    const memory = memoryTargets({ 'sample.txt': 'different\ncontent\nhere\n' })
    const result = await applyUnifiedPatch(MODIFY_PATCH, memory.targets)
    assert.equal(result.applied, false)
    assert.deepEqual(result.files, [])
    assert.deepEqual(result.rejected, ['sample.txt'])
    assert.match(result.detail, /Hunk 1 of 1 in sample\.txt does not match/)
    assert.match(result.detail, /Nothing was written/)
    assert.equal(memory.writes.length, 0)
    assert.equal(memory.files.get('sample.txt'), 'different\ncontent\nhere\n')
  })

  test('is atomic across files: one bad file means no writes at all', async () => {
    const memory = memoryTargets({ 'good.txt': 'alpha\nbeta\n', 'bad.txt': 'other\n' })
    const patch = [
      '--- a/good.txt',
      '+++ b/good.txt',
      '@@ -1,2 +1,2 @@',
      ' alpha',
      '-beta',
      '+beta changed',
      '--- a/bad.txt',
      '+++ b/bad.txt',
      '@@ -1,1 +1,1 @@',
      '-not here',
      '+whatever',
      ''
    ].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, false)
    assert.deepEqual(result.rejected, ['bad.txt'])
    assert.equal(memory.writes.length, 0)
    assert.equal(memory.files.get('good.txt'), 'alpha\nbeta\n')
  })

  test('applies a hunk that moved by reporting the real offset', async () => {
    const memory = memoryTargets({ 'sample.txt': 'zero\none\ntwo\nthree\n' })
    const result = await applyUnifiedPatch(MODIFY_PATCH, memory.targets)
    assert.equal(result.applied, true)
    assert.equal(memory.files.get('sample.txt'), 'zero\none\ntwo changed\ntwo and a half\nthree\n')
    assert.match(result.detail, /offset \+1/)
  })

  test('accepts a whole-file replacement when there are no hunks', async () => {
    const memory = memoryTargets({ 'config.json': '{"a":1}\n' })
    const patch = ['--- a/config.json', '+++ b/config.json', '{', '  "a": 2', '}', ''].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, true)
    assert.equal(memory.files.get('config.json'), '{\n  "a": 2\n}\n')
    assert.match(result.detail, /whole-file replacement/)
  })

  test('handles a patch that ends without a trailing newline', async () => {
    const memory = memoryTargets({ 'sample.txt': 'one\ntwo\nthree\n' })
    const patch = [
      '--- a/sample.txt',
      '+++ b/sample.txt',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+two changed',
      ' three',
      '\\ No newline at end of file',
      ''
    ].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, true)
    assert.equal(memory.files.get('sample.txt'), 'one\ntwo changed\nthree')
  })

  test('an empty patch is refused', async () => {
    const memory = memoryTargets({})
    await assert.rejects(
      () => applyUnifiedPatch('   ', memory.targets),
      (error: unknown) => error instanceof HuddleError && error.code === 'empty_patch'
    )
  })

  test('surfaces a path-safety refusal from the targets', async () => {
    const targets: PatchTargets = {
      read: async () => {
        throw new HuddleError('path_outside_workspace', 'outside', 'do not do that')
      },
      write: async () => 0,
      remove: async () => undefined
    }
    await assert.rejects(
      () => applyUnifiedPatch(MODIFY_PATCH, targets),
      (error: unknown) => error instanceof HuddleError && error.code === 'path_outside_workspace'
    )
  })
})

describe('applyUnifiedPatch against real git output', () => {
  test('applies a patch produced by git diff', async (t) => {
    if (!(await gitAvailable())) {
      t.skip('git is not installed')
      return
    }
    const dir = await mkdtemp(join(tmpdir(), 'huddle-patch-git-'))
    try {
      await git(dir, ['init', '-b', 'main'])
      // Pin the fixture's line endings: a Windows git install defaults to
      // core.autocrlf=true, which would make this assertion about the platform
      // rather than about the patch applier.
      await git(dir, ['config', 'core.autocrlf', 'false'])
      await git(dir, ['config', 'core.eol', 'lf'])
      const file = join(dir, 'app.ts')
      await writeFile(file, 'export const a = 1\nexport const b = 2\nexport const c = 3\n', 'utf8')
      await git(dir, ['add', '-A'])
      await git(dir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'init'
      ])

      await writeFile(file, 'export const a = 1\nexport const b = 22\nexport const c = 3\n', 'utf8')
      const diff = await git(dir, ['diff', '--no-color'])
      assert.ok(diff.stdout.includes('@@'), 'git produced no hunks')
      await git(dir, ['checkout', '--', 'app.ts'])
      assert.equal(
        await readFile(file, 'utf8'),
        'export const a = 1\nexport const b = 2\nexport const c = 3\n'
      )

      const applied = await applyUnifiedPatch(diff.stdout, {
        read: async (path) => {
          try {
            return await readFile(join(dir, path), 'utf8')
          } catch {
            return null
          }
        },
        write: async (path, contents) => {
          await writeFile(join(dir, path), contents, 'utf8')
          return Buffer.byteLength(contents, 'utf8')
        },
        remove: async (path) => {
          await rm(join(dir, path), { force: true })
        }
      })

      assert.equal(applied.applied, true)
      assert.deepEqual(applied.files, ['app.ts'])
      assert.equal(
        await readFile(file, 'utf8'),
        'export const a = 1\nexport const b = 22\nexport const c = 3\n'
      )

      const status = await git(dir, ['status', '--porcelain'])
      // Porcelain marks a worktree-only change with a leading space, so the
      // significant check is which path changed, not the exact padding.
      assert.equal(status.stdout.trim(), 'M app.ts')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

after(async () => {
  // Nothing global to clean: every test removes its own fixtures.
})
