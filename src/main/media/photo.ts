// Photo pipeline: any supported still → display JPEG (sRGB, oriented, long edge <= 3840) + thumbnail.
import { rename, rm } from 'node:fs/promises'
import sharp, { type Sharp } from 'sharp'
import { extOf, HEIF_EXT, JXL_EXT, RAW_EXT } from '@shared/formats'
import type { Ffmpeg } from '../ffmpeg'
import { exiftool, orientationOf, type Tags } from './exif'
import { rotationOf, videoStream } from './videoInfo'
import type { RawDecoding } from './raw'

export const DISPLAY_MAX = 3840
export const THUMB_MAX = 360
/**
 * Panoramas (2:1 or wider, either way round) fill the slide's height while they pan, so their display
 * image keeps this much on the short side (1080p exports in every shape, 9:16 too, and the preview)
 * instead of the 3840 px long side; 4K exports get a version with more (prepareHires).
 */
export const PANO_DISPLAY_SHORT = 1920
/** Longest side of a panorama image: the largest texture most graphics cards take (the renderer scales down for smaller ones). */
export const PANO_MAX_LONG = 16384

sharp.cache(false)

export interface PhotoOutput {
  width: number
  height: number
}

/**
 * Applies an EXIF orientation explicitly (for pixels whose own metadata has none, e.g. RAW previews).
 * sharp mirrors before it rotates, so transpose = flop + 270 and transverse = flop + 90.
 */
export function applyOrientation(img: Sharp, orientation: number): Sharp {
  switch (orientation) {
    case 2:
      return img.flop()
    case 3:
      return img.rotate(180)
    case 4:
      return img.flip()
    case 5:
      return img.flop().rotate(270)
    case 6:
      return img.rotate(90)
    case 7:
      return img.flop().rotate(90)
    case 8:
      return img.rotate(270)
    default:
      return img
  }
}

const RAW_LABEL: Record<string, string> = {
  arw: 'Sony ARW',
  sr2: 'Sony SR2',
  srf: 'Sony SRF',
  dng: 'DNG',
  cr2: 'Canon CR2',
  cr3: 'Canon CR3',
  nef: 'Nikon NEF',
  nrw: 'Nikon NRW',
  raf: 'Fujifilm RAF',
  orf: 'Olympus ORF',
  rw2: 'Panasonic RW2',
  pef: 'Pentax PEF',
  srw: 'Samsung SRW'
}

const SIMPLE_LABEL: Record<string, string> = {
  jpg: 'JPEG',
  jpeg: 'JPEG',
  jpe: 'JPEG',
  jfif: 'JPEG',
  png: 'PNG',
  webp: 'WebP',
  avif: 'AVIF',
  gif: 'GIF',
  tif: 'TIFF',
  tiff: 'TIFF',
  bmp: 'BMP',
  jxl: 'JPEG XL'
}

/** 'JPEG', 'HEIC', 'HEIC 10-bit', 'Sony HIF 10-bit 4:2:2', 'Sony ARW', 'Apple ProRAW (DNG)', … */
export function photoFormatLabel(path: string, tags: Tags): string {
  const ext = extOf(path)
  const t = tags as Record<string, unknown>
  const make = String(t.Make ?? '')
  if (RAW_EXT.includes(ext)) {
    if (ext === 'dng' && /apple/i.test(make)) return 'Apple ProRAW (DNG)'
    return RAW_LABEL[ext] ?? ext.toUpperCase()
  }
  if (HEIF_EXT.includes(ext)) {
    const depth = Number(t.BitDepthLuma) || 8
    const chroma = typeof t.ChromaFormat === 'string' ? t.ChromaFormat : ''
    const base = ext === 'hif' ? (/sony/i.test(make) ? 'Sony HIF' : 'HIF') : ext === 'heif' ? 'HEIF' : 'HEIC'
    const parts = [base]
    if (depth > 8) parts.push(`${depth}-bit`)
    if (chroma && chroma !== '4:2:0' && (ext === 'hif' || depth > 8)) parts.push(chroma)
    return parts.join(' ')
  }
  return SIMPLE_LABEL[ext] ?? ext.toUpperCase()
}

async function writeOutputs(img: Sharp, display: string, thumb?: string, panoShort = PANO_DISPLAY_SHORT): Promise<PhotoOutput> {
  const tmp = `${display}.part`
  // the shape is only known after decoding (orientation, RAW previews): a panorama that had to shrink
  // to the long side is made again from a copy of the same input, keeping `panoShort` on its short side
  const again = img.clone()
  let info = await img
    .resize({ width: DISPLAY_MAX, height: DISPLAY_MAX, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .jpeg({ quality: 92 })
    .toFile(tmp)
  const long = Math.max(info.width, info.height)
  if (long >= DISPLAY_MAX && long >= 2 * Math.min(info.width, info.height)) {
    const wide = info.width > info.height
    info = await again
      .resize({ width: wide ? PANO_MAX_LONG : panoShort, height: wide ? panoShort : PANO_MAX_LONG, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .jpeg({ quality: 92 })
      .toFile(tmp)
  }
  await rename(tmp, display)
  if (!thumb) return { width: info.width, height: info.height }
  const thumbTmp = `${thumb}.part`
  await sharp(display)
    .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(thumbTmp)
  await rename(thumbTmp, thumb)
  return { width: info.width, height: info.height }
}

const HDR_STILL_CHAIN =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=pc,format=gbrp'

/**
 * HEIF/HIF/JXL through FFmpeg (sharp's libheif has no HEVC). FFmpeg applies the HEIF irot/imir
 * transform; `+icc_profiles` embeds an ICC profile derived from the nclx colour info (Display P3 on
 * iPhones) so sharp can convert to sRGB. When the container has no rotation but EXIF says otherwise
 * (some cameras only write EXIF), the EXIF orientation is applied afterwards.
 *
 * Tile-grid images (every iPhone HEIC) are stitched by an FFmpeg-internal filtergraph that cannot be
 * combined with -vf, so they are decoded at full size; HDR grids get a second pass for tone mapping.
 */
async function decodeWithFfmpeg(ff: Ffmpeg, path: string, orientation: number, tmpBase: string, signal?: AbortSignal): Promise<Sharp> {
  let rotated = false
  let hdr = false
  let grid = false
  try {
    const probe = await ff.probe(path, signal)
    const vs = videoStream(probe)
    const groups = probe.stream_groups ?? []
    grid = groups.some((g) => /tile grid/i.test(g.type ?? ''))
    // Grid images keep irot on the tile-grid stream group, not on the tiles
    const sideData = [...(vs?.side_data_list ?? []), ...groups.flatMap((g) => (g.components ?? []).flatMap((c) => c.side_data_list ?? []))]
    rotated = sideData.some((d) => d.side_data_type === 'Display Matrix') || (!!vs && rotationOf(vs) !== 0)
    hdr = vs?.color_transfer === 'arib-std-b67' || vs?.color_transfer === 'smpte2084'
  } catch {
    // probe failures surface again in the decode below
  }
  // at most the display size; a panorama (2:1 and more) keeps up to PANO_MAX_LONG on its long side, so
  // writeOutputs can keep its short side (with 3840 here an 8000×2000 one came out 3840×960)
  const scale = `scale=w='if(gte(iw,2*ih),min(${PANO_MAX_LONG},iw),min(${DISPLAY_MAX},iw))':h='if(gte(ih,2*iw),min(${PANO_MAX_LONG},ih),min(${DISPLAY_MAX},ih))':force_original_aspect_ratio=decrease:flags=lanczos`
  const pngOut = ['-flags2', '+icc_profiles', '-c:v', 'png', '-compression_level', '1', '-f', 'image2pipe', '-']
  let png: Buffer
  if (!grid) {
    png = await ff.capture(['-i', path, '-frames:v', '1', '-vf', hdr ? `${scale},${HDR_STILL_CHAIN}` : scale, ...pngOut], { signal })
  } else if (!hdr) {
    png = await ff.capture(['-i', path, '-frames:v', '1', ...pngOut], { signal })
  } else {
    const stitched = `${tmpBase}.grid.png`
    try {
      await ff.run(['-i', path, '-frames:v', '1', '-c:v', 'png', '-compression_level', '1', stitched], { signal })
      png = await ff.capture(['-i', stitched, '-frames:v', '1', '-vf', `${scale},${HDR_STILL_CHAIN}`, ...pngOut], { signal })
    } finally {
      await rm(stitched, { force: true })
    }
  }
  if (!png.length) throw new Error('could not decode image')
  const img = sharp(png, { failOn: 'none', limitInputPixels: 1e9 })
  return rotated ? img : applyOrientation(img, orientation)
}

/** Largest embedded JPEG of a RAW file (JpgFromRaw / PreviewImage / OtherImage). */
async function embeddedPreview(path: string, tags: Tags): Promise<Sharp> {
  const t = tags as Record<string, unknown>
  const candidates = ['JpgFromRaw', 'PreviewImage', 'OtherImage', 'ThumbnailImage']
    .map((tag) => ({ tag, bytes: Number((t[tag] as { bytes?: number } | undefined)?.bytes ?? 0) }))
    .filter((c) => c.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
  for (const c of candidates) {
    try {
      const buf = await exiftool().extractBinaryTagToBuffer(c.tag as 'PreviewImage', path)
      if (buf.length < 1024) continue
      const meta = await sharp(buf).metadata()
      const img = sharp(buf, { failOn: 'none' })
      // Previews rarely carry their own orientation; the RAW's IFD0 Orientation applies
      return meta.orientation && meta.orientation !== 1 ? img.rotate() : applyOrientation(img, orientationOf(tags))
    } catch {
      // try the next candidate
    }
  }
  throw new Error('RAW format not supported and no embedded preview found')
}

export interface PhotoDeps {
  ff: Ffmpeg
  raw: RawDecoding
}

/**
 * Thumbnail straight from the original for formats sharp decodes (JPEGs are decoded at 1/8 scale,
 * several times faster than the display render), so a big import shows every thumbnail long before
 * the display images exist. Same orientation and colour handling as the display path.
 */
export async function renderThumb(path: string, out: string): Promise<void> {
  const tmp = `${out}.part`
  try {
    await sharp(path, { failOn: 'none', limitInputPixels: 1e9 })
      .rotate()
      .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .jpeg({ quality: 80 })
      .toFile(tmp)
    await rename(tmp, out)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/**
 * Renders display.jpg (+ thumb.jpg unless out.thumb is omitted) for a still image. Returns the display
 * dimensions. `out.panoShort`: short side a panorama keeps (PANO_DISPLAY_SHORT; more for 4K exports).
 */
export async function renderPhoto(
  deps: PhotoDeps,
  path: string,
  tags: Tags,
  out: { display: string; thumb?: string; panoShort?: number },
  signal?: AbortSignal
): Promise<PhotoOutput & { via: string }> {
  const ext = extOf(path)
  let img: Sharp
  let via = 'sharp'
  if (HEIF_EXT.includes(ext) || JXL_EXT.includes(ext)) {
    img = await decodeWithFfmpeg(deps.ff, path, orientationOf(tags), out.display, signal)
    via = 'ffmpeg'
  } else if (RAW_EXT.includes(ext)) {
    const decoded = await decodeRaw(deps, path, tags)
    img = decoded.img
    via = decoded.via
  } else {
    img = sharp(path, { failOn: 'none', limitInputPixels: 1e9 }).rotate()
  }
  try {
    const result = await writeOutputs(img, out.display, out.thumb, out.panoShort)
    return { ...result, via }
  } catch (err) {
    await rm(`${out.display}.part`, { force: true })
    if (out.thumb) await rm(`${out.thumb}.part`, { force: true })
    throw err
  }
}

async function decodeRaw(deps: PhotoDeps, path: string, tags: Tags): Promise<{ img: Sharp; via: string }> {
  if (deps.raw.available) {
    try {
      const raw = await deps.raw.decode(path)
      const img = sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } })
      return { img, via: 'libraw' }
    } catch {
      // fall through to the embedded preview (compressed formats this LibRaw build lacks, etc.)
    }
  }
  return { img: await embeddedPreview(path, tags), via: 'preview' }
}
