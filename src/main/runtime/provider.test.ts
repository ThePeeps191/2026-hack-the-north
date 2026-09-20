import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { HuddleError } from '../huddle-error.ts'
import {
  createDeadline,
  createDefaultProvider,
  looksLikeTransportMismatch,
  backendForModel,
  OpenAiProviderAdapter,
  toChatMessages,
  toChatTools,
  toProviderError,
  toResponsesInput,
  toResponsesTools
} from './provider.ts'
import type { ProviderInputItem, ProviderToolDefinition } from './provider.ts'

const TOOL: ProviderToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
}

function apiError(status: number, message: string): Error {
  const error = new Error(message)
  Object.assign(error, { status })
  return error
}

describe('request building', () => {
  test('text and tool items map to the Responses input shape', () => {
    const items: ProviderInputItem[] = [
      { kind: 'text', role: 'user', content: 'do it' },
      { kind: 'call', callId: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { kind: 'result', callId: 'call_1', name: 'read_file', output: 'ok' }
    ]
    assert.deepEqual(toResponsesInput(items), [
      { role: 'user', content: 'do it' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
    ])
  })

  test('chat messages fold instructions and merge consecutive tool calls', () => {
    const items: ProviderInputItem[] = [
      { kind: 'text', role: 'user', content: 'go' },
      { kind: 'call', callId: 'c1', name: 'read_file', arguments: '{}' },
      { kind: 'call', callId: 'c2', name: 'list_files', arguments: '{}' },
      { kind: 'result', callId: 'c1', name: 'read_file', output: 'a' },
      { kind: 'result', callId: 'c2', name: 'list_files', output: 'b' }
    ]
    const messages = toChatMessages('Be terse.', items)
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant', 'tool', 'tool']
    )
    assert.match(JSON.stringify(messages[0]), /Be terse/)
    const toolCalls = messages.flatMap((message) =>
      message.role === 'assistant' ? message.tool_calls ?? [] : []
    )
    assert.equal(toolCalls.length, 2)
    assert.deepEqual(
      toolCalls.map((call) => call.function.name),
      ['read_file', 'list_files']
    )
  })

  test('tool definitions carry the schema to both transports', () => {
    const responses = toResponsesTools([TOOL])
    assert.equal(responses[0].type, 'function')
    assert.equal(responses[0].name, 'read_file')
    assert.equal(responses[0].strict, false)
    const chat = toChatTools([TOOL])
    assert.equal(chat[0].function.name, 'read_file')
    assert.deepEqual(chat[0].function.parameters, TOOL.parameters)
  })
})

describe('provider errors', () => {
  test('an auth failure explains what to do', () => {
    const error = toProviderError(apiError(401, 'invalid api key'), 'building the plan')
    assert.ok(error instanceof HuddleError)
    assert.equal(error.code, 'openai_auth')
    assert.match(error.message, /rejected the API key/)
    assert.match(error.fix ?? '', /OPENAI_API_KEY/)
  })

  test('a missing model is reported as a model problem, not a network problem', () => {
    const error = toProviderError(apiError(404, 'The model does not exist'), 'turn 3')
    assert.equal(error.code, 'openai_model_unavailable')
    assert.match(error.fix ?? '', /model/i)
  })

  test('rate limits and server faults are distinct', () => {
    assert.equal(toProviderError(apiError(429, 'slow down'), 'turn 1').code, 'openai_rate_limited')
    assert.equal(toProviderError(apiError(503, 'upstream'), 'turn 1').code, 'openai_unavailable')
  })

  test('a bad request keeps the provider message for the human', () => {
    const error = toProviderError(apiError(400, 'tools: too many'), 'turn 2')
    assert.equal(error.code, 'openai_bad_request')
    assert.match(error.message, /tools: too many/)
  })

  test('a plain network error is reported as unreachable', () => {
    const error = toProviderError(new Error('fetch failed: ECONNREFUSED'), 'turn 1')
    assert.ok(['openai_error', 'openai_unreachable'].includes(error.code))
    assert.match(error.message, /ECONNREFUSED/)
  })

  test('an existing HuddleError is passed through unchanged', () => {
    const original = new HuddleError('openai_missing', 'no key', 'add one')
    assert.equal(toProviderError(original, 'anything'), original)
  })

  test('transport mismatch detection is narrow', () => {
    assert.equal(looksLikeTransportMismatch(apiError(404, 'Not Found: /v1/responses')), true)
    assert.equal(looksLikeTransportMismatch(apiError(400, 'unsupported_parameter: max_output_tokens')), true)
    assert.equal(looksLikeTransportMismatch(apiError(400, 'invalid request: tool schema')), false)
    assert.equal(looksLikeTransportMismatch(apiError(500, 'not found')), false)
    assert.equal(looksLikeTransportMismatch(new Error('boom')), false)
  })
})

describe('missing credentials', () => {
  test('no key produces a configured:false adapter, not a crash', () => {
    const provider = createDefaultProvider({ apiKey: { openai: '', deepseek: '' } })
    assert.equal(provider.configured, false)
    assert.equal(provider.status().detail, 'No model API key')
  })

  test('the first call raises openai_missing with a concrete fix', async () => {
    const provider = createDefaultProvider({ apiKey: { openai: '', deepseek: '' } })
    await assert.rejects(
      () =>
        provider.complete({
          model: 'gpt-5.6-luna',
          instructions: 'x',
          input: [{ kind: 'text', role: 'user', content: 'hi' }],
          tools: [],
          maxOutputTokens: 16
        }),
      (error: unknown) => {
        assert.ok(error instanceof HuddleError)
        assert.equal(error.code, 'openai_missing')
        assert.match(error.message, /No model provider is configured/)
        assert.match(error.fix ?? '', /OPENAI_API_KEY or DEEPSEEK_API_KEY/)
        return true
      }
    )
  })

  test('listModels also refuses cleanly', async () => {
    const provider = createDefaultProvider({ apiKey: { openai: '', deepseek: '' } })
    await assert.rejects(() => provider.listModels(), /No model provider is configured/)
  })
})

describe('choosing a backend from the model id', () => {
  test('a deepseek model id routes to DeepSeek, everything else to OpenAI', () => {
    assert.equal(backendForModel('deepseek-flash').id, 'deepseek')
    assert.equal(backendForModel('deepseek-v4-pro').id, 'deepseek')
    assert.equal(backendForModel('gpt-5.6-luna').id, 'openai')
    assert.equal(backendForModel('o3-mini').id, 'openai')
    // An id nobody recognises is not a reason to guess a vendor.
    assert.equal(backendForModel('some-new-model').id, 'openai')
  })

  test('DeepSeek is chat-only, so it never probes an endpoint it does not have', () => {
    const adapter = new OpenAiProviderAdapter({ deepseek: 'sk-test' })
    assert.equal(adapter.transport(), 'chat')
    assert.deepEqual(backendForModel('deepseek-flash').transports, ['chat'])
  })

  test('a model whose backend has no key is refused, never silently rerouted', async () => {
    // Quietly answering a gpt-* request with DeepSeek would make every later
    // report about which model did the work untrue.
    const adapter = new OpenAiProviderAdapter({ deepseek: 'sk-test', openai: '' })
    assert.equal(adapter.configured, true)
    await assert.rejects(
      () =>
        adapter.complete({
          model: 'gpt-5.6-luna',
          instructions: 'x',
          input: [{ kind: 'text', role: 'user', content: 'hi' }],
          tools: [],
          maxOutputTokens: 16
        }),
      (error: unknown) => {
        assert.ok(error instanceof HuddleError)
        assert.equal(error.code, 'openai_missing')
        assert.match(error.message, /OpenAI model and OpenAI has no API key/)
        assert.match(error.fix ?? '', /DeepSeek model in Settings/)
        return true
      }
    )
  })

  test('the status line names every backend that can actually serve a turn', () => {
    const both = new OpenAiProviderAdapter({ deepseek: 'sk-a', openai: 'sk-b' })
    const detail = both.status().detail
    assert.match(detail, /DeepSeek/)
    assert.match(detail, /OpenAI/)
  })
})

describe('deadlines', () => {
  test('an expired deadline aborts the call signal', () => {
    const deadline = createDeadline(1)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(deadline.signal.aborted, true)
        assert.equal(deadline.timedOut(), true)
        deadline.dispose()
        resolve()
      }, 20)
    })
  })

  test('an already-aborted caller signal aborts immediately', () => {
    const controller = new AbortController()
    controller.abort()
    const deadline = createDeadline(5000, controller.signal)
    assert.equal(deadline.signal.aborted, true)
    assert.equal(deadline.timedOut(), false)
    deadline.dispose()
  })
})

describe('transport selection', () => {
  test('OpenAI prefers the Responses API and can be switched explicitly', () => {
    const adapter = new OpenAiProviderAdapter('sk-test')
    assert.equal(adapter.transport(), 'responses')
    assert.match(adapter.status().detail, /Responses API/)
    adapter.setTransport('chat')
    assert.equal(adapter.transport(), 'chat')
    assert.match(adapter.status().detail, /chat completions/)
  })
})

describe('an account with no credit left', () => {
  const outOfCredit = (status: number, message: string): HuddleError =>
    toProviderError(Object.assign(new Error(message), { status }), 'a turn', 'DeepSeek')

  test('DeepSeek 402 is reported as no credit, with somewhere to fix it', () => {
    const error = outOfCredit(402, '402 Insufficient Balance')
    assert.equal(error.code, 'openai_out_of_credit')
    assert.match(error.message, /DeepSeek has no credit left/)
    assert.match(error.fix ?? '', /platform\.deepseek\.com/)
  })

  test("OpenAI's 429 for an empty balance is not mistaken for a rate limit", () => {
    // Waiting fixes a rate limit and never fixes this, so telling a person to
    // "wait a moment and retry" would send them in a circle.
    const error = toProviderError(
      Object.assign(new Error('You have no credits remaining. insufficient_quota'), { status: 429 }),
      'a turn',
      'OpenAI'
    )
    assert.equal(error.code, 'openai_out_of_credit')
    assert.match(error.fix ?? '', /platform\.openai\.com/)
  })

  test('a genuine rate limit still reads as a rate limit', () => {
    const error = toProviderError(
      Object.assign(new Error('Rate limit reached for requests'), { status: 429 }),
      'a turn',
      'OpenAI'
    )
    assert.equal(error.code, 'openai_rate_limited')
  })

  test('the vendor in the message is the one that actually failed', () => {
    // Every error used to say "OpenAI failed", including DeepSeek's.
    const error = toProviderError(new Error('boom'), 'a turn', 'DeepSeek')
    assert.match(error.message, /^DeepSeek failed/)
    assert.doesNotMatch(error.message, /OpenAI/)
  })
})
