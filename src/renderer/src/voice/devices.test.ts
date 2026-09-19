import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectOutputDevice } from './devices.ts'

test('uses the selected playback output device', async () => {
  let selected = ''
  await selectOutputDevice({ setSinkId: async (id: string) => { selected = id } }, 'headphones')
  assert.equal(selected, 'headphones')
})
test('reports unavailable output selection instead of silently using another device', async () => {
  await assert.rejects(selectOutputDevice({}, 'headphones'), /output device/)
  await selectOutputDevice({}, null)
})
