// Stabilising shaky clips: same frames, timestamps and size as the source, less shake, no edges;
// the media service caches the result, reports progress, keeps it across restarts and treats it
// like a proxy in the cache cleanup.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MediaItem } from '@shared/types'
import { createMediaService } from '../src/main/media/service'
import { stabilizeFile, transformFilter } from '../src/main/media/stabilize'
import { ff, FFMPEG_DIR } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-stab-'))
const src = join(tmp, 'src')
const W = 640
const H = 360
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

/** A detailed still larger than the frame, so a moving crop of it looks like a hand-held camera. */
async function still(path: string): Promise<void> {
  let s = 11
  const r = (): number => ((s = (s * 16807) % 2147483647) / 2147483647)
  const shapes: string[] = []
  for (let i = 0; i < 260; i++) {
    const c = `hsl(${Math.floor(r() * 360)},${30 + Math.floor(r() * 50)}%,${20 + Math.floor(r() * 60)}%)`
    const x = r() * 800
    const y = r() * 480
    const w = 6 + r() * 50
    shapes.push(r() < 0.5 ? `<rect x="${x}" y="${y}" width="${w}" height="${6 + r() * 50}" fill="${c}" transform="rotate(${r() * 90} ${x} ${y})"/>` : `<circle cx="${x}" cy="${y}" r="${w / 2}" fill="${c}"/>`)
  }
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480"><rect width="800" height="480" fill="#7a8f6a"/>${shapes.join('')}</svg>`)).png().toFile(path)
}

/** Shake: two fast wobbles per axis (up to ~13 px) on top of a slow pan. */
const SHAKE = "crop=640:360:x='80+30*sin(0.4*t)+8*sin(9.1*t)+5*sin(13.7*t+1)':y='60+6*sin(7.3*t+0.5)+5*sin(11.9*t)'"

async function probeFrames(file: string): Promise<{ pts: string[]; width: number; height: number; duration: number; streams: string[] }> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(ff.ffprobePath, ['-v', 'error', '-show_entries', 'packet=pts_time:stream=codec_type,width,height:format=duration', '-select_streams', 'v:0', '-of', 'json', file])
    let text = ''
    p.stdout.on('data', (c: Buffer) => (text += c))
    p.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(`ffprobe ${code}`))))
  })
  const j = JSON.parse(out) as { packets: { pts_time: string }[]; streams: { codec_type: string; width: number; height: number }[]; format: { duration: string } }
  const all = await ff.probe(file)
  return {
    pts: j.packets.map((p) => Number(p.pts_time).toFixed(4)).sort((a, b) => Number(a) - Number(b)),
    width: j.streams[0].width,
    height: j.streams[0].height,
    duration: Number(j.format.duration),
    streams: all.streams.map((s) => s.codec_type ?? '')
  }
}

/** Grey frames at a quarter of the size. */
async function frames(file: string): Promise<Uint8Array[]> {
  const raw = await ff.capture(['-i', file, '-vf', `scale=${W / 2}:${H / 2},format=gray`, '-f', 'rawvideo', '-'])
  const n = (W / 2) * (H / 2)
  return Array.from({ length: Math.floor(raw.length / n) }, (_, i) => raw.subarray(i * n, (i + 1) * n))
}

/** Camera shake: RMS distance (full-size px) of the camera path from its 1 s moving average. */
function shake(list: Uint8Array[]): number {
  const w = W / 2
  const h = H / 2
  const sad = (a: Uint8Array, b: Uint8Array, dx: number, dy: number): number => {
    let s = 0
    for (let y = 40; y < h - 40; y += 2) for (let x = 40; x < w - 40; x += 2) s += Math.abs(a[y * w + x] - b[(y + dy) * w + x + dx])
    return s
  }
  const path: [number, number][] = [[0, 0]]
  for (let i = 1; i < list.length; i++) {
    let best = [0, 0, Infinity]
    for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
      const v = sad(list[i - 1], list[i], dx, dy)
      if (v < best[2]) best = [dx, dy, v]
    }
    const [px, py] = path[i - 1]
    path.push([px + best[0], py + best[1]])
  }
  let e = 0
  for (let i = 0; i < path.length; i++) {
    let sx = 0
    let sy = 0
    let c = 0
    for (let j = Math.max(0, i - 15); j <= Math.min(path.length - 1, i + 15); j++) {
      sx += path[j][0]
      sy += path[j][1]
      c++
    }
    e += (path[i][0] - sx / c) ** 2 + (path[i][1] - sy / c) ** 2
  }
  return 2 * Math.sqrt(e / path.length)
}

beforeAll(async () => {
  mkdirSync(src, { recursive: true })
  await still(join(tmp, 'still.png'))
  // constant 30 fps with sound (the stabilised copy is video only)
  await ff.run(['-loop', '1', '-framerate', '30', '-i', join(tmp, 'still.png'), '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-t', '4', '-vf', `${SHAKE},format=yuv420p`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-c:a', 'aac', '-shortest', join(src, 'shaky.mp4')])
  // variable frame rate like a phone clip: frames dropped irregularly from 60 fps, timestamps kept
  await ff.run(['-loop', '1', '-framerate', '60', '-i', join(tmp, 'still.png'), '-t', '3', '-vf', `${SHAKE},select='not(eq(mod(n\\,7)\\,3))*not(eq(mod(n\\,5)\\,1))',format=yuv420p`, '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'ultrafast', join(src, 'vfr.mp4')])
}, 120_000)

describe('stabilizeFile', () => {
  it('keeps every frame, its timestamp and the size, and calms the shake', async () => {
    const input = join(src, 'shaky.mp4')
    const out = join(tmp, 'shaky.stab.mp4')
    const progress: number[] = []
    const t0 = Date.now()
    await stabilizeFile(ff, input, out, { encoders: await ff.encoders(), onProgress: (p) => progress.push(p) })
    const ms = Date.now() - t0
    const a = await probeFrames(input)
    const b = await probeFrames(out)
    expect(b.pts).toEqual(a.pts)
    expect(b.pts).toHaveLength(120)
    expect([b.width, b.height]).toEqual([a.width, a.height])
    expect(Math.abs(b.duration - a.duration)).toBeLessThan(0.05)
    expect(b.streams).toEqual(['video'])
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1]))).toBe(true)
    // the two-pass temp files are gone
    expect(existsSync(`${out}.trf`)).toBe(false)
    expect(existsSync(`${out}.part.mp4`)).toBe(false)
    const before = shake(await frames(input))
    const after = shake(await frames(out))
    console.log(`stabilised 4 s 640x360 in ${ms} ms; shake ${before.toFixed(1)} px -> ${after.toFixed(1)} px`)
    expect(before).toBeGreaterThan(4)
    expect(after).toBeLessThan(before * 0.4)
  })

  it('keeps the timestamps of variable frame rate clips', async () => {
    const input = join(src, 'vfr.mp4')
    const out = join(tmp, 'vfr.stab.mp4')
    await stabilizeFile(ff, input, out, { encoders: await ff.encoders() })
    const a = await probeFrames(input)
    const b = await probeFrames(out)
    // irregular gaps (1/60 and 1/30 s) survive
    expect(new Set(a.pts.slice(1).map((p, i) => (Number(p) - Number(a.pts[i])).toFixed(3))).size).toBeGreaterThan(1)
    expect(b.pts).toEqual(a.pts)
  })

  it('limits corrections to the zoom margin', () => {
    expect(transformFilter(1920, 1080, 'x.trf')).toBe('vidstabtransform=input=x.trf:smoothing=20:optalgo=avg:optzoom=0:zoom=6:maxshift=32:maxangle=0.02:interpol=bicubic:crop=keep')
    expect(transformFilter(1080, 1920, 'x.trf')).toContain('maxshift=32')
  })
})

describe('media service: stabilizeVideo', () => {
  it('makes, caches, restores and cleans up the stabilised version', async () => {
    const cache = join(tmp, 'cache')
    const updates: MediaItem[] = []
    let svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: cache, onUpdate: (it) => updates.push(it), hdrGpu: false })
    let item: MediaItem
    try {
      ;[item] = await svc.importPaths([join(src, 'shaky.mp4')])
      await svc.idle()
      item = svc.get(item.id)!
      expect(item.status).toBe('ready')
      expect(item.stabilized).toBeUndefined()
      // the clip analysis for duplicate detection ran too
      expect(item.hash2).toMatch(/^[0-9a-f]{16}$/)
      expect(item.bitrate).toBeGreaterThan(0)

      await Promise.all([svc.stabilizeVideo(item.id), svc.stabilizeVideo(item.id)])
      item = svc.get(item.id)!
      expect(item.stabilized).toBe(join(cache, item.id, 'stab.mp4'))
      expect(existsSync(item.stabilized!)).toBe(true)
      expect(item.stabilizing).toBeUndefined()
      const mine = updates.filter((u) => u.id === item.id)
      expect(mine.some((u) => u.stabilizing === 0)).toBe(true)
      expect(mine[mine.length - 1].stabilized).toBe(item.stabilized)
      expect(mine[mine.length - 1].stabilizing).toBeUndefined()
      // again: nothing to do
      const n = updates.length
      await svc.stabilizeVideo(item.id)
      expect(updates.length).toBe(n)
      await expect(svc.stabilizeVideo('0123456789abcdef')).rejects.toThrow()
    } finally {
      await svc.dispose()
    }

    // restart: the saved item keeps its stabilised version (also a stale progress value is dropped)
    svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: cache, hdrGpu: false })
    try {
      const [restored] = await svc.restoreMedia([{ ...item, stabilizing: 0.5 }])
      expect(restored.status).toBe('ready')
      expect(restored.stabilized).toBe(item.stabilized)
      expect(restored.stabilizing).toBeUndefined()
      // it counts as a proxy: "remove video proxies" deletes it, and the next restore forgets it
      const used = { ids: new Set([item.id]), paths: [item.path] }
      const info = await svc.cacheInfo(used)
      expect(info.parts.proxies).toBeGreaterThan(0)
      await svc.cleanCache('proxies', used)
      expect(existsSync(item.stabilized!)).toBe(false)
      const [again] = await svc.restoreMedia([item])
      expect(again.status).toBe('ready')
      expect(again.stabilized).toBeUndefined()
      // and can be made again
      await svc.stabilizeVideo(item.id)
      expect(existsSync(svc.get(item.id)!.stabilized!)).toBe(true)
    } finally {
      await svc.dispose()
    }
  })
})
