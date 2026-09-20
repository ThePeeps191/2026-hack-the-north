import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AGENT_PRESETS } from '../../shared/presets.ts'
import { defaultRoster, describeRoster, heuristicRoster, parseRoster, rosterInstructions } from './roster.ts'

const IDS = new Set(AGENT_PRESETS.map((preset) => preset.id))

describe('parseRoster', () => {
  test('reads the documented one-line format', () => {
    assert.deepEqual(parseRoster('ROSTER: maya, alex, sam', 3), ['maya', 'alex', 'sam'])
  })

  test('survives the shapes a model actually replies with', () => {
    // Every one of these is the same answer wearing different clothes.
    for (const reply of [
      'roster: rio, rio, nova',
      'ROSTER:rio,rio,nova',
      'Sure! ROSTER: rio, rio, nova',
      '- rio\n- rio\n- nova',
      '```\nROSTER: rio, rio, nova\n```'
    ]) {
      assert.deepEqual(parseRoster(reply, 3), ['rio', 'rio', 'nova'], `failed on: ${reply}`)
    }
  })

  test('takes only as many as were asked for', () => {
    assert.deepEqual(parseRoster('ROSTER: maya, alex, sam, rio, nova', 2), ['maya', 'alex'])
  })

  test('ignores ids that do not exist rather than inventing a role', () => {
    // A role with no preset behind it has no persona, so it cannot be staffed.
    const picked = parseRoster('ROSTER: maya, devops, security, alex', 3)
    assert.ok(picked)
    for (const id of picked) assert.ok(IDS.has(id), `${id} is not a real preset`)
    assert.deepEqual(picked, ['maya', 'alex'])
  })

  test('returns null when nothing usable came back', () => {
    assert.equal(parseRoster('', 3), null)
    assert.equal(parseRoster('I am not sure what you mean.', 3), null)
  })
})

describe('heuristicRoster', () => {
  test('a research goal gets researchers, not a frontend engineer', () => {
    // The exact case the fixed order got wrong: a room to research a market
    // was staffed with somebody to build screens and somebody to test them.
    const picked = heuristicRoster('Research competitors in the AI voice space and write it up', 3)
    assert.ok(picked.includes('rio'), `expected research in ${picked.join(', ')}`)
    assert.equal(picked.includes('maya'), false, 'no frontend engineer for a research goal')
  })

  test('a build goal gets a builder, a contract owner and a checker', () => {
    const picked = heuristicRoster('Add a settings screen with a dark mode toggle', 3)
    assert.ok(picked.includes('maya'), 'somebody has to build it')
    assert.ok(picked.includes('sam'), 'somebody has to check it')
    assert.ok(picked.includes('alex'), 'somebody has to own the shape it depends on')
  })

  test('a bug-hunt goal leads with quality', () => {
    const picked = heuristicRoster('Find and fix the duplicate-submit bug in checkout', 3)
    assert.equal(picked[0], 'sam')
  })

  test('always returns exactly the number asked for', () => {
    for (const count of [1, 2, 3, 4, 5, 6]) {
      const picked = heuristicRoster('Make voting anonymous in Sketch Night', count)
      assert.equal(picked.length, count, `asked for ${count}`)
      for (const id of picked) assert.ok(IDS.has(id))
    }
  })

  test('an unreadable goal falls back to the software roster', () => {
    assert.deepEqual(heuristicRoster('zzzz qqqq', 3), defaultRoster(3))
  })

  test('an empty goal never throws', () => {
    assert.equal(heuristicRoster('', 3).length, 3)
  })
})

describe('the prompt', () => {
  test('names every preset, so the model can only pick real ones', () => {
    const instructions = rosterInstructions(3)
    for (const preset of AGENT_PRESETS) {
      assert.ok(instructions.includes(preset.id), `${preset.id} missing from the prompt`)
    }
    assert.match(instructions, /ROSTER: id, id, id/)
    assert.match(instructions, /exactly 3 teammates/)
  })
})

describe('describeRoster', () => {
  test('reads as a sentence', () => {
    assert.equal(describeRoster(['maya', 'alex', 'sam']), 'frontend, systems and qa')
    assert.equal(describeRoster(['rio']), 'research')
  })
})
