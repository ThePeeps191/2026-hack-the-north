/**
 * Everything that has to be true before a demo, checked in one command.
 *
 * Run this the morning of, not five minutes before. It checks local
 * prerequisites *and* — the part that matters — whether each provider will
 * actually serve a request right now. A key being present in `.env` says
 * nothing about whether the account behind it has any money left, and a room
 * full of teammates that cannot reason is indistinguishable from a broken app
 * to anyone watching.
 *
 * Secret values are never printed.
 */
import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse } from 'dotenv'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(root, '.env')
const env = { ...(existsSync(envPath) ? parse(readFileSync(envPath)) : {}), ...process.env }

let failures = 0
let warnings = 0

function check(label, ok, remedy) {
  console.log(`${ok ? 'READY  ' : 'BLOCKED'} ${label}${ok ? '' : ` — ${remedy}`}`)
  if (!ok) failures += 1
}

function warn(label, ok, remedy) {
  console.log(`${ok ? 'READY  ' : 'WARN   '} ${label}${ok ? '' : ` — ${remedy}`}`)
  if (!ok) warnings += 1
}

function note(label, detail) {
  console.log(`       ${label}: ${detail}`)
}

async function fetchJson(url, options = {}, timeoutMs = 12_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const text = await response.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    return { status: response.status, ok: response.ok, body, text }
  } catch (error) {
    return { status: 0, ok: false, body: null, text: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

console.log('--- local prerequisites ---')

check('Node 22+', Number(process.versions.node.split('.')[0]) >= 22, 'Install Node.js 22 or newer.')
check('Git', spawnSync('git', ['--version'], { windowsHide: true }).status === 0, 'Install Git and add it to PATH.')
check(
  'Electron',
  existsSync(
    resolve(
      root,
      'node_modules/electron/dist',
      process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app' : 'electron'
    )
  ),
  'Run npm install.'
)
check('Demo project', existsSync(resolve(root, 'demo/sketch-night/package.json')), 'Run from the complete Huddle checkout.')
check(
  'Local VAD model',
  existsSync(resolve(root, 'tools/voice-lab/models/silero_vad.onnx')),
  'Run node tools/voice-lab/scripts/setup.mjs.'
)
const python =
  env.HUDDLE_PYTHON ||
  resolve(root, 'tools/voice-lab/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
check(
  'Local Whisper',
  spawnSync(python, ['-c', 'import faster_whisper'], { windowsHide: true, stdio: 'ignore', timeout: 30000 }).status === 0,
  'Run node tools/voice-lab/scripts/setup.mjs.'
)

/*
 * Disk space is a real demo risk and an invisible one: a full system drive
 * makes git worktrees, temp files and the local Whisper model fail in ways
 * that look like application bugs. This has already happened once.
 */
for (const [label, target] of [
  ['project drive', root],
  ['system temp drive', process.env.TEMP || process.env.TMPDIR || '/tmp']
]) {
  try {
    const stats = statfsSync(target)
    const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3
    warn(
      `Disk space on the ${label} (${freeGb.toFixed(1)} GB free)`,
      freeGb >= 2,
      'Free at least 2 GB. A full drive makes worktrees, jobs and Whisper fail in ways that look like app bugs.'
    )
  } catch {
    // An unreadable mount point is not worth failing a demo check over.
  }
}

console.log('\n--- providers (a key is not the same as a working account) ---')

const results = await Promise.all([
  checkOpenAI(),
  checkDeepSeek(),
  checkElevenLabs(),
  checkBrowserbase()
])

const reasoning = results.filter((result) => result.kind === 'reasoning')
const anyReasoning = reasoning.some((result) => result.usable)

console.log('')
if (!anyReasoning) {
  failures += 1
  console.log('BLOCKED No model provider can serve a request, so no teammate can reason.')
  console.log('        Add credit to OpenAI or DeepSeek, or set a key for one of them, then run this again.')
  console.log('        Everything else in Huddle still works: the room, typing, state and every other capability.')
}

console.log('')
console.log(
  failures > 0
    ? `NOT READY — ${failures} blocking issue(s)${warnings > 0 ? `, ${warnings} warning(s)` : ''}.`
    : warnings > 0
      ? `READY with ${warnings} warning(s).`
      : 'READY — every check passed.'
)
console.log('This does not check microphone recording or audible playback. Run npm run verify:voice for those.')

process.exitCode = failures > 0 ? 1 : 0

/* ------------------------------------------------------------------ */

async function checkOpenAI() {
  const key = env.OPENAI_API_KEY?.trim()
  if (!key) {
    warn('OpenAI', false, 'No OPENAI_API_KEY. Fine if DeepSeek is funded.')
    return { kind: 'reasoning', usable: false }
  }
  const models = await fetchJson('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } })
  if (models.status === 401 || models.status === 403) {
    check('OpenAI key', false, 'The key was rejected. Replace OPENAI_API_KEY.')
    return { kind: 'reasoning', usable: false }
  }
  if (!models.ok) {
    warn('OpenAI', false, `Could not list models (HTTP ${models.status || 'no response'}).`)
    return { kind: 'reasoning', usable: false }
  }

  // Listing models works with no credit, so spend one token to find out.
  const turn = await fetchJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-luna', max_completion_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
  })
  const message = String(turn.body?.error?.message ?? turn.text ?? '')
  const brokeOnCredit = /insufficient_quota|no credits remaining|exceeded your current quota/i.test(message)
  if (brokeOnCredit) {
    warn('OpenAI credit', false, 'The account has no credit. Top up at platform.openai.com/settings/organization/billing.')
    return { kind: 'reasoning', usable: false }
  }
  warn('OpenAI', turn.ok, `A real request failed (HTTP ${turn.status}): ${message.slice(0, 120)}`)
  if (turn.ok) note('OpenAI', `${models.body?.data?.length ?? 0} models reachable and a real request succeeded`)
  return { kind: 'reasoning', usable: turn.ok }
}

async function checkDeepSeek() {
  const key = env.DEEPSEEK_API_KEY?.trim()
  if (!key) {
    warn('DeepSeek', false, 'No DEEPSEEK_API_KEY. Fine if OpenAI is funded.')
    return { kind: 'reasoning', usable: false }
  }
  const balance = await fetchJson('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${key}` }
  })
  if (balance.status === 401 || balance.status === 403) {
    check('DeepSeek key', false, 'The key was rejected. Replace DEEPSEEK_API_KEY.')
    return { kind: 'reasoning', usable: false }
  }
  const usd = balance.body?.balance_infos?.find((entry) => entry.currency === 'USD')
  const amount = Number(usd?.total_balance ?? 'NaN')
  if (Number.isFinite(amount)) {
    const funded = amount > 0.2
    warn(
      `DeepSeek credit ($${amount.toFixed(2)})`,
      funded,
      amount > 0
        ? 'Under $0.20 left: a full demo run costs more than this. Top up at platform.deepseek.com/top_up.'
        : 'The account is empty. Top up at platform.deepseek.com/top_up.'
    )
    if (funded) note('DeepSeek', 'balance is enough for a demo run')
    return { kind: 'reasoning', usable: funded }
  }
  warn('DeepSeek', balance.ok, `Could not read the balance (HTTP ${balance.status || 'no response'}).`)
  return { kind: 'reasoning', usable: balance.ok }
}

async function checkElevenLabs() {
  const key = env.ELEVENLABS_API_KEY?.trim()
  if (!key) {
    warn('ElevenLabs', false, 'No ELEVENLABS_API_KEY: the team will be written-only, with no voices.')
    return { kind: 'voice', usable: false }
  }
  const subscription = await fetchJson('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': key }
  })
  if (!subscription.ok) {
    warn('ElevenLabs', false, `The key did not work (HTTP ${subscription.status || 'no response'}).`)
    return { kind: 'voice', usable: false }
  }
  const used = Number(subscription.body?.character_count ?? 0)
  const limit = Number(subscription.body?.character_limit ?? 0)
  const left = limit - used
  // A demo run is a few thousand characters of speech.
  warn(
    `ElevenLabs characters (${left.toLocaleString()} left)`,
    left > 5000,
    'Under 5,000 characters left: the team may go silent partway through.'
  )
  return { kind: 'voice', usable: left > 0 }
}

async function checkBrowserbase() {
  const key = env.BROWSERBASE_API_KEY?.trim()
  const project = env.BROWSERBASE_PROJECT_ID?.trim()
  if (!key || !project) {
    warn('Browserbase', false, 'No key or project id: browser verification will report itself unavailable.')
    return { kind: 'browser', usable: false }
  }
  const created = await fetchJson('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project })
  })
  if (!created.ok) {
    warn('Browserbase', false, `Could not open a session (HTTP ${created.status}): ${String(created.text).slice(0, 120)}`)
    return { kind: 'browser', usable: false }
  }
  // Release it again: an abandoned session burns the concurrency slot the demo
  // needs, and this check must not be the reason the demo cannot open a browser.
  await fetchJson(`https://api.browserbase.com/v1/sessions/${created.body?.id}`, {
    method: 'POST',
    headers: { 'X-BB-API-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project, status: 'REQUEST_RELEASE' })
  })
  warn('Browserbase', true, '')
  note('Browserbase', 'opened and released a real session')
  return { kind: 'browser', usable: true }
}
