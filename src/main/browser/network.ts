import type { BrowserContext, Page, Response } from 'playwright-core'
import type { NetworkEntry } from '../../shared/api.ts'
import { messageOf, withTimeout } from './narrow.ts'

/**
 * The real network the remote page produced.
 *
 * Sam's central job is proving whether data leaks where the UI does not show
 * it, so this records the actual responses from the browser session: method,
 * status and a size-bounded body. Bodies are only read for text-like payloads;
 * an image or a video is recorded by content type and length instead of being
 * silently dropped.
 */

const MAX_ENTRIES = 300
const MAX_BODY_CHARS = 6000
const MAX_RETURNED = 60
const BODY_TIMEOUT_MS = 8000

const TEXTUAL = ['json', 'text', 'xml', 'javascript', 'urlencoded', 'html', 'csv', 'graphql']

function isTextual(contentType: string, entryMethod: string): boolean {
  if (contentType.length === 0) return true
  const lowered = contentType.toLowerCase()
  for (const needle of TEXTUAL) {
    if (lowered.includes(needle)) return true
  }
  // Form posts and REST calls without a content type are still worth reading.
  return entryMethod === 'POST' || entryMethod === 'PUT' || entryMethod === 'PATCH'
}

function bound(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text
  return `${text.slice(0, MAX_BODY_CHARS)}\n…[body truncated: ${String(text.length - MAX_BODY_CHARS)} more characters were not captured]`
}

export class NetworkRecorder {
  private readonly entries: NetworkEntry[] = []
  private readonly wired = new WeakSet<Page>()
  private attached = false

  /** Wire every page in the session, including tabs opened later. */
  attach(context: BrowserContext): void {
    if (this.attached) return
    this.attached = true
    for (const page of context.pages()) this.wire(page)
    context.on('page', (page: Page) => {
      this.wire(page)
    })
  }

  private wire(page: Page): void {
    if (this.wired.has(page)) return
    this.wired.add(page)
    page.on('response', (response: Response) => {
      void this.capture(response)
    })
  }

  private async capture(response: Response): Promise<void> {
    let method = ''
    let url = ''
    try {
      method = response.request().method()
      url = response.url()
    } catch {
      return
    }
    const entry: NetworkEntry = { url, method, status: response.status(), body: '' }
    this.entries.push(entry)
    while (this.entries.length > MAX_ENTRIES) this.entries.shift()
    entry.body = await this.readBody(response, method)
  }

  private async readBody(response: Response, method: string): Promise<string> {
    let contentType = ''
    let declaredLength = ''
    try {
      const headers = response.headers()
      contentType = headers['content-type'] ?? ''
      declaredLength = headers['content-length'] ?? ''
    } catch {
      contentType = ''
    }

    const status = response.status()
    if (status === 204 || status === 304) return ''

    if (!isTextual(contentType, method)) {
      const size = declaredLength.length > 0 ? `, ${declaredLength} bytes` : ''
      return `[not read: ${contentType}${size}]`
    }

    try {
      const text = await withTimeout(response.text(), BODY_TIMEOUT_MS, 'reading a response body')
      return bound(text)
    } catch (error) {
      return `[body could not be read: ${messageOf(error)}]`
    }
  }

  count(): number {
    return this.entries.length
  }

  /** Newest last, so a reader sees the request order the page really produced. */
  list(filter?: string): NetworkEntry[] {
    const needle = (filter ?? '').trim().toLowerCase()
    const matched =
      needle.length === 0
        ? this.entries
        : this.entries.filter((entry) => entry.url.toLowerCase().includes(needle))
    return matched.slice(-MAX_RETURNED).map((entry) => ({ ...entry }))
  }

  clear(): void {
    this.entries.length = 0
  }
}
