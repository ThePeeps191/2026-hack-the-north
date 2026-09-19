import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppSnapshot,
  CallState,
  LiveTranscript,
  Message,
  RuntimeEvent
} from '../../shared/types'
import type { HumanPresence, SpeakingState } from './state/view-model'
import { applyRuntimeEvent } from './apply-event'
import { createVoiceController, type VoiceController, type VoiceUiState } from './voice/index'

/**
 * The renderer's live view of one Huddle room.
 *
 * Durable events are folded into the snapshot. Ephemeral ones (audio levels,
 * playback truth, partial transcripts, notices) drive the call UI instead and
 * are never merged into state — the same rule the backend uses.
 */

const MAX_NOTICES = 8

const EMPTY_VOICE: VoiceUiState = {
  micLevel: 0,
  playbackLevel: 0,
  speaking: false,
  captureState: 'off',
  playbackState: 'idle',
  speakingAgentId: null,
  speakingText: '',
  queuedAgentIds: [],
  error: null
}

const EMPTY_CALL: CallState = {
  roomId: null,
  connection: 'disconnected',
  micMuted: false,
  deafened: false,
  micLevel: 0,
  listening: false,
  speakingAgentId: null,
  queuedAgentIds: [],
  error: null
}

export function useHuddle(): {
  snapshot: AppSnapshot | null
  loading: boolean
  loadError: string | null
  notices: HubNotice[]
  liveTranscript: LiveTranscript | null
  speaking: Record<string, SpeakingState>
  human: HumanPresence
  voice: VoiceUiState
  error: string | null
  setError: (message: string | null) => void
  dismissNotice: (id: string) => void
  controller: VoiceController
} {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notices, setNotices] = useState<HubNotice[]>([])
  const [liveTranscript, setLiveTranscript] = useState<LiveTranscript | null>(null)
  const [playback, setPlayback] = useState<
    Record<string, { generationId: string; messageId: string | null }>
  >({})
  const [speakingHumans, setSpeakingHumans] = useState(false)
  const [voice, setVoice] = useState<VoiceUiState>(EMPTY_VOICE)
  const [error, setError] = useState<string | null>(null)

  const controller = useMemo(() => createVoiceController(), [])

  useEffect(() => {
    const stop = controller.onState(setVoice)
    setVoice(controller.getState())
    return stop
  }, [controller])

  useEffect(() => {
    let cancelled = false
    let ready = false
    let lastSeq = -1
    const seen = new Set<string>()
    const buffer: RuntimeEvent[] = []

    const rememberNotice = (event: RuntimeEvent): void => {
      if (event.type !== 'notice') return
      const notice: HubNotice = {
        id: event.id,
        level: event.level,
        text: event.text,
        at: event.createdAt,
        roomId: event.roomId,
        ...(event.fix ? { fix: event.fix } : {})
      }
      setNotices((current) =>
        current.some((item) => item.id === notice.id)
          ? current
          : [...current, notice].slice(-MAX_NOTICES)
      )
    }

    const handle = (event: RuntimeEvent): void => {
      if (seen.has(event.id)) return
      seen.add(event.id)
      lastSeq = Math.max(lastSeq, event.seq)

      switch (event.type) {
        case 'notice':
          rememberNotice(event)
          break
        case 'voice.transcript':
          setLiveTranscript(event.transcript)
          break
        case 'voice.vad':
          setSpeakingHumans(event.speaking)
          break
        case 'voice.playback':
          setPlayback((current) => {
            const next = { ...current }
            if (event.state === 'starting' || event.state === 'playing') {
              next[event.agentId] = { generationId: event.generationId, messageId: event.messageId }
            } else {
              delete next[event.agentId]
            }
            return next
          })
          break
        default:
          break
      }

      if (event.durable) {
        setSnapshot((current) => (current ? applyRuntimeEvent(current, event) : current))
      }
    }

    const unsubscribe = window.huddle.subscribe((event) => {
      if (cancelled) return
      if (!ready) {
        buffer.push(event)
        return
      }
      handle(event)
    })

    window.huddle
      .getSnapshot()
      .then((next) => {
        if (cancelled) return
        // Startup notices are part of the story the backend wants shown.
        for (const event of next.events) {
          seen.add(event.id)
          rememberNotice(event)
        }
        lastSeq = next.lastSeq
        setSnapshot(next)
        setLoading(false)
        ready = true
        for (const event of buffer) {
          if (event.seq > lastSeq) handle(event)
          else seen.add(event.id)
        }
      })
      .catch((loadFailure: unknown) => {
        if (cancelled) return
        setLoadError(
          loadFailure instanceof Error ? loadFailure.message : 'Huddle could not load its state.'
        )
        setLoading(false)
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const roomId = snapshot?.selectedRoomId ?? null

  useEffect(() => {
    const active = controller
    return () => {
      // Capture and playback always stop when the room changes or Huddle closes.
      void active.stop().catch(() => undefined)
    }
  }, [controller, roomId])

  const call: CallState = snapshot?.call ?? EMPTY_CALL

  const speaking = useMemo<Record<string, SpeakingState>>(() => {
    const messages = snapshot?.messages ?? []
    const result: Record<string, SpeakingState> = {}
    for (const [agentId, state] of Object.entries(playback)) {
      if (voice.speakingAgentId !== agentId || voice.playbackState !== 'playing') continue
      const message: Message | undefined = state.messageId
        ? messages.find((item) => item.id === state.messageId)
        : undefined
      const liveText = voice.speakingAgentId === agentId ? voice.speakingText : ''
      result[agentId] = {
        agentId,
        generationId: state.generationId,
        text: liveText || message?.body || '',
        level: voice.playbackLevel,
        messageId: state.messageId
      }
    }
    return result
  }, [playback, snapshot?.messages, voice.speakingAgentId, voice.speakingText, voice.playbackLevel, voice.playbackState])

  const human: HumanPresence = {
    name: 'You',
    muted: call.micMuted,
    deafened: call.deafened,
    level: call.micLevel,
    speaking: speakingHumans || voice.speaking
  }

  const dismissNotice = useCallback((id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id))
  }, [])

  return {
    snapshot,
    loading,
    loadError,
    notices,
    liveTranscript: liveTranscript && !liveTranscript.isFinal ? liveTranscript : null,
    speaking,
    human,
    voice,
    error,
    setError,
    dismissNotice,
    controller
  }
}

/** A real backend notice, kept out of room state but visible in the UI. */
export interface HubNotice {
  id: string
  level: 'info' | 'warn' | 'error'
  text: string
  fix?: string
  at: string
  roomId: string
}
