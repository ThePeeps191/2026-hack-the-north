import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { splitSpoken, spokenForm, speechReasonFor } from './speech.ts'

describe('spoken vs written', () => {
  test('the written message keeps file and command detail while the spoken form does not', () => {
    const written = [
      'Done — the vote panel now shows a percentage.',
      '',
      'Files: `src/components/VotePanel.tsx`, `src/styles/vote.css`',
      'Command: `npm test` exited 0.',
      '',
      'Remaining: the anonymous-session case is not covered.'
    ].join('\n')

    const split = splitSpoken(written)
    assert.equal(split.written, written)
    assert.ok(split.spoken.length > 0)
    assert.ok(split.spoken.length <= 280)
    assert.equal(split.spoken.includes('VotePanel.tsx'), false)
    assert.equal(split.spoken.includes('npm test'), false)
    assert.equal(split.spoken.includes('```'), false)
  })

  test('code fences are never read aloud', () => {
    const spoken = spokenForm('Here is the change.\n\n```ts\nconst x = 1\n```\n')
    assert.equal(spoken.includes('const x'), false)
    assert.match(spoken, /Here is the change/)
  })

  test('markdown noise is stripped down to sentences', () => {
    const spoken = spokenForm('## Result\n\n- **Maya** wired the panel\n- Sam re-tested it\n\nAll checks pass.')
    assert.equal(spoken.includes('##'), false)
    assert.equal(spoken.includes('**'), false)
    assert.equal(spoken.includes('- '), false)
    assert.match(spoken, /Maya wired the panel/)
  })

  test('at most two sentences are spoken', () => {
    const spoken = spokenForm(
      'First sentence about the work. Second sentence with the outcome. Third sentence that should not be read. Fourth sentence either.'
    )
    assert.equal(spoken.includes('Third sentence'), false)
  })

  test('a code-only turn says something true instead of reading code', () => {
    assert.equal(spokenForm('```\nnpm run build\n```'), 'The details are in the transcript.')
  })

  test('file names are never read out as mangled fragments', () => {
    const spoken = spokenForm(
      'According to README.md and src/components/VoteGallery.tsx, voter names are public.'
    )
    assert.equal(spoken.includes('README'), false)
    assert.equal(spoken.includes('.tsx'), false)
    assert.equal(spoken.includes('. md'), false)
    assert.match(spoken, /According to/)
    assert.match(spoken, /voter names are public/)
  })

  test('an empty written body produces no speech at all', () => {
    assert.equal(spokenForm('   '), '')
    assert.equal(splitSpoken('').spoken, '')
  })

  test('long prose is clipped at a sentence boundary', () => {
    const long = `${'This is a fairly long sentence about the integration result. '.repeat(12)}`
    const spoken = spokenForm(long, 200)
    assert.ok(spoken.length <= 200)
    assert.ok(spoken.endsWith('...') || /[.!?]$/.test(spoken))
  })

  test('speech reasons follow the message kind', () => {
    assert.equal(speechReasonFor('answer'), 'answer')
    assert.equal(speechReasonFor('question'), 'clarify')
    assert.equal(speechReasonFor('result'), 'result')
    assert.equal(speechReasonFor('handoff'), 'peer')
    assert.equal(speechReasonFor('system'), 'status')
  })
})
