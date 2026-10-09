// Image analysis for "find rejects": a difference hash for near-duplicates and a sharpness score for
// blurry shots. Both work on a small greyscale copy, so they cost a few milliseconds per photo.
import sharp from 'sharp'

/** Long edge of the greyscale copy the sharpness is measured on. */
export const ANALYSIS_EDGE = 512
/**
 * sharpness = 1 - exp(-v / K), v = Laplacian variance relative to the tile's contrast. Calibrated on
 * 466 phone and camera photos of a ski trip: median 0.76, quartiles 0.66 / 0.89; motion-blurred,
 * misfocused and smeared low-light shots fall below ~0.35.
 */
export const SHARPNESS_K = 0.56
/** Grey levels added to a tile's standard deviation so flat, noisy areas (sky, snow) don't count as detail. */
const CONTRAST_FLOOR = 10
const TILES_X = 4
const TILES_Y = 4

export interface ImageAnalysis {
  /** 64-bit dHash, 16 lowercase hex chars. */
  hash: string
  /** 0 (blurred) .. 1 (crisp). */
  sharpness: number
}

/**
 * dHash of a 9x8 greyscale image (row-major): bit = left pixel brighter than its right neighbour,
 * first row first, most significant bit first.
 */
export function dHashBits(grey9x8: ArrayLike<number>): string {
  let hex = ''
  for (let y = 0; y < 8; y++) {
    let byte = 0
    for (let x = 0; x < 8; x++) {
      const i = y * 9 + x
      byte = (byte << 1) | (grey9x8[i] > grey9x8[i + 1] ? 1 : 0)
    }
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/** Number of differing bits between two hashes (0..64); 64 when either is malformed. */
export function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return 64
  let d = 0
  for (let i = 0; i < 16; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0
    while (x) {
      x &= x - 1
      d++
    }
  }
  return d
}

/**
 * Per tile of a greyscale image: variance of the 4-neighbour Laplacian divided by the squared
 * (floored) standard deviation of the grey levels. The Laplacian alone confuses low contrast (haze,
 * fog, snow fields) with blur; relative to the tile's contrast it measures how steep the edges are.
 * Tiles make the score follow the in-focus part: a sharp skier in front of a blank slope is sharp.
 */
export function tileSharpness(grey: Uint8Array | Buffer, width: number, height: number): number[] {
  const out: number[] = []
  if (width < 3 || height < 3) return out
  for (let ty = 0; ty < TILES_Y; ty++) {
    const y0 = Math.max(1, Math.floor((ty * height) / TILES_Y))
    const y1 = Math.min(height - 1, Math.floor(((ty + 1) * height) / TILES_Y))
    for (let tx = 0; tx < TILES_X; tx++) {
      const x0 = Math.max(1, Math.floor((tx * width) / TILES_X))
      const x1 = Math.min(width - 1, Math.floor(((tx + 1) * width) / TILES_X))
      let n = 0
      let lapSum = 0
      let lapSq = 0
      let sum = 0
      let sq = 0
      for (let y = y0; y < y1; y++) {
        const row = y * width
        for (let x = x0; x < x1; x++) {
          const i = row + x
          const g = grey[i]
          const v = grey[i - width] + grey[i + width] + grey[i - 1] + grey[i + 1] - 4 * g
          lapSum += v
          lapSq += v * v
          sum += g
          sq += g * g
          n++
        }
      }
      if (!n) continue
      const lapVar = Math.max(0, lapSq / n - (lapSum / n) ** 2)
      const sd = Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2))
      out.push(lapVar / (sd + CONTRAST_FLOOR) ** 2)
    }
  }
  return out
}

/** Sharpness 0..1 from the per-tile values: the second-sharpest tile, mapped with 1 - exp(-v/K). */
export function sharpnessFromTiles(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => b - a)
  // The second tile, not the first: a single tile of text, foliage or noise should not decide alone
  const v = sorted[Math.min(1, sorted.length - 1)]
  return Math.round((1 - Math.exp(-v / SHARPNESS_K)) * 1000) / 1000
}

/** Greyscale copy of an image file with its long edge scaled to `edge` (never upscaled). */
async function greyCopy(input: string, edge: number): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(input, { failOn: 'none', limitInputPixels: 1e9 })
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 1) throw new Error(`expected a single grey channel, got ${info.channels}`)
  return { data, width: info.width, height: info.height }
}

async function hashOfGrey(grey: { data: Buffer; width: number; height: number }): Promise<string> {
  // sharp turns single-channel raw input into sRGB on output unless told otherwise
  const { data, info } = await sharp(grey.data, { raw: { width: grey.width, height: grey.height, channels: 1 } })
    .resize(9, 8, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const values = Array.from({ length: 72 }, (_, i) => data[i * info.channels])
  return dHashBits(values)
}

/** dHash of an image file (e.g. a video thumbnail). */
export async function imageHash(path: string): Promise<string> {
  return hashOfGrey(await greyCopy(path, ANALYSIS_EDGE))
}

/**
 * Hash + sharpness of an already oriented image (the display JPEG), from one decode at <= 512 px.
 * At that size sensor noise and JPEG artefacts are averaged away, while a missed focus or motion
 * blur of more than a few pixels in the original still removes most of the Laplacian's response.
 */
export async function analyzeImage(path: string): Promise<ImageAnalysis> {
  const grey = await greyCopy(path, ANALYSIS_EDGE)
  const sharpness = sharpnessFromTiles(tileSharpness(grey.data, grey.width, grey.height))
  return { hash: await hashOfGrey(grey), sharpness }
}
