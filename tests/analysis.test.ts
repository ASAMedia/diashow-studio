// Photo analysis: difference hash (duplicates) and sharpness (blur), plus the service integration
// (computed on import, lazily for old cache entries, faces persisted).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp, { type Sharp } from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MediaItem } from '@shared/types'
import { analyzeImage, dHashBits, hammingDistance, imageHash, sharpnessFromTiles } from '../src/main/media/analysis'
import { createMediaService, sanitizeFaces } from '../src/main/media/service'
import { ff, FFMPEG_DIR } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-analysis-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/**
 * A detailed "scene": a smooth random colour field (so the coarse structure dHash sees differs per
 * seed, like real photos) with random shapes, fine stripes and text on top.
 */
async function scene(seed: number, w = 2400, h = 1600): Promise<Sharp> {
  const r = rng(seed)
  const field = Buffer.from(Array.from({ length: 6 * 4 * 3 }, () => Math.floor(r() * 255)))
  const background = await sharp(field, { raw: { width: 6, height: 4, channels: 3 } }).resize(w, h, { kernel: 'cubic' }).png().toBuffer()
  const shapes: string[] = []
  for (let i = 0; i < 40; i++) {
    const c = `rgb(${Math.floor(r() * 255)},${Math.floor(r() * 255)},${Math.floor(r() * 255)})`
    if (r() < 0.5) shapes.push(`<rect x="${r() * w}" y="${r() * h}" width="${20 + r() * 200}" height="${20 + r() * 150}" fill="${c}"/>`)
    else shapes.push(`<circle cx="${r() * w}" cy="${r() * h}" r="${10 + r() * 80}" fill="${c}"/>`)
  }
  for (let i = 0; i < 12; i++) shapes.push(`<text x="${r() * w * 0.8}" y="${r() * h}" font-size="${30 + r() * 60}" font-family="Arial" fill="#fff">Skilager ${i}</text>`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><pattern id="p" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="3" height="6" fill="#333"/><rect x="3" width="3" height="6" fill="#ccc"/></pattern></defs>
    <rect x="${r() * w * 0.7}" y="${r() * h * 0.7}" width="${w * 0.2}" height="${h * 0.2}" fill="url(#p)"/>${shapes.join('')}</svg>`
  const flat = await sharp(background).composite([{ input: Buffer.from(svg) }]).removeAlpha().png().toBuffer()
  return sharp(flat)
}

async function save(img: Sharp, name: string): Promise<string> {
  const path = join(tmp, name)
  await img.jpeg({ quality: 90 }).toFile(path)
  return path
}

describe('dHash', () => {
  it('packs 64 comparisons into 16 hex chars, first row first', () => {
    const grey = Array.from({ length: 72 }, (_, i) => (i % 9 === 0 && i < 9 ? 255 : 0))
    expect(dHashBits(grey)).toBe('8000000000000000')
    expect(dHashBits(Array.from({ length: 72 }, (_, i) => 100 - (i % 9)))).toBe('ffffffffffffffff')
    expect(hammingDistance('8000000000000000', 'ffffffffffffffff')).toBe(63)
    expect(hammingDistance('0123456789abcdef', '0123456789abcdef')).toBe(0)
    expect(hammingDistance('xyz', '0123456789abcdef')).toBe(64)
  })

  it('is stable across re-encoding and resizing, close for near-duplicates, far for other photos', async () => {
    const a = await save(await scene(1), 'a.jpg')
    const hash = await imageHash(a)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(await imageHash(a)).toBe(hash)
    const small = await save(sharp(a).resize(800), 'a-small.jpg')
    const lowq = join(tmp, 'a-lowq.jpg')
    await sharp(a).jpeg({ quality: 40 }).toFile(lowq)
    expect(hammingDistance(hash, await imageHash(small))).toBeLessThanOrEqual(3)
    expect(hammingDistance(hash, await imageHash(lowq))).toBeLessThanOrEqual(3)
    // Burst-like near duplicates: slightly brighter, slightly cropped
    const brighter = await save(sharp(a).modulate({ brightness: 1.1 }), 'a-bright.jpg')
    const cropped = await save(sharp(a).extract({ left: 40, top: 30, width: 2320, height: 1540 }), 'a-crop.jpg')
    expect(hammingDistance(hash, await imageHash(brighter))).toBeLessThanOrEqual(6)
    expect(hammingDistance(hash, await imageHash(cropped))).toBeLessThanOrEqual(10)
    for (const seed of [2, 3, 4, 5, 6]) {
      const other = await save(await scene(seed), `other-${seed}.jpg`)
      expect(hammingDistance(hash, await imageHash(other))).toBeGreaterThan(16)
    }
  })
})

describe('sharpness', () => {
  it('drops with defocus and motion blur, stays in 0..1', async () => {
    const crisp = await save(await scene(7), 'crisp.jpg')
    const soft = await save(sharp(crisp).blur(4), 'soft.jpg')
    const blurred = await save(sharp(crisp).blur(10), 'blurred.jpg')
    // Camera shake: horizontal motion blur over 2 % of the width
    const len = 49
    const motion = await save(
      sharp(crisp).convolve({ width: len, height: 3, kernel: [...new Array(len).fill(0), ...new Array(len).fill(1), ...new Array(len).fill(0)] }),
      'motion.jpg'
    )
    const s: Record<string, number> = {
      crisp: (await analyzeImage(crisp)).sharpness,
      soft: (await analyzeImage(soft)).sharpness,
      blurred: (await analyzeImage(blurred)).sharpness,
      motion: (await analyzeImage(motion)).sharpness
    }
    expect(s.crisp).toBeGreaterThan(0.6)
    expect(s.crisp).toBeLessThanOrEqual(1)
    expect(s.soft).toBeLessThan(s.crisp - 0.2)
    expect(s.blurred).toBeLessThan(0.3)
    expect(s.blurred).toBeGreaterThanOrEqual(0)
    expect(s.motion).toBeLessThan(0.35)
    // Low contrast alone (haze) is not blur
    const hazy = await save(sharp(crisp).linear(0.35, 150), 'hazy.jpg')
    expect((await analyzeImage(hazy)).sharpness).toBeGreaterThan(0.45)
  })

  it('a flat image has no sharpness, the second-best tile decides', () => {
    expect(sharpnessFromTiles([])).toBe(0)
    expect(sharpnessFromTiles(new Array(16).fill(0))).toBe(0)
    // One busy tile alone does not make a sharp photo
    expect(sharpnessFromTiles([5, ...new Array(15).fill(0.01)])).toBeLessThan(0.05)
  })
})

describe('faces input', () => {
  it('keeps valid rects clamped to the unit square', () => {
    expect(sanitizeFaces([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, { x: -0.1, y: 0.9, w: 0.3, h: 0.3 }, { x: 'a' }, null, { x: 2, y: 0, w: 1, h: 1 }])).toEqual([
      { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      { x: 0, y: 0.9, w: 0.2, h: 0.1 }
    ])
    expect(sanitizeFaces('nope')).toEqual([])
  })
})

describe('media service integration', () => {
  const src = join(tmp, 'import')
  const cacheDir = join(tmp, 'cache')
  let photo: MediaItem
  let video: MediaItem

  beforeAll(async () => {
    mkdirSync(src, { recursive: true })
    await (await scene(11, 1600, 1200)).jpeg({ quality: 90 }).toFile(join(src, 'scene.jpg'))
    await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', join(src, 'clip.mp4')])
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir })
    try {
      const items = await svc.importPaths([src])
      await svc.idle()
      photo = svc.get(items.find((i) => i.kind === 'photo')!.id)!
      video = svc.get(items.find((i) => i.kind === 'video')!.id)!
    } finally {
      await svc.dispose()
    }
  }, 120_000)

  it('computes hash + sharpness for photos and the hash of video thumbnails, persisted in meta.json', () => {
    expect(photo.status).toBe('ready')
    expect(photo.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(photo.sharpness).toBeGreaterThan(0.5)
    expect(video.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(video.sharpness).toBeUndefined()
    const meta = JSON.parse(readFileSync(join(cacheDir, photo.id, 'meta.json'), 'utf8')) as MediaItem
    expect(meta.hash).toBe(photo.hash)
    expect(meta.sharpness).toBe(photo.sharpness)
  })

  it('fills in missing analysis of cached items lazily, without reprocessing', async () => {
    for (const it of [photo, video]) {
      const path = join(cacheDir, it.id, 'meta.json')
      const meta = JSON.parse(readFileSync(path, 'utf8')) as MediaItem
      delete meta.hash
      delete meta.sharpness
      writeFileSync(path, JSON.stringify(meta))
    }
    const seen: MediaItem[] = []
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir, onUpdate: (i) => seen.push(i) })
    try {
      const items = await svc.importPaths([src])
      expect(items.every((i) => i.status === 'ready')).toBe(true)
      expect(seen).toHaveLength(0)
      await svc.idle()
      expect(seen).toHaveLength(2)
      expect(seen.every((i) => i.status === 'ready' && i.display === (i.kind === 'photo' ? photo.display : undefined))).toBe(true)
      expect(seen.find((i) => i.id === photo.id)).toMatchObject({ hash: photo.hash, sharpness: photo.sharpness })
      expect(seen.find((i) => i.id === video.id)?.hash).toBe(video.hash)
      const meta = JSON.parse(readFileSync(join(cacheDir, photo.id, 'meta.json'), 'utf8')) as MediaItem
      expect(meta.hash).toBe(photo.hash)

      // Restoring a project with items lacking the fields works the same way
      const restorer = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir, onUpdate: (i) => seen.push(i) })
      try {
        const { hash: _h, sharpness: _s, ...old } = photo
        const [restored] = await restorer.restoreMedia([old])
        expect(restored.status).toBe('ready')
        await restorer.idle()
        expect(restorer.get(photo.id)).toMatchObject({ hash: photo.hash, sharpness: photo.sharpness })
      } finally {
        await restorer.dispose()
      }
    } finally {
      await svc.dispose()
    }
  })

  it('setFaces stores the rects, emits the full item and persists them', async () => {
    const seen: MediaItem[] = []
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir, onUpdate: (i) => seen.push(i) })
    try {
      await svc.restoreMedia([photo])
      await svc.setFaces(photo.id, [{ x: 0.25, y: 0.1, w: 0.2, h: 0.3 }])
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ id: photo.id, status: 'ready', display: photo.display, faces: [{ x: 0.25, y: 0.1, w: 0.2, h: 0.3 }] })
      const meta = JSON.parse(readFileSync(join(cacheDir, photo.id, 'meta.json'), 'utf8')) as MediaItem
      expect(meta.faces).toEqual([{ x: 0.25, y: 0.1, w: 0.2, h: 0.3 }])
      // No faces found is remembered too
      await svc.setFaces(photo.id, [])
      expect(svc.get(photo.id)!.faces).toEqual([])
      // Unknown ids are ignored
      await svc.setFaces('0000000000000000', [{ x: 0, y: 0, w: 1, h: 1 }])
      expect(seen).toHaveLength(2)
    } finally {
      await svc.dispose()
    }
    // A fresh service (app restart) reads the faces from the cache
    const again = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir })
    try {
      const [it] = await again.importPaths([join(src, 'scene.jpg')])
      expect(it.faces).toEqual([])
    } finally {
      await again.dispose()
    }
  })
})
