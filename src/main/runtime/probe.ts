/**
 * Live OpenAI probe.
 *
 * Run it by hand to prove which endpoint, transport and model this account can
 * actually serve before trusting the adapter — and to record the answer:
 *
 *   node --experimental-strip-types src/main/runtime/probe.ts
 *
 * It uses the shipped adapter (`provider.ts`), reads the key through the repo's
 * secret store, and makes five small calls with a hard 200-token ceiling. It
 * prints one `PROBE` line per fact so the result can be pasted straight into a
 * report. Nothing is written to disk and no project file is touched.
 *
 * It is deliberately NOT a `*.test.ts` file: it needs the network and a key.
 */

import { createDefaultProvider, PROBE_MAX_OUTPUT_TOKENS, type ProviderToolDefinition } from './provider.ts'

const CANDIDATE_MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.5', 'gpt-5.4']
const PRIMARY_MODEL = 'gpt-5.6-luna'

const PROBE_TOOL: ProviderToolDefinition = {
  name: 'huddle_probe',
  description: 'Records that the probe ran. Call it with marker "ok".',
  parameters: {
    type: 'object',
    properties: { marker: { type: 'string', description: 'Always "ok".' } },
    required: ['marker'],
    additionalProperties: false
  }
}

function line(label: string, value: unknown): void {
  console.log(`PROBE ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

async function main(): Promise<void> {
  const provider = createDefaultProvider({ maxRetries: 0 })
  line('configured', provider.configured)
  line('status', provider.status().detail)
  if (!provider.configured) {
    line('result', 'BLOCKED: no OPENAI_API_KEY in the repo secret store')
    process.exitCode = 1
    return
  }

  const started = Date.now()
  const models = await provider.listModels()
  line('model_count', models.length)
  line('candidates_present', CANDIDATE_MODELS.map((id) => `${id}=${models.includes(id)}`))
  line('models_ms', Date.now() - started)

  // 1. Non-streaming Responses call + function tool round trip.
  const probeResult = await provider.probe(PRIMARY_MODEL)
  line('responses_probe_ok', probeResult.ok)
  line('responses_tool_calling', probeResult.toolCalling)
  line('responses_probe_detail', probeResult.detail)

  // 2. Streaming Responses call, with deltas and a tool call.
  let streamed = ''
  const streamTurn = await provider.complete({
    model: PRIMARY_MODEL,
    instructions: 'You are a smoke test. Call the tool once, then answer in one short sentence.',
    input: [{ kind: 'text', role: 'user', content: 'Call huddle_probe with marker "ok" and then say done.' }],
    tools: [PROBE_TOOL],
    maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
    timeoutMs: 60_000,
    onTextDelta: (delta) => {
      streamed += delta
    }
  })
  line('stream_transport', streamTurn.transport)
  line('stream_text', streamTurn.text)
  line('stream_deltas_seen', streamed.length > 0)
  line('stream_tool_calls', streamTurn.toolCalls.map((call) => `${call.name}(${call.arguments})`))

  // 3. Feed the tool result back, which is what the executor does every turn.
  if (streamTurn.toolCalls.length > 0) {
    const first = streamTurn.toolCalls[0]
    const followUp = await provider.complete({
      model: PRIMARY_MODEL,
      instructions: 'You are a smoke test. Be terse.',
      input: [
        { kind: 'text', role: 'user', content: 'Call huddle_probe with marker "ok" and then say done.' },
        { kind: 'call', callId: first.id, name: first.name, arguments: first.arguments },
        { kind: 'result', callId: first.id, name: first.name, output: '{"marker":"ok"}' }
      ],
      tools: [],
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS
    })
    line('tool_round_trip_text', followUp.text)
  } else {
    line('tool_round_trip_text', 'SKIPPED: the model did not call the tool')
  }

  // 4. The fallback transport, so a Responses failure is a known quantity.
  provider.setTransport('chat')
  try {
    const chatTurn = await provider.complete({
      model: PRIMARY_MODEL,
      instructions: 'You are a smoke test. Answer in one word.',
      input: [{ kind: 'text', role: 'user', content: 'Say ready.' }],
      tools: [PROBE_TOOL],
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      timeoutMs: 60_000
    })
    line('chat_ok', true)
    line('chat_text', chatTurn.text)
    line('chat_tool_calling', chatTurn.toolCalls.length > 0)
  } catch (error) {
    line('chat_ok', false)
    line('chat_error', error instanceof Error ? error.message : String(error))
  }

  line('final_transport', provider.transport())
  line('result', 'done')
}

void main().catch((error: unknown) => {
  line('fatal', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
})
