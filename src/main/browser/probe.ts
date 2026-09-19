/**
 * Provider-level diagnostic for the remote browser, kept next to the host.
 *
 * `verify.ts` exercises the whole browser host. This file goes one level lower:
 * it talks to the Browserbase SDK and Playwright's CDP client directly, so when
 * something looks wrong you can tell whether the provider or Huddle is at fault.
 * It always releases the session it creates, in both the success and the failure
 * path, and it prints raw values only — never a credential.
 *
 *   node --experimental-strip-types src/main/browser/probe.ts
 */

import Browserbase from '@browserbasehq/sdk'
import { URL } from 'node:url'
import { chromium } from 'playwright-core'
import { getSecret } from '../config/secrets.ts'

async function main(): Promise<void> {
  const apiKey = getSecret('BROWSERBASE_API_KEY')
  const projectId = getSecret('BROWSERBASE_PROJECT_ID')
  console.log(`key set: ${String(apiKey.length > 0)} · project id set: ${String(projectId.length > 0)}`)
  if (apiKey.length === 0 || projectId.length === 0) {
    console.log('Nothing to probe without both credentials.')
    process.exitCode = 2
    return
  }

  const client = new Browserbase({ apiKey })
  const session = await client.sessions.create({
    projectId,
    browserSettings: { viewport: { width: 1440, height: 900 } }
  })
  console.log(`created ${session.id} · status ${session.status} · region ${session.region}`)
  console.log(`connectUrl host: ${new URL(session.connectUrl).host}`)

  try {
    const urls = await client.sessions.debug(session.id)
    console.log(`debuggerFullscreenUrl: ${urls.debuggerFullscreenUrl}`)
    console.log(`debuggerUrl: ${urls.debuggerUrl}`)
    console.log(`pages: ${JSON.stringify(urls.pages)}`)
  } catch (error) {
    console.log(`sessions.debug failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 90_000 })
  const context = browser.contexts()[0]
  console.log(`contexts: ${String(browser.contexts().length)} · pages: ${String(context.pages().length)}`)
  const page = context.pages()[0] ?? (await context.newPage())
  const response = await page.goto('https://example.com', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000
  })
  console.log(`goto status ${String(response === null ? null : response.status())} · url ${page.url()}`)
  console.log(`title ${await page.title()}`)
  console.log(`viewport ${JSON.stringify(page.viewportSize())}`)
  const shot = await page.screenshot({ type: 'png' })
  console.log(`screenshot bytes ${String(shot.byteLength)}`)
  const aria = await page.locator('body').ariaSnapshot({ timeout: 5_000, mode: 'ai' })
  console.log(`ariaSnapshot:\n${aria.slice(0, 600)}`)
  await browser.close()

  const released = await client.sessions.update(session.id, { status: 'REQUEST_RELEASE' })
  console.log(`release request answered with status ${released.status}`)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1500)
    })
    const record = await client.sessions.retrieve(session.id)
    console.log(`poll ${String(attempt)}: ${record.status}${record.endedAt === undefined ? '' : ` at ${record.endedAt}`}`)
    if (record.status !== 'RUNNING' && record.status !== 'PENDING') break
  }
}

main().catch((error: unknown) => {
  console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
