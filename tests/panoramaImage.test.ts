// Display images of panoramas keep enough height to pan at full height, within a texture's longest
// side, and big exports get sharper ones (prepareHires → photoJobs.ts preparePanoramas).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExportProgress, MediaItem } from '@shared/types'
import { createMediaService, type MediaService } from '../src/main/media/service'
import { classifyCacheFile } from '../src/main/cache'
import { ff, FFMPEG_DIR } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-pano-'))
const src = join(tmp, 'src')
let svc: MediaService
let items: MediaItem[]
const byName = (name: string): MediaItem => svc.get(items.find((i) => i.name === name)!.id)!
const size = async (path: string): Promise<[number, number]> => {
  const m = await sharp(path).metadata()
  return [m.width!, m.height!]
}

beforeAll(async () => {
  mkdirSync(src, { recursive: true })
  const plain = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 120, b: 200 } } })
  // an 8:1 panorama bigger than a texture: its display image is limited by the texture size
  await plain(20000, 2500).jpeg({ quality: 70 }).toFile(join(src, 'wide.jpg'))
  // a tall one smaller than the limits: kept as it is
  await plain(1200, 6000).png().toFile(join(src, 'tall.png'))
  // stored upright with "rotate 90°" in EXIF: shown wide, the second pass keeps the turn
  await plain(2000, 8000).withMetadata({ orientation: 6 }).jpeg({ quality: 70 }).toFile(join(src, 'turned.jpg'))
  // an ordinary photo keeps the 3840 px long side
  await plain(6000, 4000).jpeg({ quality: 70 }).toFile(join(src, 'normal.jpg'))
  // a format FFmpeg decodes (HEIF, HIF, JPEG XL): its first pass must not shrink a panorama already
  await ff.run(['-f', 'lavfi', '-i', 'color=c=0x2878c8:s=8000x2000', '-frames:v', '1', '-c:v', 'libjxl', '-distance', '3', join(src, 'wide.jxl')])
  svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: join(tmp, 'cache') })
  items = await svc.importPaths([src])
  await svc.idle()
}, 300_000)

afterAll(async () => {
  await svc?.dispose()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
})

describe('panorama display images', () => {
  it('keep 1920 px on the short side, up to 16384 on the long one', async () => {
    const wide = byName('wide.jpg')
    expect([wide.width, wide.height]).toEqual([15360, 1920])
    expect(await size(wide.display!)).toEqual([15360, 1920])
    const tall = byName('tall.png')
    expect([tall.width, tall.height]).toEqual([1200, 6000])
    const turned = byName('turned.jpg')
    expect([turned.width, turned.height]).toEqual([7680, 1920])
    expect(await size(turned.display!)).toEqual([7680, 1920])
    const normal = byName('normal.jpg')
    expect([normal.width, normal.height]).toEqual([3840, 2560])
    const jxl = byName('wide.jxl')
    expect([jxl.width, jxl.height]).toEqual([7680, 1920])
    expect(await size(jxl.display!)).toEqual([7680, 1920])
  })

  it('get a sharper version for big exports, once, counted with the 4K versions', async () => {
    const wide = byName('wide.jpg')
    const normal = byName('normal.jpg')
    const tall = byName('tall.png')
    // 1080p: the display image is enough; ordinary photos are left out
    expect(await svc.prepareHires([wide.id, normal.id], 1080)).toEqual({ [wide.id]: wide.display })
    const progress: ExportProgress[] = []
    const r = await svc.prepareHires([wide.id, tall.id], 2160, { onProgress: (p) => progress.push(p) })
    expect(r[wide.id]).toMatch(/pano_2160\.jpg$/)
    // limited by the texture size again: 16384 x 2048
    expect(await size(r[wide.id])).toEqual([16384, 2048])
    // the tall one has no more pixels than its display image: the same size again
    expect(r[tall.id]).toMatch(/pano_2160\.jpg$/)
    expect(await size(r[tall.id])).toEqual([1200, 6000])
    expect(progress.at(-1)).toEqual({ phase: 'prepare', frame: 2, totalFrames: 2, message: '2/2' })
    const n = progress.length
    const again = await svc.prepareHires([wide.id, tall.id], 2160, { onProgress: (p) => progress.push(p) })
    expect(again).toEqual(r)
    expect(progress).toHaveLength(n)
    expect(classifyCacheFile('pano_2160.jpg')).toBe('hires')
    expect(classifyCacheFile('display.jpg')).toBe('display')
  })
})
