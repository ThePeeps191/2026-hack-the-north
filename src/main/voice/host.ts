// The voice host: local capture -> local transcription -> ElevenLabs playback,
// with the room floor in the middle.
//
// This is the Electron main-process implementation of `VoiceHost` from
// ../contracts.ts. It is a port of tools/voice-lab/src/server/session.ts (the
// per-session audio policy) plus the lab's `src/modules` pieces, split so each
// concern is testable on its own:
//
//   vadsession       vad.ts            Silero frame counters + barge-in policy
//   segmenter/queue  transcribe.ts     utterance windowing, exactly one final
//   scheduler        floor.ts          one speaker, priority, no backlog
//   measurements     timings.ts        endpointing vs dispatch vs audible
//   voice catalogue  voices.ts         agent voice settings
//   process          helper-client.ts  supervised standalone helper
//
// Defects fixed here (each covered by a test in this directory):
//   1. microphone frames and control are never serialised behind synthesis
//   2. stopSpeaking / barge-in settle while synthesis is still streaming
//   3. completion = synthesis EOF *and* playback drained
//   4. chunks from a cancelled generation never restart playback
//   5. VAD counters and ONNX recurrent state are reset between sessions
//   6. long utterances are segmented, never dropped, capture never stops
//   7. partials never become messages; exactly one final per utterance
//   8. dispatch / receipt / endpointing / audible timings are distinguished
//   9. local VAD interrupts audio, before any transcript exists
//  10. mute forwards nothing but cancels nothing; deafen drops without backlog
//
// No parameter properties / enums: loaded by `node --experimental-strip-types --test`.

import type { SpeechHandle, SpeechIntent, VoiceHost, VoiceHostDeps } from '../contracts.ts'
import type {
  AppSettings,
  Capability,
  LiveTranscript,
  Message,
  SpokenState
} from '../../shared/types.ts'
import type {
  AudioChunkMessage,
  HaltReason,
  PlaybackClientEvent,
  PlaybackServerEvent
} from '../../shared/voice.ts'
import {
  CAPTURE_SAMPLE_RATE,
  MAX_SEGMENT_SAMPLES,
  MIN_FINAL_SAMPLES,
  MIN_PARTIAL_SAMPLES,
  PARTIAL_INTERVAL_MS,
  PLAYBACK_SAMPLE_RATE,
  PREROLL_FRAMES,
  VAD_FRAME_SAMPLES
} from '../../shared/voice.ts'
import { appRoot, speechAssets, voiceHelperPath } from '../paths.ts'
import { getSecret } from '../config/secrets.ts'
import { HuddleError } from '../huddle-error.ts'
import { BargeInPolicy, VoiceActivityDetector, type VadInferencer } from './vad.ts'
import { TranscribeQueue, UtteranceSegmenter, type UtteranceSegment } from './transcribe.ts'
import { SpeechFloor, type FloorHooks, type SpeechFloorItem, type SpeechResult } from './floor.ts'
import { VoiceTimings } from './timings.ts'
import {
  VoiceHelperClient,
  elevenLabsCapability,
  localSpeechCapability,
  type HelperCaps,
  type SpeakOutcome,
  type VoiceHelperPort
} from './helper-client.ts'
import { PREVIEW_TEXT, agentVoiceSettings, listVoices, previewVoiceSettings } from './voices.ts'
import type { ListVoicesResult } from './voices.ts'
import { pcm16ToFloat32, rmsLevel, samplesToMs, bytesToArrayBuffer } from './pcm.ts'
import type { HelperVoiceSettings } from './protocol.ts'
import { existsSync } from 'node:fs'

const ELEVENLABS_MODEL = 'eleven_flash_v2_5'
const WHISPER_DEVICE = 'cpu'
const WHISPER_COMPUTE_TYPE = 'int8'
const WHISPER_CPU_THREADS = '2'
/** How long playback may take after synthesis EOF before we call it a failure. */
const DRAIN_WATCHDOG_MS = 120_000
/** Speech is dropped if it is still queued this long after being requested. */
const QUEUE_STALE_MS = 30_000
/** Turn length: long text is spoken as bounded parts instead of one monologue. */
const PART_MAX_CHARS = 320
const MAX_PARTS = 4
const MAX_PENDING_FINALS = 8
const AGENT_PREVIEW_ID = 'voice-preview'

interface SpeechPartRecord {
  item: SpeechFloorItem | null
  agentId: string
  roomId: string
  generationId: string
  text: string
  startedAt: number
  streamedBytes: number
  watchdog: NodeJS.Timeout | null
}

interface PendingFinal {
  roomId: string
  utteranceId: string
  text: string
  startedAt: number
  endedAt: number
}

export interface VoiceHostInternals {
  /** Injectable for tests: anything implementing VoiceHelperPort. */
  helper?: VoiceHelperPort
  now?: () => number
  /** Reads the ElevenLabs key. Tests inject a stub so no secret is read. */
  elevenLabsKey?: () => string
  assets?: () => {
    helperPath: string
    pythonBin: string
    workerScript: string
    sileroModelPath: string
    appRoot: string
  }
  listVoicesImpl?: (input: { apiKey: string }) => Promise<ListVoicesResult>
  fileExists?: (path: string) => boolean
}

export interface VoiceHostHandle extends VoiceHost {
  /** Test hook: drains microphone frames and the transcription queue. */
  flush(): Promise<void>
  /** Test hook: the scheduler, so tests can assert floor decisions. */
  floor(): SpeechFloor
}

export function createVoiceHostWith(deps: VoiceHostDeps, internals: VoiceHostInternals): VoiceHostHandle {
  const now = internals.now ?? (() => Date.now())
  const keyOf = internals.elevenLabsKey ?? (() => getSecret('ELEVENLABS_API_KEY'))
  const fileExists = internals.fileExists ?? ((path: string) => existsSync(path))
  const assetsOf =
    internals.assets ??
    (() => {
      const speech = speechAssets()
      return {
        helperPath: voiceHelperPath(),
        pythonBin: speech.pythonBin,
        workerScript: speech.workerScript,
        sileroModelPath: speech.sileroModelPath,
        appRoot: appRoot()
      }
    })
  const voiceList = internals.listVoicesImpl ?? ((input: { apiKey: string }) => listVoices(input))

  const timings = new VoiceTimings((samples) => deps.bus.recordTimings(samples), now)

  let activeRoomId: string | null = null
  let micMuted = false
  let disposed = false
  let generationSeq = 0
  let utteranceSeq = 0
  let lastLevelEmit = 0
  let vad: VoiceActivityDetector | null = null
  let segmenter: UtteranceSegmenter | null = null
  let transcribeQueue: TranscribeQueue | null = null
  let bargeIn: BargeInPolicy | null = null
  /**
   * Timestamp of the frame currently being processed, in the renderer's capture
   * clock. VAD events fire *during* a frame, and the segmenter's own cadence
   * (preroll, partial interval, segmentation) is measured in this clock — mixing
   * it with the wall clock made partials fire from silence and segmentation drift.
   */
  let currentFrameAt: number | null = null
  let helper: VoiceHelperPort | null = internals.helper ?? null
  let helperCaps: HelperCaps | null = null
  let ownedHelper = internals.helper === undefined
  let lastUtteranceId: string | null = null
  const knownQueued: string[] = []
  const speechParts = new Map<string, SpeechPartRecord>()
  const voiceOverrides = new Map<string, HelperVoiceSettings>()
  const dispatchedFinals = new Set<string>()
  const pendingFinals: PendingFinal[] = []
  const frameQueue: Array<{ pcm: Float32Array; at: number }> = []
  let draining = false
  let sinkRetryTimer: NodeJS.Timeout | null = null
  let boundaryPollTimer: NodeJS.Timeout | null = null

  /* ---------------------------------------------------------------- *
   * Floor
   * ---------------------------------------------------------------- */

  const hooks: FloorHooks = {
    now,
    beginPart: (item, generationId, text) => {
      startPart(item, generationId, text)
    },
    haltPart: (item, generationId, reason) => {
      haltPart(item, generationId, reason)
    },
    complete: (item, result) => {
      finishItem(item, result)
    },
    drop: (item, result, detail) => {
      finishItem(item, result, detail)
    },
    queueChanged: (agentIds) => {
      reportQueue(agentIds)
    }
  }

  const floor = new SpeechFloor({
    now,
    hooks,
    nextGenerationId: () => `gen-${(generationSeq += 1)}`,
    staleAfterMs: QUEUE_STALE_MS,
    partMaxChars: PART_MAX_CHARS,
    maxParts: MAX_PARTS
  })

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  function room(): string {
    return activeRoomId ?? ''
  }

  function notify(level: 'info' | 'warn' | 'error', text: string, fix?: string): void {
    try {
      if (fix) deps.bus.notice(room(), level, text, fix)
      else deps.bus.notice(room(), level, text)
    } catch {
      // A broken bus must never break audio.
    }
  }

  function emitCapabilities(caps: HelperCaps | null): void {
    const checkedAt = new Date(now()).toISOString()
    try {
      deps.bus.emit(room(), {
        type: 'capability.updated',
        capability: localSpeechCapability(caps, checkedAt)
      })
      deps.bus.emit(room(), {
        type: 'capability.updated',
        capability: elevenLabsCapability(caps, checkedAt)
      })
    } catch {
      // ignore
    }
  }

  function emitCapability(capability: Capability): void {
    try {
      deps.bus.emit(room(), { type: 'capability.updated', capability })
    } catch {
      // ignore
    }
  }

  function send(event: PlaybackServerEvent): void {
    try {
      deps.sendServerEvent(event)
    } catch {
      // The renderer may be gone; playback truth will not arrive.
    }
  }

  function requireHelper(): VoiceHelperPort {
    if (!helper) {
      throw new HuddleError(
        'voice_helper_missing',
        'The voice helper is not running.',
        'Rejoin the call to restart local speech.'
      )
    }
    return helper
  }

  function createInferencer(): VadInferencer {
    return {
      infer: (frame: Float32Array) => requireHelper().frame(frame),
      reset: () => {
        const current = helper
        if (!current) return
        void current.resetVad().catch(() => undefined)
      }
    }
  }

  function gapMsFromSettings(settings: AppSettings): number {
    const silence = settings.voice.endpointSilenceMs
    const perFrame = samplesToMs(VAD_FRAME_SAMPLES, CAPTURE_SAMPLE_RATE)
    return Math.max(4, Math.round(silence / Math.max(1, perFrame)))
  }

  /* ---------------------------------------------------------------- *
   * Public surface
   * ---------------------------------------------------------------- */

  async function start(roomId: string): Promise<void> {
    const settings = deps.settings()
    if (!settings.voice.enabled) {
      throw new HuddleError(
        'voice_disabled',
        'Voice is turned off in settings.',
        'Turn mic and agent voices on in Settings, then rejoin the call.'
      )
    }
    if (activeRoomId === roomId) return
    if (activeRoomId !== null) await stop()

    activeRoomId = roomId
    micMuted = false
    floor.setActiveRoom(roomId)
    startBoundaryPoll()

    await ensureHelper(settings)

    if (helper) {
      vad = new VoiceActivityDetector({
        frameSamples: VAD_FRAME_SAMPLES,
        minSpeechFrames: 3,
        minSilenceFrames: gapMsFromSettings(settings),
        positiveThreshold: 0.5,
        negativeThreshold: 0.35,
        infer: createInferencer()
      })
      bargeIn = new BargeInPolicy({
        minSpeechMs: 160,
        bargeInThreshold: settings.voice.bargeInThreshold,
        frameMs: samplesToMs(VAD_FRAME_SAMPLES, CAPTURE_SAMPLE_RATE)
      })
      bindVad(vad)
      segmenter = new UtteranceSegmenter({
        roomId,
        now,
        maxSegmentSamples: MAX_SEGMENT_SAMPLES,
        minFinalSamples: MIN_FINAL_SAMPLES,
        minPartialSamples: MIN_PARTIAL_SAMPLES,
        partialIntervalMs: PARTIAL_INTERVAL_MS,
        prerollFrames: PREROLL_FRAMES,
        nextUtteranceId: () => `utt-${(utteranceSeq += 1)}`,
        onFinal: (segment) => queueTranscription(segment),
        onPartial: (segment) => queueTranscription(segment)
      })
      transcribeQueue = new TranscribeQueue((job) =>
        requireHelper().transcribe({
          utteranceId: job.utteranceId,
          pcm: job.pcm,
          isFinal: job.isFinal,
          ...(job.initialPrompt ? { initialPrompt: job.initialPrompt } : {})
        })
      )
      // Defect 5: a fresh session must not inherit the previous one's VAD state.
      vad.reset()
    }
  }

  async function stop(): Promise<void> {
    const leaving = activeRoomId
    activeRoomId = null
    stopBoundaryPoll()
    floor.setActiveRoom(null)
    if (segmenter && leaving) {
      const at = now()
      segmenter.flush(at)
      if (leaving) deps.sink()?.onHumanSpeechEnd(leaving)
    }
    segmenter = null
    transcribeQueue?.clear()
    transcribeQueue = null
    if (vad) {
      vad.reset()
      vad = null
    }
    bargeIn = null
    const current = helper
    if (current) {
      try {
        await current.resetVad()
      } catch {
        // Helper gone: nothing to reset.
      }
    }
    frameQueue.length = 0
    micMuted = false
    floor.setDeafened(false)
    for (const [, record] of speechParts) {
      if (record.watchdog) clearTimeout(record.watchdog)
    }
    speechParts.clear()
  }

  function pushMicFrame(pcm: ArrayBuffer, capturedAt: number): void {
    if (!activeRoomId) return
    if (micMuted) return // Defect 10: nothing is forwarded, nothing is cancelled.
    const frame = pcm16ToFloat32(new Uint8Array(pcm))
    if (frame.length === 0) return
    const at = capturedAt > 0 ? capturedAt : now()
    const level = rmsLevel(frame)
    if (at - lastLevelEmit >= 50) {
      lastLevelEmit = at
      try {
        deps.bus.emit(requireRoom(), { type: 'voice.level', level: Math.min(1, level * 4) })
      } catch {
        // ignore
      }
    }
    frameQueue.push({ pcm: frame, at })
    void drainFrames()
  }

  function requireRoom(): string {
    if (!activeRoomId) throw new HuddleError('voice_inactive', 'No active call.')
    return activeRoomId
  }

  function reportClientEvent(event: PlaybackClientEvent): void {
    flushPendingFinals()
    switch (event.type) {
      case 'playback.firstAudible': {
        if (!floor.onFirstAudible(event.generationId)) return
        const item = floor.currentItem()
        if (!item) return
        timings.markFirstAudible(now(), event.generationId)
        try {
          deps.bus.setAgentSpeech(item.intent.agentId, 'speaking')
        } catch {
          // ignore
        }
        emitPlayback(item, event.generationId, 'playing')
        updateSpoken(item, event.generationId, 'speaking', null)
        return
      }
      case 'playback.drained': {
        // Defect 3: the floor only completes when EOF was seen as well.
        floor.onPlaybackDrained(event.generationId)
        return
      }
      case 'playback.halted': {
        const item = floor.currentItem()
        if (item && item.generationId === event.generationId) {
          const record = speechParts.get(event.generationId)
          const totalMs = record ? samplesToMs(record.streamedBytes / 2, PLAYBACK_SAMPLE_RATE) : 0
          if (totalMs > 0) item.playedFraction = Math.max(0, Math.min(1, event.playedMs / totalMs))
          timings.markPlaybackHalted(now(), event.reason)
          emitPlayback(
            item,
            event.generationId,
            event.reason === 'stopSpeaking' ? 'cancelled' : 'interrupted'
          )
        }
        floor.onPlaybackHalted(event.generationId, event.reason)
        return
      }
      case 'playback.error': {
        notify('warn', `Audio output failed: ${event.message}`)
        floor.onPlaybackError(event.generationId)
        return
      }
      default:
        return
    }
  }

  function speak(intent: SpeechIntent): SpeechHandle {
    if (!deps.settings().voice.enabled) {
      return { generationId: '', done: Promise.resolve({ state: 'unheard', playedChars: null }) }
    }
    const { handle } = floor.enqueue(intent)
    return { generationId: handle.generationId, done: handle.done }
  }

  function stopSpeaking(roomId: string, scope: 'current' | 'all', reason: HaltReason): void {
    if (activeRoomId !== null && roomId !== activeRoomId) return
    floor.stopSpeaking(reason, scope)
  }

  function invalidateSpeechBefore(roomId: string, decisionRevision: number): void {
    floor.invalidateSpeechBefore(roomId, decisionRevision)
  }

  async function listVoiceOptions() {
    const result = await voiceList({ apiKey: keyOf() })
    if (!result.verified) {
      notify('warn', `Voice list: ${result.detail}`, 'Add ELEVENLABS_API_KEY in Settings.')
    }
    return result.voices
  }

  async function previewVoice(voiceId: string): Promise<void> {
    if (!voiceId.trim()) {
      throw new HuddleError('voice_missing', 'Pick a voice to preview.')
    }
    voiceOverrides.set(AGENT_PREVIEW_ID, previewVoiceSettings(voiceId))
    const roomId = activeRoomId
    if (!roomId) {
      // Settings-only preview: no room, so the floor (correctly) refuses.
      const generationId = `gen-${(generationSeq += 1)}`
      startDirectPreview(generationId, voiceId)
      return
    }
    floor.stopSpeaking('stopSpeaking', 'current')
    floor.enqueue({
      id: `preview-${voiceId}-${now()}`,
      roomId,
      agentId: AGENT_PREVIEW_ID,
      text: PREVIEW_TEXT,
      reason: 'ack',
      decisionRevision: 0,
      messageId: null,
      expiresAt: now() + 60_000
    })
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    await stop()
    if (sinkRetryTimer) clearTimeout(sinkRetryTimer)
    sinkRetryTimer = null
    voiceOverrides.clear()
    dispatchedFinals.clear()
    if (ownedHelper && helper) {
      await helper.dispose().catch(() => undefined)
    }
    helper = null
    ownedHelper = false
  }

  /* ---------------------------------------------------------------- *
   * Helper lifecycle
   * ---------------------------------------------------------------- */

  async function ensureHelper(settings: AppSettings): Promise<void> {
    const assets = assetsOf()
    if (!fileExists(assets.helperPath)) {
      emitCapability(localSpeechUnavailable(
        `Voice helper bundle missing at ${assets.helperPath}`,
        'Run "npm run build" so out/main/voice-helper.js exists.'
      ))
      emitCapability(agentVoicesUnavailable('Agent voices need the voice helper.', 'Run "npm run build".'))
      notify('warn', 'Voice helper is not built yet, so the call has no audio.', 'Run "npm run build".')
      return
    }
    if (!fileExists(assets.sileroModelPath)) {
      emitCapability(localSpeechUnavailable(
        `Silero VAD model missing at ${assets.sileroModelPath}`,
        'Run "node tools/voice-lab/scripts/setup.mjs" to download it.'
      ))
    }
    if (!fileExists(assets.workerScript)) {
      emitCapability(localSpeechUnavailable(
        `Local Whisper worker missing at ${assets.workerScript}`,
        'Restore tools/voice-lab/python/transcribe_worker.py.'
      ))
    }
    if (!keyOf().trim()) {
      emitCapability(agentVoicesUnavailable(
        'No ELEVENLABS_API_KEY, so agents cannot speak aloud.',
        'Add ELEVENLABS_API_KEY in Settings. Typed chat keeps working.',
        'unavailable'
      ))
    }

    if (!helper) {
      helper = new VoiceHelperClient({
        helperPath: assets.helperPath,
        env: { HUDDLE_APP_ROOT: assets.appRoot },
        config: {
          appRoot: assets.appRoot,
          pythonBin: assets.pythonBin,
          workerScript: assets.workerScript,
          sileroModelPath: assets.sileroModelPath,
          whisperModel: settings.voice.whisperModel,
          whisperDevice: WHISPER_DEVICE,
          whisperComputeType: WHISPER_COMPUTE_TYPE,
          whisperCpuThreads: WHISPER_CPU_THREADS,
          elevenLabsApiKey: keyOf(),
          elevenLabsModel: ELEVENLABS_MODEL,
          vadSampleRate: CAPTURE_SAMPLE_RATE,
          saveRawAudio: settings.voice.saveRawAudio
        },
        onCaps: (caps) => {
          helperCaps = caps
          emitCapabilities(caps)
        },
        onLog: (level, text) => {
          if (level === 'info') return
          notify('warn', `Voice helper: ${text}`)
        },
        onExit: (info) => {
          emitCapability(localSpeechUnavailable(
            `Voice helper exited (code=${info.code ?? 'null'}).`,
            'Rejoin the call to restart local speech.'
          ))
          emitCapability(agentVoicesUnavailable(
            `Voice helper exited (code=${info.code ?? 'null'}).`,
            'Rejoin the call to restart agent voices.'
          ))
          notify('error', 'Local speech stopped: the voice helper exited.', 'Rejoin the call to restart it.')
        },
        now
      })
    }

    try {
      helperCaps = await helper.ensureStarted()
      emitCapabilities(helperCaps)
    } catch (error) {
      const shape = toShape(error)
      emitCapability(localSpeechUnavailable(shape.message, shape.fix))
      emitCapability(agentVoicesUnavailable(shape.message, shape.fix))
      notify('error', `Voice is unavailable: ${shape.message}`, shape.fix ?? undefined)
    }
  }

  /* ---------------------------------------------------------------- *
   * Capture -> VAD -> segmenter
   * ---------------------------------------------------------------- */

  function bindVad(detector: VoiceActivityDetector): void {
    detector.on('speech-start', (probability) => {
      const roomId = activeRoomId
      if (!roomId) return
      const at = now()
      timings.markVadSpeechStart(at)
      segmenter?.begin(currentFrameAt ?? at)
      try {
        deps.bus.emit(roomId, { type: 'voice.vad', speaking: true, probability })
      } catch {
        // ignore
      }
      deps.sink()?.onHumanSpeechStart(roomId)
      // Defect 9: local audio wins the floor immediately, before any transcript.
      floor.humanSpeechStart()
    })

    detector.on('speech-end', (probability) => {
      endUtterance(currentFrameAt ?? now(), probability)
    })
  }

  /**
   * VAD speech end. `at` is in the capture clock (what the segmenter measures
   * in); timing labels that a human reads are reported in the wall clock.
   */
  function endUtterance(at: number, probability?: number): void {
    const roomId = activeRoomId
    if (!roomId) return
    const ended = segmenter?.end(at) ?? null
    if (ended) timings.markUtteranceEnd(ended.utteranceId, now())
    floor.humanSpeechEnd()
    if (probability !== undefined) {
      try {
        deps.bus.emit(roomId, { type: 'voice.vad', speaking: false, probability })
      } catch {
        // ignore
      }
    }
    deps.sink()?.onHumanSpeechEnd(roomId)
  }

  async function drainFrames(): Promise<void> {
    if (draining) return
    draining = true
    try {
      while (frameQueue.length > 0) {
        const next = frameQueue.shift()
        if (!next) break
        await processFrame(next.pcm, next.at)
      }
    } finally {
      draining = false
    }
  }

  async function processFrame(pcm: Float32Array, at: number): Promise<void> {
    const detector = vad
    if (!detector || !activeRoomId) return
    // VAD events fire inside this call, so the frame clock is published first.
    currentFrameAt = at

    let probability: number | null = null
    try {
      probability = await detector.push(pcm)
    } catch (error) {
      const shape = toShape(error)
      emitCapability(localSpeechUnavailable(shape.message, shape.fix))
      notify('error', `Local speech failed: ${shape.message}`, shape.fix ?? undefined)
      vad = null
      return
    }

    segmenter?.pushFrame(pcm, at)
    // Keep segmentation in step with VAD even if a start event was missed.
    if (detector.speaking && segmenter && !segmenter.inUtterance) segmenter.begin(at)

    if (probability === null || !bargeIn) return

    if (floor.isSpeaking() && bargeIn.observe({ probability, playbackActive: true })) {
      // The human is talking over an agent: stop the audio now, transcribe later.
      timings.markVadSpeechStart(at)
      floor.humanSpeechStart()
    }
  }

  /* ---------------------------------------------------------------- *
   * Transcription
   * ---------------------------------------------------------------- */

  function queueTranscription(segment: UtteranceSegment): void {
    const queue = transcribeQueue
    if (!queue || !activeRoomId) return
    void queue
      .enqueue({
        utteranceId: segment.utteranceId,
        pcm: segment.pcm,
        isFinal: segment.isFinal,
        ...(segment.initialPrompt ? { initialPrompt: segment.initialPrompt } : {})
      })
      .then((text) => {
        handleTranscript(segment, text)
      })
      .catch((error: unknown) => {
        const shape = toShape(error)
        emitCapability(localSpeechUnavailable(shape.message, shape.fix))
        notify('warn', `Transcription failed: ${shape.message}`, shape.fix ?? undefined)
      })
  }

  function handleTranscript(segment: UtteranceSegment, text: string | null): void {
    const roomId = segment.roomId
    if (!activeRoomId || activeRoomId !== roomId) return
    const trimmed = (text ?? '').trim()
    if (!trimmed) return
    const at = now()
    const transcript: LiveTranscript = {
      utteranceId: segment.utteranceId,
      roomId,
      text: trimmed,
      isFinal: segment.isFinal,
      updatedAt: new Date(at).toISOString()
    }
    try {
      deps.bus.emit(roomId, { type: 'voice.transcript', transcript })
    } catch {
      // ignore
    }

    if (!segment.isFinal) {
      // Defect 7: a partial is live text only — never a message.
      deps.sink()?.onPartialUtterance({ roomId, utteranceId: segment.utteranceId, text: trimmed })
      return
    }

    if (dispatchedFinals.has(segment.utteranceId)) return
    dispatchedFinals.add(segment.utteranceId)
    if (dispatchedFinals.size > 200) {
      const oldest = dispatchedFinals.values().next()
      if (!oldest.done) dispatchedFinals.delete(oldest.value)
    }
    timings.markFinalTranscript(segment.utteranceId, at)
    segmenter?.noteFinalText(trimmed)
    lastUtteranceId = segment.utteranceId

    const payload: PendingFinal = {
      roomId,
      utteranceId: segment.utteranceId,
      text: trimmed,
      startedAt: Math.round(segment.startedAt),
      endedAt: Math.round(segment.endedAt ?? at)
    }
    const sink = deps.sink()
    if (!sink) {
      pendingFinals.push(payload)
      while (pendingFinals.length > MAX_PENDING_FINALS) pendingFinals.shift()
      scheduleSinkRetry()
      return
    }
    try {
      sink.onFinalUtterance(payload)
    } catch (error) {
      notify('warn', `Could not deliver the transcript to the room: ${toShape(error).message}`)
    }
  }

  function flushPendingFinals(): void {
    if (pendingFinals.length === 0) return
    const sink = deps.sink()
    if (!sink) return
    const items = pendingFinals.splice(0, pendingFinals.length)
    for (const item of items) {
      try {
        sink.onFinalUtterance(item)
      } catch {
        // ignore
      }
    }
  }

  function scheduleSinkRetry(): void {
    if (sinkRetryTimer) return
    sinkRetryTimer = setTimeout(() => {
      sinkRetryTimer = null
      flushPendingFinals()
      if (pendingFinals.length > 0) scheduleSinkRetry()
    }, 250)
    sinkRetryTimer.unref?.()
  }

  /** While the runtime has not attached its sink, transcripts are held briefly. */
  function startBoundaryPoll(): void {
    if (boundaryPollTimer) return
    boundaryPollTimer = setInterval(() => {
      flushPendingFinals()
    }, 500)
    boundaryPollTimer.unref?.()
  }

  function stopBoundaryPoll(): void {
    if (!boundaryPollTimer) return
    clearInterval(boundaryPollTimer)
    boundaryPollTimer = null
  }

  /* ---------------------------------------------------------------- *
   * Speech
   * ---------------------------------------------------------------- */

  function resolveVoice(agentId: string): HelperVoiceSettings | null {
    const override = voiceOverrides.get(agentId)
    if (override) return override
    const agent = deps.bus.getAgent(agentId)
    if (!agent) return null
    return agentVoiceSettings(agent)
  }

  function startPart(item: SpeechFloorItem, generationId: string, text: string): void {
    const agentId = item.intent.agentId
    const record: SpeechPartRecord = {
      item,
      agentId,
      roomId: item.intent.roomId,
      generationId,
      text,
      startedAt: now(),
      streamedBytes: 0,
      watchdog: null
    }
    speechParts.set(generationId, record)
    try {
      deps.bus.setAgentSpeech(agentId, 'queued')
    } catch {
      // ignore
    }
    send({
      type: 'speech.begin',
      generationId,
      agentId,
      roomId: item.intent.roomId,
      messageId: item.intent.messageId,
      text,
      sampleRate: PLAYBACK_SAMPLE_RATE
    })
    emitPlayback(item, generationId, 'starting')
    const voice = resolveVoice(agentId)
    if (!voice) {
      send({
        type: 'speech.error',
        generationId,
        message: `No voice is configured for agent ${agentId}.`,
        fix: 'Pick a voice for this agent in Settings.'
      })
      notify('warn', `No voice configured for ${agentId}.`, 'Pick a voice for this agent in Settings.')
      floor.onSynthesisFailed(generationId)
      return
    }
    timings.markSpeechDispatched(lastUtteranceId, now())
    void runSynthesis(item, generationId, text, voice)
  }

  async function runSynthesis(
    item: SpeechFloorItem,
    generationId: string,
    text: string,
    voice: HelperVoiceSettings
  ): Promise<void> {
    const current = helper
    if (!current) {
      send({
        type: 'speech.error',
        generationId,
        message: 'The voice helper is not running.',
        fix: 'Rejoin the call to restart local speech.'
      })
      floor.onSynthesisFailed(generationId)
      return
    }

    let outcome: SpeakOutcome
    try {
      outcome = await current.speak({
        generationId,
        text,
        voice,
        onChunk: (chunk) => {
          onSynthChunk(generationId, chunk.seq, chunk.pcm)
        }
      })
    } catch (error) {
      outcome = { state: 'failed' as const, message: toShape(error).message, fix: toShape(error).fix }
    }

    if (outcome.state === 'cancelled') {
      // Defect 2: the floor already settled this speech when it cancelled it, and
      // nothing here restarts audio for a generation that is no longer current.
      return
    }
    if (outcome.state === 'failed') {
      emitCapability(agentVoicesUnavailable(outcome.message, outcome.fix))
      notify('warn', `Agent speech failed: ${outcome.message}`, outcome.fix ?? undefined)
      send({
        type: 'speech.error',
        generationId,
        message: outcome.message,
        ...(outcome.fix ? { fix: outcome.fix } : {})
      })
      floor.onSynthesisFailed(generationId)
      return
    }

    if (outcome.bytes === 0) {
      const message = 'ElevenLabs returned no audio for that line.'
      notify('warn', message, 'Try again, or pick a different voice in Settings.')
      send({ type: 'speech.error', generationId, message })
      floor.onSynthesisFailed(generationId)
      return
    }

    if (helperCaps) {
      // A successful synthesis clears a previous voice error state.
      helperCaps = {
        ...helperCaps,
        tts: { state: 'ready', detail: 'ElevenLabs streaming PCM (24 kHz)', fix: null }
      }
      emitCapabilities(helperCaps)
    }
    send({ type: 'speech.synthesisEnded', generationId, totalChars: outcome.chars })
    if (!floor.onSynthesisEnded(generationId)) return

    // Defect 3: draining may already have happened (a short line plays out while
    // the stream is still closing); completion still requires both sides.
    const part = speechParts.get(generationId)
    if (part) {
      part.watchdog = setTimeout(() => {
        const still = speechParts.get(generationId)
        if (!still) return
        notify('warn', 'Agent audio did not finish playing back.', 'Check the system output device.')
        floor.onPlaybackError(generationId)
      }, DRAIN_WATCHDOG_MS)
      part.watchdog.unref?.()
    }
  }

  function startDirectPreview(generationId: string, voiceId: string): void {
    const text = PREVIEW_TEXT
    const record: SpeechPartRecord = {
      item: null,
      agentId: AGENT_PREVIEW_ID,
      roomId: room(),
      generationId,
      text,
      startedAt: now(),
      streamedBytes: 0,
      watchdog: null
    }
    speechParts.set(generationId, record)
    send({
      type: 'speech.begin',
      generationId,
      agentId: AGENT_PREVIEW_ID,
      roomId: room(),
      messageId: null,
      text,
      sampleRate: PLAYBACK_SAMPLE_RATE
    })
    const current = helper
    if (!current) {
      send({
        type: 'speech.error',
        generationId,
        message: 'The voice helper is not running.',
        fix: 'Rejoin the call to restart local speech.'
      })
      speechParts.delete(generationId)
      return
    }
    void current
      .speak({
        generationId,
        text,
        voice: previewVoiceSettings(voiceId),
        onChunk: (chunk) => {
          onSynthChunk(generationId, chunk.seq, chunk.pcm)
        }
      })
      .then((outcome) => {
        if (outcome.state === 'ended') {
          send({ type: 'speech.synthesisEnded', generationId, totalChars: outcome.chars })
          return
        }
        if (outcome.state === 'failed') {
          send({ type: 'speech.error', generationId, message: outcome.message, ...(outcome.fix ? { fix: outcome.fix } : {}) })
        }
      })
      .catch(() => undefined)
  }

  function onSynthChunk(generationId: string, seq: number, pcm: Uint8Array): void {
    const record = speechParts.get(generationId)
    if (!record) return // Defect 4: cancelled or unknown generation, dropped here and in the renderer.
    const item = floor.currentItem()
    if (record.item && (!item || item.generationId !== generationId)) return
    record.streamedBytes += pcm.byteLength
    const chunk: AudioChunkMessage = { generationId, pcm: bytesToArrayBuffer(pcm), seq }
    try {
      deps.sendAudioChunk(chunk)
    } catch {
      // ignore
    }
  }

  function haltPart(item: SpeechFloorItem, generationId: string, reason: HaltReason): void {
    const record = speechParts.get(generationId)
    if (record?.watchdog) {
      clearTimeout(record.watchdog)
      record.watchdog = null
    }
    // Measured here as well as on the client's report: this is the local
    // barge-in latency (VAD speech start -> agent audio stopped), and it must not
    // depend on the renderer answering in time.
    timings.markPlaybackHalted(now(), reason)
    // Abort synthesis while it is still streaming (defect 2).
    helper?.cancel(generationId, reason)
    send({ type: 'speech.cancel', generationId, reason })
  }

  function finishItem(item: SpeechFloorItem, result: SpeechResult, detail?: string): void {
    const agentId = item.intent.agentId
    const generationId = item.generationId
    const spoken = spokenStateFor(result.state)
    try {
      deps.bus.setAgentSpeech(agentId, result.state === 'interrupted' ? 'interrupted' : 'silent')
    } catch {
      // ignore
    }
    if (item.intent.messageId) {
      updateSpoken(item, generationId ?? '', spoken, result.playedChars)
    }
    if (generationId) {
      const record = speechParts.get(generationId)
      if (record?.watchdog) clearTimeout(record.watchdog)
      speechParts.delete(generationId)
      if (item.intent.roomId === activeRoomId) {
        emitPlayback(item, generationId, playbackStateFor(result.state))
      }
    }
    if (result.state === 'unheard' && detail === 'deafened') {
      notify('info', `${agentId} had something to say while you were deafened.`)
    }
  }

  function reportQueue(agentIds: readonly string[]): void {
    for (const agentId of agentIds) {
      try {
        deps.bus.setAgentSpeech(agentId, 'queued')
      } catch {
        // ignore
      }
    }
    const stillQueued = knownQueued.filter((agentId) => !agentIds.includes(agentId))
    knownQueued.length = 0
    knownQueued.push(...agentIds)
    const speaking = floor.currentItem()?.intent.agentId ?? null
    for (const agentId of stillQueued) {
      if (agentId === speaking) continue
      try {
        deps.bus.setAgentSpeech(agentId, 'silent')
      } catch {
        // ignore
      }
    }
  }

  function emitPlayback(
    item: SpeechFloorItem,
    generationId: string,
    state: 'starting' | 'playing' | 'ended' | 'interrupted' | 'cancelled'
  ): void {
    if (item.intent.roomId !== activeRoomId) return
    try {
      deps.bus.emit(item.intent.roomId, {
        type: 'voice.playback',
        agentId: item.intent.agentId,
        generationId,
        state,
        messageId: item.intent.messageId
      })
    } catch {
      // ignore
    }
  }

  function updateSpoken(
    item: SpeechFloorItem,
    generationId: string,
    state: SpokenState,
    playedChars: number | null
  ): void {
    const messageId = item.intent.messageId
    if (!messageId) return
    try {
      const patch: Partial<Message> = {
        spoken: { generationId, state, playedChars }
      }
      deps.bus.updateMessage(messageId, patch)
    } catch {
      // ignore
    }
  }

  /* ---------------------------------------------------------------- *
   * Loops in `flush` (shared with tests)
   * ---------------------------------------------------------------- */

  async function flush(): Promise<void> {
    while (draining || frameQueue.length > 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (transcribeQueue) await transcribeQueue.drain()
    await new Promise((resolve) => setImmediate(resolve))
  }

  return {
    start,
    stop,
    isActive: () => activeRoomId !== null,
    activeRoomId: () => activeRoomId,
    setMicMuted: (muted: boolean) => {
      micMuted = muted
      if (muted) {
        // The human is no longer audible: close the utterance without cancelling
        // anything that is already running.
        const detector = vad
        if (detector?.speaking) endUtterance(now())
      }
    },
    setDeafened: (value: boolean) => {
      floor.setDeafened(value)
      if (value) notify('info', 'Agent voices are muted while you are deafened.')
    },
    pushMicFrame,
    reportClientEvent,
    speak,
    stopSpeaking,
    invalidateSpeechBefore,
    listVoices: listVoiceOptions,
    previewVoice,
    timings: () => timings.snapshot(),
    dispose,
    flush,
    floor: () => floor
  }
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

export const createVoiceHost = (deps: VoiceHostDeps): VoiceHost => createVoiceHostWith(deps, {})

function spokenStateFor(state: SpeechResult['state']): SpokenState {
  switch (state) {
    case 'played':
      return 'played'
    case 'interrupted':
      return 'interrupted'
    case 'cancelled':
      return 'cancelled'
    case 'unheard':
      return 'unheard'
    default:
      return 'unheard'
  }
}

function playbackStateFor(
  state: SpeechResult['state']
): 'ended' | 'interrupted' | 'cancelled' {
  if (state === 'played') return 'ended'
  if (state === 'interrupted') return 'interrupted'
  return 'cancelled'
}

function localSpeechUnavailable(detail: string, fix: string | null): Capability {
  return {
    id: 'localSpeech',
    label: 'Local speech (VAD + Whisper)',
    state: 'error',
    detail,
    fix,
    checkedAt: new Date().toISOString()
  }
}

function agentVoicesUnavailable(
  detail: string,
  fix: string | null,
  state: Capability['state'] = 'error'
): Capability {
  return {
    id: 'elevenlabs',
    label: 'Agent voices (ElevenLabs)',
    state,
    detail,
    fix,
    checkedAt: new Date().toISOString()
  }
}

function toShape(error: unknown): { message: string; fix: string | null } {
  if (error instanceof HuddleError) return { message: error.message, fix: error.fix }
  if (error instanceof Error) return { message: error.message, fix: null }
  return { message: 'Unexpected voice error', fix: null }
}
