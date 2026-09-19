import { createWriteStream, existsSync, renameSync, statSync, type WriteStream } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RuntimeEvent } from '../shared/types.ts'

/**
 * Append-only durable history.
 *
 * The in-memory event ring the UI shows is a display buffer, not the record of
 * what happened. Durable events are appended here as JSONL so task, decision
 * and integration history survives a snapshot rewrite, a crash, or the ring
 * rolling over.
 *
 * Ephemeral events (audio levels, model tokens, playback ticks) never reach
 * this file: `RoomService` filters them out before calling `append`.
 */

const MAX_BYTES = 8 * 1024 * 1024

export class EventLog {
  private readonly filePath: string
  private stream: WriteStream | null = null
  private bytes = 0
  private failed = false

  constructor(filePath: string) {
    this.filePath = filePath
  }

  private ensureStream(): WriteStream | null {
    if (this.failed) return null
    if (this.stream) return this.stream
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      if (existsSync(this.filePath)) {
        this.bytes = statSync(this.filePath).size
        if (this.bytes > MAX_BYTES) this.rotate()
      }
      this.stream = createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' })
      this.stream.on('error', () => {
        // A broken log must never take the app down; state still lives in the
        // snapshot. We stop trying rather than throwing on every event.
        this.failed = true
        this.stream = null
      })
      return this.stream
    } catch {
      this.failed = true
      return null
    }
  }

  private rotate(): void {
    try {
      renameSync(this.filePath, `${this.filePath}.1`)
      this.bytes = 0
    } catch {
      this.bytes = 0
    }
  }

  append(event: RuntimeEvent): void {
    const stream = this.ensureStream()
    if (!stream) return
    const line = `${JSON.stringify(event)}\n`
    this.bytes += Buffer.byteLength(line)
    stream.write(line)
    if (this.bytes > MAX_BYTES) {
      stream.end()
      this.stream = null
      this.rotate()
    }
  }

  /** True when appends are being dropped, so the UI can say so honestly. */
  isDegraded(): boolean {
    return this.failed
  }

  async close(): Promise<void> {
    const stream = this.stream
    this.stream = null
    if (!stream) return
    await new Promise<void>((resolve) => stream.end(resolve))
  }
}
