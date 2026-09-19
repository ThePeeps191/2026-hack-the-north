// ElevenLabs voice catalogue and per-agent voice shaping.
//
// Ported from tools/voice-lab/src/server/voices.ts (list voices, fall back to the
// presets when the key is missing), extended with the accent/gender/preview
// fields `VoiceOption` in shared/api.ts asks for and with `Agent.voice` mapping
// (voiceId + speed/stability/similarityBoost) for the helper.
//
// No parameter properties / enums: loaded by `node --experimental-strip-types --test`.

import type { VoiceOption } from '../../shared/api.ts'
import type { Agent } from '../../shared/types.ts'
import { AGENT_PRESETS } from '../../shared/presets.ts'
import type { HelperVoiceSettings } from './protocol.ts'

export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1'

/** Short, natural line so a preview is obviously the agent's voice and not a jingle. */
export const PREVIEW_TEXT =
  'This is how I sound on the call. I keep turns short, and I stop the moment you start speaking.'

interface VoiceRecord {
  voice_id?: unknown
  name?: unknown
  category?: unknown
  description?: unknown
  preview_url?: unknown
  labels?: unknown
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function labelOf(labels: unknown, key: string): string | null {
  if (!labels || typeof labels !== 'object') return null
  return asString((labels as Record<string, unknown>)[key])
}

/** The five preset voices from shared/presets.ts, used when the API cannot be reached. */
export function presetVoices(detail = 'Bundled preset voice'): VoiceOption[] {
  const seen = new Map<string, VoiceOption>()
  for (const preset of AGENT_PRESETS) {
    if (seen.has(preset.voice.voiceId)) continue
    seen.set(preset.voice.voiceId, {
      voiceId: preset.voice.voiceId,
      name: preset.voice.voiceName,
      accent: null,
      gender: null,
      description: `${detail} (used by ${preset.name})`,
      previewUrl: null
    })
  }
  return [...seen.values()]
}

export function parseVoices(payload: unknown): VoiceOption[] {
  if (!payload || typeof payload !== 'object') return []
  const voices = (payload as { voices?: unknown }).voices
  if (!Array.isArray(voices)) return []
  const out: VoiceOption[] = []
  for (const entry of voices) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as VoiceRecord
    const voiceId = asString(record.voice_id)
    if (!voiceId) continue
    out.push({
      voiceId,
      name: asString(record.name) ?? voiceId,
      accent: labelOf(record.labels, 'accent'),
      gender: labelOf(record.labels, 'gender'),
      description: asString(record.description) ?? labelOf(record.labels, 'description'),
      previewUrl: asString(record.preview_url)
    })
  }
  return out
}

export interface ListVoicesResult {
  voices: VoiceOption[]
  /** Truthful one-line description of where the list came from. */
  detail: string
  verified: boolean
}

export async function listVoices(input: {
  apiKey: string
  fetchImpl?: typeof fetch
}): Promise<ListVoicesResult> {
  if (!input.apiKey.trim()) {
    return {
      voices: presetVoices('Bundled preset voice, unverified: no ElevenLabs key'),
      detail: 'No ELEVENLABS_API_KEY, so these are the bundled preset ids only.',
      verified: false
    }
  }
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(`${ELEVENLABS_API_BASE}/voices?page_size=100`, {
      headers: { 'xi-api-key': input.apiKey }
    })
    if (!response.ok) {
      return {
        voices: presetVoices(`Bundled preset voice (ElevenLabs returned ${response.status})`),
        detail: `ElevenLabs voice list failed (${response.status} ${response.statusText}).`,
        verified: false
      }
    }
    const parsed = parseVoices(await response.json())
    if (parsed.length === 0) {
      return {
        voices: presetVoices('Bundled preset voice (account returned no voices)'),
        detail: 'The ElevenLabs account returned no voices.',
        verified: false
      }
    }
    // Presets first so agent voices are easy to find, then the rest of the account.
    const presetIds = new Set(presetVoices().map((voice) => voice.voiceId))
    const presets = presetVoices('Account voice')
    const rest = parsed.filter((voice) => !presetIds.has(voice.voiceId))
    const known = parsed.filter((voice) => presetIds.has(voice.voiceId))
    return {
      voices: [...known, ...presets.filter((voice) => !known.some((item) => item.voiceId === voice.voiceId)), ...rest],
      detail: `${parsed.length} voices listed from the account.`,
      verified: true
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      voices: presetVoices('Bundled preset voice (network error)'),
      detail: `Could not reach ElevenLabs: ${message}`,
      verified: false
    }
  }
}

/** Which of the preset voice ids actually exist on this account. */
export async function probeVoiceIds(input: {
  apiKey: string
  voiceIds: readonly string[]
  fetchImpl?: typeof fetch
}): Promise<{ valid: string[]; missing: string[]; detail: string }> {
  const result = await listVoices({ apiKey: input.apiKey, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) })
  if (!result.verified) {
    return { valid: [], missing: [...input.voiceIds], detail: result.detail }
  }
  const known = new Set(result.voices.map((voice) => voice.voiceId))
  const valid: string[] = []
  const missing: string[] = []
  for (const id of input.voiceIds) {
    if (known.has(id)) valid.push(id)
    else missing.push(id)
  }
  return { valid, missing, detail: result.detail }
}

export function findVoice(voices: readonly VoiceOption[], voiceId: string): VoiceOption | null {
  return voices.find((voice) => voice.voiceId === voiceId) ?? null
}

/** `Agent.voice` -> the exact numbers the helper sends to ElevenLabs. */
export function agentVoiceSettings(agent: Agent): HelperVoiceSettings {
  return {
    voiceId: agent.voice.voiceId,
    speed: clamp(agent.voice.speed, 0.7, 1.2),
    stability: clamp(agent.voice.stability, 0, 1),
    similarityBoost: clamp(agent.voice.similarityBoost, 0, 1)
  }
}

export function previewVoiceSettings(voiceId: string): HelperVoiceSettings {
  return { voiceId, speed: 1, stability: 0.5, similarityBoost: 0.75 }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return (min + max) / 2
  return Math.min(max, Math.max(min, value))
}
