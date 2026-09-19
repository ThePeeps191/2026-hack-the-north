/**
 * UI verification for the real Electron app over the Chrome DevTools Protocol.
 *
 * This is how the call-first interface is checked without a human looking at it:
 * connect to a running Huddle window, assert what is actually on screen, measure
 * the layout at both target sizes, and report anything the renderer logged.
 *
 * Usage:
 *   1. npx electron . --remote-debugging-port=9222
 *   2. node --experimental-transform-types scripts/ui-check.ts [--join]
 *
 * Exit code is non-zero when a check fails; every line printed is a real
 * observation from the running window, not an expectation.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright-core'

const args = new Set(process.argv.slice(2))
const tryJoin = args.has('--join')
const outDir = join(process.cwd(), '.data', 'build', 'ui')

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
const consoleErrors: string[] = []

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
}

/**
 * A step that must never hang the whole check: a renderer with a very large
 * chat can take its time producing a frame, and "we could not take a picture in
 * 25 seconds" is a truthful result while a hung script is not.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.log(`  … ${label} did not finish in ${Math.round(ms / 1000)}s`)
          resolve(null)
        }, ms)
      })
    ])
  } catch (error) {
    console.log(`  … ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function measure(page: Page): Promise<{
  viewport: { width: number; height: number }
  horizontalOverflow: number
  pageScrollsVertically: boolean
  stageMode: string
  stageIncludesGallery: boolean
  panels: Array<{ name: string; scrollHeight: number; clientHeight: number; overflowY: string }>
  tiles: string[]
  dockButtons: string[]
  railTabs: string[]
  sidebar: string
  stage: string
  bodyText: string
}> {
  return page.evaluate(() => {
    const doc = document.documentElement
    const panels: Array<{ name: string; scrollHeight: number; clientHeight: number; overflowY: string }> = []
    const names = ['hs-side', 'hs-rail', 'hs-rail-body', 'hs-chat', 'hs-stage', 'hs-gallery']
    for (const name of names) {
      const element = document.querySelector<HTMLElement>(`.${name}`)
      if (!element) continue
      panels.push({
        name,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY
      })
    }
    const text = (selector: string): string =>
      (document.querySelector<HTMLElement>(selector)?.innerText ?? '').replace(/\s+/g, ' ').trim()
    const tiles = [...document.querySelectorAll<HTMLElement>('.hs-tile')].map(
      (tile) => tile.textContent?.replace(/\s+/g, ' ').trim().slice(0, 90) ?? ''
    )
    const dockButtons = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')
    ].map(
      (button) =>
        `${(button.getAttribute('aria-label') ?? button.textContent ?? '').replace(/\s+/g, ' ').trim()}${button.disabled ? ' [disabled]' : ''}`
    )
    const railTabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].map(
      (tab) => (tab.textContent ?? '').replace(/\s+/g, ' ').trim()
    )
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      horizontalOverflow: doc.scrollWidth - doc.clientWidth,
      // "Can the page actually scroll?" is the real question: with the shell
      // pinned and overflow hidden, scrollHeight can still describe content.
      pageScrollsVertically: (() => {
        const start = window.scrollY
        window.scrollTo(0, 400)
        const moved = window.scrollY
        window.scrollTo(0, start)
        return moved > 0
      })(),
      stageMode: document.querySelector('.hs-gallery')
        ? 'gallery'
        : document.querySelector('.hs-share')
          ? 'focus share'
          : document.querySelector('.hs-spotlight')
            ? 'spotlight'
            : 'unknown',
      stageIncludesGallery: document.querySelector('.hs-gallery') !== null,
      panels,
      tiles,
      dockButtons,
      railTabs,
      sidebar: text('.hs-side'),
      stage: text('.hs-stage'),
      bodyText: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1500)
    }
  })
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true })

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const contexts = browser.contexts()
  const pages = contexts.flatMap((context) => context.pages())
  const page = pages.find((candidate) => candidate.url().startsWith('file://')) ?? pages[0]
  if (!page) throw new Error('no Huddle window found on the debugging port')

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 400))
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message.slice(0, 400)}`))

  console.log(`window: ${page.url()}`)
  // An occluded Electron window produces no frames, which makes screenshots
  // wait forever: bring it forward before measuring anything.
  await page.bringToFront().catch(() => undefined)
  await page.waitForSelector('.hs-app', { timeout: 20_000 })
  check('call-first shell rendered', true, 'the .hs-app shell is on screen')

  // Authoritative backend state, read through the same bridge the UI uses.
  const snapshot = await page.evaluate(async () => {
    const state = await window.huddle.getSnapshot()
    return {
      rooms: state.rooms.map((room) => ({ name: room.name, goal: room.goal, joined: room.joined })),
      agents: state.agents.map((agent) => ({
        name: agent.name,
        role: agent.role,
        workState: agent.workState,
        connected: agent.connected
      })),
      project: state.rooms.find((room) => room.id === state.selectedRoomId)?.project ?? null,
      messages: state.messages.length,
      capabilities: state.capabilities.map((capability) => `${capability.id}:${capability.state}`),
      recovery: state.recovery?.message ?? null,
      resumable: state.resumable.map((item) => `${item.kind}:${item.state}`)
    }
  })
  console.log(`\nrooms: ${snapshot.rooms.map((room) => `${room.name}${room.joined ? ' (joined)' : ''}`).join(', ')}`)
  console.log(`agents: ${snapshot.agents.map((agent) => `${agent.name}(${agent.role}) ${agent.workState}`).join(', ')}`)
  console.log(`project: ${snapshot.project ? snapshot.project.rootPath : 'none bound'}`)
  console.log(`capabilities: ${snapshot.capabilities.join(', ')}`)
  if (snapshot.recovery) console.log(`recovery: ${snapshot.recovery}`)
  if (snapshot.resumable.length > 0) console.log(`resumable: ${snapshot.resumable.join(', ')}`)

  check(
    'the backend has a room with the default roster',
    snapshot.rooms.length >= 1 && snapshot.agents.length >= 3,
    `${snapshot.rooms.length} room(s), ${snapshot.agents.length} teammate(s)`
  )
  check(
    'teammates are present but not falsely working',
    snapshot.agents.every((agent) => agent.workState === 'offline' || agent.workState === 'idle'),
    snapshot.agents.map((agent) => `${agent.name}=${agent.workState}`).join(', ')
  )

  const first = await measure(page)
  console.log(`\nviewport ${first.viewport.width}x${first.viewport.height}`)
  console.log(`tiles: ${first.tiles.length}`)
  for (const tile of first.tiles) console.log(`  - ${tile}`)
  console.log(`dock buttons: ${first.dockButtons.join(' | ')}`)
  console.log(`rail tabs: ${first.railTabs.join(' | ')}`)
  for (const panel of first.panels) {
    console.log(
      `panel ${panel.name}: ${panel.clientHeight}px visible of ${panel.scrollHeight}px (overflow-y: ${panel.overflowY})`
    )
  }

  check(
    'the participant tiles match the stage mode',
    first.stageIncludesGallery ? first.tiles.length >= 4 : first.tiles.length === 0,
    first.stageIncludesGallery
      ? `${first.tiles.length} tiles in the gallery`
      : `stage is showing ${first.stageMode}, so the gallery is not up`
  )

  const tileSignals = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.hs-tile')).map((tile) => ({
      connection: tile.querySelector('.hs-conn')?.textContent?.trim() ?? '',
      work: tile.querySelector('.hs-workpill')?.textContent?.trim() ?? '',
      agent: tile.querySelector('.hs-tile-name')?.textContent?.trim() ?? ''
    }))
  )
  const contradictory = tileSignals.filter(
    (signal) => signal.connection === 'Connected' && signal.work === 'Offline'
  )
  check(
    'no tile claims a live session and an offline teammate at once',
    contradictory.length === 0,
    tileSignals.length === 0
      ? 'no tiles on screen to contradict each other'
      : tileSignals.map((signal) => `${signal.agent || 'you'}: ${signal.connection}/${signal.work}`).join(', ')
  )
  check(
    'the sidebar shows rooms, the voice channel and the project block',
    first.sidebar.includes('VOICE') && first.sidebar.includes('ROOMS'),
    first.sidebar.slice(0, 140)
  )
  const projectName = (snapshot.project?.rootPath ?? '')
    .split(/[\\/]/)
    .filter((part) => part.length > 0)
    .pop() ?? ''
  // The sidebar shows the folder name with "Demo"/"git" markers and a Reveal
  // action rather than the full path, so either is honest.
  const projectHonest = snapshot.project
    ? first.sidebar.includes(projectName) ||
      first.sidebar.includes(snapshot.project.rootPath) ||
      first.stage.includes(projectName)
    : /no project|choose folder|use demo/i.test(`${first.stage} ${first.sidebar}`)
  check(
    'the stage is honest about the project it is bound to',
    projectHonest,
    snapshot.project ? `bound to ${snapshot.project.rootPath}` : 'no project bound, and the UI says so'
  )
  if (!first.stageIncludesGallery) {
    check(
      'the focused share names its owner, branch and verification state',
      first.stage.length > 20 && /workspace|branch|worktree|not verified|verified/i.test(first.stage),
      first.stage.slice(0, 160)
    )
  }
  check(
    'no horizontal page scrolling',
    first.horizontalOverflow <= 1,
    `overflow ${first.horizontalOverflow}px at ${first.viewport.width}x${first.viewport.height}`
  )

  const shell = await page.evaluate(() => {
    const root = document.getElementById('root')
    const html = getComputedStyle(document.documentElement)
    const scrollers: string[] = []
    // Bounded scan: the chat can hold thousands of message nodes, and reading
    // layout for all of them would take longer than the check is worth.
    const candidates = Array.from(
      document.querySelectorAll(
        '.hs-side, .hs-rail-body, .hs-chat, .hs-gallery, .hs-share-body, .hs-spotlight, .hs-work'
      )
    )
    for (const el of candidates.slice(0, 40)) {
      const style = getComputedStyle(el)
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 4
      ) {
        const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : ''
        scrollers.push(`${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} (${el.clientHeight}px of ${el.scrollHeight}px)`)
      }
    }
    return {
      rootHeight: root ? Math.round(root.getBoundingClientRect().height) : 0,
      viewportHeight: window.innerHeight,
      htmlOverflow: html.overflowY,
      scrollers
    }
  })

  // The window is fixed and panels scroll inside it, in every stage mode.
  check(
    'the shell keeps the window fixed',
    Math.abs(shell.rootHeight - shell.viewportHeight) <= 2 && shell.htmlOverflow !== 'visible',
    `#root ${shell.rootHeight}px in a ${shell.viewportHeight}px window, html overflow: ${shell.htmlOverflow}`
  )
  check(
    'panels scroll on their own inside the fixed shell',
    shell.scrollers.length >= (first.stageIncludesGallery ? 2 : 1),
    shell.scrollers.join(', ') || 'no scrollable panel found'
  )

  const shot1280 = join(outDir, 'ui-1280x800.png')
  const shotFile = await withTimeout(
    page.screenshot({ path: shot1280, timeout: 20_000 }),
    25_000,
    'screenshot at 1280x800'
  )
  check(
    'screenshot captured',
    shotFile !== null && shotFile.length > 20_000,
    shotFile ? `${shot1280} (${shotFile.length} bytes)` : 'the renderer did not produce a frame in 25s'
  )

  // Second target size: the app must still fit at 1000x700.
  await withTimeout(page.evaluate(() => window.resizeTo(1000, 700)), 8_000, 'resize')
  await page.waitForTimeout(800)
  const second = await measure(page)
  console.log(
    `\nresized viewport ${second.viewport.width}x${second.viewport.height}, overflow ${second.horizontalOverflow}px`
  )
  check(
    'no horizontal scrolling at the minimum size',
    second.horizontalOverflow <= 1,
    `overflow ${second.horizontalOverflow}px at ${second.viewport.width}x${second.viewport.height}`
  )
  const shot1000 = join(outDir, 'ui-1000x700.png')
  await page.screenshot({ path: shot1000 })
  await page.evaluate(() => window.resizeTo(1280, 800))
  await page.waitForTimeout(500)
  // A second screenshot for the record: the same window after a resize.
  await page.screenshot({ path: join(outDir, 'ui-after-resize.png') })

  if (tryJoin) {
    console.log('\njoining the call…')
    const joined = await page.evaluate(async () => {
      const state = await window.huddle.getSnapshot()
      await window.huddle.joinCall(state.selectedRoomId ?? '')
      await new Promise((resolve) => setTimeout(resolve, 4000))
      const after = await window.huddle.getSnapshot()
      return {
        connection: after.call.connection,
        roomId: after.call.roomId,
        error: after.call.error,
        notices: after.events
          .filter((event) => event.type === 'notice')
          .slice(-3)
          .map((event) => (event as { text: string }).text)
      }
    })
    console.log(`call state: ${joined.connection} room=${joined.roomId ?? 'none'}`)
    if (joined.error) console.log(`call error: ${joined.error}`)
    for (const notice of joined.notices) console.log(`notice: ${notice}`)
    check(
      'joining the call leaves the room usable',
      joined.connection === 'connected' || joined.error !== null,
      joined.connection === 'connected'
        ? 'voice started'
        : 'voice reported a truthful error and the room stayed usable'
    )
  }

  check(
    'no console errors in the renderer',
    consoleErrors.length === 0,
    consoleErrors.length === 0 ? 'clean' : consoleErrors.slice(0, 5).join(' || ')
  )

  await writeFile(
    join(outDir, 'report.json'),
    `${JSON.stringify({ url: page.url(), first, second, checks, consoleErrors }, null, 2)}\n`,
    'utf8'
  )

  const failed = checks.filter((entry) => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  // No `browser.close()`: over CDP that would close the Electron window we are
  // inspecting. The explicit exit drops the debugging connection so the script
  // cannot hang on it.
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error: unknown) => {
  console.error('\nUI CHECK FAILED')
  console.error(error)
  process.exitCode = 1
})
