// Frame strips for trimming (media:strip): evenly spread frames, cached per count/height.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMediaService, type MediaService } from '../src/main/media/service'
import { stripTimes, videoStrip } from '../src/main/media/video'
import { analyzeVideo } from '../src/main/media/videoInfo'
import { ff, FFMPEG_DIR } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-strip-'))
const src = join(tmp, 'src')
const cache = join(tmp, 'cache')
let svc: MediaService

beforeAll(async () => {
  mkdirSync(src, { recursive: true })
  // Brightness rises with time (luma = 10 * t), so each frame shows when it was taken
  await ff.run(['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=25:d=20,geq=lum=16+10*T:cb=128:cr=128', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '250', '-pix_fmt', 'yuv420p', join(src, 'ramp.mp4')])
  // Portrait phone clip: stored landscape with a display rotation
  const stored = join(tmp, 'stored.mp4')
  await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', stored])
  await ff.run(['-display_rotation', '-90', '-i', stored, '-c', 'copy', join(src, 'portrait.mp4')])
  // HDR (HLG, 10-bit HEVC)
  await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2', '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',
    '-x265-params', 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', join(src, 'hlg.mov')])
  svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: cache })
}, 120_000)

afterAll(async () => {
  await svc?.dispose()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
})

async function meanLuma(file: string): Promise<number> {
  const { data } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true })
  return data.reduce((s, v) => s + v, 0) / data.length
}

describe('videoStrip', () => {
  it('spreads frames evenly (slice centres) over the duration', async () => {
    expect(stripTimes(20, 5)).toEqual([2, 6, 10, 14, 18])
    expect(stripTimes(0, 2)).toEqual([0, 0])
    const files = await svc.videoStrip(join(src, 'ramp.mp4'), 5, 48)
    expect(files).toHaveLength(5)
    const lumas = await Promise.all(files.map(meanLuma))
    for (let i = 0; i < 5; i++) {
      const meta = await sharp(files[i]).metadata()
      expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 86, 48])
      // 16 + 10 t in limited range, shown full range: (10 t) * 255 / 219
      expect(lumas[i]).toBeGreaterThan(((10 * (4 * i + 2) - 6) * 255) / 219)
      expect(lumas[i]).toBeLessThan(((10 * (4 * i + 2) + 6) * 255) / 219)
    }
  })

  it('caches per count/height in the media folder of the file', async () => {
    const [item] = await svc.importPaths([join(src, 'ramp.mp4')])
    const first = await svc.videoStrip(item.path, 4, 64)
    expect(dirname(first[0])).toBe(join(cache, item.id, 'strip-4x64'))
    const mtime = statSync(first[0]).mtimeMs
    const t0 = performance.now()
    const again = await svc.videoStrip(item.path, 4, 64)
    expect(performance.now() - t0).toBeLessThan(50)
    expect(again).toEqual(first)
    expect(statSync(first[0]).mtimeMs).toBe(mtime)
    // another size is another strip; concurrent calls share the work
    const [a, b] = await Promise.all([svc.videoStrip(item.path, 3, 32), svc.videoStrip(item.path, 3, 32)])
    expect(a).toEqual(b)
    expect(dirname(a[0])).toBe(join(cache, item.id, 'strip-3x32'))
  })

  it('applies the display rotation and tone-maps HDR', async () => {
    const portrait = await svc.videoStrip(join(src, 'portrait.mp4'), 3, 64)
    const meta = await sharp(portrait[1]).metadata()
    expect([meta.width, meta.height]).toEqual([36, 64])
    const hdr = await svc.videoStrip(join(src, 'hlg.mov'), 2, 72)
    const h = await sharp(hdr[0]).metadata()
    expect([h.width, h.height]).toEqual([128, 72])
    const luma = await meanLuma(hdr[0])
    expect(luma).toBeGreaterThan(40)
    expect(luma).toBeLessThan(220)
  })

  it('strips of a proxy go to that proxy’s media folder', async () => {
    const [hlg] = await svc.importPaths([join(src, 'hlg.mov')])
    await svc.idle()
    const item = svc.get(hlg.id)!
    expect(item.playback).toMatch(/proxy\.mp4$/)
    const files = await svc.videoStrip(item.playback!, 2, 40)
    expect(dirname(dirname(files[0]))).toBe(join(cache, item.id))
    expect(files.every((f) => existsSync(f))).toBe(true)
  })

  it('falls back to the first frame where nothing can be decoded (duration longer than the stream)', async () => {
    const src2 = join(src, 'portrait.mp4')
    const info = analyzeVideo(await ff.probe(src2))!
    const files = await videoStrip(ff, src2, { ...info, duration: info.duration * 4 }, 4, 32, join(tmp, 'tail'))
    for (const f of files) expect(statSync(f).size).toBeGreaterThan(0)
  })

  // A long real file (e.g. a 40-minute 1080p export): DIASHOW_TEST_LONG_VIDEO=<path>
  const long = process.env.DIASHOW_TEST_LONG_VIDEO
  it.runIf(!!long && existsSync(long))('is fast on long files (seeks instead of decoding through)', async () => {
    const t0 = performance.now()
    const files = await svc.videoStrip(long!, 12, 90)
    const ms = performance.now() - t0
    console.log(`strip of ${long}: 12 frames in ${Math.round(ms)} ms`)
    expect(files).toHaveLength(12)
    expect(ms).toBeLessThan(10_000)
  })
})
