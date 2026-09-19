// The voice seam the UI and the integration lead use.
//
// Exactly the surface below is exported: the state shape, the controller
// interface, and one factory. Nothing else about how voice works leaks out, so
// the call UI only ever reads `VoiceUiState` and calls controller methods.
//
// It talks to the main process exclusively through `window.huddle.voice.*`
// (shared/api.ts): sendMicFrame, reportClientEvent, onServerEvent, onAudioChunk,
// plus start / stop / setMicMuted / setDeafened / stopSpeaking / listDevices.

import { createController } from './controller.ts'

export interface VoiceUiState {
  /** Truthful microphone level 0..1, ~20 Hz, never persisted. */
  micLevel: number
  /** RMS measured from the playback output graph, 0..1. */
  playbackLevel: number
  /**
   * True while the local microphone indicates human speech (level above a small
   * threshold, with a short hangover). Agent audio is reflected by
   * `speakingAgentId` / `playbackState` instead, so the two are distinguishable.
   */
  speaking: boolean
  captureState: 'off' | 'starting' | 'live' | 'error'
  playbackState: 'idle' | 'playing' | 'error'
  /** Agent currently audible. Driven by actual playback, not by token arrival. */
  speakingAgentId: string | null
  /** Text of the speech that is currently being played. */
  speakingText: string
  /**
   * Agents whose speech the main process announced but which is not audible yet.
   * A room has at most one audible agent, so this is normally empty or a single
   * entry that moves to `speakingAgentId` when the first frame sounds.
   */
  queuedAgentIds: string[]
  /** Truthful, user-visible failure of the last operation, or null. */
  error: string | null
}

export interface VoiceController {
  start(roomId: string): Promise<void>
  stop(): Promise<void>
  setMicMuted(m: boolean): Promise<void>
  setDeafened(d: boolean): Promise<void>
  stopSpeaking(scope: 'current' | 'all'): Promise<void>
  getState(): VoiceUiState
  onState(listener: (s: VoiceUiState) => void): () => void
  dispose(): void
}

/** The only way the call UI is meant to obtain a controller. */
export function createVoiceController(): VoiceController {
  let joinedRoom: string | null = null
  return createController({ loadDevices: async () => (await window.huddle.getSnapshot()).settings.voice, channel: {
    ...window.huddle.voice,
    start: async (roomId) => {
      joinedRoom = roomId
      await window.huddle.joinCall(roomId)
      const state = await window.huddle.getSnapshot()
      if (state.call.connection === 'error') throw new Error(state.call.error ?? 'Local speech could not start.')
    },
    stop: async () => {
      const roomId = joinedRoom
      joinedRoom = null
      if (roomId) await window.huddle.leaveCall(roomId)
    }
  } })
}
