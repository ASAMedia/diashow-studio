// Optional timing trace of the media pipeline for profiling big imports. DIASHOW_MEDIA_TRACE=<file>
// appends one JSON line per stage ({stage, id, t0, t1, ...}, times in ms since the process started
// tracing); without it every call is a no-op.
import { createWriteStream, type WriteStream } from 'node:fs'
import { performance } from 'node:perf_hooks'

export interface TraceEvent {
  stage: string
  id?: string
  /** Start / end in ms (performance.now()). */
  t0: number
  t1: number
  ok?: boolean
  [key: string]: unknown
}

export interface Tracer {
  readonly enabled: boolean
  /** Times `fn` as `stage`; `extra` (or its result's fields via `describe`) are added to the event. */
  span<T>(stage: string, id: string | undefined, fn: () => Promise<T>, extra?: Record<string, unknown>): Promise<T>
  /** A point event (t0 = t1 = now). */
  mark(stage: string, id?: string, extra?: Record<string, unknown>): void
  close(): Promise<void>
}

const noop: Tracer = {
  enabled: false,
  span: (_s, _i, fn) => fn(),
  mark: () => {},
  close: async () => {}
}

export function createTracer(file = process.env.DIASHOW_MEDIA_TRACE): Tracer {
  if (!file) return noop
  let out: WriteStream | null = createWriteStream(file, { flags: 'a' })
  out.on('error', () => {
    out = null
  })
  const write = (e: TraceEvent): void => {
    out?.write(JSON.stringify(e) + '\n')
  }
  const r1 = (v: number): number => Math.round(v * 10) / 10
  return {
    enabled: true,
    async span(stage, id, fn, extra) {
      const t0 = performance.now()
      try {
        const result = await fn()
        write({ stage, id, t0: r1(t0), t1: r1(performance.now()), ok: true, ...extra })
        return result
      } catch (err) {
        write({ stage, id, t0: r1(t0), t1: r1(performance.now()), ok: false, ...extra })
        throw err
      }
    },
    mark(stage, id, extra) {
      const t = r1(performance.now())
      write({ stage, id, t0: t, t1: t, ...extra })
    },
    close() {
      const s = out
      out = null
      return new Promise((resolve) => (s ? s.end(resolve) : resolve()))
    }
  }
}
