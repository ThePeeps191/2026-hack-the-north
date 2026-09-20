/**
 * Gets a room to the state you actually want to be looking at when a judge
 * walks up or the recording starts: three teammates in the gallery, mid-work,
 * with real tool lines already scrolling.
 *
 * Doing this by hand costs about a minute of clicking and a minute of silence
 * while the team reads the project — which on camera is dead air, and in front
 * of a judge is the worst possible first impression.
 *
 * Usage, with the app already running on the debugging port:
 *
 *   npx electron . --remote-debugging-port=9222
 *   node scripts/demo-warm.mjs
 *
 * It exits once the teammates are genuinely working, and prints the one thing
 * that decides whether the demo lands: whether they are still busy.
 */

import { chromium } from 'playwright-core'

const PORT = process.env.HUDDLE_CDP_PORT ?? '9222'
const GOAL = process.argv.slice(2).join(' ') || 'Make voting anonymous in Sketch Night'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function bail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

let browser
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
} catch {
  bail(
    `Could not reach Huddle on port ${PORT}.\n` +
      `Start it first:  npx electron . --remote-debugging-port=${PORT}`
  )
}

const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().startsWith('file:'))
if (!page) bail('Huddle is running but its window was not found.')

console.log(`\nGoal: ${GOAL}\n`)
process.stdout.write('  creating the room...')

const room = await page.evaluate(async (goal) => {
  const r = await window.huddle.createRoom({ name: 'Sketch Night', agentCount: 3, goal })
  await window.huddle.selectRoom(r.id)
  const p = await window.huddle.createDemoProject(r.id)
  // The gallery is what you want on screen, not one teammate's workspace.
  await window.huddle.setStage({
    roomId: r.id,
    stage: { mode: { kind: 'gallery' }, follow: false, pendingHint: null }
  })
  return { roomId: r.id, project: p.project?.rootPath ?? null }
}, GOAL)

console.log(' done')
console.log(`  project: ${room.project}`)

const look = async () =>
  page.evaluate(async (roomId) => {
    const st = await window.huddle.getSnapshot()
    const agents = st.agents.filter((a) => a.roomId === roomId)
    return {
      agents: agents.map((a) => ({ name: a.name, state: a.workState })),
      busy: agents.filter((a) => a.workState !== 'idle' && a.workState !== 'offline').length,
      tools: st.toolRuns.filter((t) => t.roomId === roomId).length
    }
  }, room.roomId)

process.stdout.write('  waiting for the team to get to work')
let seen = null
for (let i = 0; i < 60; i += 1) {
  seen = await look()
  // Two teammates busy with real tool runs behind them is a good picture.
  if (seen.busy >= 2 && seen.tools >= 8) break
  process.stdout.write('.')
  await sleep(2000)
}
console.log('')

console.log('\n  ' + seen.agents.map((a) => `${a.name}: ${a.state}`).join('   '))
console.log(`  ${seen.tools} real tool runs so far\n`)

if (seen.busy >= 2) {
  console.log('READY — the gallery is showing and the team is working.')
  console.log('')
  console.log('Before you interrupt anyone, check the tile chip.')
  console.log('It must read THINKING / READING / EDITING / RUNNING — never IDLE.')
  console.log('Interrupting an idle teammate produces a reply but no redirect,')
  console.log('which is the one thing the demo is meant to show.')
} else {
  console.log('NOT READY — the team is idle.')
  console.log('Give them something first, for example:')
  console.log('  "Maya, implement the anonymous vote UI and update the tests."')
  console.log('Then wait for her chip to change before you talk over her.')
}

await browser.close()
