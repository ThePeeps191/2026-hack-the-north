/**
 * OpenAI adapter.
 *
 * One seam between the runtime and the provider: text in, assistant text plus
 * requested tool calls out, deltas streamed as they arrive. Everything the
 * runtime knows about HTTP, streaming shapes and provider errors stops here.
 *
 * Transport: the Responses API is preferred. If the account, model or endpoint
 * cannot serve a Responses request, the adapter falls back to chat completions
 * for the rest of the session and says so, rather than failing the turn.
 *
 * Honesty rules kept here:
 *  - a call that produces neither text nor a tool call is an error, never an
 *    empty success (the runtime must not fabricate a reply);
 *  - every failure becomes a `HuddleError` with a concrete `fix`;
 *  - timeouts and cancellation are distinguished from provider faults.
 */

import OpenAI from 'openai'
import { HuddleError } from '../huddle-error.ts'
import { getSecret, redact } from '../config/secrets.ts'

/* ------------------------------------------------------------------ *
 * Public shapes
 * ------------------------------------------------------------------ */

export type ProviderTransport = 'responses' | 'chat'

export interface ProviderTextItem {
  kind: 'text'
  role: 'user' | 'assistant'
  content: string
}

export interface ProviderCallItem {
  kind: 'call'
  callId: string
  name: string
  arguments: string
}

export interface ProviderResultItem {
  kind: 'result'
  callId: string
  name: string
  output: string
}

export type ProviderInputItem = ProviderTextItem | ProviderCallItem | ProviderResultItem

export interface ProviderToolDefinition {
  name: string
  description: string
  /** JSON schema for the arguments. */
  parameters: Record<string, unknown>
}

export interface ProviderToolCall {
  /** Provider-side call id, echoed back with the result. */
  id: string
  name: string
  /** Raw JSON text exactly as the model produced it. */
  arguments: string
}

export interface ProviderUsage {
  inputTokens: number | null
  outputTokens: number | null
}

export interface ProviderTurn {
  text: string
  toolCalls: ProviderToolCall[]
  finishReason: string
  model: string
  transport: ProviderTransport
  usage: ProviderUsage
  latencyMs: number
}

export interface ProviderRequest {
  model: string
  instructions: string
  input: ProviderInputItem[]
  tools: ProviderToolDefinition[]
  maxOutputTokens: number
  /** Per-call ceiling. Defaults to 90s; reasoning models are allowed to be slow. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Called for every streamed text delta, in order. */
  onTextDelta?: (delta: string) => void
}

export interface ProviderStatus {
  configured: boolean
  transport: ProviderTransport
  detail: string
  lastError: string | null
}

export interface OpenAiProvider {
  readonly configured: boolean
  transport(): ProviderTransport
  status(): ProviderStatus
  setTransport(transport: ProviderTransport): void
  /** One turn: instructions + input + tools -> text and requested tool calls. */
  complete(request: ProviderRequest): Promise<ProviderTurn>
  /** Live model ids, newest first from the API. Throws when unconfigured. */
  listModels(): Promise<string[]>
  /** Tiny live check used by Settings and by the standalone probe. */
  probe(model: string): Promise<{ ok: boolean; detail: string; toolCalling: boolean }>
}

export interface OpenAiProviderOptions {
  /** Defaults to the repo secret store. */
  apiKey?: string
  /** Retries inside one call. Default 0: the runtime owns retry policy. */
  maxRetries?: number
  timeoutMs?: number
  onNotice?: (level: 'info' | 'warn' | 'error', text: string, fix?: string) => void
  now?: () => number
}

export const DEFAULT_PROVIDER_TIMEOUT_MS = 90_000
export const PROBE_MAX_OUTPUT_TOKENS = 32

const MISSING_KEY_MESSAGE = 'OpenAI is not configured, so teammates cannot reason yet.'
const MISSING_KEY_FIX = 'Add OPENAI_API_KEY in Settings, then retry. Typed interaction and room state still work.'

/* ------------------------------------------------------------------ *
 * Request building (pure, unit-testable)
 * ------------------------------------------------------------------ */

type ResponsesInputItem =
  | { role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

export function toResponsesInput(items: readonly ProviderInputItem[]): ResponsesInputItem[] {
  return items.map((item) => {
    if (item.kind === 'text') return { role: item.role, content: item.content }
    if (item.kind === 'call') {
      return { type: 'function_call' as const, call_id: item.callId, name: item.name, arguments: item.arguments }
    }
    return { type: 'function_call_output' as const, call_id: item.callId, output: item.output }
  })
}

interface ChatToolCallParam {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCallParam[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/**
 * Chat completions have no `instructions` parameter, so the system text travels
 * with the first user turn (or leads the conversation when there is none).
 * Consecutive tool calls are merged into one assistant message, which is what
 * the endpoint expects.
 */
export function toChatMessages(instructions: string, items: readonly ProviderInputItem[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  let pendingInstructions = instructions.trim()

  for (const item of items) {
    if (item.kind === 'text') {
      if (pendingInstructions && item.role === 'user') {
        messages.push({
          role: 'user',
          content: `Operating instructions:\n${pendingInstructions}\n\n${item.content}`
        })
        pendingInstructions = ''
        continue
      }
      messages.push({ role: item.role, content: item.content })
      continue
    }
    if (item.kind === 'call') {
      const call: ChatToolCallParam = {
        id: item.callId,
        type: 'function',
        function: { name: item.name, arguments: item.arguments }
      }
      const previous = messages[messages.length - 1]
      if (previous && previous.role === 'assistant') {
        previous.tool_calls = [...(previous.tool_calls ?? []), call]
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [call] })
      }
      continue
    }
    messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output })
  }

  if (pendingInstructions) {
    messages.unshift({ role: 'user', content: `Operating instructions:\n${pendingInstructions}` })
  }
  return messages
}

export function toResponsesTools(
  tools: readonly ProviderToolDefinition[]
): Array<{ type: 'function'; name: string; description: string; parameters: Record<string, unknown>; strict: false }> {
  return tools.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false as const
  }))
}

export function toChatTools(
  tools: readonly ProviderToolDefinition[]
): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown>; strict: false }
}> {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false as const
    }
  }))
}

/* ------------------------------------------------------------------ *
 * Error translation
 * ------------------------------------------------------------------ */

function statusOf(error: unknown): number | null {
  if (error instanceof OpenAI.APIError) {
    const status = error.status
    return typeof status === 'number' ? status : null
  }
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status
    if (typeof status === 'number') return status
  }
  return null
}

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

/** True when the failure means "this endpoint or model cannot serve this call". */
export function looksLikeTransportMismatch(error: unknown): boolean {
  const status = statusOf(error)
  if (status !== 404 && status !== 400) return false
  const message = textOf(error).toLowerCase()
  return (
    message.includes('not found') ||
    message.includes('does not exist') ||
    message.includes('unknown url') ||
    message.includes('unsupported') ||
    message.includes('not supported') ||
    message.includes('invalid endpoint') ||
    message.includes('invalid_value') ||
    message.includes('unexpected parameter') ||
    message.includes('unsupported_parameter') ||
    message.includes('unsupported_value')
  )
}

export function toProviderError(error: unknown, label: string): HuddleError {
  if (error instanceof HuddleError) return error

  const status = statusOf(error)
  const message = redact(textOf(error)).slice(0, 400)

  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new HuddleError('openai_timeout', `OpenAI stopped responding while ${label}.`, 'Retry the turn, or pick a faster model in Settings.')
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new HuddleError(
      'openai_unreachable',
      `Huddle could not reach OpenAI while ${label} (${message}).`,
      'Check the network connection and proxy settings, then retry.'
    )
  }

  switch (status) {
    case 401:
    case 403:
      return new HuddleError(
        'openai_auth',
        'OpenAI rejected the API key, so no teammate could answer.',
        'Paste a valid OPENAI_API_KEY in Settings.'
      )
    case 404:
      return new HuddleError(
        'openai_model_unavailable',
        `OpenAI did not recognise the model or endpoint used for ${label} (${message}).`,
        'Pick a different model in Settings, then retry.'
      )
    case 400:
      return new HuddleError(
        'openai_bad_request',
        `OpenAI refused the request while ${label}: ${message}`,
        'This is usually a model or tool-schema mismatch; change the model in Settings.'
      )
    case 413:
      return new HuddleError(
        'openai_context_too_large',
        `The conversation sent to OpenAI was too large while ${label}.`,
        'Start a new task or ask the teammate to summarise before continuing.'
      )
    case 429:
      return new HuddleError(
        'openai_rate_limited',
        `OpenAI rate-limited Huddle while ${label}.`,
        'Wait a moment before retrying, or lower concurrent work in Settings.'
      )
    default:
      break
  }

  if (status !== null && status >= 500) {
    return new HuddleError(
      'openai_unavailable',
      `OpenAI returned ${status} while ${label}.`,
      'Retry in a moment; nothing was changed in the project.'
    )
  }

  if (error instanceof OpenAI.APIUserAbortError) {
    return new HuddleError('openai_aborted', `The OpenAI request was cancelled while ${label}.`)
  }

  return new HuddleError('openai_error', `OpenAI failed while ${label}: ${message}`, 'Retry the turn.')
}

/* ------------------------------------------------------------------ *
 * Deadlines and cancellation
 * ------------------------------------------------------------------ */

interface Deadline {
  signal: AbortSignal
  dispose(): void
  timedOut(): boolean
}

export function createDeadline(timeoutMs: number, external?: AbortSignal): Deadline {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null

  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', () => controller.abort(), { once: true })
  }

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer)
    }
  }
}

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export class OpenAiProviderAdapter implements OpenAiProvider {
  readonly configured: boolean
  private client: OpenAI | null
  private activeTransport: ProviderTransport = 'responses'
  private lastError: string | null = null
  private readonly options: OpenAiProviderOptions
  private readonly now: () => number

  constructor(apiKey: string, options: OpenAiProviderOptions = {}) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
    const key = apiKey.trim()
    this.configured = key.length > 0
    this.client = this.configured
      ? new OpenAI({
          apiKey: key,
          maxRetries: options.maxRetries ?? 0,
          timeout: options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
        })
      : null
  }

  transport(): ProviderTransport {
    return this.activeTransport
  }

  setTransport(transport: ProviderTransport): void {
    this.activeTransport = transport
  }

  status(): ProviderStatus {
    if (!this.configured) {
      return {
        configured: false,
        transport: this.activeTransport,
        detail: 'No OpenAI API key',
        lastError: this.lastError
      }
    }
    return {
      configured: true,
      transport: this.activeTransport,
      detail:
        this.activeTransport === 'responses'
          ? 'Responses API'
          : 'Chat completions (Responses API was unavailable for this account)',
      lastError: this.lastError
    }
  }

  private requireClient(): OpenAI {
    if (!this.client) {
      throw new HuddleError('openai_missing', MISSING_KEY_MESSAGE, MISSING_KEY_FIX)
    }
    return this.client
  }

  async complete(request: ProviderRequest): Promise<ProviderTurn> {
    const client = this.requireClient()
    const first = await this.attempt(client, request, this.activeTransport)
    if (first.kind === 'ok') return first.turn

    // A transport that cannot serve this request at all: switch once, honestly.
    if (this.configured && looksLikeTransportMismatch(first.error)) {
      const next: ProviderTransport = this.activeTransport === 'responses' ? 'chat' : 'responses'
      this.activeTransport = next
      this.lastError = textOf(first.error)
      this.options.onNotice?.(
        'warn',
        `The OpenAI Responses API could not serve this call, so Huddle switched to chat completions for now (${redact(
          textOf(first.error)
        ).slice(0, 160)}).`
      )
      const second = await this.attempt(client, request, next)
      if (second.kind === 'ok') return second.turn
      throw toProviderError(second.error, `${request.model} (${next})`)
    }

    throw toProviderError(first.error, `${request.model} (${this.activeTransport})`)
  }

  private async attempt(
    client: OpenAI,
    request: ProviderRequest,
    transport: ProviderTransport
  ): Promise<{ kind: 'ok'; turn: ProviderTurn } | { kind: 'error'; error: unknown }> {
    const started = this.now()
    const deadline = createDeadline(request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS, request.signal)
    try {
      const turn =
        transport === 'responses'
          ? await this.runResponses(client, request, deadline.signal, started)
          : await this.runChat(client, request, deadline.signal, started)
      return { kind: 'ok', turn }
    } catch (error) {
      if (request.signal?.aborted) {
        return { kind: 'error', error: new HuddleError('openai_aborted', 'The turn was cancelled.') }
      }
      if (deadline.timedOut()) {
        this.lastError = 'timeout'
        return {
          kind: 'error',
          error: new HuddleError(
            'openai_timeout',
            `OpenAI did not answer within ${Math.round(
              (request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS) / 1000
            )}s.`,
            'Retry the turn; if it keeps timing out pick a faster model in Settings.'
          )
        }
      }
      this.lastError = textOf(error)
      return { kind: 'error', error }
    } finally {
      deadline.dispose()
    }
  }

  private async runResponses(
    client: OpenAI,
    request: ProviderRequest,
    signal: AbortSignal,
    started: number
  ): Promise<ProviderTurn> {
    const tools = toResponsesTools(request.tools)
    const body = {
      model: request.model,
      instructions: request.instructions,
      input: toResponsesInput(request.input),
      max_output_tokens: request.maxOutputTokens,
      store: false,
      ...(tools.length > 0 ? { tools } : {})
    }
    const onDelta = request.onTextDelta

    if (!onDelta) {
      const response = await client.responses.create(body, { signal })
      let text = ''
      const toolCalls: ProviderToolCall[] = []
      for (const item of response.output) {
        if (item.type === 'function_call') {
          toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments })
        }
      }
      // `output_text` is the SDK's own concatenation of the message parts.
      text = typeof response.output_text === 'string' ? response.output_text : ''
      const usage = response.usage
      // A response cut off by the token ceiling is not a completed turn.
      const finishReason = response.incomplete_details ? 'incomplete' : 'completed'
      this.assertSomethingReturned(text, toolCalls.length, finishReason)
      return {
        text,
        toolCalls,
        finishReason,
        model: response.model || request.model,
        transport: 'responses',
        usage: {
          inputTokens: usage?.input_tokens ?? null,
          outputTokens: usage?.output_tokens ?? null
        },
        latencyMs: this.now() - started
      }
    }

    const stream = await client.responses.create({ ...body, stream: true }, { signal })
    let text = ''
    let finishReason = 'completed'
    const toolCalls: ProviderToolCall[] = []
    let inputTokens: number | null = null
    let outputTokens: number | null = null

    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
          text += event.delta
          onDelta(event.delta)
          break
        case 'response.output_item.done':
          if (event.item.type === 'function_call') {
            toolCalls.push({
              id: event.item.call_id,
              name: event.item.name,
              arguments: event.item.arguments
            })
          }
          break
        case 'response.completed': {
          const usage = event.response.usage
          inputTokens = usage?.input_tokens ?? null
          outputTokens = usage?.output_tokens ?? null
          finishReason = event.response.incomplete_details ? 'incomplete' : 'completed'
          break
        }
        case 'response.incomplete':
          finishReason = 'incomplete'
          break
        case 'response.failed': {
          const failure = event.response.error
          throw new HuddleError(
            'openai_failed',
            `OpenAI reported a failed response: ${failure?.message ?? 'no detail'}`,
            'Retry the turn.'
          )
        }
        case 'error':
          throw new HuddleError(
            'openai_stream_error',
            `OpenAI streamed an error: ${event.message}`,
            'Retry the turn.'
          )
        default:
          break
      }
    }

    this.assertSomethingReturned(text, toolCalls.length, finishReason)
    return {
      text,
      toolCalls,
      finishReason,
      model: request.model,
      transport: 'responses',
      usage: { inputTokens, outputTokens },
      latencyMs: this.now() - started
    }
  }

  private async runChat(
    client: OpenAI,
    request: ProviderRequest,
    signal: AbortSignal,
    started: number
  ): Promise<ProviderTurn> {
    const tools = toChatTools(request.tools)
    const body = {
      model: request.model,
      messages: toChatMessages(request.instructions, request.input),
      max_completion_tokens: request.maxOutputTokens,
      ...(tools.length > 0 ? { tools } : {})
    }
    const onDelta = request.onTextDelta

    if (!onDelta) {
      const completion = await client.chat.completions.create(body, { signal })
      const choice = completion.choices[0]
      const text = choice?.message.content ?? ''
      const toolCalls: ProviderToolCall[] = []
      for (const call of choice?.message.tool_calls ?? []) {
        if (call.type !== 'function') continue
        toolCalls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments })
      }
      this.assertSomethingReturned(text, toolCalls.length, choice?.finish_reason ?? null)
      return {
        text,
        toolCalls,
        finishReason: choice?.finish_reason ?? 'stop',
        model: completion.model || request.model,
        transport: 'chat',
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? null,
          outputTokens: completion.usage?.completion_tokens ?? null
        },
        latencyMs: this.now() - started
      }
    }

    const stream = await client.chat.completions.create({ ...body, stream: true }, { signal })
    let text = ''
    let finishReason = 'stop'
    const partial = new Map<number, ProviderToolCall>()

    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) continue
      const delta = choice.delta
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content
        onDelta(delta.content)
      }
      for (const call of delta.tool_calls ?? []) {
        const existing = partial.get(call.index) ?? { id: '', name: '', arguments: '' }
        if (call.id) existing.id = call.id
        if (call.function?.name) existing.name += call.function.name
        if (call.function?.arguments) existing.arguments += call.function.arguments
        partial.set(call.index, existing)
      }
      if (choice.finish_reason) finishReason = choice.finish_reason
    }

    const toolCalls = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call)
      .filter((call) => call.name.length > 0)

    this.assertSomethingReturned(text, toolCalls.length, finishReason)
    return {
      text,
      toolCalls,
      finishReason,
      model: request.model,
      transport: 'chat',
      usage: { inputTokens: null, outputTokens: null },
      latencyMs: this.now() - started
    }
  }

  private assertSomethingReturned(text: string, toolCallCount: number, finishReason: string | null): void {
    if (text.trim().length > 0 || toolCallCount > 0) return
    throw new HuddleError(
      'openai_empty',
      `OpenAI returned no text and no tool call${finishReason ? ` (finish reason: ${finishReason})` : ''}. Nothing was recorded for this turn.`,
      'Retry the turn; if it repeats, raise the output token limit or pick another model in Settings.'
    )
  }

  async listModels(): Promise<string[]> {
    const client = this.requireClient()
    const page = await client.models.list()
    return page.data.map((model) => model.id)
  }

  /**
   * Tiny live check: does this model answer, and does it honour a function tool?
   * Used by the standalone probe and by Settings. Bounded and cheap on purpose.
   */
  async probe(model: string): Promise<{ ok: boolean; detail: string; toolCalling: boolean }> {
    const client = this.requireClient()
    const tools = toResponsesTools([
      {
        name: 'huddle_probe',
        description: 'Reports the probe marker. Always call this with marker "ok".',
        parameters: {
          type: 'object',
          properties: { marker: { type: 'string' } },
          required: ['marker'],
          additionalProperties: false
        }
      }
    ])

    try {
      const response = await client.responses.create(
        {
          model,
          instructions: 'You are a connectivity probe. Call the tool huddle_probe with marker "ok" and nothing else.',
          input: [{ role: 'user', content: 'Probe now.' }],
          tools,
          max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
          store: false
        },
        { signal: createDeadline(30_000).signal }
      )
      const calls = response.output.filter((item) => item.type === 'function_call')
      return {
        ok: true,
        detail: `${this.activeTransport} accepted ${model}${calls.length > 0 ? ' and returned a tool call' : ' but returned no tool call'}`,
        toolCalling: calls.length > 0
      }
    } catch (error) {
      const mapped = toProviderError(error, `probing ${model}`)
      this.lastError = mapped.message
      return { ok: false, detail: mapped.message, toolCalling: false }
    }
  }
}

/**
 * Builds the adapter from the secret store. A missing key is not an exception:
 * it produces a configured:false adapter, and the first call raises
 * `openai_missing` so the room can keep working without teammates reasoning.
 */
export function createDefaultProvider(options: OpenAiProviderOptions = {}): OpenAiProvider {
  let key = options.apiKey
  if (key === undefined) {
    try {
      key = getSecret('OPENAI_API_KEY')
    } catch {
      // A secret store that cannot be read behaves exactly like a missing key.
      key = ''
    }
  }
  return new OpenAiProviderAdapter(key, options)
}
