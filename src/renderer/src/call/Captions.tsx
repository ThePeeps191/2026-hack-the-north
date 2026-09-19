import type { JSX } from 'react'
import type { Agent, CallState, LiveTranscript, Message } from '../../../shared/types'
import type { HumanPresence, SpeakingState } from '../state/view-model'
import { AvatarMark } from './avatars'
import { findAgent } from './derive'
import { roleLabel, truncate } from './format'
import { SpeechIcon, StopIcon } from './icons'
import { Badge, Button, IconButton } from './ui'

/**
 * Live captions.
 *
 * The caption text is the audio device's own playback text, and its state comes
 * from the message record: an interrupted or unheard line is labelled as such
 * rather than passed off as something the room heard.
 */

export interface CaptionsProps {
  agents: Agent[]
  messages: Message[]
  speaking: Record<string, SpeakingState>
  call: CallState
  human: HumanPresence
  liveTranscript: LiveTranscript | null
  onStopSpeaking: (scope: 'current' | 'all') => void
}

export function Captions({
  agents,
  messages,
  speaking,
  call,
  human,
  liveTranscript,
  onStopSpeaking
}: CaptionsProps): JSX.Element {
  const speakingIds = Object.keys(speaking)
  const floorId =
    call.speakingAgentId ?? (speakingIds.length > 0 ? speakingIds[0] : null)
  const agent = findAgent(agents, floorId)
  const state = floorId ? speaking[floorId] ?? null : null
  const message = state?.messageId
    ? messages.find((item) => item.id === state.messageId) ?? null
    : null
  const spoken = message?.spoken ?? null
  const text = state?.text || message?.body || ''
  const queuedIds = call.queuedAgentIds.filter((id) => id !== floorId)

  return (
    <section className="hs-captions" aria-label="Live captions">
      <div className="hs-captions-head">
        <span className="hs-captions-label">
          <SpeechIcon size={13} /> Captions
        </span>
        {agent && state ? (
          <span className="hs-captions-who">
            <AvatarMark avatar={agent.avatar} color={agent.color} size={18} />
            <span className="hs-captions-name">{agent.name}</span>
            <span className="hs-captions-role">{roleLabel(agent.role)}</span>
          </span>
        ) : null}
        <span className="hs-captions-actions">
          {agent && state ? (
            <Badge
              tone={spoken?.state === 'interrupted' || spoken?.state === 'unheard' ? 'stop' : 'live'}
              title={
                spoken
                  ? `Audio state: ${spoken.state}${
                      spoken.playedChars === null ? '' : ` · ${spoken.playedChars} characters played`
                    }`
                  : 'Playback is running for this line'
              }
            >
              {spoken?.state === 'interrupted'
                ? `Interrupted${
                    spoken.playedChars === null ? '' : ` after ${spoken.playedChars} characters`
                  }`
                : spoken?.state === 'unheard'
                  ? 'Not heard'
                  : spoken?.state === 'cancelled'
                    ? 'Cancelled'
                    : 'Speaking now'}
            </Badge>
          ) : null}
          {agent && state ? (
            <IconButton
              label="Stop current speech"
              hint="Cuts this line. The work it describes keeps running."
              size="sm"
              onClick={() => onStopSpeaking('current')}
            >
              <StopIcon size={14} />
            </IconButton>
          ) : null}
          {queuedIds.length > 0 ? (
            <Button
              variant="ghost"
              hint="Drops every queued line behind the current speaker"
              onClick={() => onStopSpeaking('all')}
            >
              Stop {queuedIds.length} queued
            </Button>
          ) : null}
        </span>
      </div>

      <p className="hs-captions-text" aria-live="polite" title={text}>
        {agent && text ? (
          truncate(text, 400)
        ) : human.speaking && liveTranscript ? (
          <>
            <span className="hs-captions-you">You</span>
            {truncate(liveTranscript.text, 260)}
            {liveTranscript.isFinal ? '' : '…'}
          </>
        ) : queuedIds.length > 0 ? (
          <span className="hs-captions-idle">
            {queuedIds
              .map((id) => findAgent(agents, id)?.name ?? 'A teammate')
              .join(', ')}{' '}
            waiting to speak.
          </span>
        ) : (
          <span className="hs-captions-idle">
            {call.connection === 'connected'
              ? 'No one is speaking.'
              : 'Captions appear here once the call is live.'}
          </span>
        )}
      </p>
    </section>
  )
}
