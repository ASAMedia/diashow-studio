// Android / Samsung Motion Photos: a still (JPEG/HEIC) with an MP4 appended to the file.
import { open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { exiftool, type Tags } from './exif'

/** True when the tags announce an embedded video (Google MotionPhoto/MicroVideo, Samsung). */
export function isMotionPhoto(tags: Tags): boolean {
  const t = tags as Record<string, unknown>
  const flag = (v: unknown): boolean => v === 1 || v === '1' || v === true || v === 'Yes'
  return (
    flag(t.MotionPhoto) ||
    flag(t.MicroVideo) ||
    t.EmbeddedVideoFile !== undefined ||
    t.MotionPhotoVideo !== undefined ||
    t.EmbeddedVideoType !== undefined ||
    Number(t.MicroVideoOffset) > 0
  )
}

/**
 * True when nothing follows the image data of a JPEG (the file ends with the EOI marker FF D9).
 * Motion Photos append their video (Google) or a trailer (Samsung SEFT) after it, so a JPEG that
 * ends here and whose XMP doesn't announce a video needs no full exiftool read to rule one out.
 */
export async function endsAtJpegEoi(path: string): Promise<boolean> {
  try {
    const fh = await open(path, 'r')
    try {
      const { size } = await fh.stat()
      if (size < 4) return false
      const buf = Buffer.alloc(2)
      await fh.read(buf, 0, 2, size - 2)
      return buf[0] === 0xff && buf[1] === 0xd9
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
}

async function looksLikeMp4(path: string): Promise<boolean> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(12)
    await fh.read(buf, 0, 12, 0)
    return buf.toString('latin1', 4, 8) === 'ftyp'
  } finally {
    await fh.close()
  }
}

async function copyRange(src: string, dest: string, start: number, length: number): Promise<void> {
  const fh = await open(src, 'r')
  try {
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, start)
    await writeFile(dest, buf)
  } finally {
    await fh.close()
  }
}

/** Finds the last 'ftyp' box start after the primary image (offset > 16 skips a HEIC's own ftyp). */
async function findTrailerMp4(path: string, size: number): Promise<number | null> {
  const window = Math.min(size, 64 * 1024 * 1024)
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(window)
    await fh.read(buf, 0, window, size - window)
    let at = buf.lastIndexOf('ftyp')
    while (at >= 4) {
      const offset = size - window + at - 4
      const boxSize = buf.readUInt32BE(at - 4)
      const brand = buf.toString('latin1', at + 4, at + 8)
      if (offset > 16 && boxSize >= 8 && boxSize <= 256 && /^(mp4|isom|iso\d|avc1|mp41|mp42|qt  |M4V |hvc1|heic)/.test(brand)) return offset
      at = buf.lastIndexOf('ftyp', at - 1)
    }
    return null
  } finally {
    await fh.close()
  }
}

/**
 * Writes the embedded video to dest. Tries exiftool's binary tags first, then the
 * MicroVideoOffset trailer length, then a scan for the appended MP4's ftyp box.
 */
export async function extractMotionVideo(path: string, tags: Tags, dest: string): Promise<void> {
  const tmp = `${dest}.part`
  for (const tag of ['MotionPhotoVideo', 'EmbeddedVideoFile', 'EmbeddedVideo']) {
    try {
      await rm(tmp, { force: true })
      await exiftool().extractBinaryTag(tag, path, tmp)
      if ((await stat(tmp)).size > 1024 && (await looksLikeMp4(tmp))) {
        await rename(tmp, dest)
        return
      }
    } catch {
      // tag missing → next strategy
    }
  }
  await rm(tmp, { force: true })
  const size = (await stat(path)).size
  const offset = Number((tags as Record<string, unknown>).MicroVideoOffset)
  if (offset > 0 && offset < size) {
    await copyRange(path, tmp, size - offset, offset)
    if (await looksLikeMp4(tmp)) {
      await rename(tmp, dest)
      return
    }
  }
  const start = await findTrailerMp4(path, size)
  if (start !== null) {
    await copyRange(path, tmp, start, size - start)
    await rename(tmp, dest)
    return
  }
  await rm(tmp, { force: true })
  throw new Error('embedded video not found')
}
