// What a window reports for the log (src/renderer/src/diagnostics.ts): repeats of the same message are
// folded, at most `perMinute` reports leave a window, and objects are described by their shape only
// (never dumped: a project or a face descriptor could be in them). Pure, for tests.
import type { RendererLogEntry } from './diagnostics'

/** A console argument as short text: strings and errors as they are, objects by their shape. */
export function describeValue(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return `${v.name}: ${v.message}`
  if (v === null || v === undefined || typeof v !== 'object') return String(v)
  if (Array.isArray(v)) return `[array(${v.length})]`
  const name = (v as object).constructor?.name ?? 'Object'
  return `[${name} {${Object.keys(v).slice(0, 8).join(', ')}}]`
}

/** Folds repeats and limits the rate; `send` gets what passes. */
export function createReporter(send: (e: RendererLogEntry) => void, now: () => number = Date.now, perMinute = 30): (e: RendererLogEntry) => void {
  let windowStart = now()
  let sent = 0
  let last: RendererLogEntry | null = null
  let repeats = 0
  return (e) => {
    const t = now()
    if (t - windowStart > 60_000) {
      windowStart = t
      sent = 0
    }
    if (last && last.message === e.message && last.kind === e.kind) {
      repeats++
      return
    }
    // the folded repeats of the previous message, then this one, both within the rate
    if (last && repeats > 0 && sent < perMinute) {
      sent++
      send({ ...last, repeat: repeats + 1 })
    }
    repeats = 0
    last = e
    if (sent >= perMinute) return
    sent++
    send({ ...e, message: e.message.slice(0, 2000), ...(e.stack ? { stack: e.stack.slice(0, 4000) } : {}) })
  }
}
