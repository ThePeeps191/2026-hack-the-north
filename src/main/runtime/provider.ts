/**
 * The model adapter.
 *
 * One seam between the runtime and whichever model backend is serving a turn:
 * text in, assistant text plus requested tool calls out, deltas streamed as
 * they arrive. Everything the runtime knows about HTTP, streaming shapes and
 * provider errors stops here.
 *
 * Backends: OpenAI and DeepSeek. Both speak the OpenAI wire format, so one
 * client library serves both and the backend is chosen from the model id —
 * `deepseek-*` goes to DeepSeek, everything else to OpenAI. A room can run its
 * deep work on one backend and its fast conversation on the other, and a
 * backend with no key configured simply reports itself as unavailable instead
 * of failing a turn in a confusing way.
 *
 * Transport: the Responses API is preferred where the backend has one. If the
 * account, model or endpoint cannot serve a Responses request, the adapter
 * falls back to chat completions for the rest of the session and says so,
 * rather than failing the turn. DeepSeek serves chat completions only, so its
 * requests start there and never probe for an endpoint that does not exist.
 *
 * Honesty rules kept here:
 *  - a call that produces neither text nor a tool call is an error, never an
 *    empty success (the runtime must not fabricate a reply);
 *  - every failure becomes a `HuddleError` with a concrete `fix`;
 *  - timeouts and cancellation are distinguished from provider faults.
 */

import OpenAI from 'openai'
import { HuddleError } from '../huddle-error.ts'
import { getSecret, redact, type SecretKey } from '../config/secrets.ts'

/* ------------------------------------------------------------------ *
 * Backends
 * ------------------------------------------------------------------ */

export type BackendId = 'openai' | 'deepseek'

export interface ProviderBackend {
  id: BackendId
  label: string
  /** Undefined means the client library's own default (OpenAI). */
  baseURL: string | undefined
  secret: SecretKey
  /** Transports this backend can actually serve, best first. */
  transports: readonly ProviderTransport[]
  /** Model id prefixes that belong to this backend. */
  prefixes: readonly string[]
  /** Shown when the key is missing. */
  missingFix: string
  /**
   * Extra output budget this backend needs beyond the answer the caller asked
   * for.
   *
   * DeepSeek thinks in-band: its chat completions spend tokens on hidden
   * `reasoning_content` that count against the same ceiling as the visible
   * answer. Ask it for 500 tokens and it can spend all 500 thinking and return
   * an empty `content` with `finish_reason: "length"` — which is how a teammate
   * ended a real run with "stopped without a report". `maxOutputTokens` means
   * "tokens of answer I want", so the headroom is added here rather than being
   * guessed at by every caller.
   */
  outputBudget: (requested: number) => number
}

export const PROVIDER_BACKENDS: readonly ProviderBackend[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    secret: 'DEEPSEEK_API_KEY',
    // DeepSeek exposes an OpenAI-compatible chat-completions API and nothing
    // else. Probing for /responses here would only waste a round trip on a 404.
    transports: ['chat'],
    prefixes: ['deepseek'],
    missingFix: 'Add DEEPSEEK_API_KEY in Settings, then retry.',
    // Generous: thinking is cheap here, and a truncated answer costs a turn.
    outputBudget: (requested) => Math.min(8192, requested * 3 + 1024)
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: undefined,
    secret: 'OPENAI_API_KEY',
    transports: ['responses', 'chat'],
    prefixes: ['gpt', 'o1', 'o3', 'o4', 'chatgpt'],
    missingFix: 'Add OPENAI_API_KEY in Settings, then retry.',
    // The Responses API bills reasoning separately, so the ask is the ask.
    outputBudget: (requested) => requested
  }
]

/** The backend that serves this model id. Unknown ids go to OpenAI. */
export function backendForModel(model: string): ProviderBackend {
  const id = model.trim().toLowerCase()
  for (const backend of PROVIDER_BACKENDS) {
    if (backend.prefixes.some((prefix) => id.startsWith(prefix))) return backend
  }
  return PROVIDER_BACKENDS[PROVIDER_BACKENDS.length - 1] as ProviderBackend
}

export function backendById(id: BackendId): ProviderBackend {
  return PROVIDER_BACKENDS.find((backend) => backend.id === id) ?? (PROVIDER_BACKENDS[1] as ProviderBackend)
}

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
  /**
   * Defaults to the repo secret store. A bare string is the OpenAI key; a map
   * configures several backends at once.
   */
  apiKey?: string | Partial<Record<BackendId, string>>
  /** Retries inside one call. Default 0: the runtime owns retry policy. */
  maxRetries?: number
  timeoutMs?: number
  onNotice?: (level: 'info' | 'warn' | 'error', text: string, fix?: string) => void
  now?: () => number
}

export const DEFAULT_PROVIDER_TIMEOUT_MS = 90_000
export const PROBE_MAX_OUTPUT_TOKENS = 32

const MISSING_KEY_MESSAGE = 'No model provider is configured, so teammates cannot reason yet.'
const MISSING_KEY_FIX =
  'Add OPENAI_API_KEY or DEEPSEEK_API_KEY in Settings, then retry. Typed interaction and room state still work.'

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

/**
 * DeepSeek's chain of thought, which rides alongside the answer in a field the
 * OpenAI types do not describe. Huddle never shows it and never treats it as an
 * answer: it is read only to tell "said nothing" apart from "was cut off while
 * it was still thinking", which need different fixes.
 */
function reasoningTextOf(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const value = (message as { reasoning_content?: unknown }).reasoning_content
  return typeof value === 'string' ? value : ''
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

/** Where each vendor is topped up, so an out-of-credit error is actionable. */
const BILLING_URL: Record<string, string> = {
  OpenAI: 'https://platform.openai.com/settings/organization/billing',
  DeepSeek: 'https://platform.deepseek.com/top_up'
}

/**
 * True when the provider is refusing because the account has no money left.
 *
 * Vendors disagree about how to say this — DeepSeek returns 402, OpenAI
 * returns 429 with `insufficient_quota` — and it is worth telling apart from a
 * rate limit, because waiting fixes a rate limit and nothing fixes this except
 * paying. Getting it wrong sends someone to retry a button for ten minutes.
 */
function looksOutOfCredit(status: number | null, message: string): boolean {
  if (status === 402) return true
  const text = message.toLowerCase()
  return (
    text.includes('insufficient balance') ||
    text.includes('insufficient_quota') ||
    text.includes('credit_balance_exhausted') ||
    text.includes('no credits remaining') ||
    text.includes('exceeded your current quota')
  )
}

/** The env var a person has to set for this vendor, named in the fix text. */
function secretNameFor(vendor: string): string {
  const backend = PROVIDER_BACKENDS.find((candidate) => candidate.label === vendor)
  return backend ? backend.secret : 'OPENAI_API_KEY'
}

export function toProviderError(error: unknown, label: string, vendor = 'The model provider'): HuddleError {
  if (error instanceof HuddleError) return error

  const status = statusOf(error)
  const message = redact(textOf(error)).slice(0, 400)
  const billing = BILLING_URL[vendor]

  // Checked before anything else: a vendor can report it as 402, as 429, or as
  // a plain 400, and every one of those means the same thing.
  if (looksOutOfCredit(status, message)) {
    return new HuddleError(
      'openai_out_of_credit',
      `${vendor} has no credit left on this account, so no teammate can reason. Nothing was changed in the project.`,
      billing
        ? `Add credit at ${billing}, or switch to another provider's model in Settings.`
        : "Top up the account, or switch to another provider's model in Settings."
    )
  }

  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new HuddleError(
      'openai_timeout',
      `${vendor} stopped responding while ${label}.`,
      'Retry the turn, or pick a faster model in Settings.'
    )
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new HuddleError(
      'openai_unreachable',
      `Huddle could not reach ${vendor} while ${label} (${message}).`,
      'Check the network connection and proxy settings, then retry.'
    )
  }

  switch (status) {
    case 401:
    case 403:
      return new HuddleError(
        'openai_auth',
        `${vendor} rejected the API key, so no teammate could answer.`,
        `Paste a valid ${secretNameFor(vendor)} in Settings.`
      )
    case 404:
      return new HuddleError(
        'openai_model_unavailable',
        `${vendor} did not recognise the model or endpoint used for ${label} (${message}).`,
        'Pick a different model in Settings, then retry.'
      )
    case 400:
      return new HuddleError(
        'openai_bad_request',
        `${vendor} refused the request while ${label}: ${message}`,
        'This is usually a model or tool-schema mismatch; change the model in Settings.'
      )
    case 413:
      return new HuddleError(
        'openai_context_too_large',
        `The conversation sent to ${vendor} was too large while ${label}.`,
        'Start a new task or ask the teammate to summarise before continuing.'
      )
    case 429:
      return new HuddleError(
        'openai_rate_limited',
        `${vendor} rate-limited Huddle while ${label}.`,
        'Wait a moment before retrying, or lower concurrent work in Settings.'
      )
    default:
      break
  }

  if (status !== null && status >= 500) {
    return new HuddleError(
      'openai_unavailable',
      `${vendor} returned ${status} while ${label}.`,
      'Retry in a moment; nothing was changed in the project.'
    )
  }

  if (error instanceof OpenAI.APIUserAbortError) {
    return new HuddleError('openai_aborted', `The ${vendor} request was cancelled while ${label}.`)
  }

  return new HuddleError('openai_error', `${vendor} failed while ${label}: ${message}`, 'Retry the turn.')
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
  private readonly keys: Partial<Record<BackendId, string>>
  private readonly clients = new Map<BackendId, OpenAI>()
  /** Chosen transport per backend, narrowed once a backend proves it. */
  private readonly transports = new Map<BackendId, ProviderTransport>()
  private lastError: string | null = null
  private readonly options: OpenAiProviderOptions
  private readonly now: () => number

  constructor(apiKey: string | Partial<Record<BackendId, string>>, options: OpenAiProviderOptions = {}) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
    // A bare string is the OpenAI key: the shape this adapter had before a
    // second backend existed. Callers and tests that pass one keep working.
    this.keys =
      typeof apiKey === 'string'
        ? { openai: apiKey.trim() }
        : Object.fromEntries(
            Object.entries(apiKey).map(([id, value]) => [id, (value ?? '').trim()])
          )
    this.configured = PROVIDER_BACKENDS.some((backend) => (this.keys[backend.id] ?? '').length > 0)
    for (const backend of PROVIDER_BACKENDS) {
      this.transports.set(backend.id, backend.transports[0] ?? 'chat')
    }
  }

  /** Whether this specific backend has a key. */
  hasBackend(id: BackendId): boolean {
    return (this.keys[id] ?? '').length > 0
  }

  /** Backends that can actually serve a turn right now. */
  configuredBackends(): ProviderBackend[] {
    return PROVIDER_BACKENDS.filter((backend) => this.hasBackend(backend.id))
  }

  transport(): ProviderTransport {
    const primary = this.configuredBackends()[0] ?? backendById('openai')
    return this.transports.get(primary.id) ?? 'chat'
  }

  setTransport(transport: ProviderTransport): void {
    const primary = this.configuredBackends()[0] ?? backendById('openai')
    this.transports.set(primary.id, transport)
  }

  status(): ProviderStatus {
    const ready = this.configuredBackends()
    if (ready.length === 0) {
      return {
        configured: false,
        transport: this.transport(),
        detail: 'No model API key',
        lastError: this.lastError
      }
    }
    const parts = ready.map((backend) => {
      const transport = this.transports.get(backend.id) ?? 'chat'
      return `${backend.label} (${transport === 'responses' ? 'Responses API' : 'chat completions'})`
    })
    return {
      configured: true,
      transport: this.transport(),
      detail: parts.join(' · '),
      lastError: this.lastError
    }
  }

  /** The client for a backend, built once. Throws when that key is missing. */
  private clientFor(backend: ProviderBackend): OpenAI {
    const existing = this.clients.get(backend.id)
    if (existing) return existing
    const key = this.keys[backend.id] ?? ''
    if (!key) {
      throw new HuddleError(
        'openai_missing',
        `${backend.label} is not configured, so teammates cannot reason with ${backend.label} models yet.`,
        backend.missingFix
      )
    }
    const client = new OpenAI({
      apiKey: key,
      ...(backend.baseURL ? { baseURL: backend.baseURL } : {}),
      maxRetries: this.options.maxRetries ?? 0,
      timeout: this.options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
    })
    this.clients.set(backend.id, client)
    return client
  }

  /**
   * The backend that should serve this model.
   *
   * When the model's own backend has no key but another one does, the request
   * is *not* silently sent somewhere else — a model id is a promise about which
   * model answered, and quietly swapping it would make every later report about
   * "which model did this" a lie. The caller gets a clear error instead.
   */
  private backendFor(model: string): ProviderBackend {
    const backend = backendForModel(model)
    if (this.hasBackend(backend.id)) return backend
    const alternatives = this.configuredBackends()
    throw new HuddleError(
      'openai_missing',
      alternatives.length > 0
        ? `"${model}" is a ${backend.label} model and ${backend.label} has no API key. Configured right now: ${alternatives
            .map((item) => item.label)
            .join(', ')}.`
        : MISSING_KEY_MESSAGE,
      alternatives.length > 0
        ? `${backend.missingFix} Or pick a ${alternatives[0]?.label} model in Settings.`
        : MISSING_KEY_FIX
    )
  }

  async complete(request: ProviderRequest): Promise<ProviderTurn> {
    const backend = this.backendFor(request.model)
    const client = this.clientFor(backend)
    const active = this.transports.get(backend.id) ?? backend.transports[0] ?? 'chat'

    const first = await this.attempt(client, request, active)
    if (first.kind === 'ok') return first.turn

    // A transport this backend cannot serve: switch once, to a transport the
    // backend actually has, and say so.
    const fallback = backend.transports.find((candidate) => candidate !== active)
    if (fallback && looksLikeTransportMismatch(first.error)) {
      this.transports.set(backend.id, fallback)
      this.lastError = textOf(first.error)
      this.options.onNotice?.(
        'warn',
        `${backend.label}'s ${active === 'responses' ? 'Responses API' : 'chat endpoint'} could not serve this call, so Huddle switched to ${
          fallback === 'responses' ? 'the Responses API' : 'chat completions'
        } for now (${redact(textOf(first.error)).slice(0, 160)}).`
      )
      const second = await this.attempt(client, request, fallback)
      if (second.kind === 'ok') return second.turn
      throw toProviderError(second.error, `${request.model} (${fallback})`, backend.label)
    }

    throw toProviderError(first.error, `${request.model} (${active})`, backend.label)
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
    const backend = backendForModel(request.model)
    const body = {
      model: request.model,
      messages: toChatMessages(request.instructions, request.input),
      // The caller asks for tokens of *answer*. A backend that thinks in-band
      // needs its thinking paid for on top, or it truncates before it speaks.
      max_completion_tokens: backend.outputBudget(request.maxOutputTokens),
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
      // An empty `content` next to a non-empty chain of thought means the
      // budget ran out mid-thought, which is a different fault from silence.
      const reasoned = reasoningTextOf(choice?.message).length > 0
      this.assertSomethingReturned(text, toolCalls.length, choice?.finish_reason ?? null, reasoned)
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
    let reasoningSeen = false
    const partial = new Map<number, ProviderToolCall>()

    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) continue
      const delta = choice.delta
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content
        onDelta(delta.content)
      }
      // Never streamed into the room: the human hears what a teammate says, not
      // what it thinks. Tracked only to explain an empty answer honestly.
      if (reasoningTextOf(delta).length > 0) reasoningSeen = true
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

    this.assertSomethingReturned(text, toolCalls.length, finishReason, reasoningSeen)
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

  /**
   * A turn that produced nothing is an error, never an empty success.
   *
   * `reasoningOnly` distinguishes the two ways that happens, because they need
   * different fixes: a model that answered nothing at all is a different
   * problem from one that spent its whole budget thinking and was cut off
   * before it spoke. Saying "no text and no tool call" for the second case sent
   * a real debugging session looking in the wrong place.
   */
  private assertSomethingReturned(
    text: string,
    toolCallCount: number,
    finishReason: string | null,
    reasoningOnly = false
  ): void {
    if (text.trim().length > 0 || toolCallCount > 0) return
    if (reasoningOnly) {
      throw new HuddleError(
        'openai_empty',
        `The model spent its entire output budget on internal reasoning and was cut off before it said anything${
          finishReason ? ` (finish reason: ${finishReason})` : ''
        }. Nothing was recorded for this turn.`,
        'Raise the output token limit for this model, or pick a model that reasons less, in Settings.'
      )
    }
    throw new HuddleError(
      'openai_empty',
      `The model returned no text and no tool call${finishReason ? ` (finish reason: ${finishReason})` : ''}. Nothing was recorded for this turn.`,
      'Retry the turn; if it repeats, raise the output token limit or pick another model in Settings.'
    )
  }

  /**
   * Every model id this machine can actually reach, across every configured
   * backend. A backend that fails to answer is skipped rather than failing the
   * whole list, so one dead key does not hide the models that do work.
   */
  async listModels(): Promise<string[]> {
    const backends = this.configuredBackends()
    if (backends.length === 0) {
      throw new HuddleError('openai_missing', MISSING_KEY_MESSAGE, MISSING_KEY_FIX)
    }
    const ids: string[] = []
    const failures: string[] = []
    for (const backend of backends) {
      try {
        const page = await this.clientFor(backend).models.list()
        for (const model of page.data) ids.push(model.id)
      } catch (error) {
        failures.push(`${backend.label}: ${textOf(error)}`)
      }
    }
    if (ids.length === 0 && failures.length > 0) {
      this.lastError = failures.join('; ')
      throw toProviderError(new Error(failures.join('; ')), 'listing models')
    }
    return [...new Set(ids)]
  }

  /**
   * Tiny live check: does this model answer, and does it honour a function tool?
   * Used by the standalone probe and by Settings. Bounded and cheap on purpose.
   */
  async probe(model: string): Promise<{ ok: boolean; detail: string; toolCalling: boolean }> {
    const definition: ProviderToolDefinition = {
      name: 'huddle_probe',
      description: 'Reports the probe marker. Always call this with marker "ok".',
      parameters: {
        type: 'object',
        properties: { marker: { type: 'string' } },
        required: ['marker'],
        additionalProperties: false
      }
    }

    let backend: ProviderBackend
    let client: OpenAI
    try {
      backend = this.backendFor(model)
      client = this.clientFor(backend)
    } catch (error) {
      const mapped = toProviderError(error, `probing ${model}`, backendForModel(model).label)
      return { ok: false, detail: mapped.message, toolCalling: false }
    }

    const transport = this.transports.get(backend.id) ?? backend.transports[0] ?? 'chat'
    const signal = createDeadline(30_000).signal

    try {
      if (transport === 'responses') {
        const response = await client.responses.create(
          {
            model,
            instructions:
              'You are a connectivity probe. Call the tool huddle_probe with marker "ok" and nothing else.',
            input: [{ role: 'user', content: 'Probe now.' }],
            tools: toResponsesTools([definition]),
            max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
            store: false
          },
          { signal }
        )
        const calls = response.output.filter((item) => item.type === 'function_call')
        return {
          ok: true,
          detail: `${backend.label} Responses API accepted ${model}${
            calls.length > 0 ? ' and returned a tool call' : ' but returned no tool call'
          }`,
          toolCalling: calls.length > 0
        }
      }

      const completion = await client.chat.completions.create(
        {
          model,
          messages: [
            {
              role: 'user',
              content:
                'You are a connectivity probe. Call the tool huddle_probe with marker "ok" and nothing else. Probe now.'
            }
          ],
          tools: toChatTools([definition]),
          // Reasoning models spend tokens before they emit a call, so the probe
          // ceiling has to leave room for that or it reports a false negative.
          max_tokens: PROBE_MAX_OUTPUT_TOKENS * 16
        },
        { signal }
      )
      const calls = completion.choices[0]?.message.tool_calls ?? []
      return {
        ok: true,
        detail: `${backend.label} chat completions accepted ${model}${
          calls.length > 0 ? ' and returned a tool call' : ' but returned no tool call'
        }`,
        toolCalling: calls.length > 0
      }
    } catch (error) {
      const mapped = toProviderError(error, `probing ${model}`, backend.label)
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
  if (options.apiKey !== undefined) return new OpenAiProviderAdapter(options.apiKey, options)

  const keys: Partial<Record<BackendId, string>> = {}
  for (const backend of PROVIDER_BACKENDS) {
    try {
      keys[backend.id] = getSecret(backend.secret)
    } catch {
      // A secret store that cannot be read behaves exactly like a missing key.
      keys[backend.id] = ''
    }
  }
  return new OpenAiProviderAdapter(keys, options)
}
