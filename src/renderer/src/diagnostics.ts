// Error reporting of a window for the log file (src/main/diagnostics): uncaught errors, unhandled
// rejections and console.error calls go to the main process through window.api.logError, folded and
// rate-limited (src/shared/logReport.ts).
import type { RendererLogEntry } from '@shared/diagnostics'
import { createReporter, describeValue } from '@shared/logReport'

let installed = false

/** Hooks window errors, unhandled rejections and console.error of this window. */
export function installErrorReporting(): void {
  if (installed || typeof window === 'undefined' || !window.api?.logError) return
  installed = true
  const report = createReporter((e) => {
    try {
      window.api.logError(e)
    } catch {
      // the main process is gone (closing): nothing to do
    }
  })
  window.addEventListener('error', (ev) => {
    const err = ev.error as Error | undefined
    report({ kind: 'error', message: ev.message || describeValue(err), stack: err?.stack, where: ev.filename ? `${ev.filename.split('/').pop()}:${ev.lineno}:${ev.colno}` : undefined })
  })
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason as unknown
    report({ kind: 'rejection', message: r instanceof Error ? `${r.name}: ${r.message}` : describeValue(r), stack: r instanceof Error ? r.stack : undefined })
  })
  const original = console.error.bind(console)
  console.error = (...args: unknown[]): void => {
    original(...args)
    const err = args.find((a): a is Error => a instanceof Error)
    report({ kind: 'console', message: args.map(describeValue).join(' '), stack: err?.stack })
  }
}

/** Notable events of the app itself (an export failed, a file could not be read). */
export function logEvent(kind: RendererLogEntry['kind'], message: string): void {
  try {
    window.api.logError({ kind, message: message.slice(0, 2000) })
  } catch {
    // ignore
  }
}
