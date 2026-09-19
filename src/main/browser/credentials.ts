import Browserbase from '@browserbasehq/sdk'
import type { AppSettings } from '../../shared/types.ts'
import { getSecret, secretOrigin, type SecretKey } from '../config/secrets.ts'
import { HuddleError } from '../huddle-error.ts'

/**
 * Browserbase credentials for the real remote browser.
 *
 * These never leave the main process: the renderer gets a session record and a
 * live-view URL, never a key. A missing credential is refused with the concrete
 * next step, because a session record that looks live but drives nothing would
 * be a lie about what Sam verified.
 */

export interface BrowserbaseCredentials {
  apiKey: string
  projectId: string
  /** `env` | `dotenv` | `keychain` | `session`. Never the value itself. */
  origin: string
}

const KEY_FIX =
  'Open Settings → Secrets in Huddle and paste BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID from the Browserbase dashboard (Settings → Project ID / API Keys). Huddle also reads them from a gitignored .env at the repo root, but you must restart Huddle after editing that file.'

/** The next step, short enough to sit inside the error message itself. */
const KEY_FIX_SHORT =
  'Set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID in Settings → Secrets (or the repo .env) and restart Huddle.'

function value(key: SecretKey): string {
  return getSecret(key).trim()
}

/** The credentials as they exist right now, or null when incomplete. */
export function peekCredentials(): BrowserbaseCredentials | null {
  const apiKey = value('BROWSERBASE_API_KEY')
  const projectId = value('BROWSERBASE_PROJECT_ID')
  if (apiKey.length === 0 || projectId.length === 0) return null
  return { apiKey, projectId, origin: secretOrigin('BROWSERBASE_API_KEY') }
}

/**
 * The credentials, or a `HuddleError` that says exactly what is missing and how
 * to fix it. Called before any session is created, so a missing key can never
 * turn into a fake "live" session.
 */
export function requireCredentials(settings: AppSettings): BrowserbaseCredentials {
  if (!settings.browserbaseEnabled) {
    throw new HuddleError(
      'browserbase_disabled',
      'Remote browser sessions are turned off in Settings, so Huddle will not open one. Turn Browserbase back on in Settings, then open a session again.',
      'Turn Browserbase back on in Settings, then open a session again.'
    )
  }

  const apiKey = value('BROWSERBASE_API_KEY')
  const projectId = value('BROWSERBASE_PROJECT_ID')

  if (apiKey.length === 0 && projectId.length === 0) {
    throw new HuddleError(
      'browserbase_unconfigured',
      `Huddle has no Browserbase credentials, so it cannot open a real remote browser. ${KEY_FIX_SHORT}`,
      KEY_FIX
    )
  }
  if (apiKey.length === 0) {
    throw new HuddleError(
      'browserbase_unconfigured',
      `Huddle has a Browserbase project id but no BROWSERBASE_API_KEY, so it cannot authenticate. ${KEY_FIX_SHORT}`,
      KEY_FIX
    )
  }
  if (projectId.length === 0) {
    throw new HuddleError(
      'browserbase_unconfigured',
      `Huddle has a Browserbase API key but no BROWSERBASE_PROJECT_ID, and it will not open a session it cannot attribute to your project. ${KEY_FIX_SHORT}`,
      KEY_FIX
    )
  }

  return { apiKey, projectId, origin: secretOrigin('BROWSERBASE_API_KEY') }
}

let cachedClient: Browserbase | null = null
let cachedKey = ''

/** One SDK client per key, rebuilt if the key changes while Huddle is running. */
export function clientFor(credentials: BrowserbaseCredentials): Browserbase {
  if (cachedClient !== null && cachedKey === credentials.apiKey) return cachedClient
  cachedClient = new Browserbase({ apiKey: credentials.apiKey })
  cachedKey = credentials.apiKey
  return cachedClient
}

export function originLabel(origin: string): string {
  if (origin === 'env') return 'the process environment'
  if (origin === 'dotenv') return 'the repo .env file'
  if (origin === 'keychain') return "the OS keychain"
  if (origin === 'session') return 'this session'
  return 'an unknown source'
}
