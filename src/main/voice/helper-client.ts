// Supervises the standalone voice helper process.
//
// Mirrors tools/voice-lab/src/server/index.ts (which owned the helper in-lab),
// but as a supervised child of the Electron main process:
//
//  - spawns `out/main/voice-helper.js` with **system Node** (never Electron, and
//    never with ELECTRON_RUN_AS_NODE: the native audio modules must match Node's
//    ABI), so a missing Node binary becomes a truthful capability, not a crash
//  - one `init` carries paths and the ElevenLabs key over a private pipe; the key
//    is never written to a log, an event, or the renderer
//  - restarts on crash (bounded, with backoff) and reports structured errors
//  - requests are matched by id and time out instead of hanging forever
//  - nothing here blocks the microphone path: control messages are written
//    immediately and responses are dispatched as they arrive
//
// No parameter properties / enums: loaded by `node --experimental-strip-types --test`.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Capability } from '../../shared/types.ts'
import { HuddleError } from '../huddle-error.ts'
import type { HelperCap, HelperCaps, HelperEvent, HelperInitConfig, HelperRequest, HelperVoiceSettings } from './protocol.ts'
import { HELPER_PROTOCOL_VERSION, encodeHelperRequest, parseHelperLine, startingCaps } from './protocol.ts'

/** The helper's capability report. Re-exported so the host and its tests import it from one place. */
export type {
  HelperCap,
  HelperCaps,
  HelperEvent,
  HelperInitConfig,
  HelperRequest,
  HelperVoiceSettings
} from './protocol.ts'
import { float32ToBase64 } from './pcm.ts'

export interface VoiceHelperChunk {
  generationId: string
  seq: number
  pcm: Uint8Array
}

export interface HelperChunk {
  seq: number
  pcm: Uint8Array
}

export type SpeakOutcome =
  | { state: 'ended'; chars: number; bytes: number }
  | { state: 'cancelled' }
  | { state: 'failed'; message: string; fix: string | null }

export interface VoiceHelperPort {
  ensureStarted(): Promise<HelperCaps>
  caps(): HelperCaps | null
  running(): boolean
  resetVad(): Promise<void>
  frame(frame: Float32Array): Promise<number>
  transcribe(input: {
    utteranceId: string
    pcm: Float32Array
    isFinal: boolean
    initialPrompt?: string
  }): Promise<string>
  speak(input: {
    generationId: string
    text: string
    voice: HelperVoiceSettings
    /** PCM as it streams. Only ever called for this generation. */
    onChunk(chunk: HelperChunk): void
  }): Promise<SpeakOutcome>
  cancel(generationId: string, reason: string): void
  dispose(): Promise<void>
}

export interface VoiceHelperClientOptions {
  /** Absolute path of out/main/voice-helper.js. */
  helperPath: string
  /** System node binary. Defaults to HUDDLE_NODE, then `node` on PATH. */
  nodeBin?: string
  /** Extra environment for the child (HUDDLE_APP_ROOT keeps paths honest). */
  env?: Record<string, string>
  config: Omit<HelperInitConfig, 'protocol'>
  onCaps(caps: HelperCaps): void
  onLog(level: 'info' | 'warn' | 'error', text: string): void
  /** The helper died. The host reports a truthful capability and keeps typed chat working. */
  onExit(info: { code: number | null; signal: string | null; restarts: number }): void
  spawnImpl?: typeof spawn
  now?: () => number
}

interface PendingRequest {
  resolve: (event: HelperEvent) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  /** Set for `tts.speak`, so cancel() can settle it immediately. */
  generationId?: string
}

const DEFAULT_TIMEOUT_MS = 20_000
const TRANSCRIBE_TIMEOUT_MS = 90_000
const SPEAK_TIMEOUT_MS = 180_000
const RESTART_WINDOW_MS = 60_000
const MAX_RESTARTS_PER_WINDOW = 3

export class VoiceHelperClient implements VoiceHelperPort {
  private readonly options: VoiceHelperClientOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly chunkHandlers = new Map<string, (chunk: HelperChunk) => void>()
  private currentCaps: HelperCaps | null = null
  private starting: Promise<HelperCaps> | null = null
  private disposed = false
  private restartTimes: number[] = []

  constructor(options: VoiceHelperClientOptions) {
    this.options = options
  }

  caps(): HelperCaps | null {
    return this.currentCaps
  }

  running(): boolean {
    return this.child !== null
  }

  async ensureStarted(): Promise<HelperCaps> {
    if (this.disposed) throw new HuddleError('voice_disposed', 'Voice is shutting down.')
    if (this.child && this.currentCaps) return this.currentCaps
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async frame(frame: Float32Array): Promise<number> {
    const event = await this.request(
      { t: 'vad.frame', id: this.takeId(), pcm: float32ToBase64(frame) },
      DEFAULT_TIMEOUT_MS
    )
    if (event.t !== 'vad.prob') {
      throw new HuddleError('vad_failed', 'VAD produced no probability for a frame.')
    }
    return event.p
  }

  async resetVad(): Promise<void> {
    await this.request({ t: 'vad.reset', id: this.takeId() }, DEFAULT_TIMEOUT_MS)
  }

  async transcribe(input: {
    utteranceId: string
    pcm: Float32Array
    isFinal: boolean
    initialPrompt?: string
  }): Promise<string> {
    const event = await this.request(
      {
        t: 'stt.transcribe',
        id: this.takeId(),
        utteranceId: input.utteranceId,
        pcm: float32ToBase64(input.pcm),
        isFinal: input.isFinal,
        ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {})
      },
      TRANSCRIBE_TIMEOUT_MS
    )
    if (event.t !== 'stt.text') {
      throw new HuddleError('stt_failed', 'Local transcription returned no text.')
    }
    return event.text
  }

  /**
   * Streams PCM through `onChunk` and settles when synthesis reached EOF, failed,
   * or was cancelled. `cancel(generationId)` settles this promise immediately —
   * while the helper's HTTP stream is still being read — so barge-in and
   * stop-speaking never wait for synthesis to finish.
   */
  async speak(input: {
    generationId: string
    text: string
    voice: HelperVoiceSettings
    onChunk(chunk: HelperChunk): void
  }): Promise<SpeakOutcome> {
    // Chunks are routed per generation, so a cancelled generation's stream can
    // never deliver audio into a newer one.
    this.chunkHandlers.set(input.generationId, input.onChunk)
    let event: HelperEvent
    try {
      event = await this.request(
        {
          t: 'tts.speak',
          id: this.takeId(),
          generationId: input.generationId,
          text: input.text,
          voice: input.voice
        },
        SPEAK_TIMEOUT_MS,
        input.generationId
      )
    } catch (error) {
      if (error instanceof HuddleError) {
        return { state: 'failed', message: error.message, fix: error.fix }
      }
      return {
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
        fix: null
      }
    } finally {
      this.chunkHandlers.delete(input.generationId)
    }
    if (event.t === 'tts.cancelled') return { state: 'cancelled' }
    if (event.t === 'tts.ended') return { state: 'ended', chars: event.chars, bytes: event.bytes }
    if (event.t === 'error') {
      return { state: 'failed', message: event.message, fix: event.fix ?? null }
    }
    return { state: 'failed', message: 'Synthesis ended unexpectedly.', fix: null }
  }

  cancel(generationId: string, reason: string): void {
    this.chunkHandlers.delete(generationId)
    // Fire and forget: cancellation must never wait behind anything.
    try {
      this.write({ t: 'tts.cancel', id: this.takeId(), generationId, reason })
    } catch {
      // The helper is gone; there is nothing left to cancel.
    }
    for (const [id, pending] of this.pending) {
      if (pending.generationId !== generationId) continue
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.resolve({ t: 'tts.cancelled', id, generationId })
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const child = this.child
    this.child = null
    this.currentCaps = null
    this.rejectAll(new HuddleError('voice_helper_stopped', 'Voice helper is shutting down.'))
    if (!child) return
    try {
      child.stdin.write(encodeHelperRequest({ t: 'shutdown', id: this.takeId() }))
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1200)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          // ignore
        }
      }, 400)
    })
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private async start(): Promise<HelperCaps> {
    const now = this.options.now ?? (() => Date.now())
    this.restartTimes = this.restartTimes.filter((time) => now() - time < RESTART_WINDOW_MS)
    if (this.restartTimes.length >= MAX_RESTARTS_PER_WINDOW) {
      throw new HuddleError(
        'voice_helper_crashing',
        'The voice helper keeps exiting, so local speech is off.',
        'Run "node tools/voice-lab/scripts/setup.mjs" and restart Huddle.'
      )
    }

    const spawnImpl = this.options.spawnImpl ?? spawn
    const nodeBin = this.options.nodeBin ?? process.env.HUDDLE_NODE ?? 'node'
    this.currentCaps = startingCaps()
    this.options.onCaps(this.currentCaps)

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnImpl(nodeBin, [this.options.helperPath], {
        env: { ...process.env, ...(this.options.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new HuddleError(
        'voice_helper_missing',
        `Could not start the voice helper with "${nodeBin}": ${message}`,
        'Install Node.js 20 or newer, or set HUDDLE_NODE to a node binary.'
      )
    }
    this.child = child
    this.restartTimes.push(now())

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) this.options.onLog('warn', text)
    })

    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      let newline = this.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.trim()) this.handleLine(line)
        newline = this.buffer.indexOf('\n')
      }
    })

    const exited = new Promise<never>((_resolve, reject) => {
      child.once('error', (error: Error) => {
        reject(
          new HuddleError(
            'voice_helper_missing',
            `Voice helper failed to start with "${nodeBin}": ${error.message}`,
            'Install Node.js 20 or newer, or set HUDDLE_NODE to a node binary.'
          )
        )
      })
      child.once('exit', (code, signal) => {
        if (this.child === child) {
          this.child = null
          this.currentCaps = null
        }
        const failure = new HuddleError(
          'voice_helper_crashed',
          `Voice helper exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`,
          'Local speech restarts on the next call; if it keeps failing run tools/voice-lab/scripts/setup.mjs.'
        )
        this.rejectAll(failure)
        this.options.onExit({
          code: code ?? null,
          signal: signal ?? null,
          restarts: this.restartTimes.length
        })
        reject(failure)
      })
    })

    const initEvent = await Promise.race([
      this.withSilentRejection(
        this.request(
          {
            t: 'init',
            id: this.takeId(),
            config: { protocol: HELPER_PROTOCOL_VERSION, ...this.options.config }
          },
          DEFAULT_TIMEOUT_MS
        )
      ),
      exited
    ])
    if (initEvent.t === 'error') {
      throw new HuddleError('voice_helper_failed', initEvent.message, initEvent.fix)
    }
    return this.currentCaps ?? startingCaps()
  }

  private handleLine(line: string): void {
    const event = parseHelperLine(line)
    if (!event) return

    if (event.t === 'log') {
      this.options.onLog(event.level, event.text)
      return
    }
    if (event.t === 'fatal') {
      this.options.onLog('error', event.message)
      return
    }
    if (event.t === 'ready') {
      if (event.protocol !== HELPER_PROTOCOL_VERSION) {
        this.options.onLog(
          'error',
          `Voice helper protocol ${event.protocol} does not match ${HELPER_PROTOCOL_VERSION}.`
        )
      }
      return
    }
    if (event.t === 'caps') {
      this.currentCaps = event.caps
      this.options.onCaps(event.caps)
      return
    }
    if (event.t === 'tts.chunk') {
      const handler = this.chunkHandlers.get(event.generationId)
      if (handler) handler({ seq: event.seq, pcm: decodeBase64(event.pcm) })
      return
    }

    // Everything else answers a request by id.
    const id = eventId(event)
    const pending = this.pending.get(id)
    if (pending) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      if (event.t === 'error') pending.reject(new HuddleError(event.code, event.message, event.fix))
      else pending.resolve(event)
      return
    }
    if (event.t === 'error') {
      // An error for a request we already settled: report it, never swallow it.
      this.options.onLog('error', `${event.code}: ${event.message}`)
    }
  }

  private request(message: HelperRequest, timeoutMs: number, generationId?: string): Promise<HelperEvent> {
    return new Promise<HelperEvent>((resolve, reject) => {
      const id = message.id
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new HuddleError(
            'voice_helper_timeout',
            `The voice helper did not answer "${message.t}" within ${Math.round(timeoutMs / 1000)}s.`,
            'Restart the call. If it repeats, restart Huddle.'
          )
        )
      }, timeoutMs)
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        ...(generationId ? { generationId } : {})
      })
      try {
        this.write(message)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Keeps a losing `Promise.race` branch from surfacing as an unhandled rejection. */
  private withSilentRejection<T>(promise: Promise<T>): Promise<T> {
    void promise.catch(() => undefined)
    return promise
  }

  private write(request: HelperRequest): void {
    const child = this.child
    if (!child || !child.stdin.writable) {
      throw new HuddleError(
        'voice_helper_missing',
        'The voice helper is not running.',
        'Rejoin the call to restart local speech.'
      )
    }
    child.stdin.write(encodeHelperRequest(request))
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private takeId(): number {
    this.nextId += 1
    return this.nextId
  }
}

function eventId(event: HelperEvent): number {
  return 'id' in event && typeof event.id === 'number' ? event.id : -1
}

function decodeBase64(text: string): Uint8Array {
  const buffer = Buffer.from(text, 'base64')
  const copy = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return copy
}

/* ------------------------------------------------------------------ *
 * Capabilities: what the user is told about the audio stack
 * ------------------------------------------------------------------ */

/** Local VAD + local transcription, as one user-visible capability. */
export function localSpeechCapability(caps: HelperCaps | null, checkedAt: string): Capability {
  if (!caps) {
    return {
      id: 'localSpeech',
      label: 'Local speech (VAD + Whisper)',
      state: 'starting',
      detail: 'Starting the voice helper',
      fix: null,
      checkedAt
    }
  }
  const combined = combineLocal(caps.vad, caps.stt)
  return {
    id: 'localSpeech',
    label: 'Local speech (VAD + Whisper)',
    state: combined.state,
    detail: combined.detail,
    fix: combined.fix,
    checkedAt
  }
}

export function elevenLabsCapability(caps: HelperCaps | null, checkedAt: string): Capability {
  const tts = caps?.tts ?? { state: 'starting' as const, detail: 'Waiting for the voice helper', fix: null }
  return {
    id: 'elevenlabs',
    label: 'Agent voices (ElevenLabs)',
    state: tts.state,
    detail: tts.detail,
    fix: tts.fix,
    checkedAt
  }
}

function combineLocal(vad: HelperCap, stt: HelperCap): HelperCap {
  const detail = `${vad.detail}. ${stt.detail}`
  if (vad.state === 'ready' && stt.state === 'ready') {
    return { state: 'ready', detail, fix: null }
  }
  const first = vad.state === 'ready' ? stt : vad
  const state = first.state === 'ready' ? 'error' : first.state
  return { state, detail, fix: first.fix }
}
