import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ArgReader } from './validate.ts'

describe('ArgReader', () => {
  test('accepts a well-formed call and builds typed arguments', () => {
    const reader = new ArgReader({ path: 'src/App.tsx', start_line: 10, team: true })
    const result = reader.finish(() => ({
      path: reader.str('path', { required: true }),
      startLine: reader.num('start_line', { integer: true, min: 1 }),
      team: reader.bool('team')
    }))
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.value, { path: 'src/App.tsx', startLine: 10, team: true })
    }
  })

  test('missing required fields are reported, not defaulted silently', () => {
    const reader = new ArgReader({})
    reader.str('path', { required: true })
    const result = reader.finish(() => ({ path: reader.str('path') }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /"path" is required/)
  })

  test('non-object arguments are rejected', () => {
    const reader = new ArgReader('just a string')
    const result = reader.finish(() => ({}))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /must be a JSON object/)
  })

  test('wrong types are reported with the offending key', () => {
    const reader = new ArgReader({ max: 'many' })
    reader.num('max')
    const result = reader.finish(() => ({ max: reader.num('max') }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /"max" must be a finite number/)
  })

  test('numeric strings from the model are accepted', () => {
    const reader = new ArgReader({ max: '25' })
    const result = reader.finish(() => ({ max: reader.num('max', { integer: true }) }))
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.max, 25)
  })

  test('enum values are enforced', () => {
    const reader = new ArgReader({ action: 'teleport' })
    reader.str('action', { enum: ['click', 'type'] })
    const result = reader.finish(() => ({ action: reader.str('action') }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /must be one of: click, type/)
  })

  test('lists validate their items and drop blanks', () => {
    const reader = new ArgReader({ acceptance: ['tests pass', '  ', 'a screenshot exists'] })
    const result = reader.finish(() => ({ acceptance: reader.list('acceptance') }))
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.value.acceptance, ['tests pass', 'a screenshot exists'])
  })

  test('oversized strings are rejected rather than truncated', () => {
    const reader = new ArgReader({ reason: 'x'.repeat(50) })
    reader.str('reason', { max: 10 })
    const result = reader.finish(() => ({ reason: reader.str('reason') }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /at most 10 characters/)
  })

  test('check() records tool-specific rules', () => {
    const reader = new ArgReader({ action: 'type', selector: '#name' })
    reader.check(reader.has('text'), '"type" needs a "text" value')
    const result = reader.finish(() => ({ action: reader.str('action') }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /needs a "text" value/)
  })

  test('nested objects are size-bounded', () => {
    const reader = new ArgReader({ config: { blob: 'y'.repeat(25000) } })
    reader.record('config')
    const result = reader.finish(() => ({ config: reader.record('config') }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /too large/)
  })

  test('build() never runs when a field failed', () => {
    let built = false
    const reader = new ArgReader({})
    reader.str('path', { required: true })
    reader.finish(() => {
      built = true
      return {}
    })
    assert.equal(built, false)
  })
})
