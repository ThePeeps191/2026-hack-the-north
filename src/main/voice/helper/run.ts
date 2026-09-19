// The helper's message loop.
//
// Why a separate process at all: onnxruntime-node and the python
// faster-whisper/ctranslate2 stack are native modules that must match the Node
// ABI, and Electron's ABI is not Node's. This file runs under system Node
// (`out/main/voice-helper.js`) and speaks newline-delimited JSON on stdio.
//
// Dispatch rules (these are deliberate, see the defects list):
//  - VAD frames are processed on their own ordered chain. They are *never*
//    queued behind synthesis or transcription, so the microphone path cannot be
//    blocked by an ElevenLabs request.
//  - Transcription has its own chain (the local model runs one window at a time).
//  - Every `tts.speak` runs concurrently, keyed by generation id, and
//    `tts.cancel` aborts the HTTP stream immediately — while it is still
//    streaming — instead of waiting for it to finish.
//  - Nothing here ever writes the API key to stdout or stderr.

import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { HelperCaps, HelperEvent, HelperInitConfig, HelperRequest } from '../protocol.ts'
import { HELPER_PROTOCOL_VERSION, startingCaps } from '../protocol.ts'
import { base64ToFloat32 } from '../pcm.ts'
import { loadSileroVadSession, type SileroVadSession } from './vad-session.ts'
import { FasterWhisperWorker } from './stt.ts'
import { ElevenLabsError, ElevenLabsSynthesizer } from './synth.ts'
import type { VadInferencer } from '../vad.ts'

interface HelperState {
  config: HelperInitConfig | null
  vadSession: SileroVadSession | null
  inferencer: VadInferencer | null
  stt: FasterWhisperWorker | null
  synth: ElevenLabsSynthesizer | null
  caps: HelperCaps
  /** VAD frames: ordered, and never behind synthesis or transcription. */
  vadChain: Promise<void>
  /** The local model handles one recognition window at a time. */
  sttChain: Promise<void>
  readonly generations: Map<string, AbortController>
  shuttingDown: boolean
  apiKey: string
}

function emit(event: HelperEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

function redact(text: string, apiKey: string): string {
  if (apiKey.length >= 8 && text.includes(apiKey)) {
    return text.split(apiKey).join('[ELEVENLABS_API_KEY redacted]')
  }
  return text
}

function log(level: 'info' | 'warn' | 'error', text: string, apiKey: string): void {
  const safe = redact(text.replace(/\s+/g, ' ').trim(), apiKey)
  if (!safe) return
  emit({ t: 'log', level, text: safe.length > 600 ? `${safe.slice(0, 600)}…` : safe })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorFix(error: unknown): string | null {
  return error instanceof ElevenLabsError ? error.fix : null
}

export async function runVoiceHelper(): Promise<void> {
  const state: HelperState = {
    config: null,
    vadSession: null,
    inferencer: null,
    stt: null,
    synth: null,
    caps: startingCaps(),
    vadChain: Promise.resolve(),
    sttChain: Promise.resolve(),
    generations: new Map<string, AbortController>(),
    shuttingDown: false,
    apiKey: ''
  }

  emit({ t: 'ready', protocol: HELPER_PROTOCOL_VERSION, pid: process.pid, node: process.version })

  const shutdown = async (code: number): Promise<void> => {
    if (state.shuttingDown) return
    state.shuttingDown = true
    for (const [, controller] of state.generations) {
      try {
        controller.abort()
      } catch {
        // ignore
      }
    }
    state.generations.clear()
    try {
      await state.stt?.dispose()
    } catch {
      // ignore
    }
    process.exit(code)
  }

  process.on('SIGTERM', () => {
    void shutdown(0)
  })
  process.on('SIGINT', () => {
    void shutdown(0)
  })
  process.on('uncaughtException', (error) => {
    emit({ t: 'fatal', message: errorMessage(error) })
    void shutdown(1)
  })
  process.on('unhandledRejection', (reason) => {
    emit({ t: 'fatal', message: errorMessage(reason) })
    void shutdown(1)
  })

  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    handleLine(line)
  })
  rl.on('close', () => {
    void shutdown(0)
  })

  function handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let request: HelperRequest
    try {
      request = JSON.parse(trimmed) as HelperRequest
    } catch {
      log('warn', 'ignored malformed control line', state.apiKey)
      return
    }
    switch (request.t) {
      case 'init':
        void handleInit(request.id, request.config)
        return
      case 'shutdown':
        emit({ t: 'ack', id: request.id })
        void shutdown(0)
        return
      case 'vad.reset':
        state.vadChain = state.vadChain.then(() => {
          state.inferencer?.reset()
          emit({ t: 'ack', id: request.id })
        })
        return
      case 'vad.frame': {
        const inferencer = state.inferencer
        if (!inferencer) {
          emit({
            t: 'error',
            id: request.id,
            code: 'vad_unavailable',
            message: state.caps.vad.detail,
            ...(state.caps.vad.fix ? { fix: state.caps.vad.fix } : {})
          })
          return
        }
        const frame = base64ToFloat32(request.pcm)
        state.vadChain = state.vadChain.then(async () => {
          try {
            const p = await inferencer.infer(frame)
            emit({ t: 'vad.prob', id: request.id, p })
          } catch (error) {
            emit({ t: 'error', id: request.id, code: 'vad_failed', message: errorMessage(error) })
          }
        })
        return
      }
      case 'stt.transcribe':
        state.sttChain = state.sttChain.then(async () => {
          const stt = state.stt
          if (!stt || !stt.running) {
            emit({
              t: 'error',
              id: request.id,
              code: 'stt_unavailable',
              message: state.caps.stt.detail,
              ...(state.caps.stt.fix ? { fix: state.caps.stt.fix } : {})
            })
            return
          }
          try {
            const text = await stt.transcribeEncoded({
              pcmBase64: request.pcm,
              isFinal: request.isFinal,
              ...(request.initialPrompt ? { initialPrompt: request.initialPrompt } : {})
            })
            emit({ t: 'stt.text', id: request.id, text })
          } catch (error) {
            emit({ t: 'error', id: request.id, code: 'stt_failed', message: errorMessage(error) })
          }
        })
        return
      case 'tts.speak':
        startSynthesis(request)
        return
      case 'tts.cancel': {
        const controller = state.generations.get(request.generationId)
        if (controller) {
          state.generations.delete(request.generationId)
          try {
            controller.abort()
          } catch {
            // ignore
          }
        }
        emit({ t: 'ack', id: request.id })
        return
      }
      default:
        log('warn', 'ignored unknown control message', state.apiKey)
    }
  }

  async function handleInit(id: number, config: HelperInitConfig): Promise<void> {
    if (state.config) {
      emit({ t: 'ack', id })
      return
    }
    state.config = config
    state.apiKey = config.elevenLabsApiKey
    emit({ t: 'ack', id })
    updateCaps(state.caps)

    await Promise.all([startVad(config), startStt(config), startTts(config)])
  }

  async function startVad(config: HelperInitConfig): Promise<void> {
    if (!existsSync(config.sileroModelPath)) {
      state.caps = {
        ...state.caps,
        vad: {
          state: 'unavailable',
          detail: `Silero VAD model missing at ${config.sileroModelPath}`,
          fix: 'Run "node tools/voice-lab/scripts/setup.mjs" to download the local VAD model.'
        }
      }
      updateCaps(state.caps)
      return
    }
    try {
      const session = await loadSileroVadSession(config.sileroModelPath)
      state.vadSession = session
      state.inferencer = session.createInferencer()
      state.caps = {
        ...state.caps,
        vad: {
          state: 'ready',
          detail: `Silero VAD loaded (${session.inputNames.join(', ')})`,
          fix: null
        }
      }
    } catch (error) {
      state.caps = {
        ...state.caps,
        vad: {
          state: 'error',
          detail: `Silero VAD failed to load: ${errorMessage(error)}`,
          fix: 'Run "node tools/voice-lab/scripts/setup.mjs", then retry.'
        }
      }
    }
    updateCaps(state.caps)
  }

  async function startStt(config: HelperInitConfig): Promise<void> {
    if (!existsSync(config.workerScript)) {
      state.caps = {
        ...state.caps,
        stt: {
          state: 'unavailable',
          detail: `faster-whisper worker missing at ${config.workerScript}`,
          fix: 'Run "node tools/voice-lab/scripts/setup.mjs" inside tools/voice-lab.'
        }
      }
      updateCaps(state.caps)
      return
    }
    const worker = new FasterWhisperWorker({
      pythonBin: config.pythonBin,
      workerScript: config.workerScript,
      model: config.whisperModel,
      device: config.whisperDevice,
      computeType: config.whisperComputeType,
      cpuThreads: config.whisperCpuThreads,
      onLog: (line) => log('info', `[whisper] ${line}`, state.apiKey)
    })
    state.stt = worker
    try {
      const info = await worker.start()
      state.caps = {
        ...state.caps,
        stt: {
          state: 'ready',
          detail: `Local faster-whisper ${info.model} (${info.device}/${info.computeType}) — audio never leaves this machine`,
          fix: null
        }
      }
    } catch (error) {
      state.caps = {
        ...state.caps,
        stt: {
          state: 'error',
          detail: `Local transcription failed to start: ${errorMessage(error)}`,
          fix: 'Run "node tools/voice-lab/scripts/setup.mjs" inside tools/voice-lab, then retry.'
        }
      }
    }
    updateCaps(state.caps)
  }

  async function startTts(config: HelperInitConfig): Promise<void> {
    const synth = new ElevenLabsSynthesizer({
      apiKey: config.elevenLabsApiKey,
      modelId: config.elevenLabsModel,
      outputFormat: 'pcm_24000'
    })
    state.synth = synth
    if (!synth.hasKey) {
      state.caps = {
        ...state.caps,
        tts: {
          state: 'unavailable',
          detail: 'No ELEVENLABS_API_KEY, so agents cannot speak',
          fix: 'Add ELEVENLABS_API_KEY in Huddle settings. Typed chat keeps working.'
        }
      }
      updateCaps(state.caps)
      return
    }
    try {
      const response = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': config.elevenLabsApiKey }
      })
      if (!response.ok) {
        state.caps = {
          ...state.caps,
          tts: {
            state: 'error',
            detail: `ElevenLabs rejected the key (${response.status} ${response.statusText})`,
            fix: response.status === 401 ? 'Replace ELEVENLABS_API_KEY in Settings.' : 'Retry in a moment.'
          }
        }
      } else {
        const body = (await response.json()) as { tier?: unknown; character_count?: unknown; character_limit?: unknown }
        const tier = typeof body.tier === 'string' ? body.tier : 'account'
        const used = typeof body.character_count === 'number' ? body.character_count : null
        const limit = typeof body.character_limit === 'number' ? body.character_limit : null
        state.caps = {
          ...state.caps,
          tts: {
            state: 'ready',
            detail:
              used !== null && limit !== null
                ? `ElevenLabs ${tier} reachable (${used}/${limit} characters used)`
                : `ElevenLabs ${tier} reachable`,
            fix: null
          }
        }
      }
    } catch (error) {
      state.caps = {
        ...state.caps,
        tts: {
          state: 'error',
          detail: `Could not reach ElevenLabs: ${errorMessage(error)}`,
          fix: 'Check the network connection, then retry.'
        }
      }
    }
    updateCaps(state.caps)
  }

  function startSynthesis(request: Extract<HelperRequest, { t: 'tts.speak' }>): void {
    const synth = state.synth
    if (!synth) {
      emit({
        t: 'error',
        id: request.id,
        code: 'tts_unavailable',
        message: 'Voice helper is still starting.',
        fix: 'Wait for the voice helper, then retry.'
      })
      return
    }
    const controller = new AbortController()
    state.generations.set(request.generationId, controller)
    let seq = 0
    void (async () => {
      try {
        const result = await synth.speak({
          text: request.text,
          voice: request.voice,
          signal: controller.signal,
          onChunk: (chunk) => {
            seq += 1
            emit({
              t: 'tts.chunk',
              generationId: request.generationId,
              seq,
              pcm: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64')
            })
          }
        })
        if (controller.signal.aborted) {
          emit({ t: 'tts.cancelled', id: request.id, generationId: request.generationId })
          return
        }
        emit({
          t: 'tts.ended',
          id: request.id,
          generationId: request.generationId,
          chars: result.chars,
          bytes: result.bytes
        })
      } catch (error) {
        if (controller.signal.aborted) {
          emit({ t: 'tts.cancelled', id: request.id, generationId: request.generationId })
          return
        }
        const fix = errorFix(error)
        emit({
          t: 'error',
          id: request.id,
          code: 'tts_failed',
          message: errorMessage(error),
          ...(fix ? { fix } : {})
        })
      } finally {
        if (state.generations.get(request.generationId) === controller) {
          state.generations.delete(request.generationId)
        }
      }
    })()
  }

  function updateCaps(caps: HelperCaps): void {
    emit({ t: 'caps', caps })
  }
}
