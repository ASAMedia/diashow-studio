// Relinking moved originals (media:relink): matching by name/size/time, cache migration, re-import.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MediaItem } from '@shared/types'
import { mediaId, type ScannedFile } from '../src/main/media/scan'
import { createMediaService, pickRelinkCandidate } from '../src/main/media/service'
import { ff, FFMPEG_DIR } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-relink-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

function scanned(path: string, size: number, mtimeMs: number): ScannedFile {
  const name = path.split('\\').pop()!
  const ext = name.split('.').pop()!.toLowerCase()
  return { path, dir: path.slice(0, path.lastIndexOf('\\')), name, base: name.slice(0, -(ext.length + 1)), ext, kind: 'photo', size, mtimeMs }
}

describe('pickRelinkCandidate', () => {
  const oldPath = 'D:\\Fotos\\Urlaub\\Tag 2\\IMG_0001.JPG'
  const item = { id: mediaId(oldPath, 500, 1000), path: oldPath } as MediaItem

  it('prefers the file with the same size and time (the id matches)', () => {
    const exact = scanned('E:\\Archiv\\x\\IMG_0001.JPG', 500, 1000)
    const sameFolder = scanned('E:\\Archiv\\Urlaub\\Tag 2\\IMG_0001.JPG', 400, 5)
    expect(pickRelinkCandidate(item, [sameFolder, exact])).toEqual({ file: exact, exact: true })
  })

  it('then the known size, then the parent folder names', () => {
    const a = scanned('E:\\A\\Tag 1\\IMG_0001.JPG', 500, 7)
    const b = scanned('E:\\B\\Urlaub\\Tag 2\\IMG_0001.JPG', 600, 7)
    expect(pickRelinkCandidate(item, [a, b], 500)).toEqual({ file: a, exact: false })
    expect(pickRelinkCandidate(item, [a, b])).toEqual({ file: b, exact: false })
    // a known size that no candidate has: not this file
    expect(pickRelinkCandidate(item, [b], 500)).toBeNull()
  })

  it('takes a single same-named file, but no guess between equal candidates', () => {
    const a = scanned('E:\\A\\Tag 2\\IMG_0001.JPG', 1, 1)
    const b = scanned('E:\\B\\Tag 2\\IMG_0001.JPG', 2, 2)
    expect(pickRelinkCandidate(item, [a])).toEqual({ file: a, exact: false })
    expect(pickRelinkCandidate(item, [a, b])).toBeNull()
    expect(pickRelinkCandidate(item, [])).toBeNull()
  })
})

describe('relinkMedia', () => {
  const orig = join(tmp, 'Fotos', 'Urlaub')
  const cache = join(tmp, 'cache')
  let items: MediaItem[]
  const byName = (name: string): MediaItem => items.find((i) => i.name === name)!

  beforeAll(async () => {
    mkdirSync(join(orig, 'Tag 1'), { recursive: true })
    await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 90, b: 160 } } }).jpeg().toFile(join(orig, 'Tag 1', 'photo.jpg'))
    await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toFile(join(orig, 'Tag 1', 'live.jpg'))
    await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=640x480:r=30:d=2', '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error', join(orig, 'Tag 1', 'live.mov')])
    await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(orig, 'Tag 1', 'clip.mp4')])
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 200, b: 10 } } }).jpeg().toFile(join(orig, 'Tag 1', 'edited.jpg'))
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: cache })
    items = await svc.importPaths([orig])
    await svc.idle()
    items = items.map((i) => svc.get(i.id)!)
    await svc.dispose()
  }, 120_000)

  it('finds moved files, takes the cache along for identical ones and re-imports the rest', async () => {
    expect(items.map((i) => i.name).sort()).toEqual(['clip.mp4', 'edited.jpg', 'live.jpg', 'photo.jpg'])
    expect(byName('live.jpg').live?.source).toMatch(/live\.mov$/)
    // The whole folder moves elsewhere (rename keeps size and modification time)
    const moved = join(tmp, 'Archiv', '2025')
    mkdirSync(moved, { recursive: true })
    renameSync(join(tmp, 'Fotos'), join(moved, 'Fotos'))
    // One file was touched afterwards: same name and size, other time → no proof it is identical
    const edited = join(moved, 'Fotos', 'Urlaub', 'Tag 1', 'edited.jpg')
    utimesSync(edited, new Date(), new Date(Date.now() - 3600_000))
    // A same-named file of different size elsewhere must not be taken
    mkdirSync(join(moved, 'Andere'), { recursive: true })
    copyFileSync(join(moved, 'Fotos', 'Urlaub', 'Tag 1', 'clip.mp4'), join(moved, 'Andere', 'photo.jpg'))

    const updates: MediaItem[] = []
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: cache, onUpdate: (u) => updates.push(u) })
    try {
      const restored = await svc.restoreMedia(items)
      expect(restored.every((r) => r.status === 'error' && r.error === 'missing')).toBe(true)
      const gone = { ...byName('photo.jpg'), id: 'ffffffffffffffff', path: join(tmp, 'nowhere', 'gone.jpg'), name: 'gone.jpg' }
      // fields of the project, not of the cache: they must survive the move (restore keeps them too)
      const edit = { rotate: 90 as const, straighten: 2.5, crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 } }
      const faceFocus = { x: 0.3, y: 0.4 }
      expect(restored.find((r) => r.name === 'photo.jpg')?.edit).toBeUndefined()
      const own = (r: MediaItem): MediaItem => (r.name === 'photo.jpg' ? { ...r, edit, faceFocus } : r.name === 'clip.mp4' ? { ...r, edit: { rotate: 270, straighten: 0 } } : r)
      const again = await svc.restoreMedia(restored.map(own))
      expect(again.find((r) => r.name === 'photo.jpg')).toMatchObject({ edit, faceFocus, error: 'missing' })

      const result = await svc.relinkMedia([...restored.map(own), gone], join(tmp, 'Archiv'))
      expect(result[byName('photo.jpg').id]).toMatchObject({ edit, faceFocus, status: 'ready' })
      expect(result[byName('clip.mp4').id].edit).toEqual({ rotate: 270, straighten: 0 })
      expect(result[byName('live.jpg').id].edit).toBeUndefined()
      // the cache itself keeps no edit (another project may use the same file)
      expect(svc.get(result[byName('photo.jpg').id].id)?.edit).toBeUndefined()
      // opened again while the service still knows the item: the project's fields come back with it
      const reopened = await svc.restoreMedia([{ ...result[byName('photo.jpg').id], edit: { rotate: 180, straighten: 0 } }])
      expect(reopened[0]).toMatchObject({ edit: { rotate: 180, straighten: 0 }, faceFocus, status: 'ready' })
      expect((await svc.restoreMedia([{ ...result[byName('photo.jpg').id], edit: undefined }]))[0].edit).toBeUndefined()
      expect(Object.keys(result).sort()).toEqual(items.map((i) => i.id).sort())
      for (const old of items) {
        const found = result[old.id]
        expect(found.name).toBe(old.name)
        expect(found.path.startsWith(join(moved, 'Fotos', 'Urlaub', 'Tag 1'))).toBe(true)
        const st = statSync(found.path)
        expect(found.id).toBe(mediaId(found.path, st.size, st.mtimeMs))
        expect(found.id).not.toBe(old.id)
      }
      // identical files: ready at once from the migrated cache, paths point into the new folder
      for (const name of ['photo.jpg', 'clip.mp4', 'live.jpg']) {
        const old = byName(name)
        const found = result[old.id]
        expect(found.status, name).toBe('ready')
        for (const key of ['thumb', 'display', 'audio', 'liveVideo'] as const) {
          if (old[key]) {
            expect(found[key], `${name} ${key}`).toBe(join(cache, found.id, (old[key] as string).split(/[\\/]/).pop()!))
            expect(existsSync(found[key] as string)).toBe(true)
          }
        }
        expect(found.hash).toBe(old.hash)
        expect(existsSync(join(cache, found.id, 'meta.json'))).toBe(true)
      }
      expect(result[byName('clip.mp4').id].playback).toBe(result[byName('clip.mp4').id].path)
      expect(result[byName('clip.mp4').id].loudness).toBe(byName('clip.mp4').loudness)
      expect(result[byName('live.jpg').id].live?.source).toBe(join(moved, 'Fotos', 'Urlaub', 'Tag 1', 'live.mov'))
      // the old cache stays for projects that still use the old path
      expect(existsSync(byName('photo.jpg').display!)).toBe(true)
      expect(readFileSync(result[byName('photo.jpg').id].display!).equals(readFileSync(byName('photo.jpg').display!))).toBe(true)

      // the touched file is processed again, reported through media:update
      const editedItem = result[byName('edited.jpg').id]
      expect(editedItem.status).toBe('pending')
      await svc.idle()
      expect(svc.get(editedItem.id)!.status).toBe('ready')
      expect(updates.filter((u) => u.id === editedItem.id).map((u) => u.status)).toContain('ready')
    } finally {
      await svc.dispose()
    }
  })

  it('returns nothing for an empty request or folder', async () => {
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: cache })
    try {
      expect(await svc.relinkMedia([], tmp)).toEqual({})
      expect(await svc.relinkMedia([byName('photo.jpg')], join(tmp, 'empty-nonexistent'))).toEqual({})
    } finally {
      await svc.dispose()
    }
  })
})
