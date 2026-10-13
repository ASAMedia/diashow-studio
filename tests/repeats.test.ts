// Photos and videos already in a show are not added twice: the rule (src/shared/repeats.ts), the content
// hash and its cache (src/main/media/contentHash.ts), and the import that leaves the repeats out
// unprocessed (src/main/media/repeats.ts).
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { candidateOf, findRepeats, sameShot, showCandidates, type RepeatCandidate } from '@shared/repeats'
import { DEFAULT_SETTINGS, type MediaItem, type Project } from '@shared/types'
import { ContentHashes, contentKeys, edgeHash, fullHash, WHOLE, type HashFile, type Hasher } from '../src/main/media/contentHash'
import { mediaId } from '../src/main/media/scan'
import { createMediaService, type MediaService } from '../src/main/media/service'
import { FFMPEG_DIR, TEST_MEDIA, ensureTestMedia } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-repeats-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

const photo = (id: string, path: string, extra: Partial<RepeatCandidate> = {}): RepeatCandidate => ({
  id, path, kind: 'photo', width: 4032, height: 3024, captureTime: Date.UTC(2026, 4, 4, 10, 0, 0, 123), device: 'iPhone 15 Pro', ...extra
})

describe('the rule', () => {
  const show = [photo('a', 'C:\\Fotos\\IMG_0001.JPG'), photo('b', 'C:\\Fotos\\IMG_0002.HEIC', { live: 'C:\\Fotos\\IMG_0002.MOV', captureTime: Date.UTC(2026, 4, 4, 10, 1, 0, 456) })]

  it('the same file: the same media id, or the same path in another case', () => {
    const r = findRepeats([photo('a', 'C:\\Fotos\\IMG_0001.JPG'), photo('x', 'c:\\fotos\\img_0001.jpg', { captureTime: 1 })], show)
    expect([...r]).toEqual([['a', 'a'], ['x', 'a']])
  })

  it('the motion part of a Live Photo in the show is the Live Photo (a pair is one item)', () => {
    const mov: RepeatCandidate = { id: 'm', path: 'C:\\Fotos\\IMG_0002.MOV', kind: 'video', width: 1080, height: 1920, captureTime: 0 }
    expect(findRepeats([mov], show).get('m')).toBe('b')
  })

  it('a byte-identical copy under another name: the same content key', () => {
    const keys: Record<string, string> = { 'c:\\fotos\\img_0001.jpg': '100:aa', 'd:\\uploads\\mia\\urlaub.jpg': '100:aa', 'd:\\uploads\\ben\\other.jpg': '100:bb' }
    const r = findRepeats(
      [photo('u', 'D:\\Uploads\\Mia\\Urlaub.jpg', { captureTime: 5 }), photo('v', 'D:\\Uploads\\Ben\\other.jpg', { captureTime: 6 })],
      show,
      (p) => keys[p.toLowerCase()]
    )
    expect([...r]).toEqual([['u', 'a']])
  })

  it('inside one import only the first of identical files is added', () => {
    const keys: Record<string, string> = { 'd:\\a\\x.jpg': '7:k', 'd:\\b\\x.jpg': '7:k', 'd:\\b\\y.jpg': '7:k' }
    const list = [photo('1', 'D:\\a\\x.jpg', { captureTime: 1 }), photo('2', 'D:\\b\\x.jpg', { captureTime: 1 }), photo('3', 'D:\\b\\y.jpg', { captureTime: 1 })]
    expect([...findRepeats(list, [], (p) => keys[p.toLowerCase()])]).toEqual([['2', '1'], ['3', '1']])
  })

  it('the same shot in another format: same camera, picture size and capture time to the millisecond', () => {
    const jpeg = photo('j', 'D:\\Uploads\\Mia\\IMG_0002.jpg', { captureTime: show[1].captureTime })
    expect(sameShot(jpeg, show[1])).toBe(true)
    expect(findRepeats([jpeg], show).get('j')).toBe('b')
    // the other way round the Live Photo goes in: skipping it would lose its motion
    const still = photo('s', 'D:\\Uploads\\Mia\\IMG_0003.jpg', { captureTime: Date.UTC(2026, 4, 4, 10, 2, 0, 789) })
    const live = photo('l', 'C:\\Fotos\\IMG_0003.HEIC', { live: 'C:\\Fotos\\IMG_0003.MOV', captureTime: still.captureTime })
    expect(sameShot(live, still)).toBe(true)
    expect(findRepeats([live], [still]).has('l')).toBe(false)
    expect(findRepeats([still, live], []).has('l')).toBe(false)
  })

  it('bursts, capture times without milliseconds and other cameras are never the same shot', () => {
    const t = Date.UTC(2026, 4, 4, 12, 0, 0)
    const heic = photo('h', 'C:\\Burst\\IMG_0100.HEIC', { captureTime: t + 300 })
    // a burst: the same second and size, other milliseconds
    expect(sameShot(heic, photo('n', 'C:\\Burst\\IMG_0101.jpg', { captureTime: t + 400 }))).toBe(false)
    // the same millisecond in the same format (a camera's own sequence)
    expect(sameShot(heic, photo('s', 'C:\\Burst\\IMG_0102.HEIC', { captureTime: t + 300 }))).toBe(false)
    // whole seconds only (no sub-second tags): never
    expect(sameShot(photo('w', 'C:\\x.HEIC', { captureTime: t }), photo('v', 'C:\\x.jpg', { captureTime: t }))).toBe(false)
    // another camera, another size, no camera at all
    expect(sameShot(heic, photo('o', 'C:\\o.jpg', { captureTime: t + 300, device: 'Pixel 8' }))).toBe(false)
    expect(sameShot(heic, photo('p', 'C:\\p.jpg', { captureTime: t + 300, width: 3024, height: 4032 }))).toBe(false)
    expect(sameShot(photo('q', 'C:\\q.HEIC', { captureTime: t + 300, device: undefined }), photo('r', 'C:\\r.jpg', { captureTime: t + 300, device: undefined }))).toBe(false)
    // two different photos of the same size and capture second are both added
    const burst = [photo('1', 'C:\\B\\1.jpg', { captureTime: t + 100 }), photo('2', 'C:\\B\\2.jpg', { captureTime: t + 200 }), photo('3', 'C:\\B\\3.jpg', { captureTime: t })]
    expect(findRepeats(burst, [], () => undefined).size).toBe(0)
  })

  it('the show is every photo and video with a slide, left-out ones too', () => {
    const m = (id: string): MediaItem => ({ id, path: `C:\\${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: 10, height: 10, captureTime: 0, status: 'ready' })
    const p: Project = {
      version: 1, id: 'p', name: 'P', createdAt: 0, updatedAt: 0, music: [], settings: DEFAULT_SETTINGS,
      media: [m('in'), m('out'), m('gone')],
      entries: [{ id: 'e1', type: 'photo', mediaId: 'in' }, { id: 'e2', type: 'photo', mediaId: 'out', excluded: true }, { id: 't', type: 'text', title: 'T' }]
    }
    expect(showCandidates(p).map((c) => c.id)).toEqual(['in', 'out'])
    expect(findRepeats([candidateOf(m('out'))], showCandidates(p)).get('out')).toBe('out')
  })
})

describe('content keys', () => {
  /** A hasher whose keys are given per path; counts what it reads. */
  function fake(edge: Record<string, string>, full: Record<string, string>): Hasher & { edges: string[]; fulls: string[] } {
    const h = {
      edges: [] as string[],
      fulls: [] as string[],
      edge: async (f: HashFile) => (h.edges.push(f.path), edge[f.path]),
      full: async (f: HashFile) => (h.fulls.push(f.path), full[f.path])
    }
    return h
  }
  const file = (path: string, size: number, wanted = false): HashFile => ({ path, size, mtimeMs: 0, wanted })

  it('reads only files that share their size with a new file, and whole files only when their edges match', async () => {
    const h = fake({ 'C:\\a': 'e1', 'C:\\b': 'e1', 'C:\\c': 'e2', 'C:\\d': 'e3', 'C:\\e': 'e3' }, { 'C:\\a': 'f1', 'C:\\b': 'f1' })
    const keys = await contentKeys(
      [file('C:\\a', 5e6), file('C:\\b', 5e6, true), file('C:\\c', 5e6, true), file('C:\\d', 7e6), file('C:\\e', 7e6), file('C:\\f', 9e6, true)],
      h
    )
    // f: a size of its own; d and e: no new file among them
    expect(h.edges.sort()).toEqual(['C:\\a', 'C:\\b', 'C:\\c'])
    // c's edges differ from the others
    expect(h.fulls.sort()).toEqual(['C:\\a', 'C:\\b'])
    expect([...keys]).toEqual(expect.arrayContaining([['c:\\a', '5000000:f1'], ['c:\\b', '5000000:f1']]))
    expect(keys.size).toBe(2)
  })

  it('a file that cannot be read gets no key', async () => {
    const h: Hasher = { edge: async (f) => { if (f.path === 'C:\\gone') throw new Error('ENOENT'); return 'e' }, full: async () => 'f' }
    const keys = await contentKeys([file('C:\\gone', 10, true), file('C:\\here', 10), file('C:\\new', 10, true)], h)
    expect([...keys.keys()].sort()).toEqual(['c:\\here', 'c:\\new'])
  })
})

describe('content hash and cache', () => {
  const dir = join(tmp, 'hash')
  const big = join(dir, 'big.bin')
  const copy = join(dir, 'copy of big.bin')
  const middle = join(dir, 'middle.bin')
  const small = join(dir, 'small.bin')
  const f = (path: string, wanted = true): HashFile => {
    const st = statSync(path)
    return { path, size: st.size, mtimeMs: st.mtimeMs, wanted }
  }

  beforeAll(() => {
    mkdirSync(dir, { recursive: true })
    // a big file (a video): its edges are compared first
    const data = randomBytes(WHOLE + 12345)
    writeFileSync(big, data)
    copyFileSync(big, copy)
    // the same size and edges, one byte different in the middle
    const changed = Buffer.from(data)
    changed[Math.floor(changed.length / 2)] ^= 0xff
    writeFileSync(middle, changed)
    writeFileSync(small, randomBytes(100_000))
  })

  it('the edges of a big file cover size, first and last MiB; the full hash the whole file', async () => {
    expect(await edgeHash(big, statSync(big).size)).toBe(await edgeHash(copy, statSync(copy).size))
    expect(await edgeHash(middle, statSync(middle).size)).toBe(await edgeHash(big, statSync(big).size))
    expect(await fullHash(middle)).not.toBe(await fullHash(big))
    expect(await fullHash(copy)).toBe(await fullHash(big))
    // a small file is read whole for its edges
    expect(await edgeHash(small, 100_000)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('finds the copy, not the file that differs only in the middle', async () => {
    const keys = await contentKeys([f(big, false), f(copy), f(middle)], new ContentHashes())
    expect(keys.get(copy.toLowerCase())).toBe(keys.get(big.toLowerCase()))
    expect(keys.get(middle.toLowerCase())).not.toBe(keys.get(big.toLowerCase()))
  })

  it('computes each key once per file and keeps it next to the cache folder', async () => {
    const cache = join(tmp, 'hash-cache')
    const folder = (id: string): string => join(cache, id)
    // the original has a cache folder (it is in a show), the copy not yet
    mkdirSync(folder(mediaId(big, statSync(big).size, statSync(big).mtimeMs)), { recursive: true })
    const h = new ContentHashes(folder)
    const keys = await contentKeys([f(big, false), f(copy)], h)
    expect(h.reads).toBe(4) // edges and whole file of both
    expect(await contentKeys([f(big, false), f(copy)], h)).toEqual(keys)
    expect(h.reads).toBe(4)
    const stored = join(folder(mediaId(big, statSync(big).size, statSync(big).mtimeMs)), 'content.json')
    expect(JSON.parse(readFileSync(stored, 'utf8'))).toMatchObject({ size: statSync(big).size, edge: expect.stringMatching(/^[0-9a-f]{64}$/), full: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(existsSync(folder(mediaId(copy, statSync(copy).size, statSync(copy).mtimeMs)))).toBe(false)
    // after a restart: the original's keys come from content.json, only the copy is read again
    const again = new ContentHashes(folder)
    expect(await contentKeys([f(big, false), f(copy)], again)).toEqual(keys)
    expect(again.reads).toBe(2)
  })

  it('a file changed since (another size or time) is read again', async () => {
    const h = new ContentHashes()
    const before = await h.full(f(small))
    writeFileSync(small, randomBytes(100_000))
    utimesSync(small, new Date(), new Date(Date.now() + 5000))
    expect(await h.full(f(small))).not.toBe(before)
    expect(h.reads).toBe(2)
  })
})

describe('importing into a show', () => {
  const src = join(tmp, 'import')
  const trip = join(src, 'Ausflug')
  let svc: MediaService
  const cache = join(tmp, 'import-cache')
  const show = (items: MediaItem[]): RepeatCandidate[] => items.map(candidateOf)

  /** A phone-like photo: random pixels (each one different), a camera and a capture time. */
  async function phonePhoto(path: string, i: number, w = 1200, h = 900): Promise<void> {
    await sharp(randomBytes(w * h * 3), { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 90 })
      .withExif({ IFD0: { Make: 'Google', Model: 'Pixel 8' }, IFD2: { DateTimeOriginal: `2026:05:04 10:00:${String(i).padStart(2, '0')}`, OffsetTimeOriginal: '+02:00' } })
      .toFile(path)
  }

  beforeAll(async () => {
    ensureTestMedia()
    mkdirSync(trip, { recursive: true })
    for (let i = 0; i < 3; i++) await phonePhoto(join(trip, `PXL_${i}.jpg`), i)
    // bigger than WHOLE: its edges are compared first, then the whole file
    await phonePhoto(join(trip, 'PXL_big.jpg'), 9, 4000, 3000)
    // a Live Photo (HEIC + MOV) and a RAW+JPEG pair: one item each
    for (const f of ['iphone/IMG_0001.HEIC', 'iphone/IMG_0001.MOV', 'sony/DCIM/100MSDCF/DSC00001.JPG', 'sony/DCIM/100MSDCF/DSC00001.ARW']) {
      copyFileSync(join(TEST_MEDIA, ...f.split('/')), join(trip, f.split('/').pop()!))
    }
    svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: cache, hdrGpu: false })
  }, 120_000)

  afterAll(async () => {
    await svc?.dispose()
  })

  let first: MediaItem[] = []

  it('a new show takes everything; a Live Photo and a RAW+JPEG pair are one item each', async () => {
    const r = await svc.importNew([trip], [])
    expect(r.repeats).toEqual({})
    first = r.items
    expect(first.map((m) => m.name).sort()).toEqual(['DSC00001.JPG', 'IMG_0001.HEIC', 'PXL_0.jpg', 'PXL_1.jpg', 'PXL_2.jpg', 'PXL_big.jpg'])
    expect(first.find((m) => m.name === 'IMG_0001.HEIC')!.live?.source).toBe(join(trip, 'IMG_0001.MOV'))
    await svc.idle()
    expect(first.every((m) => svc.get(m.id)?.status === 'ready')).toBe(true)
  }, 120_000)

  it('the same folder again: everything is a repeat of itself', async () => {
    const r = await svc.importNew([trip], show(first))
    expect(Object.keys(r.repeats).sort()).toEqual(first.map((m) => m.id).sort())
    expect(Object.entries(r.repeats).every(([a, b]) => a === b)).toBe(true)
    // the show's own items are kept by the service
    expect(first.every((m) => svc.get(m.id)?.status === 'ready')).toBe(true)
  })

  it('a renamed copy is skipped unprocessed, a different photo comes in, and so does the copy when added anyway', async () => {
    const other = join(src, 'Mia')
    mkdirSync(other, { recursive: true })
    copyFileSync(join(trip, 'PXL_1.jpg'), join(other, 'Urlaub.jpg'))
    copyFileSync(join(trip, 'PXL_big.jpg'), join(other, 'Groß.jpg'))
    await phonePhoto(join(other, 'Neu.jpg'), 30)
    copyFileSync(join(trip, 'IMG_0001.MOV'), join(other, 'Bewegung.MOV'))
    expect(statSync(join(other, 'Groß.jpg')).size).toBeGreaterThan(WHOLE)
    const r = await svc.importNew([other], show(first))
    const byName = (n: string): MediaItem => r.items.find((m) => m.name === n)!
    const orig = (n: string): string => first.find((m) => m.name === n)!.id
    expect(r.repeats).toEqual({
      [byName('Urlaub.jpg').id]: orig('PXL_1.jpg'),
      [byName('Groß.jpg').id]: orig('PXL_big.jpg'),
      // a copy of a Live Photo's motion part
      [byName('Bewegung.MOV').id]: orig('IMG_0001.HEIC')
    })
    await svc.idle()
    expect(svc.get(byName('Neu.jpg').id)?.status).toBe('ready')
    for (const n of ['Urlaub.jpg', 'Groß.jpg', 'Bewegung.MOV']) {
      expect(svc.get(byName(n).id), n).toBeUndefined()
      expect(existsSync(join(cache, byName(n).id)), n).toBe(false)
    }
    // "Add anyway" imports them again the plain way: processed like any import
    const [again] = await svc.importPaths([join(other, 'Urlaub.jpg')])
    await svc.idle()
    expect(svc.get(again.id)?.status).toBe('ready')
  }, 120_000)

  it('the same new photo in two folders of one import is added once', async () => {
    const a = join(src, 'Ben')
    const b = join(src, 'Lena')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    await phonePhoto(join(a, 'Klasse.jpg'), 40)
    copyFileSync(join(a, 'Klasse.jpg'), join(b, 'Klassenfoto.jpg'))
    const r = await svc.importNew([a, b], show(first))
    const kept = r.items.find((m) => m.name === 'Klasse.jpg')!
    const copy = r.items.find((m) => m.name === 'Klassenfoto.jpg')!
    expect(r.repeats).toEqual({ [copy.id]: kept.id })
  })
})
