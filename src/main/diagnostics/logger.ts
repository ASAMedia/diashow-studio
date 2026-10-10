// Rotating log file: <dir>/diashow.log, renamed to diashow.1.log … when it grows past maxBytes; the
// newest `keep` old files stay. Lines are written synchronously (a crash right after an error still
// leaves it in the file) and cleaned by redact() first. Errors of the logger itself are swallowed:
// logging must never break the app. No Electron.
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from './redact'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LoggerOptions {
  dir: string
  /** Size at which the file is rotated (default 2 MB). */
  maxBytes?: number
  /** Old files kept besides the current one (default 4). */
  keep?: number
  /** User profile folder, shortened to %USERPROFILE% in every line. */
  home?: string
  /** Longest single entry (default 8000 characters). */
  maxEntry?: number
  now?: () => number
}

export interface Logger {
  readonly dir: string
  readonly file: string
  log(level: LogLevel, source: string, message: unknown, details?: unknown): void
  info(source: string, message: unknown, details?: unknown): void
  warn(source: string, message: unknown, details?: unknown): void
  error(source: string, message: unknown, details?: unknown): void
  /** The log files, newest first (current file, then .1, .2 …). */
  files(): string[]
}

export const LOG_NAME = 'diashow'

/** diashow.log, diashow.1.log, … */
export function logFileName(index: number): string {
  return index === 0 ? `${LOG_NAME}.log` : `${LOG_NAME}.${index}.log`
}

export function createLogger(opts: LoggerOptions): Logger {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024
  const keep = Math.max(0, opts.keep ?? 4)
  const now = opts.now ?? Date.now
  const file = join(opts.dir, logFileName(0))
  let size: number | null = null
  let ready = false

  const ensure = (): void => {
    if (ready) return
    mkdirSync(opts.dir, { recursive: true })
    ready = true
  }

  const rotate = (): void => {
    for (let i = keep; i >= 1; i--) {
      const from = join(opts.dir, logFileName(i - 1))
      const to = join(opts.dir, logFileName(i))
      if (!existsSync(from)) continue
      if (i === keep) rmSync(to, { force: true })
      renameSync(from, to)
    }
    if (keep === 0) rmSync(file, { force: true })
    // files beyond `keep` from an earlier, larger setting
    for (const name of readdirSync(opts.dir)) {
      const m = new RegExp(`^${LOG_NAME}\\.(\\d+)\\.log$`).exec(name)
      if (m && Number(m[1]) > keep) rmSync(join(opts.dir, name), { force: true })
    }
    size = 0
  }

  const line = (level: LogLevel, source: string, message: unknown, details: unknown): string => {
    const text = redact(message, { home: opts.home, maxLength: opts.maxEntry ?? 8000 })
    const extra = details === undefined ? '' : redact(typeof details === 'string' || details instanceof Error ? details : safeJson(details), { home: opts.home, maxLength: opts.maxEntry ?? 8000 })
    const body = extra ? `${text}\n${extra}` : text
    // continuation lines are indented so every entry starts with its time stamp
    const indented = body.replace(/\r?\n/g, '\n    ')
    return `${new Date(now()).toISOString()} ${level.toUpperCase().padEnd(5)} ${source.replace(/\s+/g, '_').slice(0, 40)}: ${indented}\n`
  }

  const log = (level: LogLevel, source: string, message: unknown, details?: unknown): void => {
    try {
      ensure()
      const text = line(level, source, message, details)
      const bytes = Buffer.byteLength(text)
      if (size === null) size = existsSync(file) ? statSync(file).size : 0
      if (size > 0 && size + bytes > maxBytes) rotate()
      appendFileSync(file, text, 'utf8')
      size += bytes
    } catch {
      // a full disk or a locked file: the app goes on without its log
      size = null
    }
  }

  return {
    dir: opts.dir,
    file,
    log,
    info: (s, m, d) => log('info', s, m, d),
    warn: (s, m, d) => log('warn', s, m, d),
    error: (s, m, d) => log('error', s, m, d),
    files() {
      const out: string[] = []
      for (let i = 0; i <= keep; i++) {
        const f = join(opts.dir, logFileName(i))
        if (existsSync(f)) out.push(f)
      }
      return out
    }
  }
}

/** JSON for log details; never throws (cycles, BigInt). */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)) ?? String(value)
  } catch {
    return String(value)
  }
}
