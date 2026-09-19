import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createActions } from './actions.ts'
import type { CallState } from '../../../shared/types.ts'

test('failed sends reject so the composer can retain its draft and show the failure', async () => {
  const errors: Array<string | null> = []
  Object.assign(globalThis, { window: { huddle: { sendMessage: async () => { throw new Error('Disk is full') } } } })
  const actions = createActions({ roomId: 'room', getCall: () => ({} as CallState), setError: e => errors.push(e) })
  await assert.rejects(actions.sendMessage('Keep my draft', { refs: [] }), /Disk is full/)
  assert.deepEqual(errors, ['Disk is full'])
})

test('failed settings and secret writes reject rather than claim saved', async () => {
  Object.assign(globalThis, { window: { huddle: { settings: {
    update: async () => { throw new Error('Cannot save settings') },
    setSecret: async () => { throw new Error('Cannot save key') }
  } } } })
  const actions = createActions({ roomId: 'room', getCall: () => ({} as CallState), setError() {} })
  await assert.rejects(actions.updateSettings({}), /Cannot save settings/)
  await assert.rejects(actions.setSecret('OPENAI_API_KEY', 'test-value'), /Cannot save key/)
})

test('successful sends resolve and clear the preceding error', async () => {
  const errors: Array<string | null> = []
  let body = ''
  Object.assign(globalThis, { window: { huddle: { sendMessage: async (input: { body: string }) => { body = input.body } } } })
  const actions = createActions({ roomId: 'room', getCall: () => ({} as CallState), setError: e => errors.push(e) })
  await actions.sendMessage('Hello')
  assert.equal(body, 'Hello')
  assert.deepEqual(errors, [null])
})

test('call controls reach local audio capture and playback as well as the backend', async () => {
  const calls: string[] = []
  const voice = { start: async (id: string) => { calls.push(`start:${id}`) }, stop: async () => { calls.push('stop') }, setMicMuted: async (v: boolean) => { calls.push(`mic:${v}`) }, setDeafened: async (v: boolean) => { calls.push(`deafen:${v}`) }, stopSpeaking: async (scope: string) => { calls.push(`speech:${scope}`) } }
  const actions = createActions({ roomId: 'room', getCall: () => ({ micMuted: false, deafened: false } as CallState), setError() {}, voice })
  await actions.joinCall()
  await actions.toggleMic()
  await actions.toggleDeafen()
  await actions.stopSpeaking('all')
  await actions.leaveCall()
  assert.deepEqual(calls, ['start:room', 'mic:true', 'deafen:true', 'speech:all', 'stop'])
})
