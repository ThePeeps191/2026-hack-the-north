import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VoicePlayback } from './playback.ts'

function fixture() {
  let amplitude = 0
  const context = {
    state: 'running', sampleRate: 24000, currentTime: 0, destination: {},
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    createAnalyser: () => ({ fftSize: 256, connect() {}, getFloatTimeDomainData(buffer: Float32Array) { buffer.fill(amplitude) } }),
    createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => ({ buffer: null, connect() {}, start() {}, stop() {}, onended: null })
  } as unknown as AudioContext
  const playback = new VoicePlayback({ now: () => 0, createContext: () => context, callbacks: { report() {}, onAudible() {}, onDrained() {}, onHalted() {}, onError() {} } })
  playback.begin({ generationId: 'g', agentId: 'maya', text: 'Hello', messageId: null, sampleRate: 24000 })
  playback.push({ generationId: 'g', pcm: new Int16Array([100, -100]).buffer } as Parameters<VoicePlayback['push']>[0])
  return { playback, context, amplitude(value: number) { amplitude = value } }
}

test('output level follows measured playback samples, including silence', () => {
  const f = fixture()
  f.amplitude(0.25)
  assert.equal(f.playback.outputLevel(), 0.25)
  f.amplitude(0)
  assert.equal(f.playback.outputLevel(), 0)
})

test('halted, deafened and suspended output cannot show a speaking level', () => {
  const f = fixture()
  f.amplitude(0.5)
  Object.assign(f.context, { state: 'suspended' })
  assert.equal(f.playback.outputLevel(), 0)
  Object.assign(f.context, { state: 'running' })
  f.playback.setDeafened(true)
  assert.equal(f.playback.outputLevel(), 0)
  f.playback.setDeafened(false)
  assert.equal(f.playback.outputLevel(), 0)
})
