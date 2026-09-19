import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseBlocks, parseInline, safeHref } from './markdown-parse.ts'

/**
 * The renderer builds React elements, so HTML in a message can never execute.
 * These tests cover the block parser, which is where text could be lost.
 */

describe('parseBlocks', () => {
  test('separates paragraphs on blank lines', () => {
    const blocks = parseBlocks('first line\nsame paragraph\n\nsecond paragraph')
    assert.equal(blocks.length, 2)
    assert.deepEqual(blocks[0], { kind: 'paragraph', lines: ['first line', 'same paragraph'] })
  })

  test('keeps fenced code verbatim, including markdown markers', () => {
    const blocks = parseBlocks('before\n\n```ts\nconst a = **1**\n```\n\nafter')
    const code = blocks.find((block) => block.kind === 'code')
    assert.ok(code && code.kind === 'code')
    assert.equal(code.language, 'ts')
    assert.deepEqual(code.lines, ['const a = **1**'])
  })

  test('an unterminated fence still keeps every line', () => {
    const blocks = parseBlocks('```\nline one\nline two')
    const code = blocks.find((block) => block.kind === 'code')
    assert.ok(code && code.kind === 'code')
    assert.deepEqual(code.lines, ['line one', 'line two'])
  })

  test('reads bullet and ordered lists, with wrapped continuations', () => {
    const bullets = parseBlocks('- one\n- two\n  still two')
    assert.deepEqual(bullets, [{ kind: 'list', ordered: false, items: [['one'], ['two', 'still two']] }])

    const ordered = parseBlocks('1. first\n2. second')
    assert.deepEqual(ordered, [{ kind: 'list', ordered: true, items: [['first'], ['second']] }])
  })

  test('reads headings, quotes and rules', () => {
    assert.deepEqual(parseBlocks('## Result'), [{ kind: 'heading', level: 2, text: 'Result' }])
    assert.deepEqual(parseBlocks('> quoted'), [{ kind: 'quote', lines: ['quoted'] }])
    assert.deepEqual(parseBlocks('---'), [{ kind: 'rule' }])
  })

  test('treats html source as ordinary paragraph text', () => {
    const blocks = parseBlocks('<script>alert(1)</script>')
    assert.deepEqual(blocks, [{ kind: 'paragraph', lines: ['<script>alert(1)</script>'] }])
  })

  test('loses nothing on an empty or whitespace-only message', () => {
    assert.deepEqual(parseBlocks(''), [])
    assert.deepEqual(parseBlocks('\n\n  \n'), [])
  })
})

describe('parseInline', () => {
  test('reads bold, italic and inline code', () => {
    assert.deepEqual(parseInline('a **b** c'), [
      { kind: 'text', text: 'a ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' c' }
    ])
    assert.deepEqual(parseInline('`npm run build`'), [{ kind: 'code', text: 'npm run build' }])
  })

  test('leaves emphasis markers inside code spans alone', () => {
    assert.deepEqual(parseInline('`**not bold**`'), [{ kind: 'code', text: '**not bold**' }])
  })

  test('keeps an unsafe link as plain text', () => {
    assert.equal(safeHref('javascript:alert'), null)
    assert.deepEqual(parseInline('[click](javascript:alert)'), [
      { kind: 'text', text: '[click](javascript:alert)' }
    ])
  })

  test('keeps a safe link', () => {
    assert.deepEqual(parseInline('[docs](https://example.com/a)'), [
      { kind: 'link', href: 'https://example.com/a', children: [{ kind: 'text', text: 'docs' }] }
    ])
  })
})
