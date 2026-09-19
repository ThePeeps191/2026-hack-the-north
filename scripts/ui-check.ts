/** Read-only layout checks against the real Electron window. No fixtures or state injection. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright-core'

const outDir = join(process.cwd(), '.data', 'build', 'ui')
const checks: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
}
async function measure(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
    const overflows = [...document.querySelectorAll('.hs-rail-tabs, .hs-share-tabs, .hs-share-owners, .hs-dock, [role="tablist"]')]
      .filter(visible).filter(el => el.scrollWidth > el.clientWidth + 1)
      .map(el => `${el.className}: ${el.scrollWidth - el.clientWidth}px`)
    const clipped = [...document.querySelectorAll('.hs-composer button, .hs-dock button, [role="tab"]')]
      .filter(visible).filter(el => {
        const r = el.getBoundingClientRect()
        if (r.left < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) return true
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent)
          const p = parent.getBoundingClientRect()
          if (/(hidden|clip|auto|scroll)/.test(style.overflowX) && (r.left < p.left - 1 || r.right > p.right + 1)) return true
        }
        return false
      }).map(el => el.getAttribute('aria-label') || el.textContent?.trim() || 'unnamed control')
    const unnamed = [...document.querySelectorAll('button')].filter(visible).filter(el =>
      !el.getAttribute('aria-label') && !el.getAttribute('title') && !el.textContent?.trim()
    ).length
    const root = document.getElementById('root')!
    const viewH = document.documentElement.clientHeight
    const viewW = document.documentElement.clientWidth
    const rootH = root.getBoundingClientRect().height
    const htmlOverflow = getComputedStyle(document.documentElement).overflowY
    const bodyOverflow = getComputedStyle(document.body).overflowY
    const locked = htmlOverflow === 'hidden' || htmlOverflow === 'clip'
    const grows = !locked && (document.documentElement.scrollHeight > viewH + 2 || document.body.scrollHeight > viewH + 2)
    return { width: innerWidth, height: innerHeight, pageOverflow: document.documentElement.scrollWidth - viewW,
      rootH, viewH, grows, locked, fixed: Math.abs(rootH - viewH) <= 4 && !grows,
      overflows, clipped, unnamed,
      gallery: !!document.querySelector('.hs-gallery'), spotlight: !!document.querySelector('.hs-spotlight'),
      tiles: document.querySelectorAll('.hs-tile').length,
      sidebar: document.querySelector('.hs-side')?.textContent ?? '',
      composer: !!document.querySelector('.hs-composer textarea'),
      markdown: document.querySelectorAll('.hs-markdown, .hs-md').length }
  })
}
async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true })
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('file:')) ?? browser.contexts()[0]?.pages()[0]
  if (!page) throw new Error('Start Huddle with --remote-debugging-port=9222 first.')
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.waitForSelector('.hs-app')
  const cdp = await page.context().newCDPSession(page)
  const state = await page.evaluate(async () => {
    const s = await window.huddle.getSnapshot()
    const room = s.rooms.find(r => r.id === s.selectedRoomId)
    return { room: room?.name, mode: room?.stage.mode.kind, agents: s.agents.filter(a => a.roomId === room?.id), project: room?.project?.rootPath ?? null }
  })
  check('call shell and selected room', !!state.room, state.room ?? 'No selected room')
  const measurements = []
  try {
    for (const [width, height] of [[1920, 1080], [1280, 800], [1000, 700]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await page.waitForTimeout(250)
      const m = await measure(page)
      measurements.push(m)
      const label = `${width}x${height}`
      check(
        `${label} fixed shell`,
        m.fixed && m.pageOverflow <= 1,
        `overflowX ${m.pageOverflow}px; root ${Math.round(m.rootH)}px vs client ${m.viewH}px; grows=${String(m.grows)}`
      )
      check(`${label} navigation and controls fit`, m.overflows.length === 0 && m.clipped.length === 0, [...m.overflows, ...m.clipped].join('; ') || 'No clipped controls or overflowing navigation')
      check(`${label} named controls`, m.unnamed === 0, `${m.unnamed} unnamed buttons`)
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const png = Buffer.from(data, 'base64')
      await writeFile(join(outDir, `ui-${label}.png`), png)
      check(`${label} screenshot`, png.length > 1000, `${png.length} bytes; raw CDP capture`)
    }
    const first = measurements[0]
    check('stage matches room mode', state.mode === 'gallery' ? first.gallery && first.tiles === state.agents.length + 1 : !first.gallery,
      `${state.mode}, ${first.tiles} participant tiles`)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    const surfaces = ['Code', 'Terminal', 'Files', 'Browser']
    for (const name of surfaces) {
      const clicked = await page.evaluate((label) => {
        const tab = [...document.querySelectorAll('.hw-tabs button, [role="tab"]')].find((el) =>
          (el.textContent ?? '').includes(label)
        )
        if (!(tab instanceof HTMLElement)) return false
        tab.click()
        return true
      }, name)
      await page.waitForTimeout(250)
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const png = Buffer.from(data, 'base64')
      await writeFile(join(outDir, `surface-${name.toLowerCase()}.png`), png)
      check(`open ${name} surface`, clicked && png.length > 1000, clicked ? `${png.length} bytes` : 'tab not found')
    }
    const roomClicked = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((el) => (el.textContent ?? '').trim() === 'Room')
      if (!(button instanceof HTMLElement)) return false
      button.click()
      return true
    })
    await page.waitForTimeout(300)
    const gallery = await page.evaluate(() => ({
      gallery: !!document.querySelector('.hs-gallery'),
      tiles: document.querySelectorAll('.hs-tile').length
    }))
    const { data: galleryPng } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(join(outDir, 'ui-gallery.png'), Buffer.from(galleryPng, 'base64'))
    check(
      'return to room gallery',
      roomClicked && gallery.gallery && gallery.tiles >= 1,
      roomClicked ? `${gallery.tiles} tiles` : 'Room control not found'
    )
    check('renderer errors', errors.length === 0, errors.join('; ') || 'None observed during checks')
    await writeFile(join(outDir, 'report.json'), JSON.stringify({ checks, measurements, errors }, null, 2))
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await cdp.detach()
    await browser.close()
  }
  const failed = checks.filter(c => !c.ok)
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
  process.exitCode = failed.length ? 1 : 0
}
main().catch(error => { console.error(error); process.exitCode = 1 })

