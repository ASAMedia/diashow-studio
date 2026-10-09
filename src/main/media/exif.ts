// Shared exiftool-vendored instance (one perl process pool for the whole app).
import { ExifDateTime, ExifTool, type Tags } from 'exiftool-vendored'

let instance: ExifTool | null = null

export function exiftool(): ExifTool {
  instance ??= new ExifTool({ maxProcs: 4, taskTimeoutMillis: 30_000, geolocation: false })
  return instance
}

export async function endExiftool(): Promise<void> {
  const et = instance
  instance = null
  if (et) await et.end()
}

export type { Tags }

/** Reads tags; never throws (returns {} for unreadable files). */
export async function readTags(path: string, fast: boolean): Promise<Tags> {
  try {
    return await exiftool().read(path, { readArgs: fast ? ['-fast'] : [] })
  } catch {
    return {} as Tags
  }
}

const DATE_TAGS = [
  'SubSecDateTimeOriginal',
  'DateTimeOriginal',
  'CreationDate',
  'SubSecCreateDate',
  'CreateDate',
  'MediaCreateDate',
  'DateTimeCreated',
  'DigitalCreationDateTime'
] as const

/** Capture time in ms since epoch, or undefined when the file has no usable date. */
export function captureTimeOf(tags: Tags): number | undefined {
  const t = tags as Record<string, unknown>
  for (const key of DATE_TAGS) {
    const v = t[key]
    if (v instanceof ExifDateTime) {
      // 1904/1970 epoch placeholders written by some cameras when the clock is unset
      if (v.year < 1980) continue
      const ms = v.toMillis()
      if (Number.isFinite(ms)) return ms
    }
  }
  return undefined
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined
  if (typeof v === 'number') return String(v)
  return undefined
}

/** "iPhone 15 Pro", "ILCE-7M4", "Pixel 8"; Make + Model only when the model is a bare number. */
export function deviceOf(tags: Tags): string | undefined {
  const t = tags as Record<string, unknown>
  const model = str(t.Model) ?? str(t.AndroidModel) ?? str(t.DeviceModelName) ?? str(t.CameraModelName)
  const make = str(t.Make) ?? str(t.AndroidMake) ?? str(t.AndroidManufacturer) ?? str(t.DeviceManufacturer)
  if (model && make && /^[\d\s-]+$/.test(model)) return `${make} ${model}`
  return model ?? make
}

export function orientationOf(tags: Tags): number {
  const o = Number((tags as Record<string, unknown>).Orientation)
  return Number.isInteger(o) && o >= 1 && o <= 8 ? o : 1
}

export function makeOf(tags: Tags): string | undefined {
  const t = tags as Record<string, unknown>
  return str(t.Make) ?? str(t.DeviceManufacturer)
}
