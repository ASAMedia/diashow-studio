// App-wide settings (AppSettings) as JSON in the userData folder (path injected). Electron-free.
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppSettings } from '@shared/types'
import { validHost } from '@shared/netPaths'
import { replaceFile } from './replaceFile'

const MAX_BYTES = 256 * 1024

export interface AppSettingsStore {
  get(): Promise<AppSettings>
  set(settings: AppSettings): Promise<void>
  /** Merges `patch` into the stored settings (after earlier writes); other fields stay. */
  update(patch: AppSettings): Promise<void>
}

/** Drops update-check fields of the wrong type (the release URL is opened in the browser). */
function sanitizeUpdateFields(copy: Record<string, unknown>): void {
  if (copy.updateCheck !== undefined && typeof copy.updateCheck !== 'boolean') delete copy.updateCheck
  if (copy.updateCheckedAt !== undefined && !(typeof copy.updateCheckedAt === 'number' && Number.isFinite(copy.updateCheckedAt))) delete copy.updateCheckedAt
  const latest = copy.updateLatest as { version?: unknown; url?: unknown } | null | undefined
  if (latest !== undefined && latest !== null) {
    const ok = typeof latest === 'object' && typeof latest.version === 'string' && latest.version.length <= 64 && typeof latest.url === 'string' && /^https:\/\/github\.com\//.test(latest.url) && latest.url.length <= 512
    if (!ok) delete copy.updateLatest
  }
}

/** Plain JSON object with the known fields validated; unknown fields are kept for newer renderers. */
export function sanitizeAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  let copy: Record<string, unknown>
  try {
    copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  } catch {
    return {}
  }
  const kiosk = copy.kioskProjectId
  if (kiosk !== undefined && kiosk !== null && !(typeof kiosk === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(kiosk))) delete copy.kioskProjectId
  sanitizeUpdateFields(copy)
  if (copy.gpuPreference !== undefined && copy.gpuPreference !== 'performance' && copy.gpuPreference !== 'saving') delete copy.gpuPreference
  if (copy.trustedHosts !== undefined) {
    const hosts = Array.isArray(copy.trustedHosts) ? copy.trustedHosts.filter(validHost).map((h) => h.toLowerCase()) : []
    copy.trustedHosts = [...new Set(hosts)].slice(0, 200)
  }
  return copy as AppSettings
}

/** The settings at start-up, before anything else runs (e.g. Chromium switches); {} if unreadable. */
export function readAppSettingsSync(file: string): AppSettings {
  try {
    return sanitizeAppSettings(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}

export function createAppSettingsStore(file: string): AppSettingsStore {
  // Reads and writes take turns: on Windows, replacing the file fails while a read still has it open
  // (several parts of the UI read the settings when a dialog opens, while another part writes).
  let queue: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn)
    queue = next.catch(() => {})
    return next
  }
  const read = async (): Promise<AppSettings> => {
    try {
      return sanitizeAppSettings(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      return {}
    }
  }
  const write = async (settings: AppSettings): Promise<void> => {
    const data = JSON.stringify(sanitizeAppSettings(settings), null, 1)
    if (data.length > MAX_BYTES) throw new Error('settings too large')
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, data, 'utf8')
    try {
      // a virus scanner may still hold the old file for a moment
      await replaceFile(tmp, file)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
  }
  return {
    get() {
      return inTurn(read)
    },
    set(settings) {
      const data = JSON.stringify(sanitizeAppSettings(settings), null, 1)
      if (data.length > MAX_BYTES) return Promise.reject(new Error('settings too large'))
      return inTurn(() => write(settings))
    },
    update(patch) {
      return inTurn(async () => write({ ...(await read()), ...sanitizeAppSettings(patch) }))
    }
  }
}
