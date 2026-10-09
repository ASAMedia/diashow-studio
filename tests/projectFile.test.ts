// Packing a project with copies of its media and opening the .dshow elsewhere.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type ExportProgress, type MediaItem, type MusicTrack, type Project } from '@shared/types'
import { mediaId } from '../src/main/media/scan'
import { importProjectFile, packProject, safeName } from '../src/main/projectFile'
import { createProjectStore } from '../src/main/projects'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-pack-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

function file(path: string, content: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

function idOf(path: string): string {
  const st = statSync(path)
  return mediaId(path, st.size, st.mtimeMs)
}

const orig = join(tmp, 'originals')
const cache = join(tmp, 'cache')
const day1 = file(join(orig, 'Tag 1', 'IMG_0001.JPG'), 'photo day 1')
const day1Mov = file(join(orig, 'Tag 1', 'IMG_0001.MOV'), 'live part day 1')
const day2 = file(join(orig, 'Tag 2', 'IMG_0001.JPG'), 'photo day 2')
const day2Mov = file(join(orig, 'Tag 2', 'IMG_0001.MOV'), 'live part day 2')
const motion = file(join(orig, 'Tag 2', 'PXL_1.MP.jpg'), 'motion photo')
const video = file(join(orig, 'Tag 2', 'clip.mp4'), 'video')
const song = file(join(orig, 'Musik', 'song.mp3'), 'music')
const gone = join(orig, 'Tag 3', 'missing.jpg')

function media(id: string, path: string, extra: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    path,
    name: path.split(/[\\/]/).pop()!,
    kind: 'photo',
    format: 'JPEG',
    width: 4000,
    height: 3000,
    captureTime: 1,
    status: 'ready',
    thumb: join(cache, id, 'thumb.jpg'),
    display: join(cache, id, 'display.jpg'),
    sharpness: 0.8,
    hash: '0123456789abcdef',
    faces: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
    ...extra
  }
}

const project: Project = {
  version: 1,
  id: 'skilager-2026',
  name: 'Skilager: 2026 / Südtirol.',
  createdAt: 1,
  updatedAt: 2,
  entries: [
    { id: 'e1', type: 'photo', mediaId: idOf(day1) },
    { id: 'e2', type: 'photo', mediaId: idOf(day2), caption: 'Tag 2' },
    { id: 'e3', type: 'text', title: 'Pause' },
    { id: 'e4', type: 'photo', mediaId: idOf(motion) },
    { id: 'e5', type: 'video', mediaId: idOf(video), trimIn: 1 },
    { id: 'e6', type: 'photo', mediaId: 'gone' }
  ],
  media: [
    media(idOf(day1), day1, { live: { source: day1Mov, duration: 2.5 }, liveVideo: join(cache, 'x', 'live.mp4') }),
    media(idOf(day2), day2, { live: { source: day2Mov, duration: 2.4 } }),
    media(idOf(motion), motion, { live: { source: join(cache, idOf(motion), 'motion.mp4'), duration: 1.5 } }),
    media(idOf(video), video, { kind: 'video', format: 'H.264', playback: join(cache, 'v', 'proxy.mp4'), proxied: true, audio: join(cache, 'v', 'audio.m4a'), duration: 3, progress: 1 }),
    media('gone', gone, { status: 'error', error: 'missing' })
  ],
  music: [{ id: idOf(song), path: song, title: 'Song', duration: 200, status: 'ready', playback: join(cache, 's', 'music.m4a'), beats: [0.5, 1, 1.5], bpm: 120 } satisfies MusicTrack],
  settings: DEFAULT_SETTINGS
}

describe('safeName', () => {
  it('makes Windows-safe folder names', () => {
    expect(safeName('Skilager: 2026 / Südtirol.')).toBe('Skilager 2026 Südtirol')
    expect(safeName('CON')).toBe('CON_')
    expect(safeName('  ...  ')).toBe('Diashow')
    expect(safeName('a'.repeat(300))).toHaveLength(100)
  })
})

describe('pack and open', () => {
  const out = join(tmp, 'out')
  let dshow: string
  const progress: ExportProgress[] = []

  it('copies every original into media/ and music/ and writes a relative .dshow', async () => {
    mkdirSync(out)
    dshow = await packProject(project, out, { onProgress: (p) => progress.push(p) })
    const root = join(out, 'Skilager 2026 Südtirol')
    expect(dshow).toBe(join(root, 'Skilager 2026 Südtirol.dshow'))
    expect(readdirSync(join(root, 'media')).sort()).toEqual(['IMG_0001 (2).JPG', 'IMG_0001 (2).MOV', 'IMG_0001.JPG', 'IMG_0001.MOV', 'PXL_1.MP.jpg', 'clip.mp4'].sort())
    expect(readdirSync(join(root, 'music'))).toEqual(['song.mp3'])
    expect(readFileSync(join(root, 'media', 'IMG_0001 (2).MOV'), 'utf8')).toBe('live part day 2')
    // Copies keep the modification time
    expect(statSync(join(root, 'media', 'clip.mp4')).mtimeMs).toBe(statSync(video).mtimeMs)

    const packed = JSON.parse(readFileSync(dshow, 'utf8')) as Project
    expect(packed.entries).toEqual(project.entries)
    expect(packed.media.map((m) => m.path)).toEqual(['media/IMG_0001.JPG', 'media/IMG_0001 (2).JPG', 'media/PXL_1.MP.jpg', 'media/clip.mp4', gone])
    expect(packed.media[0].live).toEqual({ source: 'media/IMG_0001.MOV', duration: 2.5 })
    expect(packed.media[1].live).toEqual({ source: 'media/IMG_0001 (2).MOV', duration: 2.4 })
    // The motion photo's video lives in the cache: re-extracted on the other PC
    expect(packed.media[2].live).toBeUndefined()
    for (const m of packed.media) {
      expect(m.status).toBe('pending')
      for (const key of ['thumb', 'display', 'playback', 'audio', 'liveVideo', 'proxied', 'progress', 'error']) expect(m).not.toHaveProperty(key)
      expect(m.hash).toBe('0123456789abcdef')
      expect(m.faces).toHaveLength(1)
    }
    expect(packed.music).toEqual([{ id: idOf(song), path: 'music/song.mp3', title: 'Song', duration: 200, status: 'pending', beats: [0.5, 1, 1.5], bpm: 120 }])

    expect(progress.every((p) => p.phase === 'prepare' && p.totalFrames === 7)).toBe(true)
    expect(progress.map((p) => p.message)).toEqual(['0/7', '1/7', '2/7', '3/7', '4/7', '5/7', '6/7', '7/7'])
  })

  it('never overwrites an existing folder', async () => {
    const second = await packProject(project, out)
    expect(second).toBe(join(out, 'Skilager 2026 Südtirol (2)', 'Skilager 2026 Südtirol.dshow'))
  })

  it('opens the packed project after the folder moved: absolute paths, ids of the copies, saved in the store', async () => {
    const moved = join(tmp, 'Anderer PC', 'Skilager')
    mkdirSync(join(moved, '..'), { recursive: true })
    renameSync(join(out, 'Skilager 2026 Südtirol'), moved)
    const store = createProjectStore(join(tmp, 'projects'))
    const p = await importProjectFile(join(moved, 'Skilager 2026 Südtirol.dshow'), store)
    expect(p.id).toBe('skilager-2026')
    const copy = (name: string): string => join(moved, 'media', name)
    expect(p.media.map((m) => m.path)).toEqual([copy('IMG_0001.JPG'), copy('IMG_0001 (2).JPG'), copy('PXL_1.MP.jpg'), copy('clip.mp4'), gone])
    expect(p.media[1].live?.source).toBe(copy('IMG_0001 (2).MOV'))
    expect(p.media[0].id).toBe(idOf(copy('IMG_0001.JPG')))
    expect(p.media[4].id).toBe('gone')
    // Entries follow the new ids
    expect(p.entries.map((e) => (e.type === 'text' ? e.title : e.mediaId))).toEqual([...p.media.slice(0, 2).map((m) => m.id), 'Pause', p.media[2].id, p.media[3].id, 'gone'])
    expect(p.music[0]).toMatchObject({ id: idOf(join(moved, 'music', 'song.mp3')), path: join(moved, 'music', 'song.mp3'), beats: [0.5, 1, 1.5] })
    expect(await store.load(p.id)).toEqual(p)

    // Opening it again: the id is taken now, so it becomes a second project
    const again = await importProjectFile(join(moved, 'Skilager 2026 Südtirol.dshow'), store)
    expect(again.id).not.toBe(p.id)
    expect(again.id).toMatch(/^[0-9a-f-]{36}$/)
    expect((await store.list()).map((s) => s.id).sort()).toEqual([p.id, again.id].sort())

    // Opening a project file of the store itself just loads it
    const own = await importProjectFile(join(store.dir, `${p.id}.dshow`), store)
    expect(own).toEqual(p)
    expect(await store.list()).toHaveLength(2)
  })

  it('rejects files that are not projects', async () => {
    const bad = file(join(tmp, 'bad.dshow'), '{"hello": 1}')
    const store = createProjectStore(join(tmp, 'projects2'))
    await expect(importProjectFile(bad, store)).rejects.toThrow(/not a Diashow Studio project/)
    expect(existsSync(store.dir)).toBe(false)
  })

  it('removes its own partial folder when cancelled', async () => {
    const ctrl = new AbortController()
    const target = join(tmp, 'cancelled')
    mkdirSync(target)
    const run = packProject(project, target, { signal: ctrl.signal, onProgress: (p) => p.frame === 2 && ctrl.abort() })
    await expect(run).rejects.toThrow(/cancelled/)
    expect(readdirSync(target)).toEqual([])
  })
})
