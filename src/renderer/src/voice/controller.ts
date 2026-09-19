// The renderer's voice controller: the object the UI talks to.
//
// It owns exactly two things — microphone capture and agent playback — and it
// uses only `window.huddle.voice.*` from the preload API (see shared/api.ts):
// sendMicFrame, reportClientEvent, onServerEvent, onAudioChunk, start, stop,
// setMicMuted, setDeafened, stopSpeaking, listDevices. There is no other channel
// back to the main process, so every audio decision the main process needs is
// reported from here, from what the hardware actually did.
//
// Defects covered here:
//   3. nothing is declared drained before synthesis EOF (see playback.ts)
//   4. chunks whose generationId is not the active generation are dropped
//   2. cancelling halts playback immediately, even while synthesis streams
//  10. mute stops forwarding mic audio and deafen clears buffered audio; neither
//      cancels work the agents are doing

import type {
  AudioChunkMessage,
  AudioDeviceInfo,
  PlaybackClientEvent,
  PlaybackServerEvent
} from '../../../shared/voice.ts'
import { PLAYBACK_SAMPLE_RATE } from '../../../shared/voice.ts'
import type { VoiceController, VoiceUiState } from './index.ts'
import { VoicePlayback, type PlaybackReport } from './playback.ts'
import { startCapture, type CaptureHandle } from './capture.ts'

/** The slice of the preload API this controller depends on. */
export interface VoiceChannel {
  start(roomId: string): Promise<void>
  stop(): Promise<void>
  setMicMuted(muted: boolean): Promise<void>
  setDeafened(deafened: boolean): Promise<void>
  stopSpeaking(input: { roomId: string; scope: 'current' | 'all' }): Promise<void>
  listDevices(): Promise<AudioDeviceInfo[]>
  sendMicFrame(pcm: ArrayBuffer, capturedAt: number): void
  reportClientEvent(event: PlaybackClientEvent): void
  onServerEvent(listener: (event: PlaybackServerEvent) => void): () => void
  onAudioChunk(listener: (chunk: AudioChunkMessage) => void): () => void
}

export interface VoiceControllerOptions {
  channel: VoiceChannel
  /** Injectable for tests and for Electron's non-default output devices. */
  createAudioContext?: (sampleRate: number) => AudioContext
  mediaDevices?: MediaDevices
  now?: () => number
  /** Worklet url, defaults to /capture-processor.js. */
  workletUrl?: string
}

/** Local mic level above which we consider the human to be talking. */
const SPEAKING_LEVEL = 0.02
const SPEAKING_HANGOVER_MS = 400

export function createController(options: VoiceControllerOptions): VoiceController {
  const channel = options.channel
  const now = options.now ?? (() => performance.now())
  const listeners = new Set<(state: VoiceUiState) => void>()

  const state: VoiceUiState = {
    micLevel: 0,
    speaking: false,
    captureState: 'off',
    playbackState: 'idle',
    speakingAgentId: null,
    speakingText: '',
    queuedAgentIds: [],
    error: null
  }

  let activeRoomId: string | null = null
  let started = false
  let micMuted = false
  let capture: CaptureHandle | null = null
  let captureContext: AudioContext | null = null
  let playbackContext: AudioContext | null = null
  let lastVoiceAt = 0
  let unsubscribeServer: (() => void) | null = null
  let unsubscribeChunk: (() => void) | null = null

  const playback = new VoicePlayback({
    now,
    createContext: (sampleRate) => {
      // Playback gets its own context at the PCM rate, so no resampling is needed
      // on the hot path.
      if (!playbackContext) playbackContext = (options.createAudioContext ?? defaultCreateContext)(sampleRate)
      return playbackContext
    },
    callbacks: {
      report: (event) => {
        try {
          channel.reportClientEvent(event)
        } catch {
          // The main process is gone: stop pretending we are in a call.
        }
      },
      onAudible: (info) => {
        state.playbackState = 'playing'
        state.speakingAgentId = info.agentId
        state.speakingText = info.text
        state.queuedAgentIds = state.queuedAgentIds.filter((agentId) => agentId !== info.agentId)
        emit()
      },
      onDrained: (info) => {
        clearSpeaking(info)
        state.playbackState = 'idle'
        emit()
      },
      onHalted: (info) => {
        clearSpeaking(info)
        state.playbackState = 'idle'
        emit()
      },
      onError: (info) => {
        state.playbackState = 'error'
        state.error = info.message
        clearSpeaking(info)
        emit()
      }
    }
  })

  function defaultCreateContext(sampleRate: number): AudioContext {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    return new Ctor({ sampleRate })
  }

  /** Capture runs at the device's own rate; the worklet block is resampled to 16 kHz. */
  function newCaptureContext(): AudioContext {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    return new Ctor()
  }

  function emit(): void {
    const snapshot: VoiceUiState = {
      ...state,
      queuedAgentIds: [...state.queuedAgentIds]
    }
    for (const listener of listeners) {
      try {
        listener(snapshot)
      } catch {
        // A broken listener must not break audio.
      }
    }
  }

  function clearSpeaking(info: PlaybackReport): void {
    if (state.speakingAgentId !== info.agentId) return
    state.speakingAgentId = null
    state.speakingText = ''
  }

  function setCaptureState(next: VoiceUiState['captureState'], error: string | null = null): void {
    state.captureState = next
    state.error = error
  }

  function setPlaybackState(next: VoiceUiState['playbackState']): void {
    state.playbackState = next
  }

  function handleServerEvent(event: PlaybackServerEvent): void {
    switch (event.type) {
      case 'speech.begin': {
        playback.begin({
          generationId: event.generationId,
          agentId: event.agentId,
          text: event.text,
          messageId: event.messageId,
          sampleRate: event.sampleRate || PLAYBACK_SAMPLE_RATE
        })
        setPlaybackState('playing')
        // Announced, not yet audible: the UI can show it as waiting to speak.
        if (!state.queuedAgentIds.includes(event.agentId)) {
          state.queuedAgentIds = [...state.queuedAgentIds, event.agentId]
        }
        emit()
        return
      }
      case 'speech.synthesisEnded': {
        playback.synthesisEnded(event.generationId)
        return
      }
      case 'speech.cancel': {
        playback.halt(event.generationId, event.reason)
        setPlaybackState('idle')
        emit()
        return
      }
      case 'speech.error': {
        playback.halt(event.generationId, 'stale')
        setPlaybackState('error')
        state.error = event.message
        emit()
        return
      }
      default:
        return
    }
  }

  function handleAudioChunk(chunk: AudioChunkMessage): void {
    // Stale generations are dropped inside the gate: a late chunk can never
    // restart playback for an interrupted utterance.
    playback.push(chunk)
  }

  async function start(roomId: string): Promise<void> {
    if (started) {
      if (activeRoomId === roomId && state.captureState === 'live') return
      await stop()
    }
    setCaptureState('starting')
    emit()
    try {
      // Capture uses the device's own rate (clean microphone capture); playback
      // uses PLAYBACK_SAMPLE_RATE.
      if (!captureContext) captureContext = newCaptureContext()
      if (captureContext.state === 'suspended') await captureContext.resume()
      unsubscribeServer = channel.onServerEvent(handleServerEvent)
      unsubscribeChunk = channel.onAudioChunk(handleAudioChunk)
      capture = await startCapture({
        context: captureContext,
        deviceId: null,
        ...(options.workletUrl ? { workletUrl: options.workletUrl } : {}),
        ...(options.mediaDevices ? { mediaDevices: options.mediaDevices } : {}),
        now,
        onFrame: (pcm, capturedAt) => {
          if (micMuted) return
          try {
            channel.sendMicFrame(pcm, capturedAt)
          } catch {
            setCaptureState('error', 'Lost the connection to the app backend.')
            emit()
          }
        },
        onLevel: (level) => {
          state.micLevel = level
          const talking = level > SPEAKING_LEVEL
          if (talking) lastVoiceAt = now()
          state.speaking = talking || now() - lastVoiceAt < SPEAKING_HANGOVER_MS
          emit()
        },
        onError: (error) => {
          setCaptureState('error', error.message)
          emit()
        }
      })
      capture.setForwarding(!micMuted)
      await channel.start(roomId)
      activeRoomId = roomId
      started = true
      setCaptureState('live')
      setPlaybackState(playback.isPlaying() ? 'playing' : 'idle')
      emit()
    } catch (error) {
      unsubscribe()
      capture?.stop()
      capture = null
      setPlaybackState('idle')
      setCaptureState('error', error instanceof Error ? error.message : String(error))
      emit()
    }
  }

  async function stop(): Promise<void> {
    unsubscribe()
    capture?.stop()
    capture = null
    playback.stopAll('leave')
    try {
      await channel.stop()
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    }
    activeRoomId = null
    started = false
    micMuted = false
    state.micLevel = 0
    state.speaking = false
    state.speakingAgentId = null
    state.speakingText = ''
    state.queuedAgentIds = []
    setCaptureState('off')
    setPlaybackState('idle')
    emit()
  }

  function unsubscribe(): void {
    unsubscribeServer?.()
    unsubscribeChunk?.()
    unsubscribeServer = null
    unsubscribeChunk = null
  }

  return {
    start,
    stop,
    async setMicMuted(muted: boolean): Promise<void> {
      micMuted = muted
      // Capture keeps running; only forwarding stops, so no work is cancelled.
      capture?.setForwarding(!muted)
      try {
        await channel.setMicMuted(muted)
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error)
        emit()
      }
    },
    async setDeafened(deafened: boolean): Promise<void> {
      playback.setDeafened(deafened)
      try {
        await channel.setDeafened(deafened)
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error)
        emit()
      }
    },
    async stopSpeaking(scope: 'current' | 'all'): Promise<void> {
      playback.stopAll('stopSpeaking')
      try {
        await channel.stopSpeaking({ roomId: activeRoomId ?? '', scope })
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error)
        emit()
      }
    },
    getState(): VoiceUiState {
      return { ...state, queuedAgentIds: [...state.queuedAgentIds] }
    },
    onState(listener: (next: VoiceUiState) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose(): void {
      unsubscribe()
      capture?.stop()
      capture = null
      playback.dispose()
      listeners.clear()
      for (const closing of [captureContext, playbackContext]) {
        if (closing && closing.state !== 'closed') void closing.close().catch(() => undefined)
      }
      captureContext = null
      playbackContext = null
      activeRoomId = null
      started = false
    }
  }
}
