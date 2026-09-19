export class HuddleError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'HuddleError'
    this.code = code
  }
}

export function toErrorShape(error: unknown): { code: string; message: string } {
  if (error instanceof HuddleError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof Error) {
    return { code: 'internal', message: error.message }
  }
  return { code: 'internal', message: 'Unexpected error' }
}
