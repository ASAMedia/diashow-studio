// Header-only metadata for stills sharp can read (JPEG, PNG, WebP, TIFF, AVIF): size, orientation,
// camera and the capture time from a minimal EXIF reader. ~10x faster than an exiftool round trip,
// which keeps importPaths quick for big folders; the full exiftool read still runs in the background.
import sharp from 'sharp'

export interface QuickMeta {
  /** Display size (EXIF orientation applied). */
  width: number
  height: number
  orientation: number
  make?: string
  model?: string
  /**
   * Capture time in ms since epoch. Only set when the EXIF date carries its UTC offset
   * (OffsetTimeOriginal / OffsetTimeDigitized): without one, the zone has to be inferred the way
   * exiftool-vendored does it (GPS position, other dates), so callers fall back to exiftool.
   */
  captureTime?: number
}

const TAG = {
  make: 0x010f,
  model: 0x0110,
  orientation: 0x0112,
  exifIfd: 0x8769,
  dateTimeOriginal: 0x9003,
  createDate: 0x9004,
  offsetTimeOriginal: 0x9011,
  offsetTimeDigitized: 0x9012,
  subSecOriginal: 0x9291,
  subSecDigitized: 0x9292
}

/** IFD0 + Exif IFD entries (ASCII, SHORT, LONG) of an EXIF block ("Exif\0\0" prefix optional). */
export function parseExif(exif: Buffer): Map<number, string | number> {
  const out = new Map<number, string | number>()
  const base = exif.length >= 6 && exif.toString('latin1', 0, 6) === 'Exif\0\0' ? 6 : 0
  const order = exif.toString('latin1', base, base + 2)
  if (order !== 'II' && order !== 'MM') return out
  const le = order === 'II'
  const fits = (off: number, len: number): boolean => off >= 0 && base + off + len <= exif.length
  const u16 = (off: number): number => (le ? exif.readUInt16LE(base + off) : exif.readUInt16BE(base + off))
  const u32 = (off: number): number => (le ? exif.readUInt32LE(base + off) : exif.readUInt32BE(base + off))
  const readIfd = (off: number, depth: number): void => {
    if (!fits(off, 2)) return
    const n = u16(off)
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12
      if (!fits(e, 12)) break
      const tag = u16(e)
      const type = u16(e + 2)
      const count = u32(e + 4)
      if (type === 2) {
        const start = count > 4 ? u32(e + 8) : e + 8
        if (!fits(start, count)) continue
        const text = exif.toString('latin1', base + start, base + start + count)
        const end = text.indexOf('\0')
        out.set(tag, (end >= 0 ? text.slice(0, end) : text).trim())
      } else if (type === 3) {
        out.set(tag, u16(e + 8))
      } else if (type === 4) {
        out.set(tag, u32(e + 8))
      }
    }
    const sub = out.get(TAG.exifIfd)
    if (depth === 0 && typeof sub === 'number') readIfd(sub, 1)
  }
  if (fits(4, 4)) readIfd(u32(4), 0)
  return out
}

/** "2026:01:19 20:56:58" + "+01:00" + "123" → ms since epoch, or undefined. */
export function exifInstant(date: unknown, offset: unknown, subSec?: unknown): number | undefined {
  if (typeof date !== 'string' || typeof offset !== 'string') return undefined
  const d = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(date)
  const o = /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim())
  if (!d || !o || Number(d[1]) < 1980) return undefined
  const digits = typeof subSec === 'string' && /^\d+$/.test(subSec.trim()) ? subSec.trim() : ''
  const ms = digits ? Number(digits.padEnd(3, '0').slice(0, 3)) : 0
  const t = Date.parse(`${d[1]}-${d[2]}-${d[3]}T${d[4]}:${d[5]}:${d[6]}.${String(ms).padStart(3, '0')}${o[1]}${o[2]}:${o[3]}`)
  return Number.isFinite(t) ? t : undefined
}

export async function quickPhotoMeta(path: string): Promise<QuickMeta | null> {
  try {
    const meta = await sharp(path, { failOn: 'none', limitInputPixels: false }).metadata()
    if (!meta.width || !meta.height) return null
    const tags = meta.exif ? parseExif(meta.exif) : new Map<number, string | number>()
    const orientation = meta.orientation && meta.orientation >= 1 && meta.orientation <= 8 ? meta.orientation : 1
    const swap = orientation >= 5
    const str = (tag: number): string | undefined => {
      const v = tags.get(tag)
      return typeof v === 'string' && v ? v : undefined
    }
    return {
      width: swap ? meta.height : meta.width,
      height: swap ? meta.width : meta.height,
      orientation,
      make: str(TAG.make),
      model: str(TAG.model),
      // Same precedence as captureTimeOf: DateTimeOriginal decides when present
      captureTime: tags.has(TAG.dateTimeOriginal)
        ? exifInstant(tags.get(TAG.dateTimeOriginal), tags.get(TAG.offsetTimeOriginal), tags.get(TAG.subSecOriginal))
        : exifInstant(tags.get(TAG.createDate), tags.get(TAG.offsetTimeDigitized), tags.get(TAG.subSecDigitized))
    }
  } catch {
    return null
  }
}
