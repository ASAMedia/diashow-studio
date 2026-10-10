// The same clip twice ("find rejects", review grid): an original next to a 640 px re-encode (as a
// messenger forwards it) is one group that keeps the original; another clip of the same scene and
// length is not part of it.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compareClipQuality, hashDistance, sameClip, sameClipGroups } from '@shared/duplicates'
import { DEFAULT_SETTINGS, type MediaItem, type Project } from '@shared/types'
import { createMediaService, type MediaService } from '../src/main/media/service'
import { ff, FFMPEG_DIR } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-dupes-'))
const src = join(tmp, 'src')
let svc: MediaService
let original: MediaItem
let reencode: MediaItem
let other: MediaItem

async function scene(path: string): Promise<void> {
  let s = 5
  const r = (): number => ((s = (s * 16807) % 2147483647) / 2147483647)
  const shapes: string[] = []
  for (let i = 0; i < 500; i++) {
    const c = `hsl(${Math.floor(r() * 360)},${30 + Math.floor(r() * 50)}%,${20 + Math.floor(r() * 60)}%)`
    const x = r() * 2400
    const y = r() * 1000
    const w = 15 + r() * 140
    shapes.push(r() < 0.5 ? `<rect x="${x}" y="${y}" width="${w}" height="${15 + r() * 140}" fill="${c}"/>` : `<circle cx="${x}" cy="${y}" r="${w / 2}" fill="${c}"/>`)
  }
  // a horizon: sky above, ground below, so every part of the pan has coarse structure
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1000"><rect width="2400" height="420" fill="#9cc3e6"/><rect y="420" width="2400" height="580" fill="#6b7f4a"/>${shapes.join('')}</svg>`
  await sharp(Buffer.from(svg)).png().toFile(path)
}

beforeAll(async () => {
  mkdirSync(src, { recursive: true })
  const still = join(tmp, 'scene.png')
  await scene(still)
  const pan = (x: string): string => `crop=1280:720:x='${x}':y=140,format=yuv420p`
  const inputs = ['-loop', '1', '-framerate', '30', '-i', still, '-f', 'lavfi', '-i', 'sine=f=330:d=6']
  const common = ['-t', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '30', '-c:a', 'aac', '-b:a', '160k', '-shortest']
  // the phone's original: a pan to the right
  await ff.run([...inputs, '-vf', pan('t*180'), ...common, join(src, 'VID_20261008_101500.mp4')])
  // the same clip forwarded through a messenger: 640 px wide, much lower bit rate, no metadata
  await ff.run(['-i', join(src, 'VID_20261008_101500.mp4'), '-vf', 'scale=640:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '64k', '-map_metadata', '-1', join(src, 'WhatsApp Video 2026-10-08 at 10.20.11.mp4')])
  // another clip of the same scene with the same length: the pan goes the other way
  await ff.run([...inputs, '-vf', pan('1080-t*180'), ...common, join(src, 'VID_20261008_101800.mp4')])
  svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: join(tmp, 'cache'), hdrGpu: false })
  const items = await svc.importPaths([src])
  await svc.idle()
  const get = (name: string): MediaItem => svc.get(items.find((m) => m.name.startsWith(name))!.id)!
  original = get('VID_20261008_101500')
  reencode = get('WhatsApp')
  other = get('VID_20261008_101800')
}, 180_000)

afterAll(async () => {
  await svc?.dispose()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
})

describe('same clip twice', () => {
  it('computes two frame hashes and the bit rate for every video', () => {
    for (const m of [original, reencode, other]) {
      expect(m.status).toBe('ready')
      expect(m.hash).toMatch(/^[0-9a-f]{16}$/)
      expect(m.hash2).toMatch(/^[0-9a-f]{16}$/)
      expect(m.bitrate).toBeGreaterThan(0)
    }
    expect([reencode.width, reencode.height]).toEqual([640, 360])
    expect(original.bitrate!).toBeGreaterThan(reencode.bitrate! * 2)
    console.log(
      'hash bits: re-encode',
      hashDistance(original.hash!, reencode.hash!),
      hashDistance(original.hash2!, reencode.hash2!),
      '| other clip',
      hashDistance(original.hash!, other.hash!),
      hashDistance(original.hash2!, other.hash2!),
      '| durations',
      original.duration,
      reencode.duration,
      other.duration
    )
  })

  it('groups the original with its re-encode, not with the other clip', () => {
    expect(sameClip(original, reencode)).toBe(true)
    expect(sameClip(reencode, original)).toBe(true)
    expect(sameClip(original, other)).toBe(false)
    expect(sameClip(reencode, other)).toBe(false)
    // the re-encode first in the show: the original is still the one to keep
    expect(sameClipGroups([reencode, other, original])).toEqual([[2, 0]])
    expect(sameClipGroups([original, other])).toEqual([])
  })

  it('marks the re-encode in findRejects (and the review grid) as the same clip', async () => {
    // the renderer module reads window only when the store saves
    ;(globalThis as unknown as { window: unknown }).window ??= { api: { saveProject: async () => {} } }
    const path = '../src/renderer/src/components/Dialogs'
    const { findRejects } = (await import(/* @vite-ignore */ path)) as {
      findRejects: (p: Project, threshold: number) => { entryId: string; reason: string; detail: string; media: MediaItem }[]
    }
    const project: Project = {
      version: 1,
      id: 'p',
      name: 'Klassenfahrt',
      createdAt: 0,
      updatedAt: 0,
      settings: structuredClone(DEFAULT_SETTINGS),
      music: [],
      media: [original, reencode, other],
      entries: [
        { id: 'a', type: 'video', mediaId: reencode.id },
        { id: 'b', type: 'video', mediaId: other.id },
        { id: 'c', type: 'video', mediaId: original.id }
      ]
    }
    const rejects = findRejects(project, 0.35)
    expect(rejects.map((r) => [r.entryId, r.reason, r.detail])).toEqual([['a', 'sameClip', '#3']])
  })
})

describe('which copy stays', () => {
  const clip = (patch: Partial<MediaItem>): MediaItem => ({
    id: Math.random().toString(16).slice(2),
    path: 'C:\\v.mp4',
    name: 'v.mp4',
    kind: 'video',
    format: 'MP4',
    width: 1920,
    height: 1080,
    duration: 12,
    captureTime: 0,
    status: 'ready',
    hash: '0f0f0f0f0f0f0f0f',
    hash2: 'f0f0f0f0f0f0f0f0',
    ...patch
  })

  it('prefers resolution, then bit rate, then camera data', () => {
    expect(compareClipQuality(clip({}), clip({ width: 1280, height: 720 }))).toBeGreaterThan(0)
    expect(compareClipQuality(clip({ bitrate: 8e6 }), clip({ bitrate: 2e6 }))).toBeGreaterThan(0)
    expect(compareClipQuality(clip({ bitrate: 8e6 }), clip({ bitrate: 8.1e6, device: 'iPhone 15' }))).toBeLessThan(0)
    const groups = sameClipGroups([clip({ bitrate: 2e6 }), clip({ bitrate: 9e6, device: 'Pixel 8' }), clip({ width: 848, height: 478, bitrate: 1e6 })])
    expect(groups).toEqual([[1, 0, 2]])
  })

  it('needs the same length and shape, and both frames close', () => {
    expect(sameClip(clip({}), clip({ duration: 12.3 }))).toBe(true)
    expect(sameClip(clip({}), clip({ duration: 13 }))).toBe(false)
    expect(sameClip(clip({}), clip({ width: 1080, height: 1920 }))).toBe(false)
    expect(sameClip(clip({}), clip({ hash2: '0f0f0f0f0f0f0f0f' }))).toBe(false)
    expect(sameClip(clip({}), clip({ kind: 'photo' }))).toBe(false)
    // only the thumbnail hash known (not analysed yet): it must be nearly identical
    expect(sameClip(clip({ hash2: undefined }), clip({ hash: '0f0f0f0f0f0f0f0e' }))).toBe(true)
    expect(sameClip(clip({ hash2: undefined }), clip({ hash: '0f0f0f0f0f0f0ff0' }))).toBe(false)
  })
})
