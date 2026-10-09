// Header-only photo metadata (fast import path) must agree with exiftool.
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureTimeOf, endExiftool, readTags } from '../src/main/media/exif'
import { exifInstant, parseExif, quickPhotoMeta } from '../src/main/media/quickMeta'
import { ensureTestMedia, TEST_MEDIA } from './helpers/media'

beforeAll(() => ensureTestMedia(), 300_000)
afterAll(() => endExiftool())

/** Minimal big-endian EXIF block: IFD0 (Make, Orientation, ExifIFD) + Exif IFD (date, offset). */
function exifMM(): Buffer {
  const entries0 = [
    [0x010f, 2, 6, 'Canon\0'],
    [0x0112, 3, 1, 8],
    [0x8769, 4, 1, 0]
  ] as const
  const date = '2024:12:24 18:30:05\0'
  const buf = Buffer.alloc(200)
  buf.write('MM', 0, 'latin1')
  buf.writeUInt16BE(42, 2)
  buf.writeUInt32BE(8, 4)
  let off = 8
  buf.writeUInt16BE(entries0.length, off)
  const exifIfd = 8 + 2 + entries0.length * 12 + 4
  const makeAt = exifIfd + 2 + 2 * 12 + 4
  const dateAt = makeAt + 8
  entries0.forEach(([tag, type, count, value], i) => {
    const e = off + 2 + i * 12
    buf.writeUInt16BE(tag, e)
    buf.writeUInt16BE(type, e + 2)
    buf.writeUInt32BE(count, e + 4)
    if (tag === 0x010f) buf.writeUInt32BE(makeAt, e + 8)
    else if (tag === 0x0112) buf.writeUInt16BE(value as number, e + 8)
    else buf.writeUInt32BE(exifIfd, e + 8)
  })
  off = exifIfd
  buf.writeUInt16BE(2, off)
  buf.writeUInt16BE(0x9003, off + 2)
  buf.writeUInt16BE(2, off + 4)
  buf.writeUInt32BE(date.length, off + 6)
  buf.writeUInt32BE(dateAt, off + 10)
  buf.writeUInt16BE(0x9011, off + 14)
  buf.writeUInt16BE(2, off + 16)
  buf.writeUInt32BE(4, off + 18)
  buf.write('-05\0', off + 22, 'latin1')
  buf.write('Canon\0', makeAt, 'latin1')
  buf.write(date, dateAt, 'latin1')
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), buf])
}

describe('quick EXIF reader', () => {
  it('parses big-endian EXIF with inline and offset values', () => {
    const tags = parseExif(exifMM())
    expect(tags.get(0x010f)).toBe('Canon')
    expect(tags.get(0x0112)).toBe(8)
    expect(tags.get(0x9003)).toBe('2024:12:24 18:30:05')
    expect(tags.get(0x9011)).toBe('-05')
    expect(parseExif(Buffer.from('garbage'))).toEqual(new Map())
  })

  it('turns zoned EXIF dates into instants, and refuses unzoned ones', () => {
    expect(exifInstant('2025:08:01 12:01:00', '+02:00')).toBe(Date.parse('2025-08-01T12:01:00+02:00'))
    expect(exifInstant('2025:08:01 12:01:00', '+02:00', '57')).toBe(Date.parse('2025-08-01T12:01:00.570+02:00'))
    expect(exifInstant('2025:08:01 12:01:00', '-0330', '123456')).toBe(Date.parse('2025-08-01T12:01:00.123-03:30'))
    expect(exifInstant('2025:08:01 12:01:00', undefined)).toBeUndefined()
    expect(exifInstant('1970:01:01 00:00:00', '+00:00')).toBeUndefined()
  })

  it('matches exiftool on the test photos (size after orientation, camera, capture time)', async () => {
    for (const rel of [['iphone', 'IMG_0003.JPG'], ['android', 'PXL_0002.jpg'], ['sony', 'DCIM', '100MSDCF', 'DSC00001.JPG']]) {
      const path = join(TEST_MEDIA, ...rel)
      const quick = (await quickPhotoMeta(path))!
      const tags = await readTags(path, false)
      const t = tags as Record<string, unknown>
      expect(quick.captureTime, rel.join('/')).toBe(captureTimeOf(tags))
      expect(quick.make).toBe(t.Make)
      expect(quick.model).toBe(t.Model)
    }
    expect(await quickPhotoMeta(join(TEST_MEDIA, 'iphone', 'IMG_0003.JPG'))).toMatchObject({ width: 900, height: 1200, orientation: 6 })
    // No EXIF date: the caller falls back to exiftool
    expect((await quickPhotoMeta(join(TEST_MEDIA, 'misc', 'pano.png')))?.captureTime).toBeUndefined()
    expect(await quickPhotoMeta(join(TEST_MEDIA, 'misc', 'notes.txt'))).toBeNull()
  })
})
