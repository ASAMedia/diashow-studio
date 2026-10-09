// Storage overview and cleanup of the media cache (cache:info / cache:clean), and rebuilding proxies
// that a cleanup removed.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type MediaItem, type Project } from '@shared/types'
import { cacheInfo, classifyCacheFile, cleanCache, type CacheUse } from '../src/main/cache'
import { createMediaService } from '../src/main/media/service'
import { createProjectStore } from '../src/main/projects'
import { ff, FFMPEG_DIR } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-cachetest-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

function file(path: string, bytes: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes, 1))
}

describe('classifyCacheFile', () => {
  it('sorts cache files into the parts shown to the user', () => {
    expect(classifyCacheFile('thumb.jpg')).toBe('thumbs')
    expect(classifyCacheFile('strip-10x64/003.jpg')).toBe('thumbs')
    expect(classifyCacheFile('display.jpg')).toBe('display')
    expect(classifyCacheFile('proxy.mp4')).toBe('proxies')
    expect(classifyCacheFile('live.mp4')).toBe('proxies')
    expect(classifyCacheFile('proxy_3840.mp4')).toBe('hires')
    expect(classifyCacheFile('audio.m4a')).toBe('audio')
    expect(classifyCacheFile('music.m4a')).toBe('audio')
    for (const other of ['meta.json', 'music.json', 'motion.mp4', 'proxy.mp4.part.mp4', 'source.json']) expect(classifyCacheFile(other)).toBe('other')
  })
})

describe('cacheInfo / cleanCache on a synthetic cache', () => {
  const dir = join(tmp, 'synthetic')
  const A = 'aaaaaaaaaaaaaaaa' // used by a project
  const B = 'bbbbbbbbbbbbbbbb' // unused
  const C = 'cccccccccccccccc' // unused, but busy
  const D = 'dddddddddddddddd' // unused, but an original some project references lives inside it
  const use = (): CacheUse => ({ ids: new Set([A]), paths: [join(dir, D, 'original.jpg'), 'C:\\photos\\x.jpg'], busy: new Set([C]) })

  beforeAll(() => {
    file(join(dir, A, 'thumb.jpg'), 100)
    file(join(dir, A, 'display.jpg'), 1000)
    file(join(dir, A, 'proxy.mp4'), 5000)
    file(join(dir, A, 'proxy_3840.mp4'), 20000)
    file(join(dir, A, 'audio.m4a'), 300)
    file(join(dir, A, 'meta.json'), 10)
    file(join(dir, A, 'strip-4x64', '000.jpg'), 7)
    file(join(dir, B, 'thumb.jpg'), 200)
    file(join(dir, B, 'live.mp4'), 4000)
    file(join(dir, B, 'music.m4a'), 600)
    file(join(dir, C, 'proxy.mp4'), 3000)
    file(join(dir, D, 'original.jpg'), 50)
    file(join(dir, 'export', 'mix.wav'), 70)
    file(join(dir, 'not-an-id', 'thumb.jpg'), 5)
  })

  it('sums bytes per part and finds unused media folders', async () => {
    const info = await cacheInfo(dir, use())
    expect(info.dir).toBe(dir)
    expect(info.parts).toEqual({ thumbs: 307, display: 1000, proxies: 12000, hires: 20000, audio: 900, other: 10 + 50 + 70 + 5 })
    expect(info.total).toBe(307 + 1000 + 12000 + 20000 + 900 + 135)
    expect(info.unused).toBe(200 + 4000 + 600)
    expect(info.unusedItems).toBe(1)
  })

  it("'hires' removes only proxy_<n>.mp4, 'proxies' all proxies of idle items, 'unused' unused folders", async () => {
    expect(await cleanCache(dir, 'hires', use())).toEqual([])
    expect(existsSync(join(dir, A, 'proxy_3840.mp4'))).toBe(false)
    expect(existsSync(join(dir, A, 'proxy.mp4'))).toBe(true)

    expect((await cleanCache(dir, 'proxies', use())).sort()).toEqual([A, B])
    expect(existsSync(join(dir, A, 'proxy.mp4'))).toBe(false)
    expect(existsSync(join(dir, B, 'live.mp4'))).toBe(false)
    expect(existsSync(join(dir, C, 'proxy.mp4'))).toBe(true) // busy
    expect(existsSync(join(dir, A, 'thumb.jpg'))).toBe(true)

    expect(await cleanCache(dir, 'unused', use())).toEqual([B])
    expect(existsSync(join(dir, B))).toBe(false)
    for (const kept of [A, C, D, 'export', 'not-an-id']) expect(existsSync(join(dir, kept))).toBe(true)
    expect(existsSync(join(dir, D, 'original.jpg'))).toBe(true)
    const info = await cacheInfo(dir, use())
    expect(info.unused).toBe(0)
    expect(info.parts.proxies).toBe(3000)
  })
})

describe('media service cache cleanup', () => {
  const src = join(tmp, 'media')
  const cache = join(tmp, 'cache')
  const store = createProjectStore(join(tmp, 'projects'))
  let items: MediaItem[]

  const byName = (list: MediaItem[], name: string): MediaItem => list.find((i) => i.name === name)!

  beforeAll(async () => {
    mkdirSync(src, { recursive: true })
    const hevc = ['-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error']
    // HEVC: needs a proxy; with sound
    await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'sine=d=2', ...hevc, '-c:a', 'aac', '-shortest', join(src, 'clip.mp4')])
    // Live Photo: JPEG + HEVC MOV of the same name
    await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toFile(join(src, 'live.jpg'))
    await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=640x480:r=30:d=2', ...hevc, join(src, 'live.mov')])
    // Not in any project
    await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=1', ...hevc, join(src, 'other.mp4')])
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: cache })
    items = (await svc.importPaths([src])).map((i) => i)
    await svc.idle()
    items = items.map((i) => svc.get(i.id)!)
    await svc.dispose()
    const used = [byName(items, 'clip.mp4'), byName(items, 'live.jpg')]
    const project: Project = {
      version: 1,
      id: 'p1',
      name: 'Test',
      createdAt: 1,
      updatedAt: 1,
      entries: used.map((m, i) => ({ id: `e${i}`, type: m.kind, mediaId: m.id }) as Project['entries'][number]),
      media: used,
      music: [],
      settings: DEFAULT_SETTINGS
    }
    await store.save(project)
  }, 180_000)

  it('reports, cleans proxies (rebuilt on restore, thumbnails kept) and unused folders', async () => {
    const clip = byName(items, 'clip.mp4')
    const live = byName(items, 'live.jpg')
    const other = byName(items, 'other.mp4')
    expect(clip.proxied).toBe(true)
    expect(live.liveVideo).toMatch(/live\.mp4$/)

    const updates: MediaItem[] = []
    // A new session: nothing imported recently, nothing in work
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: cache, onUpdate: (i) => updates.push(i) })
    try {
      const refs = await store.references()
      expect(refs.ids).toEqual(new Set([clip.id, live.id]))
      const before = await svc.cacheInfo(refs)
      expect(before.unusedItems).toBe(1)
      expect(before.parts.proxies).toBeGreaterThan(0)
      expect(before.parts.thumbs).toBeGreaterThan(0)
      expect(before.parts.display).toBeGreaterThan(0)
      expect(before.parts.audio).toBeGreaterThan(0)

      const afterProxies = await svc.cleanCache('proxies', refs)
      expect(afterProxies.parts.proxies).toBe(0)
      expect(existsSync(clip.playback!)).toBe(false)
      expect(existsSync(live.liveVideo!)).toBe(false)
      expect(existsSync(clip.thumb!)).toBe(true)

      const [c, l] = await svc.restoreMedia([clip, live])
      // the video keeps its thumbnail and audio while only the proxy is rebuilt
      expect(c).toMatchObject({ status: 'processing', thumb: clip.thumb, audio: clip.audio })
      expect(c.playback).toBeUndefined()
      // the photo stays usable; its motion part comes back with an update
      expect(l.status).toBe('ready')
      expect(l.liveVideo).toBeUndefined()
      await svc.idle()
      expect(svc.get(clip.id)).toMatchObject({ status: 'ready', playback: clip.playback, proxied: true })
      expect(existsSync(clip.playback!)).toBe(true)
      expect(svc.get(live.id)!.liveVideo).toBe(live.liveVideo)
      expect(existsSync(live.liveVideo!)).toBe(true)
      expect(updates.filter((u) => u.id === clip.id).pop()!.status).toBe('ready')

      const afterUnused = await svc.cleanCache('unused', refs)
      expect(afterUnused.unusedItems).toBe(0)
      expect(existsSync(join(cache, other.id))).toBe(false)
      expect(existsSync(join(cache, clip.id))).toBe(true)
      expect(existsSync(other.path)).toBe(true)
    } finally {
      await svc.dispose()
    }
  })

  it('counts freshly imported items as used until the project is saved', async () => {
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: cache })
    try {
      const [again] = await svc.importPaths([join(src, 'other.mp4')])
      await svc.idle()
      const refs = await store.references()
      expect((await svc.cacheInfo(refs)).unusedItems).toBe(0)
      await svc.cleanCache('unused', refs)
      expect(existsSync(join(cache, again.id))).toBe(true)
    } finally {
      await svc.dispose()
    }
  })
})
