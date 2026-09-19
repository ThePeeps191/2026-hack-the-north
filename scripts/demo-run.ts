/**
 * End-to-end demo run inside the real Electron app.
 *
 * This drives the actual user interface — it clicks the real "Use demo" control
 * and types into the real composer — and then reports what the team actually
 * did: tool runs, touched files, tasks, decisions and the written reply.
 *
 * Usage:
 *   1. npx electron . --remote-debugging-port=9222
 *   2. node --experimental-transform-types scripts/demo-run.ts ["your instruction"]
 *
 * Everything it prints is read back from the app's own state. If the team did
 * nothing, it says so and exits non-zero.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright-core'

const instructions = process.argv
  .filter((argument) => argument.startsWith('--say='))
  .map((argument) => argument.slice('--say='.length))

const instruction = instructions.length > 0
  ? instructions[0]
  : process.argv.slice(2).find((argument) => !argument.startsWith('--')) ??
    'Maya, read README.md and FEATURE_NOTES.md, then tell me in two sentences what this app does and one concrete risk in the voting flow. Do not change any files yet.'

const budgetMs = Number(
  process.argv.find((argument) => argument.startsWith('--budget='))?.slice('--budget='.length) ??
    300_000
)

const outDir = join(process.cwd(), '.data', 'build', 'demo')

interface Snapshot {
  rooms: Array<{ id: string; name: string; project: { rootPath: string; isGitRepo: boolean } | null }>
  selectedRoomId: string | null
  agents: Array<{ id: string; name: string; workState: string; activityLabel: string; connected: boolean }>
  messages: Array<{
    id: string
    author: { type: string; agentId?: string }
    kind: string
    body: string
    spoken?: { state: string; generationId: string } | null
    refs?: Array<{ kind: string }> | null
  }>
  toolRuns: Array<{ name: string; status: string; summary: string; argsPreview: string; error: string | null }>
  tasks: Array<{ title: string; status: string; ownerAgentId: string | null }>
  decisions: Array<{ revision: number; title: string }>
  jobs: Array<{ label: string; command: string; status: string; exitCode: number | null }>
  workspaces: Array<{ kind: string; branch: string | null; rootPath: string }>
  artifacts: Array<{ kind: string; title: string }>
  integrations: Array<{ status: string; revision: string | null; checks: Array<{ name: string; status: string }> }>
  notices: string[]
}

async function readSnapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const state = await window.huddle.getSnapshot()
    return {
      rooms: state.rooms.map((room) => ({
        id: room.id,
        name: room.name,
        project: room.project
          ? { rootPath: room.project.rootPath, isGitRepo: room.project.isGitRepo }
          : null
      })),
      selectedRoomId: state.selectedRoomId,
      agents: state.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        workState: agent.workState,
        activityLabel: agent.activityLabel,
        connected: agent.connected
      })),
      messages: state.messages.map((message) => ({
        id: message.id,
        author: message.author,
        kind: message.kind,
        body: message.body,
        spoken: message.spoken ? { state: message.spoken.state, generationId: message.spoken.generationId } : null,
        refs: message.refs ? message.refs.map((ref) => ({ kind: ref.kind })) : null
      })),
      toolRuns: state.toolRuns.map((run) => ({
        name: run.name,
        status: run.status,
        summary: run.summary,
        argsPreview: run.argsPreview,
        error: run.error
      })),
      tasks: state.tasks.map((task) => ({
        title: task.title,
        status: task.status,
        ownerAgentId: task.ownerAgentId
      })),
      decisions: state.decisions.map((decision) => ({ revision: decision.revision, title: decision.title })),
      jobs: state.jobs.map((job) => ({
        label: job.label,
        command: job.command,
        status: job.status,
        exitCode: job.exitCode
      })),
      workspaces: state.workspaces.map((workspace) => ({
        kind: workspace.kind,
        branch: workspace.branch,
        rootPath: workspace.rootPath
      })),
      artifacts: state.artifacts.map((artifact) => ({ kind: artifact.kind, title: artifact.title })),
      integrations: state.integrations.map((attempt) => ({
        status: attempt.status,
        revision: attempt.revision,
        checks: attempt.checks.map((check) => ({ name: check.name, status: check.status }))
      })),
      notices: state.events
        .filter((event) => event.type === 'notice')
        .slice(-6)
        .map((event) => (event as { level: string; text: string }).text)
    }
  })
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true })
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith('file://'))
  if (!page) throw new Error('no Huddle window found on the debugging port')

  const before = await readSnapshot(page)
  const room = before.rooms.find((candidate) => candidate.id === before.selectedRoomId)
  console.log(`room: ${room?.name ?? '(none)'}`)

  if (!room?.project) {
    console.log('binding the demo project through the real "Use demo" control…')
    await page.getByRole('button', { name: /use demo/i }).first().click()
    const deadline = Date.now() + 90_000
    let bound = false
    while (Date.now() < deadline) {
      await page.waitForTimeout(1500)
      const snapshot = await readSnapshot(page)
      const current = snapshot.rooms.find((candidate) => candidate.id === snapshot.selectedRoomId)
      if (current?.project) {
        console.log(`bound: ${current.project.rootPath} (git: ${current.project.isGitRepo})`)
        bound = true
        break
      }
    }
    if (!bound) throw new Error('the demo project was never bound')
  }

  const afterBind = await readSnapshot(page)
  console.log(`workspaces: ${afterBind.workspaces.map((workspace) => `${workspace.kind}${workspace.branch ? `@${workspace.branch}` : ''}`).join(', ') || 'none yet'}`)

  console.log('\n--- instruction, typed into the real composer ---')
  console.log(instruction)
  const composer = page.locator('.hs-composer textarea, .hs-composer input[type="text"]').first()
  await composer.click()
  await composer.fill(instruction)
  await composer.press('Enter')

  const known = new Set(afterBind.messages.map((message) => message.id))
  const started = Date.now()
  let reply: Snapshot['messages'][number] | null = null
  let latest: Snapshot['messages'][number] | null = null
  const seenToolRuns = new Set<string>()

  while (Date.now() - started < budgetMs) {
    await page.waitForTimeout(2000)
    const snapshot = await readSnapshot(page)
    for (const run of snapshot.toolRuns) {
      const key = `${run.name}:${run.argsPreview}`
      if (seenToolRuns.has(key)) continue
      seenToolRuns.add(key)
      console.log(`  [tool] ${run.status.padEnd(9)} ${run.name} ${run.argsPreview.slice(0, 110)}${run.error ? ` :: ${run.error.slice(0, 120)}` : ''}`)
    }
    const fresh = snapshot.messages.filter(
      (message) => !known.has(message.id) && message.author.type === 'agent'
    )
    // The acknowledgement is not the answer: wait for the run's report. An agent
    // that closes its task mid-run still writes the report afterwards.
    const settled = fresh.find((message) => message.kind === 'result' || message.kind === 'answer')
    if (settled) {
      reply = settled
      break
    }
    latest = fresh[fresh.length - 1] ?? latest
  }

  const final = await readSnapshot(page)
  console.log(`\n--- what actually happened (${Math.round((Date.now() - started) / 1000)}s) ---`)

  console.log('\ntool runs:')
  if (final.toolRuns.length === 0) console.log('  none — the model called no tools')
  for (const run of final.toolRuns) {
    console.log(`  ${run.status.padEnd(9)} ${run.name} :: ${run.summary.slice(0, 120)}${run.error ? ` [${run.error.slice(0, 100)}]` : ''}`)
  }

  console.log('\nwritten replies:')
  for (const message of final.messages.filter((item) => item.author.type === 'agent')) {
    const who = final.agents.find((agent) => agent.id === message.author.agentId)?.name ?? 'agent'
    console.log(`  [${who}/${message.kind}] ${message.body.replace(/\n+/g, ' ').slice(0, 400)}`)
    if (message.spoken) console.log(`      spoken: ${message.spoken.state}`)
    if (message.refs?.length) console.log(`      refs: ${message.refs.map((ref) => ref.kind).join(', ')}`)
  }

  console.log('\ntasks:')
  for (const task of final.tasks) {
    const owner = final.agents.find((agent) => agent.id === task.ownerAgentId)?.name ?? 'unowned'
    console.log(`  ${task.status.padEnd(14)} ${task.title.slice(0, 90)} (${owner})`)
  }

  console.log('\njobs:')
  for (const job of final.jobs) {
    console.log(`  ${job.status.padEnd(9)} ${job.label}: ${job.command} (exit ${job.exitCode ?? 'n/a'})`)
  }

  console.log('\ndecisions:')
  for (const decision of final.decisions) console.log(`  rev ${decision.revision}: ${decision.title}`)

  console.log('\nartifacts:')
  for (const artifact of final.artifacts) console.log(`  ${artifact.kind}: ${artifact.title}`)

  console.log('\nrecent notices:')
  for (const notice of final.notices) console.log(`  - ${notice}`)

  await writeFile(
    join(outDir, 'run.json'),
    `${JSON.stringify({ instruction, afterBind, final, reply }, null, 2)}\n`,
    'utf8'
  )
  await page.screenshot({ path: join(outDir, 'after-run.png') })

  if (!reply) {
    console.log('\nNO FINAL REPORT — the team did not finish a turn inside the budget.')
    if (latest) console.log(`last agent message: ${latest.body.replace(/\s+/g, ' ').slice(0, 300)}`)
    process.exitCode = 1
  } else {
    console.log('\nthe team replied. Evidence written to .data/build/demo/run.json')
  }

  // Deliberately no `browser.close()`: over CDP that closes the Electron app
  // itself, which is the window we are inspecting. The explicit exit also drops
  // the debugging connection so this script cannot hang on it.
  process.exit(process.exitCode ?? 0)
}

main().catch((error: unknown) => {
  console.error('\nDEMO RUN FAILED')
  console.error(error)
  process.exitCode = 1
})

// A background failure in the room (a dropped provider call, a cancelled run)
// must be visible here rather than silently changing the exit status.
process.on('unhandledRejection', (reason: unknown) => {
  console.error('\nUNHANDLED REJECTION while driving the app:')
  console.error(reason)
  process.exitCode = 1
})
