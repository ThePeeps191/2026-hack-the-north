import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  STATE_VERSION,
  type AppSettings,
  type PersistedState
} from '../shared/types.ts'
import { migrateToCurrent, type MigrationOutcome } from './migrate.ts'

/**
 * Versioned JSON snapshot store.
 *
 * Two rules matter here and both come from a source review:
 *   - A failed replacement must never destroy the last good file (finding 7).
 *   - A valid older schema is migrated, not reported as corruption (finding 7).
 */

export type StoreReadResult =
  | { kind: 'missing' }
  | { kind: 'ok'; data: PersistedState; migratedFrom: number | null }
  | { kind: 'corrupt'; backupPath: string | null; reason: string }

export class JsonSnapshotStore {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  path(): string {
    return this.filePath
  }

  async read(): Promise<StoreReadResult> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return { kind: 'missing' }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return {
        kind: 'corrupt',
        backupPath: await this.preserveCorrupt(),
        reason: error instanceof Error ? error.message : 'State file could not be parsed.'
      }
    }

    const outcome: MigrationOutcome = migrateToCurrent(parsed)
    if (!outcome.ok) {
      return {
        kind: 'corrupt',
        backupPath: await this.preserveCorrupt(),
        reason: outcome.reason
      }
    }

    // Keep a copy of the pre-migration file before the first v2 write lands on it.
    if (outcome.fromVersion !== STATE_VERSION) {
      await this.preserveMigrated(outcome.fromVersion)
    }

    return {
      kind: 'ok',
      data: outcome.state,
      migratedFrom: outcome.fromVersion === STATE_VERSION ? null : outcome.fromVersion
    }
  }

  async write(state: PersistedState): Promise<void> {
    const payload = `${JSON.stringify(state, null, 2)}\n`
    await atomicWriteFile(this.filePath, payload)
  }

  private async preserveCorrupt(): Promise<string | null> {
    const backupPath = `${this.filePath}.corrupt-${stamp()}`
    try {
      await copyFile(this.filePath, backupPath)
      return backupPath
    } catch {
      return null
    }
  }

  private async preserveMigrated(fromVersion: number): Promise<void> {
    try {
      await copyFile(this.filePath, `${this.filePath}.v${fromVersion}-${stamp()}.bak`)
    } catch {
      // A missing backup is not a reason to refuse to run; the original file is
      // still intact until the first successful atomic replace.
    }
  }
}

/**
 * Write-then-replace. If the replace fails we delete the temp file and throw,
 * leaving the previous file exactly as it was. We never unlink the destination
 * to "make room" -- that is how a transient EPERM turns into data loss.
 *
 * Windows gives EPERM/EBUSY when an indexer or antivirus has the destination
 * open for a few milliseconds, so a bounded retry is worth the wait.
 */
export async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = join(dirname(filePath), `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`)

  const handle = await open(tmpPath, 'w')
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }

  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES'])
  let lastError: unknown = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(tmpPath, filePath)
      return
    } catch (error) {
      lastError = error
      const code = (error as { code?: string } | null)?.code
      if (!code || !retryable.has(code)) break
      await delay(20 * 2 ** attempt)
    }
  }

  await unlink(tmpPath).catch(() => undefined)
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Could not replace ${filePath}; previous state left untouched. ${detail}`)
}

export function defaultSettings(): AppSettings {
  return structuredClone(DEFAULT_SETTINGS)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
