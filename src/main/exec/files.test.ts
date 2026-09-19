import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { HuddleError } from '../huddle-error.ts'
import {
  compileGlob,
  detectLanguage,
  listWorkspaceDir,
  looksBinary,
  readWorkspaceFile,
  searchWorkspace,
  writeWorkspaceFile
} from './files.ts'

let root = ''

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'huddle-files-'))
  await mkdir(join(root, 'src', 'components'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'src', 'App.tsx'), 'export function App() {\n  return null\n}\n', 'utf8')
  await writeFile(
    join(root, 'src', 'components', 'DrawBoard.tsx'),
    'export const DrawBoard = () => null\n',
    'utf8'
  )
  await writeFile(join(root, 'README.md'), 'The needle is in this file.\n', 'utf8')
  await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'const needle = 1\n', 'utf8')
  await writeFile(join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x42]))
  await writeFile(join(root, 'big.txt'), 'x'.repeat(4096), 'utf8')
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('readWorkspaceFile', () => {
  test('reads real content with language and size', async () => {
    const file = await readWorkspaceFile(root, 'src/App.tsx')
    assert.equal(file.text, 'export function App() {\n  return null\n}\n')
    assert.equal(file.bytes, Buffer.byteLength('export function App() {\n  return null\n}\n', 'utf8'))
    assert.equal(file.truncated, false)
    assert.equal(detectLanguage('src/App.tsx'), 'typescript')
    assert.match(file.modifiedAt, /^\d{4}-\d{2}-\d{2}T/)
  })

  test('truncates at maxBytes and says so', async () => {
    const file = await readWorkspaceFile(root, 'big.txt', 1024)
    assert.equal(file.truncated, true)
    assert.equal(file.bytes, 4096)
    assert.equal(file.text.length, 1024)
  })

  test('refuses a binary file', async () => {
    await assert.rejects(
      () => readWorkspaceFile(root, 'binary.bin'),
      (error: unknown) => error instanceof HuddleError && error.code === 'binary_file'
    )
  })

  test('refuses a directory', async () => {
    await assert.rejects(
      () => readWorkspaceFile(root, 'src'),
      (error: unknown) => error instanceof HuddleError && error.code === 'path_is_directory'
    )
  })

  test('reports a missing file', async () => {
    await assert.rejects(
      () => readWorkspaceFile(root, 'src/Nope.ts'),
      (error: unknown) => error instanceof HuddleError && error.code === 'file_not_found'
    )
  })

  test('refuses traversal', async () => {
    await assert.rejects(
      () => readWorkspaceFile(root, '../../etc/passwd'),
      (error: unknown) => error instanceof HuddleError && error.code === 'path_outside_workspace'
    )
  })

  test('looksBinary detects NUL bytes', () => {
    assert.equal(looksBinary(Buffer.from('plain text')), false)
    assert.equal(looksBinary(Buffer.from([0x00, 0x41])), true)
  })
})

describe('listWorkspaceDir', () => {
  test('lists dirs first with sizes, including .git and node_modules as dirs', async () => {
    const entries = await listWorkspaceDir(root)
    const names = entries.map((entry) => entry.name)
    assert.ok(names.includes('.git'))
    assert.ok(names.includes('node_modules'))
    assert.ok(names.includes('src'))
    const kinds = entries.map((entry) => entry.kind)
    const firstFile = kinds.indexOf('file')
    const lastDir = kinds.lastIndexOf('dir')
    assert.ok(firstFile === -1 || lastDir < firstFile, 'directories must sort before files')
    const readme = entries.find((entry) => entry.name === 'README.md')
    assert.ok(readme !== undefined)
    assert.equal(readme.kind, 'file')
    assert.equal(readme.bytes, Buffer.byteLength('The needle is in this file.\n', 'utf8'))
    assert.ok(readme.modifiedAt !== null)
  })

  test('lists a subdirectory with workspace-relative paths', async () => {
    const entries = await listWorkspaceDir(root, 'src/components')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'DrawBoard.tsx')
    assert.equal(entries[0].path, 'src/components/DrawBoard.tsx')
    assert.equal(entries[0].kind, 'file')
  })

  test('a missing directory is a clear error', async () => {
    await assert.rejects(
      () => listWorkspaceDir(root, 'src/nope'),
      (error: unknown) => error instanceof HuddleError && error.code === 'dir_not_found'
    )
  })
})

describe('searchWorkspace', () => {
  test('finds real matches with line numbers and skips node_modules', async () => {
    const result = await searchWorkspace(root, 'needle')
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0].path, 'README.md')
    assert.equal(result.hits[0].line, 1)
    assert.match(result.hits[0].text, /needle/)
  })

  test('respects the glob filter', async () => {
    const result = await searchWorkspace(root, 'export', { glob: '**/*.tsx' })
    assert.equal(result.hits.length, 2)
    assert.deepEqual(
      result.hits.map((hit) => hit.path).sort(),
      ['src/App.tsx', 'src/components/DrawBoard.tsx']
    )
  })

  test('honours the max hit bound and reports truncation', async () => {
    const result = await searchWorkspace(root, 'export', { max: 1 })
    assert.equal(result.hits.length, 1)
    assert.equal(result.truncated, true)
    assert.match(result.detail, /Stopped after 1 hit/)
  })

  test('skips binary files', async () => {
    const result = await searchWorkspace(root, '\u0000', { max: 10 })
    assert.equal(result.hits.length, 0)
  })

  test('an empty query is refused', async () => {
    await assert.rejects(
      () => searchWorkspace(root, '   '),
      (error: unknown) => error instanceof HuddleError && error.code === 'empty_query'
    )
  })

  test('compileGlob matches basenames and full paths', () => {
    const ts = compileGlob('*.ts')
    assert.equal(ts('src/App.ts'), true)
    assert.equal(ts('src/App.tsx'), false)
    const deep = compileGlob('src/**/*.tsx')
    assert.equal(deep('src/App.tsx'), true)
    assert.equal(deep('src/components/DrawBoard.tsx'), true)
    assert.equal(deep('other/App.tsx'), false)
  })
})

describe('writeWorkspaceFile', () => {
  test('creates parents and reports the real byte count', async () => {
    const written = await writeWorkspaceFile(root, 'src/hooks/useThing.ts', 'export const x = 1\n')
    assert.equal(written.created, true)
    assert.equal(written.relativePath, 'src/hooks/useThing.ts')
    assert.equal(written.bytes, Buffer.byteLength('export const x = 1\n', 'utf8'))
    const read = await readWorkspaceFile(root, 'src/hooks/useThing.ts')
    assert.equal(read.text, 'export const x = 1\n')
  })

  test('reports an overwrite as not created', async () => {
    const written = await writeWorkspaceFile(root, 'src/App.tsx', 'export const App = 2\n')
    assert.equal(written.created, false)
    assert.equal(written.bytes, Buffer.byteLength('export const App = 2\n', 'utf8'))
  })

  test('refuses traversal', async () => {
    await assert.rejects(
      () => writeWorkspaceFile(root, '../escaped.txt', 'nope'),
      (error: unknown) => error instanceof HuddleError && error.code === 'path_outside_workspace'
    )
  })

  test('refuses to write over a directory', async () => {
    await assert.rejects(
      () => writeWorkspaceFile(root, 'src', 'nope'),
      (error: unknown) => error instanceof HuddleError && error.code === 'path_is_directory'
    )
  })
})
