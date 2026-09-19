import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STATE_VERSION, type PersistedState } from '../shared/types.ts'

export type StoreReadResult =
  | { kind: 'missing' }
  | { kind: 'ok'; data: PersistedState }
  | { kind: 'corrupt'; backupPath: string; reason: string }

export class JsonSnapshotStore {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async read(): Promise<StoreReadResult> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNotFound(error)) {
        return { kind: 'missing' }
      }
      throw error
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isPersistedState(parsed)) {
        return {
          kind: 'corrupt',
          backupPath: await this.preserveCorrupt(),
          reason: 'State file is missing required fields or uses an unsupported version.'
        }
      }
      return { kind: 'ok', data: parsed }
    } catch (error) {
      return {
        kind: 'corrupt',
        backupPath: await this.preserveCorrupt(),
        reason: error instanceof Error ? error.message : 'State file could not be parsed.'
      }
    }
  }

  async write(state: PersistedState): Promise<void> {
    const payload = `${JSON.stringify(state, null, 2)}\n`
    await atomicWriteFile(this.filePath, payload)
  }

  private async preserveCorrupt(): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${this.filePath}.corrupt-${stamp}`
    await copyFile(this.filePath, backupPath)
    return backupPath
  }
}

export async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = join(dirname(filePath), `.${process.pid}-${Date.now()}.tmp`)
  const handle = await open(tmpPath, 'w')
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    await rename(tmpPath, filePath)
  } catch {
    await unlink(filePath).catch(() => undefined)
    await rename(tmpPath, filePath)
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function isPersistedState(value: unknown): value is PersistedState {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    record.version === STATE_VERSION &&
    Array.isArray(record.rooms) &&
    Array.isArray(record.agents) &&
    Array.isArray(record.messages) &&
    Array.isArray(record.events) &&
    typeof record.lastSeq === 'number' &&
    (record.selectedRoomId === null || typeof record.selectedRoomId === 'string')
  )
}
