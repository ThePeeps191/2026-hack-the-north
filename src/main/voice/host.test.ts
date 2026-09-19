// End-to-end behaviour of the voice host with a fake helper and a fake sink.
//
// The fake helper stands in for the standalone Node process (VAD probabilities,
// transcription, streaming synthesis); the fake sink stands for the room
// service. Everything else is the real host.
//
// Run: node --experimental-strip-types --test src/main/voice/host.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { HuddleBus, SpeechIntent, VoiceSink } from '../contracts.ts'
import type {
  Agent,
  AgentSpeechState,
  Capability,
  Message,
  RuntimeEvent,
  RuntimeEventBody,
  TimingSample
} from '../../shared/types.ts'
import { DEFAULT_SETTINGS } from '../../shared/types.ts'
import type { AudioChunkMessage, PlaybackServerEvent, SpeechReason } from '../../shared/voice.ts'
import { HuddleError } from '../huddle-error.ts'
import type { HelperVoiceSettings } from './protocol.ts'
import { createVoiceHostWith, type VoiceHostHandle } from './host.ts'
import type { HelperCaps, HelperChunk, SpeakOutcome, VoiceHelperPort } from './helper-client.ts'

/* ------------------------------------------------------------------ *
 * Fakes
 * ------------------------------------------------------------------ */

function makeAgent(id: string, name: string): Agent {
  return {
    id,
    roomId: 'room-1',
    presetId: 'maya',
    name,
    role: 'frontend',
    summary: 'test agent',
    persona: 'test',
    color: '#6f5bd6',
    avatar: 'prism',
    voice: {
      voiceId: 'FGY2WhTYpPnrIDTdsKH5',
      voiceName: 'Laura',
      speed: 1.05,
      stability: 0.4,
      similarityBoost: 0.75
    },
    model: 'gpt-6-astra',
    workState: 'idle',
    speechState: 'silent',
    activityLabel: '',
    connected: true,
    workspaceId: null,
    browserSessionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

interface BusSpy {
  bus: HuddleBus
  emitted: RuntimeEventBody[]
  notices: Array<{ level: string; text: string; fix?: string }>
  timings: TimingSample[]
  speech: Array<{ agentId: string; state: AgentSpeechState }>
  messagePatches: Array<{ messageId: string; patch: Partial<Message> }>
  capabilities(): Capability[]
}

function createBus(): BusSpy {
  const emitted: RuntimeEventBody[] = []
  const notices: Array<{ level: string; text: string; fix?: string }> = []
  const timings: TimingSample[] = []
  const speech: Array<{ agentId: string; state: AgentSpeechState }> = []
  const messagePatches: Array<{ messageId: string; patch: Partial<Message> }> = []
  const agents = new Map<string, Agent>([
    ['agent-maya', makeAgent('agent-maya', 'Maya')],
    ['agent-alex', makeAgent('agent-alex', 'Alex')]
  ])

  const target: Record<string, unknown> = {
    emit: (_roomId: string, body: RuntimeEventBody): RuntimeEvent => {
      emitted.push(body)
      return { id: 'e', seq: emitted.length, roomId: _roomId, createdAt: '', durable: false, ...body }
    },
    notice: (_roomId: string, level: string, text: string, fix?: string): void => {
      notices.push(fix ? { level, text, fix } : { level, text })
    },
    recordTimings: (samples: TimingSample[]): void => {
      timings.push(...samples)
    },
    setAgentSpeech: (agentId: string, state: AgentSpeechState): void => {
      speech.push({ agentId, state })
    },
    updateMessage: (messageId: string, patch: Partial<Message>): Message | null => {
      messagePatches.push({ messageId, patch })
      return null
    },
    getAgent: (agentId: string): Agent | null => agents.get(agentId) ?? null,
    getRoom: (roomId: string) => ({ id: roomId }),
    now: () => '2026-01-01T00:00:00.000Z',
    newId: () => 'id'
  }

  const bus = new Proxy(target, {
    get: (inner, property): unknown => {
      if (typeof property !== 'string') return undefined
      if (property in inner) return inner[property]
      return () => null
    }
  }) as unknown as HuddleBus

  return {
    bus,
    emitted,
    notices,
    timings,
    speech,
    messagePatches,
    capabilities: () =>
      emitted
        .filter((body) => body.type === 'capability.updated')
        .map((body) => (body as { capability: Capability }).capability)
  }
}

interface SinkSpy {
  impl: VoiceSink
  finals: Array<{ roomId: string; utteranceId: string; text: string; startedAt: number; endedAt: number }>
  partials: Array<{ roomId: string; utteranceId: string; text: string }>
  speechStarts: number
  speechEnds: number
}

function createSink(): SinkSpy {
  const spy: SinkSpy = {
    finals: [],
    partials: [],
    speechStarts: 0,
    speechEnds: 0,
    impl: {
      onFinalUtterance: (input) => {
        spy.finals.push(input)
      },
      onPartialUtterance: (input) => {
        spy.partials.push(input)
      },
      onHumanSpeechStart: () => {
        spy.speechStarts += 1
      },
      onHumanSpeechEnd: () => {
        spy.speechEnds += 1
      }
    }
  }
  return spy
}

class FakeHelper implements VoiceHelperPort {
  readonly speakCalls: Array<{ generationId: string; text: string; voiceId: string }> = []
  readonly cancelled: Array<{ generationId: string; reason: string }> = []
  readonly transcribeCalls: Array<{ utteranceId: string; isFinal: boolean; samples: number }> = []
  frameCalls = 0
  resetCount = 0
  defaultProbability = 0.9
  finalText = 'Maya, can you check the build?'
  partialText = 'Maya, can you'
  /** true: resolve immediately with one chunk. false: wait for pushChunk/finish. */
  autoFinish = true
  startError: HuddleError | null = null
  private seq = 0
  private readonly held = new Map<
    string,
    { resolve: (outcome: SpeakOutcome) => void; onChunk: (chunk: HelperChunk) => void; bytes: number }
  >()

  caps(): HelperCaps {
    return {
      vad: { state: 'ready', detail: 'Silero VAD loaded', fix: null },
      stt: { state: 'ready', detail: 'faster-whisper base.en', fix: null },
      tts: { state: 'ready', detail: 'ElevenLabs reachable', fix: null }
    }
  }

  async ensureStarted(): Promise<HelperCaps> {
    if (this.startError) throw this.startError
    return this.caps()
  }

  running(): boolean {
    return true
  }

  async resetVad(): Promise<void> {
    this.resetCount += 1
  }

  async frame(_frame: Float32Array): Promise<number> {
    this.frameCalls += 1
    return this.defaultProbability
  }

  async transcribe(input: {
    utteranceId: string
    pcm: Float32Array
    isFinal: boolean
    initialPrompt?: string
  }): Promise<string> {
    this.transcribeCalls.push({
      utteranceId: input.utteranceId,
      isFinal: input.isFinal,
      samples: input.pcm.length
    })
    return input.isFinal ? this.finalText : this.partialText
  }

  speak(input: {
    generationId: string
    text: string
    voice: HelperVoiceSettings
    onChunk(chunk: HelperChunk): void
  }): Promise<SpeakOutcome> {
    this.speakCalls.push({
      generationId: input.generationId,
      text: input.text,
      voiceId: input.voice.voiceId
    })
    if (this.startError) {
      return Promise.resolve({
        state: 'failed',
        message: this.startError.message,
        fix: this.startError.fix
      })
    }
    if (this.autoFinish) {
      const pcm = new Uint8Array(4096)
      input.onChunk({ seq: (this.seq += 1), pcm })
      return Promise.resolve({ state: 'ended', chars: input.text.length, bytes: pcm.byteLength })
    }
    return new Promise<SpeakOutcome>((resolve) => {
      this.held.set(input.generationId, { resolve, onChunk: input.onChunk, bytes: 0 })
    })
  }

  pushChunk(generationId: string, bytes = 2048): void {
    const held = this.held.get(generationId)
    if (!held) return
    held.bytes += bytes
    held.onChunk({ seq: (this.seq += 1), pcm: new Uint8Array(bytes) })
  }

  finish(generationId: string): void {
    const held = this.held.get(generationId)
    if (!held) return
    this.held.delete(generationId)
    held.resolve({ state: 'ended', chars: 12, bytes: held.bytes })
  }

  cancel(generationId: string, reason: string): void {
    this.cancelled.push({ generationId, reason })
    const held = this.held.get(generationId)
    if (!held) return
    this.held.delete(generationId)
    held.resolve({ state: 'cancelled' })
  }

  async dispose(): Promise<void> {
    this.held.clear()
  }
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

interface Harness {
  host: VoiceHostHandle
  bus: BusSpy
  sink: SinkSpy
  helper: FakeHelper
  serverEvents: PlaybackServerEvent[]
  audioChunks: AudioChunkMessage[]
  advance(ms: number): void
  push(samples: number, at: number): void
}

function harness(options?: {
  helper?: FakeHelper
  enabled?: boolean
  key?: string
  sink?: VoiceSink | null
}): Harness {
  const bus = createBus()
  const sink = createSink()
  const helper = options?.helper ?? new FakeHelper()
  const serverEvents: PlaybackServerEvent[] = []
  const audioChunks: AudioChunkMessage[] = []
  const clock = { value: 1_000_000 }

  const host = createVoiceHostWith(
    {
      bus: bus.bus,
      settings: () => ({
        ...DEFAULT_SETTINGS,
        voice: { ...DEFAULT_SETTINGS.voice, enabled: options?.enabled ?? true }
      }),
      sink: () => (options?.sink === undefined ? sink.impl : options.sink),
      sendServerEvent: (event) => {
        serverEvents.push(event)
      },
      sendAudioChunk: (chunk) => {
        audioChunks.push(chunk)
      }
    },
    {
      helper,
      now: () => clock.value,
      elevenLabsKey: () => options?.key ?? 'test-key',
      fileExists: () => true,
      assets: () => ({
        helperPath: 'out/main/voice-helper.js',
        pythonBin: 'python',
        workerScript: 'tools/voice-lab/python/transcribe_worker.py',
        sileroModelPath: 'tools/voice-lab/models/silero_vad.onnx',
        appRoot: '.'
      })
    }
  )

  return {
    host,
    bus,
    sink,
    helper,
    serverEvents,
    audioChunks,
    advance: (ms: number) => {
      clock.value += ms
    },
    push: (samples: number, at: number) => {
      // The host measures endpointing against capture times, so the test clock
      // has to follow the frames.
      if (at > clock.value) clock.value = at
      const buffer = new ArrayBuffer(samples * 2)
      new Int16Array(buffer).fill(1_000)
      host.pushMicFrame(buffer, at)
    }
  }
}

function intent(input: { agentId: string; reason: SpeechReason; text?: string; messageId?: string | null }): SpeechIntent {
  return {
    id: `intent-${input.agentId}`,
    roomId: 'room-1',
    agentId: input.agentId,
    text: input.text ?? 'Build passed and I pushed the branch.',
    reason: input.reason,
    decisionRevision: 1,
    messageId: input.messageId ?? 'message-1'
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** VAD speech start (3 voiced frames) then the endpoint (22 silent frames). */
async function speakAnUtterance(h: Harness, startAt: number): Promise<void> {
  h.helper.defaultProbability = 0.9
  for (let i = 0; i < 4; i += 1) h.push(512, startAt + i * 32)
  await h.host.flush()
  h.helper.defaultProbability = 0.1
  for (let i = 0; i < 22; i += 1) h.push(512, startAt + 200 + i * 32)
  await h.host.flush()
  h.helper.defaultProbability = 0.9
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test('defect 7: one finalized utterance produces exactly one message', async () => {
  const h = harness()
  await h.host.start('room-1')
  await speakAnUtterance(h, 1_000_000)

  assert.equal(h.sink.finals.length, 1)
  assert.equal(h.sink.finals[0]?.text, 'Maya, can you check the build?')
  assert.equal(h.sink.finals[0]?.roomId, 'room-1')
  assert.equal(h.sink.partials.length, 0)
  assert.equal(h.sink.speechStarts, 1)
  assert.equal(h.sink.speechEnds, 1)
  assert.deepEqual(
    h.helper.transcribeCalls.filter((call) => call.isFinal).map((call) => call.utteranceId),
    ['utt-1']
  )

  // Transcripts are live events too, but only finals carry isFinal: true.
  const transcripts = h.bus.emitted.filter((body) => body.type === 'voice.transcript')
  assert.deepEqual(
    transcripts.map((body) => (body as { transcript: { isFinal: boolean } }).transcript.isFinal),
    [true]
  )
})

test('defect 7: partials update live text and never become messages', async () => {
  const h = harness()
  await h.host.start('room-1')

  h.helper.defaultProbability = 0.9
  // 1024-sample pushes, one second apart, so partials fire on the cadence.
  for (let i = 0; i < 14; i += 1) h.push(1024, 2_000_000 + i * 1_000)
  await h.host.flush()

  assert.ok(h.sink.partials.length >= 1, 'a partial transcript is produced')
  assert.equal(h.sink.finals.length, 0, 'a partial is never a message')
  assert.equal(h.sink.partials[0]?.text, 'Maya, can you')
  assert.equal(
    h.sink.partials[0]?.utteranceId,
    h.bus.emitted
      .filter((body) => body.type === 'voice.transcript')
      .map((body) => (body as { transcript: { utteranceId: string } }).transcript.utteranceId)[0]
  )

  h.helper.defaultProbability = 0.1
  for (let i = 0; i < 22; i += 1) h.push(512, 2_020_000 + i * 32)
  await h.host.flush()

  assert.equal(h.sink.finals.length, 1, 'the finalized utterance is exactly one message')
  assert.equal(h.sink.finals[0]?.utteranceId, h.sink.partials[0]?.utteranceId)
})

test('defect 3: completion needs synthesis EOF and a drained buffer', async () => {
  const h = harness()
  await h.host.start('room-1')
  h.helper.autoFinish = false

  const speechIntent = intent({ agentId: 'agent-maya', reason: 'answer' })
  const handle = h.host.speak(speechIntent)
  await h.host.flush()
  assert.equal(
    h.serverEvents.some((event) => event.type === 'speech.synthesisEnded'),
    false,
    'synthesis is still streaming'
  )
  assert.deepEqual(
    h.serverEvents.filter((event) => event.type === 'speech.begin').map((event) => event.generationId),
    [handle.generationId]
  )

  h.helper.pushChunk(handle.generationId)
  assert.equal(h.audioChunks.length, 1)
  assert.equal(h.audioChunks[0]?.generationId, handle.generationId)

  let settled: { state: string; playedChars: number | null } | null = null
  void handle.done.then((result) => {
    settled = result
  })

  // The client's buffer drains before synthesis has ended: not completion.
  h.host.reportClientEvent({ type: 'playback.firstAudible', generationId: handle.generationId, at: 1 })
  h.host.reportClientEvent({ type: 'playback.drained', generationId: handle.generationId, playedMs: 120 })
  await settle()
  assert.equal(settled, null, 'an empty buffer must not end an unfinished utterance')

  h.helper.finish(handle.generationId)
  await h.host.flush()
  await settle()
  assert.deepEqual(settled, { state: 'played', playedChars: speechIntent.text.length })
  assert.ok(h.serverEvents.some((event) => event.type === 'speech.synthesisEnded'))
  assert.equal(h.bus.messagePatches.at(-1)?.patch.spoken?.state, 'played')
})

test('defect 2: barge-in stops synthesis while it is still streaming', async () => {
  const h = harness()
  await h.host.start('room-1')
  h.helper.autoFinish = false

  const handle = h.host.speak(intent({ agentId: 'agent-maya', reason: 'explain' }))
  await h.host.flush()
  h.helper.pushChunk(handle.generationId)
  const chunksBefore = h.audioChunks.length

  // The human talks over the agent: five 32 ms frames above the barge-in threshold.
  let settled: { state: string } | null = null
  const slot = { get: (): { state: string } | null => settled }
  void handle.done.then((result) => {
    settled = result
  })
  h.helper.defaultProbability = 0.9
  for (let i = 0; i < 6; i += 1) h.push(512, 3_000_000 + i * 32)
  await h.host.flush()
  await settle()

  assert.deepEqual(h.helper.cancelled, [{ generationId: handle.generationId, reason: 'bargeIn' }])
  assert.equal(slot.get()?.state, 'interrupted')
  assert.ok(
    h.serverEvents.some((event) => event.type === 'speech.cancel' && event.generationId === handle.generationId)
  )

  // Defect 4 at the host boundary: a late chunk from the cancelled generation is
  // never forwarded to the renderer.
  h.helper.pushChunk(handle.generationId)
  assert.equal(h.audioChunks.length, chunksBefore, 'late chunks stay dropped')
  assert.equal(h.bus.speech.some((entry) => entry.state === 'interrupted'), true)
})

test('defect 10: mute stops forwarding mic audio and cancels nothing', async () => {
  const h = harness()
  await h.host.start('room-1')
  const framesBefore = h.helper.frameCalls

  h.host.setMicMuted(true)
  h.push(1024, 4_000_000)
  await h.host.flush()
  assert.equal(h.helper.frameCalls, framesBefore, 'no audio is analysed while muted')
  assert.equal(h.helper.transcribeCalls.length, 0)
  assert.equal(h.helper.cancelled.length, 0, 'muting never cancels work')

  const handle = h.host.speak(intent({ agentId: 'agent-maya', reason: 'result' }))
  assert.notEqual(handle.generationId, '', 'agent speech is unaffected by the mute')

  h.host.setMicMuted(false)
  h.helper.defaultProbability = 0.9
  for (let i = 0; i < 4; i += 1) h.push(512, 4_100_000 + i * 32)
  await h.host.flush()
  assert.ok(h.helper.frameCalls > framesBefore, 'capture resumes on unmute')
})

test('defect 10: deafening drops queued speech without a backlog', async () => {
  const h = harness()
  await h.host.start('room-1')

  const first = h.host.speak(intent({ agentId: 'agent-maya', reason: 'answer' }))
  const second = h.host.speak(intent({ agentId: 'agent-alex', reason: 'result' }))
  h.host.setDeafened(true)

  assert.equal((await first.done).state, 'unheard')
  assert.equal((await second.done).state, 'unheard')
  assert.ok(
    h.serverEvents.some((event) => event.type === 'speech.cancel' && event.reason === 'deafen'),
    'the audible generation is cancelled'
  )
  const beginsWhileDeafened = h.serverEvents.filter((event) => event.type === 'speech.begin').length

  h.host.setDeafened(false)
  await h.host.flush()
  assert.equal(
    h.serverEvents.filter((event) => event.type === 'speech.begin').length,
    beginsWhileDeafened,
    'undeafening releases no backlog'
  )

  const third = h.host.speak(intent({ agentId: 'agent-maya', reason: 'answer' }))
  assert.equal(
    h.serverEvents.filter((event) => event.type === 'speech.begin').length,
    beginsWhileDeafened + 1
  )
  assert.notEqual(third.generationId, '')
})

test('defect 8: endpointing, dispatch and audible playback are timed separately', async () => {
  const h = harness()
  await h.host.start('room-1')
  await speakAnUtterance(h, 5_000_000)
  assert.equal(h.sink.finals.length, 1)

  h.advance(120)
  const handle = h.host.speak(intent({ agentId: 'agent-maya', reason: 'answer' }))
  await h.host.flush()
  h.advance(90)
  h.host.reportClientEvent({ type: 'playback.firstAudible', generationId: handle.generationId, at: 1 })
  await settle()

  const labels = h.bus.timings.map((sample) => `${sample.label}|${sample.detail ?? ''}`)
  assert.ok(
    h.bus.timings.some(
      (sample) => sample.label === 'utteranceEndToFinalTranscript' && sample.ms >= 0
    ),
    `endpointing must be measured, saw ${labels.join(', ')}`
  )
  assert.ok(
    h.bus.timings.some(
      (sample) =>
        sample.label === 'finalTranscriptToFirstAudioChunkPlayed' &&
        (sample.detail ?? '').startsWith('phase=dispatch')
    ),
    `the server dispatch hop must be measured, saw ${labels.join(', ')}`
  )
  assert.ok(
    h.bus.timings.some(
      (sample) =>
        sample.label === 'finalTranscriptToFirstAudioChunkPlayed' &&
        (sample.detail ?? '').startsWith('phase=audible')
    ),
    `the client audible hop must be measured, saw ${labels.join(', ')}`
  )
  assert.ok(h.host.timings().length >= 2)
  assert.ok(
    h.bus.emitted.some((body) => body.type === 'voice.timing' || body.type === 'voice.playback')
  )
})

test('defect 9: local VAD records the barge-in latency', async () => {
  const h = harness()
  await h.host.start('room-1')
  h.helper.autoFinish = false

  const handle = h.host.speak(intent({ agentId: 'agent-maya', reason: 'explain' }))
  await h.host.flush()
  h.host.reportClientEvent({ type: 'playback.firstAudible', generationId: handle.generationId, at: 1 })

  h.advance(1_000)
  h.helper.defaultProbability = 0.9
  let at = 5_500_000
  for (let i = 0; i < 6; i += 1) {
    h.advance(32)
    at += 32
    h.push(512, at)
  }
  await h.host.flush()

  const halt = h.bus.timings.find((sample) => sample.label === 'vadSpeechStartToPlaybackHalt')
  assert.ok(halt, 'the barge-in latency must be measured from local VAD, before any transcript')
  assert.ok(halt.ms >= 0 && halt.ms < 2_000)
  assert.equal(h.sink.speechStarts, 1, 'the human speech start is reported to the room')
})

test('capability: an unavailable voice helper is reported and no audio is faked', async () => {
  const failing = new FakeHelper()
  failing.startError = new HuddleError(
    'voice_helper_missing',
    'Could not start the voice helper with "node": spawn node ENOENT',
    'Install Node.js 20 or newer, or set HUDDLE_NODE to a node binary.'
  )
  const h = harness({ helper: failing, key: '' })
  await h.host.start('room-1')

  const capabilities = h.bus.capabilities()
  assert.ok(
    capabilities.some((capability) => capability.id === 'localSpeech' && capability.state === 'error' && capability.fix),
    'local speech must report a truthful error with a fix'
  )
  assert.ok(
    capabilities.some((capability) => capability.id === 'elevenlabs' && capability.state === 'unavailable'),
    'a missing ElevenLabs key must be reported before any synthesis is attempted'
  )
  assert.ok(h.bus.notices.length >= 1)

  const handle = h.host.speak(intent({ agentId: 'agent-maya', reason: 'answer' }))
  const result = await handle.done
  assert.ok(['error', 'unheard', 'cancelled'].includes(result.state), `unexpected ${result.state}`)
  assert.equal(h.audioChunks.length, 0, 'no PCM may be invented when voices are unavailable')
})

test('voice turned off in settings refuses to join without breaking typing', async () => {
  const h = harness({ enabled: false })
  let failure: unknown = null
  try {
    await h.host.start('room-1')
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof HuddleError)
  assert.equal((failure as HuddleError).code, 'voice_disabled')
  assert.ok((failure as HuddleError).fix)
  assert.equal(h.host.isActive(), false)
})

test('start and stop reset the VAD between sessions (defect 5)', async () => {
  const h = harness()
  await h.host.start('room-1')
  await speakAnUtterance(h, 6_000_000)
  assert.equal(h.sink.finals.length, 1)

  await h.host.stop()
  assert.ok(h.helper.resetCount >= 1, 'stopping must clear the model state')
  assert.equal(h.host.isActive(), false)

  await h.host.start('room-2')
  assert.ok(h.helper.resetCount >= 2, 'joining again starts from silence')
  assert.equal(h.host.activeRoomId(), 'room-2')
})

test('a full long utterance is segmented into messages instead of being dropped', async () => {
  const h = harness()
  await h.host.start('room-1')

  // One continuous breath of 26 s (over MAX_SEGMENT_SAMPLES of 22 s), voiced
  // throughout, with no VAD speech-end until the end.
  h.helper.defaultProbability = 0.9
  const frameSamples = 512
  const totalFrames = Math.ceil((26 * 16_000) / frameSamples)
  for (let i = 0; i < totalFrames; i += 1) {
    h.push(frameSamples, 7_000_000 + i * 32)
  }
  await h.host.flush()
  assert.ok(h.sink.finals.length >= 1, 'the segment that hit the limit must be transcribed')

  h.helper.defaultProbability = 0.1
  for (let i = 0; i < 22; i += 1) h.push(frameSamples, 7_000_000 + (totalFrames + i) * 32)
  await h.host.flush()

  assert.ok(h.sink.finals.length >= 2, 'the continuation of the same breath must not be lost')
  const ids = h.sink.finals.map((final) => final.utteranceId)
  assert.equal(new Set(ids).size, ids.length, 'each segment gets its own message id')
})
