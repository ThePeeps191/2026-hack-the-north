import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { boundInput, MAX_CONTEXT_ITEMS } from './executor.ts'
import { toChatMessages } from './provider.ts'
import type { ProviderInputItem } from './provider.ts'

/**
 * The context window trimmer.
 *
 * A `result` only makes sense directly after the assistant turn that asked for
 * it. Trimming that split a pair produced a message list every provider
 * rejects with a 400 — and because the closing summary turn carries the longest
 * context, it failed there most reliably, which is how long runs ended with
 * "stopped without a report" instead of a report.
 */

function brief(): ProviderInputItem {
  return { kind: 'text', role: 'user', content: 'the brief' }
}

/** A long run: a call and its result for every turn, as the loop really builds it. */
function longRun(pairs: number): ProviderInputItem[] {
  const items: ProviderInputItem[] = [brief()]
  for (let index = 0; index < pairs; index += 1) {
    items.push({ kind: 'call', callId: `c${index}`, name: 'read_file', arguments: '{}' })
    items.push({ kind: 'result', callId: `c${index}`, name: 'read_file', output: 'contents' })
  }
  return items
}

/** Every tool message must sit immediately after an assistant turn that asked for it. */
function pairingIsValid(items: ProviderInputItem[]): boolean {
  const messages = toChatMessages('instructions', items)
  const answered = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) answered.add(call.id)
      continue
    }
    if (message.role === 'tool' && !answered.has(message.tool_call_id)) return false
  }
  return true
}

describe('boundInput', () => {
  test('leaves a short run exactly as it is', () => {
    const items = longRun(3)
    assert.equal(boundInput(items), items)
  })

  test('never starts the window on a result whose call was dropped', () => {
    // Every length around the boundary, because the bug only appeared when the
    // cut happened to land between a call and its result.
    for (let pairs = MAX_CONTEXT_ITEMS; pairs < MAX_CONTEXT_ITEMS + 8; pairs += 1) {
      const bounded = boundInput(longRun(pairs))
      const body = bounded.slice(2)
      assert.notEqual(body[0]?.kind, 'result', `window started on an orphan result at ${pairs} pairs`)
      assert.ok(pairingIsValid(bounded), `unanswered tool message at ${pairs} pairs`)
    }
  })

  test('drops a trailing call that has no result yet', () => {
    const items = longRun(MAX_CONTEXT_ITEMS + 2)
    items.push({ kind: 'call', callId: 'dangling', name: 'read_file', arguments: '{}' })
    const bounded = boundInput(items)
    assert.equal(bounded[bounded.length - 1]?.kind === 'call', false)
    assert.ok(pairingIsValid(bounded))
  })

  test('always keeps the brief and says how much was dropped', () => {
    const bounded = boundInput(longRun(MAX_CONTEXT_ITEMS + 5))
    assert.equal(bounded[0]?.kind, 'text')
    assert.equal((bounded[0] as { content: string }).content, 'the brief')
    assert.match((bounded[1] as { content: string }).content, /earlier items were dropped/)
  })

  test('stays within the budget', () => {
    const bounded = boundInput(longRun(MAX_CONTEXT_ITEMS * 2))
    assert.ok(bounded.length <= MAX_CONTEXT_ITEMS + 1, `kept ${bounded.length} items`)
  })
})
