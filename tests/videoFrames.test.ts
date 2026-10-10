// Video frames at given times for the face analysis (media:frames): one decoding pass for evenly
// spaced times, single seeks otherwise; rotation applied; aligned with the requested times.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { selectExpr, splitJpegs, uniformStep, videoFrames } from '../src/main/media/frames'
import { createMediaService, type MediaService } from '../src/main/media/service'
import { analyzeVideo } from '../src/main/media/videoInfo'
import { ff, FFMPEG_DIR } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-frames-'))
const ramp = join(tmp, 'ramp.mp4')
const portrait = join(tmp, 'portrait.mp4')
let svc: MediaService

beforeAll(async () => {
  mkdirSync(tmp, { recursive: true })
  // Brightness rises with time (luma = 16 + 10 * t), so each frame shows when it was taken
  await ff.run(['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=25:d=10,geq=lum=16+10*T:cb=128:cr=128', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p', ramp])
  const stored = join(tmp, 'stored.mp4')
  await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', stored])
  await ff.run(['-display_rotation', '-90', '-i', stored, '-c', 'copy', portrait])
  svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: join(tmp, 'cache') })
}, 120_000)

afterAll(async () => {
  await svc?.dispose()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
})

async function luma(jpeg: Uint8Array): Promise<number> {
  const { data } = await sharp(Buffer.from(jpeg)).greyscale().raw().toBuffer({ resolveWithObject: true })
  return data.reduce((s, v) => s + v, 0) / data.length
}

describe('frame helpers', () => {
  it('recognises evenly spaced times', () => {
    expect(uniformStep([0.25, 0.75, 1.25])).toBeCloseTo(0.5, 6)
    expect(uniformStep([0.25, 0.75, 1.5])).toBeNull()
    expect(uniformStep([1])).toBeNull()
    expect(selectExpr(0.5)).toContain('ld(0)*0.500000')
  })

  it('splits an MJPEG stream into pictures', () => {
    const a = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9])
    const b = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 3, 0xff, 0xd9])
    const parts = splitJpegs(Buffer.concat([a, b]))
    expect(parts.map((p) => p.length)).toEqual([a.length, b.length])
    expect(splitJpegs(Buffer.alloc(0))).toEqual([])
  })
})

describe('videoFrames', () => {
  it('evenly spaced times: one pass, each frame from its time', async () => {
    const info = analyzeVideo(await ff.probe(ramp))!
    const times = [1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75]
    const frames = await videoFrames(ff, ramp, info, times, 1280)
    expect(frames).toHaveLength(times.length)
    for (let i = 0; i < times.length; i++) {
      // limited range in, full range JPEG out: about (16 + 10 t - 16) * 255 / 219
      const expected = (10 * times[i] * 255) / 219
      expect(Math.abs((await luma(frames[i])) - expected)).toBeLessThan(1.5)
    }
    const meta = await sharp(Buffer.from(frames[0])).metadata()
    // never enlarged
    expect([meta.width, meta.height]).toEqual([320, 180])
  })

  it('other times: one seek each; past the end gives an empty frame', async () => {
    const info = analyzeVideo(await ff.probe(ramp))!
    const times = [0.5, 3.2, 7.7, 30]
    const frames = await videoFrames(ff, ramp, info, times, 160)
    expect(frames[3]).toHaveLength(0)
    for (let i = 0; i < 3; i++) expect(Math.abs((await luma(frames[i])) - (10 * times[i] * 255) / 219)).toBeLessThan(1.5)
    const meta = await sharp(Buffer.from(frames[0])).metadata()
    expect([meta.width, meta.height]).toEqual([160, 90])
  })

  it('through the media service: rotation applied, times sorted and capped', async () => {
    const frames = await svc.videoFrames(portrait, [1.5, 0.5, 1], 640)
    expect(frames).toHaveLength(3)
    const meta = await sharp(Buffer.from(frames[0])).metadata()
    expect([meta.width, meta.height]).toEqual([360, 640])
    expect((await svc.videoFrames(ramp, Array.from({ length: 100 }, (_, i) => i * 0.05), 320)).length).toBe(64)
    await expect(svc.videoFrames('', [1], 320)).rejects.toThrow()
  })
})
