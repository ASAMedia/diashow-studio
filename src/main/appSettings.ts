// App-wide settings (AppSettings) as JSON in the userData folder (path injected). Electron-free.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppSettings } from '@shared/types'

const MAX_BYTES = 256 * 1024

export interface AppSettingsStore {
  get(): Promise<AppSettings>
  set(settings: AppSettings): Promise<void>
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
  return copy as AppSettings
}

export function createAppSettingsStore(file: string): AppSettingsStore {
  let writing: Promise<void> = Promise.resolve()
  return {
    async get() {
      await writing.catch(() => {})
      try {
        return sanitizeAppSettings(JSON.parse(await readFile(file, 'utf8')))
      } catch {
        return {}
      }
    },
    set(settings) {
      const data = JSON.stringify(sanitizeAppSettings(settings), null, 1)
      if (data.length > MAX_BYTES) return Promise.reject(new Error('settings too large'))
      const run = async (): Promise<void> => {
        await mkdir(dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        await writeFile(tmp, data, 'utf8')
        try {
          await rename(tmp, file)
        } catch (err) {
          await rm(tmp, { force: true })
          throw err
        }
      }
      writing = writing.catch(() => {}).then(run)
      return writing
    }
  }
}
