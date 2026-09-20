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

  test('notes a header whose counts disagree with the body, and trusts the body', () => {
    const parsed = parseUnifiedDiff(
      ['--- a/x.txt', '+++ b/x.txt', '@@ -1,3 +1,3 @@', ' one', ' two', ''].join('\n')
    )
    const hunk = parsed.files[0].hunks[0]
    assert.equal(hunk.malformed, true)
    // Counts come from the lines actually supplied, not from the header's claim.
    const supplied = hunk.body.filter((line) => line.kind !== 'add').length
    assert.equal(hunk.oldCount, supplied)
    assert.notEqual(hunk.oldCount, 3)
    // A miscounted header is not by itself a reason to refuse the patch: the
    // applier still verifies every context line against the real file.
    assert.deepEqual(parsed.errors, [])
  })

  test('a hunk longer than its header claims keeps its trailing lines', () => {
    // The exact failure a real teammate hit: the model declared four old lines
    // and supplied five, and the fifth was reported as "follows a hunk".
    const parsed = parseUnifiedDiff(
      [
        '--- a/x.txt',
        '+++ b/x.txt',
        '@@ -1,2 +1,2 @@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        ' four',
        ''
      ].join('\n')
    )
    assert.deepEqual(parsed.errors, [])
    const hunk = parsed.files[0].hunks[0]
    assert.equal(hunk.body.length, 5)
    assert.equal(hunk.oldCount, 4)
    assert.equal(hunk.newCount, 4)
  })

  test('a second file section ends the hunk rather than being eaten by it', () => {
    // `--- ` and `+++ ` would otherwise read as a removed and an added line.
    const parsed = parseUnifiedDiff(
      [
        '--- a/x.txt',
        '+++ b/x.txt',
        '@@ -1,1 +1,1 @@',
        '-a',
        '+b',
        '--- a/y.txt',
        '+++ b/y.txt',
        '@@ -1,1 +1,1 @@',
        '-c',
        '+d',
        ''
      ].join('\n')
    )
    assert.deepEqual(parsed.errors, [])
    assert.equal(parsed.files.length, 2)
    assert.equal(parsed.files[0].newPath, 'x.txt')
    assert.equal(parsed.files[0].hunks[0].body.length, 2)
    assert.equal(parsed.files[1].newPath, 'y.txt')
    assert.equal(parsed.files[1].hunks[0].body.length, 2)
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

/* ------------------------------------------------------------------ *
 * The shapes models actually emit
 *
 * Every case below is a real patch a teammate produced during a live run and
 * that Huddle used to refuse. A refused patch costs a turn and teaches the
 * model nothing, so the parser accepts any shape whose *content* is
 * unambiguous and leaves the safety to the applier, which still matches every
 * context line against the real bytes on disk.
 * ------------------------------------------------------------------ */

describe('patch dialects', () => {
  const FILE = 'a\nb\nc\nd\n'

  test('a bare "@@" with context is located by its content', async () => {
    const memory = memoryTargets({ 'x.txt': FILE })
    const patch = ['--- a/x.txt', '+++ b/x.txt', '@@', ' b', '-c', '+C', ' d', ''].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, true, result.detail)
    assert.equal(memory.files.get('x.txt'), 'a\nb\nC\nd\n')
  })

  test('a bare "@@" with no context at all is refused rather than guessed at', async () => {
    const memory = memoryTargets({ 'x.txt': FILE })
    const patch = ['--- a/x.txt', '+++ b/x.txt', '@@', '+inserted', ''].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, false)
    assert.match(result.detail, /no way to tell where it belongs/)
    assert.equal(memory.files.get('x.txt'), FILE, 'the file is untouched')
  })

  test('a header that miscounts its own lines still applies', async () => {
    // The exact failure from a live run: five body lines under a header that
    // declared four. The content was correct; only the arithmetic was wrong.
    const memory = memoryTargets({ 'x.txt': FILE })
    const patch = ['--- a/x.txt', '+++ b/x.txt', '@@ -1,2 +1,2 @@', ' a', ' b', '-c', '+C', ' d', ''].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, true, result.detail)
    assert.equal(memory.files.get('x.txt'), 'a\nb\nC\nd\n')
  })

  test('the "*** Begin Patch" envelope is translated, not rejected', async () => {
    const memory = memoryTargets({ 'x.txt': FILE })
    const patch = [
      '*** Begin Patch',
      '*** Update File: x.txt',
      '@@',
      ' b',
      '-c',
      '+C',
      ' d',
      '*** End Patch',
      ''
    ].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, true, result.detail)
    assert.equal(memory.files.get('x.txt'), 'a\nb\nC\nd\n')
  })

  test('the envelope can add and delete files', async () => {
    const memory = memoryTargets({ 'gone.txt': 'x\n' })
    const patch = [
      '*** Begin Patch',
      '*** Add File: made.txt',
      '+hello',
      '*** Delete File: gone.txt',
      '-x',
      '*** End Patch',
      ''
    ].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, true, result.detail)
    assert.equal(memory.files.get('made.txt'), 'hello\n')
    assert.equal(memory.files.has('gone.txt'), false)
  })

  test('a patch whose content disagrees with the file is still refused whole', async () => {
    // The tolerance above is about *format*, never about content: a line the
    // patch claims to remove has to exist, or nothing is written at all.
    const memory = memoryTargets({ 'x.txt': FILE })
    const patch = ['--- a/x.txt', '+++ b/x.txt', '@@', ' b', '-NOT-IN-FILE', '+C', ' d', ''].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, false)
    assert.match(result.detail, /does not match/)
    assert.equal(memory.files.get('x.txt'), FILE)
    assert.equal(memory.writes.length, 0)
  })
})

describe('half-remembered envelopes', () => {
  test('a plain diff with a stray "*** End Patch" still applies', async () => {
    // Seen in a live run: the model wrote a correct unified diff and then
    // closed it with an envelope terminator it never opened.
    const memory = memoryTargets({ 'x.txt': 'a\nb\nc\n' })
    const patch = ['--- a/x.txt', '+++ b/x.txt', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '*** End Patch', ''].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, true, result.detail)
    assert.equal(memory.files.get('x.txt'), 'a\nB\nc\n')
  })
})

describe('marker casing', () => {
  test('"*** End patch" with a lowercase p is still an envelope terminator', async () => {
    // Exactly what a live run produced. The marker check was case-sensitive,
    // so this one plain diff was refused while the capitalised one applied.
    const memory = memoryTargets({ 'x.txt': 'a\nb\nc\n' })
    const patch = ['--- a/x.txt', '+++ b/x.txt', '@@', ' a', '-b', '+B', ' c', '*** End patch', ''].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, true, result.detail)
    assert.equal(memory.files.get('x.txt'), 'a\nB\nc\n')
  })

  test('a lowercase "*** update file:" header still names its file', async () => {
    const memory = memoryTargets({ 'x.txt': 'a\nb\nc\n' })
    const patch = ['*** Begin patch', '*** update file: x.txt', '@@', ' a', '-b', '+B', ' c', '*** end patch', ''].join('\n')
    const result = await applyUnifiedPatch(patch, memory.targets)
    assert.equal(result.applied, true, result.detail)
    assert.equal(memory.files.get('x.txt'), 'a\nB\nc\n')
  })
})
