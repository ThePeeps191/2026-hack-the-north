/**
 * Live smoke test: one real agent vertical slice, end to end.
 *
 * This is the evidence script for "the model actually did the work":
 *
 *   1. bind a real project directory (a fresh copy of demo/sketch-night),
 *   2. send a human instruction,
 *   3. let the OpenAI-backed runtime choose and call real tools,
 *   4. wait for a grounded reply,
 *   5. print the real tool runs, job output, artifacts and speech intents.
 *
 * It talks to the live providers in `.env`. Everything it prints comes from the
 * real run: if something failed, the failure is printed instead of a summary.
 *
 * Usage:
 *   node --experimental-strip-types scripts/live-smoke.ts               # agent slice
 *   node --experimental-strip-types scripts/live-smoke.ts --browser     # + Browserbase
 *   node --experimental-strip-types scripts/live-smoke.ts --model=gpt-5.6-luna
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createBrowserHost } from '../src/main/browser/index.ts'
import { createExecutionHost } from '../src/main/exec/index.ts'
import { EventLog } from '../src/main/event-log.ts'
import { JsonSnapshotStore } from '../src/main/json-store.ts'
import { RoomService } from '../src/main/room-service.ts'
import { createAgentRuntime } from '../src/main/runtime/index.ts'
import type { SpeechHandle, SpeechIntent, VoiceHost } from '../src/main/contracts.ts'
import type { Capability, RuntimeEvent } from '../src/shared/types.ts'

const args = new Set(process.argv.slice(2))
const withBrowser = args.has('--browser')
const modelArg = [...args].find((arg) => arg.startsWith('--model='))?.slice('--model='.length)
const instruction = (() => {
  const inline = [...args].find((arg) => arg.startsWith('--say='))
  if (inline) return inline.slice('--say='.length)
  return (
    'Sketch Night is in this folder. Read the README and the feature notes, list what the app does, ' +
    'and tell me one concrete risk in the voting flow. Do not change any files yet.'
  )
})()

const root = join(process.cwd(), '.data', 'live-smoke')
const projectDir = join(root, 'sketch-night')
const stateDir = join(root, 'state')

function log(section: string, detail = ''): void {
  console.log(`\n=== ${section}${detail ? ` — ${detail}` : ''}`)
}

function record(events: RuntimeEvent[], event: RuntimeEvent): void {
  events.push(event)
  if (events.length > 4000) events.splice(0, events.length - 4000)
}

async function main(): Promise<void> {
  // A fresh room and a fresh copy of the demo project, so the run is repeatable
  // (binding refuses to copy the template over an existing folder).
  await rm(root, { recursive: true, force: true })
  await mkdir(stateDir, { recursive: true })

  const store = new JsonSnapshotStore(join(stateDir, 'huddle-state.json'))
  const service = await RoomService.open(store, {
    log: new EventLog(join(stateDir, 'events.jsonl'))
  })

  const model = modelArg ?? service.getSettings().models.contributor
  log('model', model)

  const events: RuntimeEvent[] = []
  service.subscribe((event) => record(events, event))

  // The runtime needs a capability answer before it will call the provider.
  service.setCapability({
    id: 'openai',
    label: 'OpenAI',
    state: 'ready',
    detail: 'assumed ready for the smoke run',
    fix: null,
    checkedAt: new Date().toISOString()
  })
  service.setCapability({
    id: 'elevenlabs',
    label: 'ElevenLabs speech',
    state: 'unavailable',
    detail: 'speech is recorded, not synthesised, in this smoke run',
    fix: null,
    checkedAt: new Date().toISOString()
  })

  const settings = (): ReturnType<RoomService['getSettings']> => service.getSettings()
  await service.updateSettings({ models: { contributor: model, conversation: model } })

  const exec = createExecutionHost({
    bus: service,
    capability: (id) => service.getCapability(id),
    settings
  })

  const speech: SpeechIntent[] = []
  const voiceStub: VoiceHost = {
    start: async () => undefined,
    stop: async () => undefined,
    isActive: () => false,
    activeRoomId: () => null,
    setMicMuted: () => undefined,
    setDeafened: () => undefined,
    pushMicFrame: () => undefined,
    reportClientEvent: () => undefined,
    speak: (intent: SpeechIntent): SpeechHandle => {
      speech.push(intent)
      return {
        generationId: `stub-${speech.length}`,
        done: Promise.resolve({ state: 'played', playedChars: intent.text.length })
      }
    },
    stopSpeaking: () => undefined,
    invalidateSpeechBefore: () => undefined,
    listVoices: async () => [],
    previewVoice: async () => undefined,
    timings: () => [],
    dispose: async () => undefined
  }

  const browser = createBrowserHost({ bus: service, exec, settings })

  const runtime = createAgentRuntime({
    bus: service,
    exec,
    browser,
    voice: voiceStub,
    capability: (id) => service.getCapability(id),
    settings
  })

  const room = service.snapshot().rooms[0]
  await runtime.attachRoom(room.id)

  log('binding project', projectDir)
  const binding = await exec.bindProject(room.id, projectDir, 'demo')
  await service.bindProject(room.id, binding)
  console.log(`bound ${binding.rootPath} (git: ${binding.isGitRepo})`)

  const team = await exec.ensureTeamWorkspace(room.id)
  console.log(`team workspace: ${team.rootPath} branch=${team.branch ?? '(none)'}`)

  const agents = service.getAgents(room.id)
  console.log(`roster: ${agents.map((agent) => `${agent.name}(${agent.role})`).join(', ')}`)

  log('human instruction')
  console.log(instruction)
  const message = await service.sendHumanMessage({
    roomId: room.id,
    body: instruction,
    clientRequestId: `smoke-${Date.now()}`,
    to: agents[0] ? [agents[0].id] : []
  })

  // The room stores the message; handing it to the team is the runtime's job.
  // The Electron app does this in the IPC layer on every human message.
  await runtime.handleHumanMessage({
    roomId: room.id,
    message,
    addressed: message.to
  })

  const deadline = Date.now() + 240_000
  const before = new Set(service.getMessages(room.id, 200).map((item) => item.id))

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const messages = service.getMessages(room.id, 200)
    const reply = messages.find(
      (item) => item.author.type === 'agent' && !before.has(item.id) && item.id !== message.id
    )
    if (reply) break
  }

  await new Promise((resolve) => setTimeout(resolve, 1500))

  log('tool runs')
  const toolRuns = service.getToolRuns(room.id)
  if (toolRuns.length === 0) {
    console.log('NONE — the model did not call any tool.')
  }
  for (const run of toolRuns) {
    console.log(
      `${run.status.padEnd(9)} ${run.name} ${run.argsPreview.slice(0, 120)}${run.error ? ` :: ${run.error}` : ''}`
    )
  }

  log('jobs')
  for (const job of service.getJobs(room.id)) {
    console.log(`${job.status.padEnd(9)} ${job.label}: ${job.command} (exit ${job.exitCode ?? 'n/a'})`)
  }

  log('conversation')
  for (const item of service.getMessages(room.id, 200)) {
    const who =
      item.author.type === 'human'
        ? 'human'
        : item.author.type === 'agent'
          ? (service.getAgent(item.author.agentId)?.name ?? 'agent')
          : 'system'
    console.log(`[${who}/${item.kind}] ${item.body.slice(0, 400)}`)
  }

  log('speech intents')
  if (speech.length === 0) console.log('none requested')
  for (const intent of speech) {
    console.log(`${intent.reason}: "${intent.text.slice(0, 200)}"`)
  }

  log('tasks and decisions')
  for (const task of service.getTasks(room.id)) {
    console.log(`${task.status.padEnd(14)} ${task.title} (rev ${task.decisionRevision})`)
  }
  for (const decision of service.getDecisions(room.id)) {
    console.log(`rev ${decision.revision}: ${decision.title}`)
  }

  if (withBrowser) {
    log('browserbase')
    try {
      const preview = await exec.startPreview(room.id, team.id)
      console.log(`preview: ${preview.state} local=${preview.localUrl} public=${preview.publicUrl ?? 'none'}`)
      console.log(`detail: ${preview.detail}`)
      if (preview.publicUrl) {
        const session = await browser.openSession({
          roomId: room.id,
          agentId: agents[2]?.id ?? agents[0].id,
          url: preview.publicUrl
        })
        console.log(`session ${session.status}: ${session.currentUrl ?? 'no url'} — ${session.detail}`)
        const observation = await browser.observe(session.id)
        console.log(`title: ${observation.title}`)
        console.log(`elements: ${observation.elements.slice(0, 8).map((el) => el.ref).join(', ')}`)
        const shot = await browser.screenshot(session.id)
        console.log(`screenshot: ${shot.viewport.width}x${shot.viewport.height} -> ${shot.artifact.path ?? '(inline)'}`)
        await browser.closeSession(session.id)
        console.log('session closed')
      }
      await exec.stopPreview(room.id)
    } catch (error) {
      console.log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  log('capabilities as the room saw them')
  for (const capability of service.getCapabilities() as Capability[]) {
    console.log(`${capability.id}: ${capability.state} — ${capability.detail}`)
  }

  await runtime.dispose()
  await browser.dispose()
  await exec.dispose()
  await service.dispose()
}

main().catch((error: unknown) => {
  console.error('\nSMOKE RUN FAILED')
  console.error(error)
  process.exitCode = 1
})
