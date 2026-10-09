// Hi-res playback versions of proxied videos for 4K exports (prepareHires / export:hires).
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExportProgress, MediaItem } from '@shared/types'
import { createMediaService, type MediaService } from '../src/main/media/service'
import { rotationOf, videoStream } from '../src/main/media/videoInfo'
import { ff, FFMPEG_DIR } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-hires-'))
const src = join(tmp, 'src')
let svc: MediaService
let items: MediaItem[]
const byName = (name: string): MediaItem => svc.get(items.find((i) => i.name === name)!.id)!

beforeAll(async () => {
  mkdirSync(src, { recursive: true })
  const lavfi = (s: string, d = 2): string[] => ['-f', 'lavfi', '-i', `testsrc2=s=${s}:r=25:d=${d}`]
  // HEVC 2560x1440: needs a proxy (1920x1080), and a hi-res version is worth it
  await ff.run([...lavfi('2560x1440'), '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error', join(src, 'big-hevc.mp4')])
  // Portrait phone clip stored landscape with a rotation flag: the hi-res version bakes it in
  const stored = join(tmp, 'rot-src.mp4')
  await ff.run([...lavfi('2400x1350'), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', stored])
  await ff.run(['-display_rotation', '-90', '-i', stored, '-c', 'copy', join(src, 'rotated.mp4')])
  // Small HEVC: proxied, but the proxy already has the full resolution
  await ff.run([...lavfi('1280x720'), '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error', join(src, 'small-hevc.mp4')])
  // Direct playable H.264
  await ff.run([...lavfi('1920x1080'), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-profile:v', 'high', join(src, 'plain.mp4')])
  svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: join(tmp, 'cache') })
  items = await svc.importPaths([src])
  await svc.idle()
}, 300_000)

afterAll(async () => {
  await svc?.dispose()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
})

describe('prepareHires', () => {
  it('transcodes proxied videos larger than their proxy, keeps everything else', async () => {
    const big = byName('big-hevc.mp4')
    const rotated = byName('rotated.mp4')
    const small = byName('small-hevc.mp4')
    const plain = byName('plain.mp4')
    expect(big.proxied).toBe(true)
    expect(rotated.proxied).toBe(true)
    expect([rotated.width, rotated.height]).toEqual([1350, 2400])
    expect(plain.proxied).toBe(false)

    const progress: ExportProgress[] = []
    const result = await svc.prepareHires([big.id, rotated.id, small.id, plain.id, 'unknown'], 3840, { onProgress: (p) => progress.push(p) })
    expect(Object.keys(result).sort()).toEqual([big.id, rotated.id, small.id, plain.id].sort())
    expect(result[small.id]).toBe(small.playback)
    expect(result[plain.id]).toBe(plain.path)
    expect(result[big.id]).toMatch(/proxy_3840\.mp4$/)
    expect(result[rotated.id]).toMatch(/proxy_3840\.mp4$/)

    for (const [id, size] of [
      [big.id, [2560, 1440]],
      [rotated.id, [1350, 2400]]
    ] as const) {
      const probe = await ff.probe(result[id])
      const vs = videoStream(probe)!
      expect([vs.codec_name, vs.pix_fmt, vs.profile]).toEqual(['h264', 'yuv420p', 'High'])
      expect([vs.width, vs.height]).toEqual(size)
      expect(rotationOf(vs)).toBe(0)
      expect(probe.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(0)
    }

    expect(progress.length).toBeGreaterThanOrEqual(3)
    expect(progress.every((p) => p.phase === 'prepare')).toBe(true)
    const last = progress[progress.length - 1]
    expect(last).toEqual({ phase: 'prepare', frame: 100, totalFrames: 100, message: '2/2' })
    expect(progress[0]).toMatchObject({ frame: 0, totalFrames: 100, message: '1/2' })
    expect(progress.map((p) => p.message)).toContain('2/2')
    for (let i = 1; i < progress.length; i++) expect(progress[i].frame!).toBeGreaterThanOrEqual(progress[i - 1].frame!)
  })

  it('reuses cached hi-res files and needs nothing for a 1920 export', async () => {
    const big = byName('big-hevc.mp4')
    const progress: ExportProgress[] = []
    const again = await svc.prepareHires([big.id], 3840, { onProgress: (p) => progress.push(p) })
    expect(again[big.id]).toMatch(/proxy_3840\.mp4$/)
    expect(progress).toHaveLength(0)
    expect((await svc.prepareHires([big.id], 1920))[big.id]).toBe(big.playback)
  })

  it('can be cancelled', async () => {
    const rotated = byName('rotated.mp4')
    const ctrl = new AbortController()
    const run = svc.prepareHires([rotated.id], 2560, { signal: ctrl.signal, onProgress: () => ctrl.abort() })
    await expect(run).rejects.toThrow(/cancelled/)
    expect(existsSync(join(tmp, 'cache', rotated.id, 'proxy_2560.mp4'))).toBe(false)
  })
})
