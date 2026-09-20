import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appRoot, dataRoot, secretsPath } from '../paths.ts'

/**
 * Backend-only secret store.
 *
 * Secrets come from (in order) an explicit override, the OS-backed encrypted
 * store, the process environment, then a gitignored `.env` at the repo root.
 * Values never reach the renderer, never enter an event, and never get logged.
 */

export type SecretKey =
  | 'OPENAI_API_KEY'
  | 'DEEPSEEK_API_KEY'
  | 'ELEVENLABS_API_KEY'
  | 'BROWSERBASE_API_KEY'
  | 'BROWSERBASE_PROJECT_ID'
  | 'NGROK_AUTHTOKEN'

export const SECRET_KEYS: readonly SecretKey[] = [
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'ELEVENLABS_API_KEY',
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'NGROK_AUTHTOKEN'
]

type SafeStorage = {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

let safeStorage: SafeStorage | null = null
const overrides = new Map<SecretKey, string>()
let envLoaded = false
const dotenvValues = new Map<string, string>()

/** Called from Electron main. Plain Node callers simply skip encryption. */
export function attachSafeStorage(storage: SafeStorage): void {
  safeStorage = storage
}

function loadDotEnvOnce(): void {
  if (envLoaded) return
  envLoaded = true
  for (const candidate of [join(appRoot(), '.env'), join(dataRoot(), '.env')]) {
    if (!existsSync(candidate)) continue
    let raw: string
    try {
      raw = readFileSync(candidate, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (value && !dotenvValues.has(key)) dotenvValues.set(key, value)
    }
  }
}

type StoredSecrets = Record<string, string>

function readStore(): StoredSecrets {
  const path = secretsPath()
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as StoredSecrets
  } catch {
    return {}
  }
}

function writeStore(store: StoredSecrets): void {
  const path = secretsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function decodeStored(value: string): string | null {
  if (!value.startsWith('enc:')) return null
  if (!safeStorage?.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
  } catch {
    return null
  }
}

export function getSecret(key: SecretKey): string {
  const override = overrides.get(key)
  if (override) return override

  const stored = readStore()[key]
  if (typeof stored === 'string' && stored) {
    const decoded = decodeStored(stored)
    if (decoded) return decoded
  }

  const fromEnv = process.env[key]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()

  loadDotEnvOnce()
  return dotenvValues.get(key)?.trim() ?? ''
}

export function hasSecret(key: SecretKey): boolean {
  return getSecret(key).length > 0
}

export function setSecret(key: SecretKey, value: string): void {
  const trimmed = value.trim()
  if (!trimmed) {
    overrides.delete(key)
    const store = readStore()
    delete store[key]
    writeStore(store)
    return
  }
  overrides.set(key, trimmed)
  if (safeStorage?.isEncryptionAvailable()) {
    const store = readStore()
    store[key] = `enc:${safeStorage.encryptString(trimmed).toString('base64')}`
    writeStore(store)
  }
}

/** Where a secret is currently coming from. Never returns the value itself. */
export function secretOrigin(key: SecretKey): 'session' | 'keychain' | 'env' | 'dotenv' | 'none' {
  if (overrides.has(key)) return 'session'
  const stored = readStore()[key]
  if (typeof stored === 'string' && decodeStored(stored)) return 'keychain'
  if (process.env[key]?.trim()) return 'env'
  loadDotEnvOnce()
  if (dotenvValues.get(key)?.trim()) return 'dotenv'
  return 'none'
}

/** Replace any secret value appearing in text with a marker, for logs and events. */
export function redact(text: string): string {
  let output = text
  for (const key of SECRET_KEYS) {
    const value = getSecret(key)
    if (value.length >= 8) {
      output = output.split(value).join(`[${key} redacted]`)
    }
  }
  return output
}
