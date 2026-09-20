import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { linkDependencies } from './deps.ts'

const temps: string[] = []
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'huddle-deps-'))
  temps.push(dir)
  return dir
}
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

describe('linkDependencies', () => {
  test('makes an installed node_modules readable from the target', async () => {
    // The real failure: a fresh git worktree has no node_modules, so every
    // teammate's first command fails until it installs.
    const root = await scratch()
    const source = join(root, 'project')
    const target = join(root, 'worktree')
    await mkdir(join(source, 'node_modules', 'left-pad'), { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(source, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')

    assert.equal(await linkDependencies(source, target), 'linked')
    const seen = await readFile(join(target, 'node_modules', 'left-pad', 'index.js'), 'utf8')
    assert.equal(seen, 'module.exports = 1\n')
  })

  test('leaves a real node_modules alone', async () => {
    const root = await scratch()
    const source = join(root, 'project')
    const target = join(root, 'worktree')
    await mkdir(join(source, 'node_modules'), { recursive: true })
    await mkdir(join(target, 'node_modules', 'own'), { recursive: true })

    assert.equal(await linkDependencies(source, target), 'already-present')
    assert.ok(existsSync(join(target, 'node_modules', 'own')), 'existing install was replaced')
  })

  test('says so when there is nothing installed to link', async () => {
    const root = await scratch()
    const source = join(root, 'project')
    const target = join(root, 'worktree')
    await mkdir(source, { recursive: true })
    await mkdir(target, { recursive: true })
    assert.equal(await linkDependencies(source, target), 'no-source')
  })

  test('never throws, whatever it is handed', async () => {
    // Called during workspace creation: a failure here must degrade to
    // "install first", never take the workspace down with it.
    assert.equal(await linkDependencies('/definitely/not/here', '/nor/here'), 'no-source')
  })
})
