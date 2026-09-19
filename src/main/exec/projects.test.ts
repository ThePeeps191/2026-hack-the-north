import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { HuddleError } from '../huddle-error.ts'
import { gitAvailable, hasCommits, isDirty } from './git.ts'
import { bindProjectDirectory, copyDemoTemplate, demoTemplate, suggestDemoPath } from './projects.ts'

process.env.HUDDLE_DATA_ROOT = join(mkdtempSync(join(tmpdir(), 'huddle-data-')), 'data')

let template = ''
let workdir = ''

before(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'huddle-demo-'))
  template = join(workdir, 'template')
  await mkdir(join(template, 'src'), { recursive: true })
  await mkdir(join(template, 'node_modules', 'left-pad'), { recursive: true })
  await mkdir(join(template, 'dist'), { recursive: true })
  await mkdir(join(template, '.git'), { recursive: true })
  await writeFile(join(template, 'package.json'), '{"name":"fixture-demo"}\n', 'utf8')
  await writeFile(join(template, 'src', 'main.ts'), 'export const main = 1\n', 'utf8')
  await writeFile(join(template, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n', 'utf8')
  await writeFile(join(template, 'dist', 'bundle.js'), 'built\n', 'utf8')
  await writeFile(join(template, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
})

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

describe('copyDemoTemplate', () => {
  test('copies the project and skips install and build output', async () => {
    const target = join(workdir, 'copy-one')
    const result = await copyDemoTemplate(template, target)
    assert.ok(result.entries >= 2)
    assert.equal(existsSync(join(target, 'package.json')), true)
    assert.equal(existsSync(join(target, 'src', 'main.ts')), true)
    assert.equal(existsSync(join(target, 'node_modules')), false)
    assert.equal(existsSync(join(target, 'dist')), false)
    assert.equal(existsSync(join(target, '.git')), false)
  })

  test('a missing template is a clear error', async () => {
    await assert.rejects(
      () => copyDemoTemplate(join(workdir, 'nope'), join(workdir, 'copy-two')),
      (error: unknown) => error instanceof HuddleError && error.code === 'demo_template_missing'
    )
  })
})

describe('bindProjectDirectory demo mode', () => {
  test('creates the project and a real git repository with one commit', async (t) => {
    if (!(await gitAvailable())) {
      t.skip('git is not installed')
      return
    }
    const target = join(workdir, 'demo-project')
    const notices: string[] = []
    const binding = await bindProjectDirectory(target, {
      kind: 'demo',
      templatePath: template,
      notify: (_level, text) => notices.push(text)
    })

    assert.equal(binding.kind, 'demo')
    assert.equal(binding.isGitRepo, true)
    assert.equal(binding.hadDirtyWorkOnBind, false)
    assert.equal(binding.demoTemplate, template)
    assert.ok(existsSync(join(target, 'package.json')))
    assert.equal(existsSync(join(target, 'node_modules')), false)
    assert.equal(await hasCommits(target), true)
    assert.equal(await isDirty(target), false, 'the initial commit should leave a clean tree')
    assert.ok(notices.some((notice) => notice.includes('Copied the demo template')))
    assert.ok(notices.some((notice) => notice.includes('npm install')))
  })

  test('refuses to copy over a folder that already has files', async () => {
    const target = join(workdir, 'demo-occupied')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'existing.txt'), 'do not overwrite me\n', 'utf8')
    await assert.rejects(
      () => bindProjectDirectory(target, { kind: 'demo', templatePath: template }),
      (error: unknown) => error instanceof HuddleError && error.code === 'demo_target_not_empty'
    )
    assert.equal(await readFile(join(target, 'existing.txt'), 'utf8'), 'do not overwrite me\n')
  })

  test('an empty existing folder is filled in', async () => {
    const target = join(workdir, 'demo-empty')
    await mkdir(target, { recursive: true })
    const binding = await bindProjectDirectory(target, { kind: 'demo', templatePath: template })
    assert.equal(binding.kind, 'demo')
    assert.ok(existsSync(join(target, 'src', 'main.ts')))
  })
})

describe('suggestDemoPath', () => {
  test('suggests a fresh folder under the data root, never reusing one', async () => {
    const first = suggestDemoPath('room-abcdef12')
    assert.equal(existsSync(first), false)
    assert.match(first, /sketch-night-roomabcd$/)
    await mkdir(first, { recursive: true })
    const second = suggestDemoPath('room-abcdef12')
    assert.notEqual(second, first)
    assert.match(second, /sketch-night-roomabcd-2$/)
  })

  test('demoTemplate points at the packaged template', () => {
    const path = demoTemplate()
    assert.equal(typeof path, 'string')
    assert.ok(path.includes('sketch-night'))
  })
})
