// Cancellation in the main process: an Error named 'AbortError' (like the DOM's), so callers can tell
// a stop on purpose from a failure.

export function abortError(): Error {
  const e = new Error('cancelled')
  e.name = 'AbortError'
  return e
}

export function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}
