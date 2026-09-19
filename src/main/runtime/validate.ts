/**
 * Tiny, dependency-free argument validation for the tool registry.
 *
 * Every tool declares a JSON schema for the provider and a `validate` function
 * built from this reader. A malformed call never reaches the filesystem: the
 * reader collects every problem, the tool result is recorded as `rejected`, and
 * the exact message is handed back to the model so it can fix its arguments.
 *
 * Pure module: no imports beyond shared types, so it is directly unit-testable.
 */

export interface ValidationOk<T> {
  ok: true
  value: T
}

export interface ValidationFail {
  ok: false
  message: string
}

export type Validation<T> = ValidationOk<T> | ValidationFail

export function ok<T>(value: T): ValidationOk<T> {
  return { ok: true, value }
}

export function fail(message: string): ValidationFail {
  return { ok: false, message }
}

export type JsonObject = Record<string, unknown>

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Hard ceiling so a model cannot hand us a megabyte of arguments. */
const MAX_LIST_ITEMS = 64
const MAX_NESTED_BYTES = 20000

interface StringOptions {
  required?: boolean
  /** Trimmed length ceiling; longer values are rejected, never silently cut. */
  max?: number
  min?: number
  enum?: readonly string[]
  /**
   * Keep the value byte-for-byte. Only for arguments that are file contents or
   * a patch: trimming those silently changes what gets written.
   */
  raw?: boolean
}

interface NumberOptions {
  required?: boolean
  integer?: boolean
  min?: number
  max?: number
}

interface ListOptions {
  required?: boolean
  maxItems?: number
  maxLength?: number
}

/**
 * Reads a raw `unknown` argument object into typed fields.
 *
 * Defaults keep the call sites linear: an absent optional string reads as `''`,
 * an absent optional number as `0`, an absent optional list as `[]`. Callers
 * that need to distinguish "absent" from "empty" use `has()`.
 */
export class ArgReader {
  private readonly raw: JsonObject | null
  private readonly problems: string[] = []

  constructor(value: unknown) {
    if (isRecord(value)) {
      this.raw = value
    } else {
      this.raw = null
      this.problems.push('arguments must be a JSON object')
    }
  }

  get failed(): boolean {
    return this.problems.length > 0
  }

  /** Problem text without the tool prefix. */
  get message(): string {
    return this.problems.join('; ')
  }

  has(key: string): boolean {
    return this.raw !== null && this.raw[key] !== undefined && this.raw[key] !== null
  }

  str(key: string, options: StringOptions = {}): string {
    const value = this.raw?.[key]
    if (value === undefined || value === null) {
      if (options.required) this.problems.push(`"${key}" is required and must be a string`)
      return ''
    }
    if (typeof value !== 'string') {
      this.problems.push(`"${key}" must be a string, got ${typeof value}`)
      return ''
    }
    const text = options.raw ? value : value.trim()
    if (!text) {
      if (options.required) this.problems.push(`"${key}" must not be empty`)
      return ''
    }
    if (options.min !== undefined && text.length < options.min) {
      this.problems.push(`"${key}" must be at least ${options.min} characters`)
      return ''
    }
    if (options.max !== undefined && text.length > options.max) {
      this.problems.push(`"${key}" must be at most ${options.max} characters (got ${text.length})`)
      return ''
    }
    if (options.enum && !options.enum.includes(text)) {
      this.problems.push(`"${key}" must be one of: ${options.enum.join(', ')}`)
      return ''
    }
    return text
  }

  num(key: string, options: NumberOptions = {}): number {
    const value = this.raw?.[key]
    if (value === undefined || value === null) {
      if (options.required) this.problems.push(`"${key}" is required and must be a number`)
      return 0
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      // Accept a numeric string, which models produce regularly.
      if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
        return this.numFrom(key, Number(value), options)
      }
      this.problems.push(`"${key}" must be a finite number, got ${typeof value}`)
      return 0
    }
    return this.numFrom(key, value, options)
  }

  private numFrom(key: string, value: number, options: NumberOptions): number {
    if (options.integer && !Number.isInteger(value)) {
      this.problems.push(`"${key}" must be an integer`)
      return 0
    }
    if (options.min !== undefined && value < options.min) {
      this.problems.push(`"${key}" must be >= ${options.min}`)
      return 0
    }
    if (options.max !== undefined && value > options.max) {
      this.problems.push(`"${key}" must be <= ${options.max}`)
      return 0
    }
    return value
  }

  bool(key: string, options: { required?: boolean } = {}): boolean {
    const value = this.raw?.[key]
    if (value === undefined || value === null) {
      if (options.required) this.problems.push(`"${key}" is required and must be a boolean`)
      return false
    }
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    this.problems.push(`"${key}" must be a boolean`)
    return false
  }

  list(key: string, options: ListOptions = {}): string[] {
    const value = this.raw?.[key]
    if (value === undefined || value === null || value === '') {
      if (options.required) this.problems.push(`"${key}" is required and must be an array of strings`)
      return []
    }
    const items = Array.isArray(value) ? value : [value]
    if (items.length > (options.maxItems ?? MAX_LIST_ITEMS)) {
      this.problems.push(`"${key}" accepts at most ${options.maxItems ?? MAX_LIST_ITEMS} items`)
      return []
    }
    const out: string[] = []
    for (const item of items) {
      if (typeof item !== 'string') {
        this.problems.push(`"${key}" must contain only strings`)
        return []
      }
      const text = item.trim()
      if (!text) continue
      const max = options.maxLength ?? 600
      if (text.length > max) {
        this.problems.push(`"${key}" items must be at most ${max} characters`)
        return []
      }
      out.push(text)
    }
    if (options.required && out.length === 0) {
      this.problems.push(`"${key}" must contain at least one entry`)
    }
    return out
  }

  /** An arbitrary JSON object, size-bounded. */
  record(key: string, options: { required?: boolean } = {}): JsonObject | null {
    const value = this.raw?.[key]
    if (value === undefined || value === null) {
      if (options.required) this.problems.push(`"${key}" is required and must be an object`)
      return null
    }
    if (!isRecord(value)) {
      this.problems.push(`"${key}" must be a JSON object`)
      return null
    }
    let encoded: string
    try {
      encoded = JSON.stringify(value)
    } catch {
      this.problems.push(`"${key}" must be JSON-serialisable`)
      return null
    }
    if (encoded.length > MAX_NESTED_BYTES) {
      this.problems.push(`"${key}" is too large (${encoded.length} > ${MAX_NESTED_BYTES} characters)`)
      return null
    }
    return value
  }

  /** Records a problem found by a tool-specific rule. */
  check(condition: boolean, message: string): boolean {
    if (!condition) this.problems.push(message)
    return condition
  }

  /** Fails with a message written by the tool itself. */
  reject(message: string): void {
    this.problems.push(message)
  }

  /**
   * Runs `build` when every field validated cleanly. `build` only runs on the
   * success path, so it may assume real values.
   */
  finish<T>(build: () => T): Validation<T> {
    if (this.problems.length > 0) return fail(this.message)
    return ok(build())
  }
}
