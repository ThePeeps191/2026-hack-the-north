/**
 * Narrowing and small helpers for the browser host.
 *
 * Every value here arrives from somewhere we do not control: the remote page,
 * the Browserbase API, or an error thrown by a socket. Nothing in this module
 * trusts a shape. Each reader returns `null` (or a fallback) instead of
 * throwing, and the caller decides what an unreadable value means.
 */

export type JsonRecord = Record<string, unknown>

export function asRecord(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as JsonRecord
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** The message of anything throwable, without assuming it is an Error. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  const record = asRecord(error)
  if (record) {
    const message = record.message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return 'Unknown error'
}

/** Collapse whitespace so a message fits one `detail` line in the UI. */
export function oneLine(text: string, max = 400): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/** Short form of a provider id, for labels and file names. */
export function shortId(id: string | null): string {
  if (id === null || id.length === 0) return 'none'
  return id.length <= 8 ? id : id.slice(0, 8)
}

/** `20260214-183005`, stable and sortable, safe in a file name. */
export function timestampForFilename(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * A promise that can never hang the caller. Used for reading response bodies on
 * a page that may navigate away mid-read: the caller gets a real failure instead
 * of a request that never settles.
 */
export function withTimeout<T>(input: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not settle within ${String(ms)} ms`))
    }, ms)
    input.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(messageOf(error)))
      }
    )
  })
}
