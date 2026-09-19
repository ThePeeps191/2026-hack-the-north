/**
 * A failure we can explain to the person in the call.
 *
 * Every error that reaches the UI carries a stable `code` (for branching), a
 * plain-language `message` (what went wrong), and where possible a `fix` (the
 * concrete next step). Errors without a fix are still fine -- an empty hint is
 * better than an invented one.
 */
export class HuddleError extends Error {
  readonly code: string
  readonly fix: string | null

  constructor(code: string, message: string, fix?: string) {
    super(message)
    this.name = 'HuddleError'
    this.code = code
    this.fix = fix ?? null
  }
}

/** The shape that crosses IPC. `fix` is omitted when we have no real next step. */
export interface ErrorShape {
  code: string
  message: string
  fix?: string
}

export function toErrorShape(error: unknown): ErrorShape {
  if (error instanceof HuddleError) {
    return error.fix
      ? { code: error.code, message: error.message, fix: error.fix }
      : { code: error.code, message: error.message }
  }
  if (error instanceof Error) {
    return { code: 'internal', message: error.message }
  }
  return { code: 'internal', message: 'Unexpected error' }
}
