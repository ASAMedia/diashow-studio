// Order of the background processing: thumbnails of everything first, show order, what the renderer
// focuses (prioritize) ahead of the rest, analysis only once every item is usable; HEVC originals
// play directly when the renderer decodes them.
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MediaItem } from '@shared/types'
import { createMediaService } from '../src/main/media/service'
import { ff, FFMPEG_DIR } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-order-'))
const photos = join(tmp, 'photos')
const videos = join(tmp, 'videos')
const NAMES = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `${n}.jpg`)
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

beforeAll(async () => {
  mkdirSync(photos, { recursive: true })
  mkdirSync(videos, { recursive: true })
  const t0 = Date.UTC(2026, 0, 18, 9) / 1000
  for (const [i, name] of NAMES.entries()) {
    const path = join(photos, name)
    // Big enough that a display image takes a moment; no EXIF date: the file time is the capture time
    await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 40 * i, g: 120, b: 200 - 30 * i } } })
      .composite([{ input: Buffer.from(`<svg width="2400" height="1600"><text x="100" y="800" font-size="400">${name}</text></svg>`) }])
      .jpeg({ quality: 90 })
      .toFile(path)
    utimesSync(path, t0 + i * 60, t0 + i * 60)
  }
  const src = ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-ac', '2']
  await ff.run([...src, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(videos, 'h264.mp4')])
  await ff.run([...src, '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest', join(videos, 'hevc8.mp4')])
  await ff.run([...src, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'matroska', join(videos, 'screen.mkv')])
}, 120_000)

describe('processing order', () => {
  it('thumbnails of every item come before any display image; analysis only after every item is ready', async () => {
    const updates: MediaItem[] = []
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: join(tmp, 'cache-1'), photoConcurrency: 1, onUpdate: (u) => updates.push(u) })
    try {
      const items = await svc.importPaths([photos, videos])
      expect(items.map((i) => i.name).slice(0, 6)).toEqual(NAMES)
      await svc.idle()
      const firstReady = updates.findIndex((u) => u.status === 'ready')
      const thumbs = new Set(updates.slice(0, firstReady).filter((u) => u.thumb).map((u) => u.id))
      expect(thumbs.size).toBe(items.length)
      // Index of each item's switch to 'ready' (later updates of a ready item carry analysis results)
      const becameReady = items.map((it) => updates.findIndex((u) => u.id === it.id && u.status === 'ready'))
      expect(becameReady.every((i) => i >= 0)).toBe(true)
      const firstAnalysis = updates.findIndex((u) => u.sharpness !== undefined || u.hash !== undefined)
      expect(firstAnalysis).toBeGreaterThan(Math.max(...becameReady))
      // Photos: display images in show order (one worker), then hash + sharpness for each
      const readyOrder = updates.filter((u) => u.status === 'ready' && u.kind === 'photo' && u.sharpness === undefined).map((u) => u.name)
      expect(readyOrder).toEqual(NAMES)
      for (const it of items) {
        const cur = svc.get(it.id)!
        expect(cur.status, `${cur.name}: ${cur.error}`).toBe('ready')
        expect(cur.hash, cur.name).toMatch(/^[0-9a-f]{16}$/)
        if (cur.kind === 'photo') expect(cur.sharpness).toBeGreaterThan(0)
        else expect(cur.loudness).toBeGreaterThan(-30)
      }
    } finally {
      await svc.dispose()
    }
  })

  it('prioritize(): the focused item is processed first, and its analysis does not wait for the others', async () => {
    const updates: MediaItem[] = []
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: join(tmp, 'cache-2'), photoConcurrency: 1, onUpdate: (u) => updates.push(u) })
    try {
      const items = await svc.importPaths([photos])
      const last = items[items.length - 1]
      // Jobs start on the next macrotask: this lands before any of them
      svc.prioritize(['unknown', last.id])
      await svc.idle()
      const ready = updates.filter((u) => u.status === 'ready' && u.sharpness === undefined).map((u) => u.name)
      expect(ready[0]).toBe(last.name)
      const focusedAnalysis = updates.findIndex((u) => u.id === last.id && u.sharpness !== undefined)
      const othersReady = updates.map((u) => u.status === 'ready' && u.id !== last.id && u.sharpness === undefined).lastIndexOf(true)
      expect(focusedAnalysis).toBeLessThan(othersReady)
    } finally {
      await svc.dispose()
    }
  })
})

describe('playback without proxies', () => {
  it('HEVC plays directly only when the renderer decodes it; Matroska H.264 always; sound copied with its loudness', async () => {
    const run = async (hevc: boolean, cache: string): Promise<Record<string, MediaItem>> => {
      const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: join(tmp, cache), directDecode: async () => ({ hevc }) })
      try {
        const items = await svc.importPaths([videos])
        await svc.idle()
        return Object.fromEntries(items.map((i) => [i.name, svc.get(i.id)!]))
      } finally {
        await svc.dispose()
      }
    }
    const without = await run(false, 'cache-3')
    expect(without['hevc8.mp4'].proxied).toBe(true)
    expect(without['hevc8.mp4'].playback).toMatch(/proxy\.mp4$/)
    const withHevc = await run(true, 'cache-4')
    for (const name of ['hevc8.mp4', 'screen.mkv', 'h264.mp4']) {
      const v = withHevc[name]
      expect(v.status, `${name}: ${v.error}`).toBe('ready')
      expect(v.proxied, name).toBe(false)
      expect(v.playback, name).toBe(v.path)
      // AAC-LC stereo: copied, not re-encoded
      const a = (await ff.probe(v.audio!)).streams[0]
      expect([a.codec_name, a.channels]).toEqual(['aac', 2])
      expect(v.loudness, name).toBeGreaterThan(-30)
    }
  })
})
