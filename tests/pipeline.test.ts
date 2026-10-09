// End-to-end media pipeline on generated test media (scripts/make-test-media.mjs).
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MediaItem, MusicTrack } from '@shared/types'
import { rotationOf, videoStream } from '../src/main/media/videoInfo'
import { createMediaService, type MediaService } from '../src/main/media/service'
import { pairFiles, scanPaths } from '../src/main/media/scan'
import { RawDecoder } from '../src/main/media/raw'
import { renderPhoto } from '../src/main/media/photo'
import { readTags } from '../src/main/media/exif'
import { ensureTestMedia, ff, FFMPEG_DIR, TEST_MEDIA } from './helpers/media'

const has = (...parts: string[]): boolean => existsSync(join(TEST_MEDIA, ...parts))

let cacheDir: string
let svc: MediaService
let items: MediaItem[]
const updates: MediaItem[] = []
let updatesBeforeReturn = -1
const trackUpdates: MusicTrack[] = []

function item(name: string): MediaItem {
  const found = items.find((i) => i.name === name)
  if (!found) throw new Error(`${name} not imported`)
  return svc.get(found.id)!
}

async function pixel(path: string, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true })
  const i = (Math.round(y) * info.width + Math.round(x)) * info.channels
  return [data[i], data[i + 1], data[i + 2]]
}

const isRed = ([r, g, b]: number[]): boolean => r > 200 && g < 80 && b < 80

beforeAll(async () => {
  ensureTestMedia()
  cacheDir = mkdtempSync(join(tmpdir(), 'diashow-cache-'))
  svc = createMediaService({
    ffmpegDir: FFMPEG_DIR,
    cacheDir,
    onUpdate: (it) => updates.push(it),
    onMusicUpdate: (t) => trackUpdates.push(t)
  })
  items = await svc.importPaths([TEST_MEDIA])
  updatesBeforeReturn = updates.length
  await svc.idle()
}, 300_000)

afterAll(async () => {
  await svc?.dispose()
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true, maxRetries: 3 })
})

describe('scan', () => {
  it('skips sidecars, hidden files and card helper folders, finds AVCHD clips', async () => {
    const names = (await scanPaths([TEST_MEDIA])).map((f) => f.name)
    expect(names).toContain('00000.MTS')
    expect(names).toContain('C0002.MP4')
    for (const skipped of ['C0002M01.XML', 'IMG_0001.AAE', '.hidden.jpg', 'Thumbs.db', 'notes.txt', 'C0001T01.JPG', 'index.bdm', '00000.CPI', '00000.MPL', 'track1.mp3']) {
      expect(names).not.toContain(skipped)
    }
  })

  it('pairs Live Photos and drops RAW twins', async () => {
    const groups = pairFiles(await scanPaths([TEST_MEDIA]))
    const names = groups.map((g) => g.file.name)
    expect(names).not.toContain('DSC00001.ARW')
    expect(names).toContain('DSC00001.JPG')
    expect(groups.find((g) => g.file.name === 'DSC00001.JPG')?.raw?.name).toBe('DSC00001.ARW')
    if (has('iphone', 'IMG_0001.HEIC')) {
      expect(names).not.toContain('IMG_0001.MOV')
      expect(groups.find((g) => g.file.name === 'IMG_0001.HEIC')?.live?.name).toBe('IMG_0001.MOV')
    }
  })
})

describe('import', () => {
  it('returns every item sorted by capture time, all processed', () => {
    const names = items.map((i) => i.name)
    expect(names).not.toContain('IMG_0001.MOV')
    expect(names).not.toContain('DSC00001.ARW')
    expect(names).toContain('00000.MTS')
    const times = items.map((i) => i.captureTime)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    for (const it of items) {
      const cur = svc.get(it.id)!
      expect(cur.status, `${cur.name}: ${cur.error}`).toBe('ready')
    }
  })

  it('reports pending → processing → ready through onUpdate, only after importPaths returned', () => {
    expect(updatesBeforeReturn).toBe(0)
    expect(items.every((i) => i.status === 'pending')).toBe(true)
    const plain = item('plain.mp4')
    const states = updates.filter((u) => u.id === plain.id).map((u) => u.status)
    expect(states[0]).toBe('processing')
    expect(states[states.length - 1]).toBe('ready')
    expect(updates.filter((u) => u.id === plain.id).every((u) => u.path === plain.path)).toBe(true)
  })

  it('reads capture time with time zone and the device', () => {
    const pxl = item('PXL_0002.jpg')
    expect(pxl.device).toBe('Pixel 8')
    expect(pxl.captureTime).toBe(Date.parse('2025-08-01T12:01:00+02:00'))
    const sony = item('C0002.MP4')
    // from the C0002M01.XML sidecar
    expect(sony.device).toBe('ILCE-7M4')
    expect(sony.captureTime).toBe(Date.parse('2025-09-10T09:02:30+02:00'))
    expect(item('PXL_0001.mp4').captureTime).toBe(Date.parse('2025-08-01T10:00:00Z'))
  })
})

describe('photos', () => {
  it.runIf(has('iphone', 'IMG_0001.HEIC'))('HEIC Live Photo: oriented display JPEG + playable motion part', async () => {
    const heic = item('IMG_0001.HEIC')
    expect(heic.kind).toBe('photo')
    expect(heic.format).toBe('HEIC')
    expect(heic.device).toBe('iPhone 15 Pro')
    expect(heic.captureTime).toBe(Date.parse('2025-07-14T18:30:00+02:00'))
    expect([heic.width, heic.height]).toEqual([768, 1024])
    const meta = await sharp(heic.display!).metadata()
    expect([meta.width, meta.height, meta.format]).toEqual([768, 1024, 'jpeg'])
    // stored red block top-left + orientation 6 (90° CW) → top-right
    expect(isRed(await pixel(heic.display!, 760, 8))).toBe(true)
    expect(isRed(await pixel(heic.display!, 8, 8))).toBe(false)
    expect(heic.live?.source).toMatch(/IMG_0001\.MOV$/)
    expect(heic.live?.duration).toBeCloseTo(3, 0)
    expect(heic.liveVideo).toMatch(/live\.mp4$/)
    const probe = await ff.probe(heic.liveVideo!)
    const vs = videoStream(probe)!
    expect([vs.codec_name, vs.pix_fmt, vs.width, vs.height]).toEqual(['h264', 'yuv420p', 480, 640])
    expect(rotationOf(vs)).toBe(0)
  })

  it.runIf(has('sony', 'DCIM', '100MSDCF', 'DSC00002.HIF'))('Sony HIF 10-bit 4:2:2 → display JPEG', async () => {
    const hif = item('DSC00002.HIF')
    expect(hif.format).toBe('Sony HIF 10-bit 4:2:2')
    expect(hif.device).toBe('ILCE-7M4')
    expect([hif.width, hif.height]).toEqual([1200, 800])
    const meta = await sharp(hif.display!).metadata()
    expect([meta.width, meta.height]).toEqual([1200, 800])
    expect(isRed(await pixel(hif.display!, 8, 8))).toBe(true)
  })

  it('JPEG with EXIF orientation 6 and Display P3 profile', async () => {
    const jpg = item('IMG_0003.JPG')
    expect([jpg.width, jpg.height]).toEqual([900, 1200])
    const meta = await sharp(jpg.display!).metadata()
    expect([meta.width, meta.height]).toEqual([900, 1200])
    expect(meta.orientation ?? 1).toBe(1)
    expect(meta.icc).toBeUndefined()
    expect(isRed(await pixel(jpg.display!, 890, 8))).toBe(true)
    const thumb = await sharp(jpg.thumb!).metadata()
    expect(Math.max(thumb.width!, thumb.height!)).toBe(360)
  })

  it('PNG / WebP / plain JPEG, panorama stays panoramic', async () => {
    expect(item('pano.png')).toMatchObject({ format: 'PNG', width: 3000, height: 750 })
    expect(item('photo.webp')).toMatchObject({ format: 'WebP', width: 800, height: 600 })
    expect(item('DSC00001.JPG')).toMatchObject({ format: 'JPEG', device: 'ILCE-7M4', width: 1600, height: 1067 })
  })

  it('Motion Photo: embedded MP4 is extracted', async () => {
    const mp = item('PXL_0003.MP.jpg')
    expect(mp.live).toBeDefined()
    expect(mp.live!.duration).toBeCloseTo(2, 0)
    expect(existsSync(mp.live!.source)).toBe(true)
    expect(mp.liveVideo).toBeDefined()
    const vs = videoStream(await ff.probe(mp.liveVideo!))!
    expect([vs.codec_name, vs.width, vs.height]).toEqual(['h264', 640, 480])
  })
})

describe('videos', () => {
  async function expectProxy(it: MediaItem, w: number, h: number): Promise<void> {
    expect(it.proxied, it.name).toBe(true)
    expect(it.playback).toMatch(/proxy\.mp4$/)
    const probe = await ff.probe(it.playback!)
    const vs = videoStream(probe)!
    expect(vs.codec_name).toBe('h264')
    expect(vs.profile).toBe('High')
    expect(vs.pix_fmt).toBe('yuv420p')
    expect([vs.width, vs.height]).toEqual([w, h])
    expect(rotationOf(vs)).toBe(0)
    expect((vs.side_data_list ?? []).some((d) => d.side_data_type === 'Display Matrix')).toBe(false)
    expect(probe.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(0)
    expect(parseFloat(probe.format.duration!)).toBeCloseTo(it.duration!, 0)
  }

  async function expectAudio(it: MediaItem): Promise<void> {
    expect(it.hasAudio, it.name).toBe(true)
    expect(it.audio).toMatch(/audio\.m4a$/)
    const a = (await ff.probe(it.audio!)).streams[0]
    expect([a.codec_name, a.sample_rate, a.channels]).toEqual(['aac', '48000', 2])
  }

  it('plain H.264 4:2:0 + AAC MP4 and VP9 WebM play directly', async () => {
    for (const name of ['plain.mp4', 'clip.webm']) {
      const v = item(name)
      expect(v.proxied, name).toBe(false)
      expect(v.playback).toBe(v.path)
      await expectAudio(v)
      expect(existsSync(v.thumb!)).toBe(true)
    }
    expect(item('plain.mp4').format).toBe('H.264')
    expect(item('clip.webm').format).toBe('VP9')
  })

  it('rotated phone video gets a proxy with the rotation baked in', async () => {
    const v = item('PXL_0001.mp4')
    expect([v.width, v.height]).toEqual([720, 1280])
    await expectProxy(v, 720, 1280)
    await expectAudio(v)
    const thumb = await sharp(v.thumb!).metadata()
    expect([thumb.width, thumb.height]).toEqual([202, 360])
  })

  it('iPhone HEVC HLG with rotation → tone-mapped SDR proxy', async () => {
    const v = item('IMG_0002.MOV')
    expect(v.hdr).toBe(true)
    expect(v.format).toBe('HEVC 10-bit HDR (HLG)')
    expect(v.device).toBe('iPhone 15 Pro')
    await expectProxy(v, 720, 1280)
    const vs = videoStream(await ff.probe(v.playback!))!
    expect(vs.color_transfer).toBe('bt709')
    await expectAudio(v)
  })

  it('Sony XAVC S (PCM), XAVC HS (HEVC 4:2:2 10-bit), XAVC S-I and AVCHD get proxies + audio', async () => {
    expect(item('C0001.MP4').format).toBe('XAVC S · H.264')
    expect(item('C0002.MP4').format).toBe('XAVC HS · HEVC 4:2:2 10-bit')
    expect(item('C0003.MP4').format).toBe('XAVC S-I · H.264 4:2:2 10-bit')
    expect(item('00000.MTS').format).toBe('AVCHD')
    for (const name of ['C0001.MP4', 'C0002.MP4', 'C0003.MP4', '00000.MTS']) {
      const v = item(name)
      await expectProxy(v, 1280, 720)
      await expectAudio(v)
    }
    expect(item('C0001.MP4').fps).toBe(50)
  })
})

describe('cache and restore', () => {
  it('a second service instance returns ready items from the cache without reprocessing', async () => {
    const seen: MediaItem[] = []
    const again = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir, onUpdate: (i) => seen.push(i) })
    try {
      const list = await again.importPaths([TEST_MEDIA])
      expect(list.map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort())
      expect(list.every((i) => i.status === 'ready')).toBe(true)
      await again.idle()
      expect(seen).toHaveLength(0)
    } finally {
      await again.dispose()
    }
  })

  it('restoreMedia: missing original → error, missing cache → requeued, intact → ready', async () => {
    const intact = item('photo.webp')
    const damaged = item('DSC00001.JPG')
    unlinkSync(damaged.display!)
    const seen: MediaItem[] = []
    const restorer = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir, onUpdate: (i) => seen.push(i) })
    try {
      const gone: MediaItem = { ...intact, id: 'deadbeefdeadbeef', path: join(TEST_MEDIA, 'misc', 'does-not-exist.jpg') }
      const [a, b, c] = await restorer.restoreMedia([intact, damaged, gone])
      // processing only starts after the call returned (the IPC reply precedes media:update events)
      expect(seen).toHaveLength(0)
      expect(a.status).toBe('ready')
      expect(b.status).toBe('pending')
      expect(b.display).toBeUndefined()
      expect(c).toMatchObject({ status: 'error', error: 'missing' })
      await restorer.idle()
      const fixed = restorer.get(damaged.id)!
      expect(fixed.status).toBe('ready')
      expect(seen.map((u) => u.status)).toEqual(expect.arrayContaining(['processing', 'ready']))
      expect(existsSync(fixed.display!)).toBe(true)
    } finally {
      await restorer.dispose()
    }
  })
})

describe('music', () => {
  it('reads tags, keeps native formats and transcodes WMA / ALAC', async () => {
    const tracks = await svc.importMusic([join(TEST_MEDIA, 'music')])
    expect(tracks.map((t) => t.title)).toEqual(['Morning Tone', 'Evening Tone', 'Windows Tone', 'track4-alac'])
    const [mp3, m4a] = tracks
    expect(mp3).toMatchObject({ status: 'ready', artist: 'Test Orchestra', playback: mp3.path })
    expect(mp3.duration).toBeCloseTo(6, 1)
    expect(m4a.playback).toBe(m4a.path)
    await svc.idle()
    const again = await svc.importMusic([join(TEST_MEDIA, 'music')])
    for (const t of again.slice(2)) {
      expect(t.status).toBe('ready')
      expect(t.playback).toMatch(/music\.m4a$/)
      const a = (await ff.probe(t.playback!)).streams[0]
      expect(a.codec_name).toBe('aac')
    }
    expect(trackUpdates.some((t) => t.title === 'Windows Tone' && t.status === 'ready')).toBe(true)
  })

  it('restoreMusic flags missing files', async () => {
    const [t] = await svc.restoreMusic([{ id: 'x', path: join(TEST_MEDIA, 'music', 'nope.mp3'), title: 'nope', duration: 1, status: 'ready' }])
    expect(t).toMatchObject({ status: 'error', error: 'missing' })
  })

  it('waveform returns memoised peaks in 0..1', async () => {
    const path = join(TEST_MEDIA, 'music', 'track1.mp3')
    const w = await svc.waveform(path, 64)
    expect(w).toHaveLength(64)
    expect(Math.max(...w)).toBeGreaterThan(0.03)
    expect(Math.max(...w)).toBeLessThanOrEqual(1)
    expect(Math.min(...w)).toBeGreaterThanOrEqual(0)
    expect(await svc.waveform(path, 64)).toBe(w)
  })
})

describe('camera RAW', () => {
  // Real RAW files cannot be synthesised; point DIASHOW_TEST_RAW at one (e.g. a Sony .ARW) to run this.
  const rawFile = process.env.DIASHOW_TEST_RAW
  it.runIf(!!rawFile && existsSync(rawFile))('decodes with libraw-wasm and with the embedded-preview fallback', async () => {
    const tags = await readTags(rawFile!, false)
    const out = mkdtempSync(join(tmpdir(), 'diashow-raw-'))
    const decoder = new RawDecoder()
    try {
      expect(decoder.available).toBe(true)
      const a = await renderPhoto({ ff, raw: decoder }, rawFile!, tags, { display: join(out, 'a.jpg'), thumb: join(out, 'at.jpg') })
      expect(a.via).toBe('libraw')
      const b = await renderPhoto({ ff, raw: new RawDecoder(null) }, rawFile!, tags, { display: join(out, 'b.jpg'), thumb: join(out, 'bt.jpg') })
      expect(b.via).toBe('preview')
      // same orientation either way
      expect(a.width > a.height).toBe(b.width > b.height)
    } finally {
      decoder.dispose()
      rmSync(out, { recursive: true, force: true })
    }
  })
})
