// "Diashow als ZIP archivieren" (src/main/archive): which files go in under which names (duplicates,
// Live Photo videos, items left out of the show, missing originals, the theme song, exported videos),
// what the dialog lists, writing with the check after it, cancelling, a full disk, a file that
// vanishes while writing, and opening the extracted .dshow like a packed project, with the archived
// theme song taking over when the app's own song for the theme is another one.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { archiveSize, FAT_MAX_FILE, type ArchiveChoice, type ArchiveProgress } from '@shared/archive'
import { classifyError } from '@shared/friendlyError'
import type { ThemeTrack } from '@shared/themeMusic'
import { DEFAULT_SETTINGS, type MediaItem, type Project } from '@shared/types'
import { archiveInventory, chosenVideos, defaultTarget, fileLimitFor, maxFileSizeOf, planArchive, showOnly, writeArchive, type ArchiveDeps } from '../src/main/archive/archive'
import { checkArchiveChoice } from '../src/main/archive/archiveMain'
import { readmeText } from '../src/main/archive/readme'
import { ARCHIVED_THEME_SONG, readArchivedThemeSong, sameContent, withArchivedThemeSong } from '../src/main/archive/themeSong'
import { entryDataOffset, fileInput, readCentralDirectory } from '../src/main/archive/zip64'
import { mediaId } from '../src/main/media/scan'
import { importProjectFile, packProject } from '../src/main/projectFile'
import { createProjectStore } from '../src/main/projects'
import { parseThemeCatalog } from '../src/main/themeMusic'
import { hasTar, PYTHON, pythonRead, tarExtract } from './helpers/zipTools'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-archive-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

const NOW = new Date(2026, 9, 12, 12, 0).getTime()
const DELETE_AT = new Date(2027, 0, 12).getTime()

function file(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

const idOf = (path: string): string => {
  const st = statSync(path)
  return mediaId(path, st.size, st.mtimeMs)
}

function media(path: string, extra: Partial<MediaItem> = {}): MediaItem {
  return {
    id: existsSync(path) ? idOf(path) : `gone-${path.length}`,
    path,
    name: path.split(/[\\/]/).pop()!,
    kind: 'photo',
    format: 'JPEG',
    width: 4000,
    height: 3000,
    captureTime: 1,
    status: 'ready',
    thumb: join(tmp, 'cache', 'x', 'thumb.jpg'),
    display: join(tmp, 'cache', 'x', 'display.jpg'),
    ...extra
  }
}

/** Originals of a class trip: two photos of the same name, a Live Photo, a video, a left-out photo, two missing ones. */
function originals(root: string) {
  const day1 = file(join(root, 'Tag 1', 'IMG_0001.JPG'), `photo day 1 ${'x'.repeat(2000)}`)
  const day1Mov = file(join(root, 'Tag 1', 'IMG_0001.MOV'), 'live part day 1')
  const day2 = file(join(root, 'Tag 2', 'IMG_0001.JPG'), 'photo day 2')
  const video = file(join(root, 'Tag 2', 'Ausflug ins Grüne.mp4'), `video ${'v'.repeat(5000)}`)
  const blurry = file(join(root, 'Tag 2', 'IMG_0099.JPG'), 'blurry, left out')
  const song = file(join(root, 'Musik', 'Lied.mp3'), 'our own song')
  const gone = join(root, 'Tag 3', 'fehlt.jpg')
  const goneLeftOut = join(root, 'Tag 3', 'fehlt-auch.jpg')
  return { day1, day1Mov, day2, video, blurry, song, gone, goneLeftOut }
}

function makeProject(o: ReturnType<typeof originals>, ownMusic: boolean): Project {
  const items = [
    media(o.day1, { live: { source: o.day1Mov, duration: 2.5 }, faces: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }], faceDesc: [[0.1, 0.2]] }),
    media(o.day2),
    media(o.video, { kind: 'video', format: 'H.264', duration: 4, playback: join(tmp, 'cache', 'v', 'proxy.mp4'), proxied: true }),
    media(o.blurry),
    media(o.gone, { status: 'error', error: 'missing' }),
    media(o.goneLeftOut, { status: 'error', error: 'missing' })
  ]
  return {
    version: 1,
    id: ownMusic ? 'berlin-own' : 'berlin-theme',
    name: 'Klassenfahrt: Berlin',
    createdAt: 1,
    updatedAt: 2,
    deleteAt: DELETE_AT,
    entries: [
      { id: 'e0', type: 'text', title: 'Berlin' },
      { id: 'e1', type: 'photo', mediaId: items[0].id },
      { id: 'e2', type: 'photo', mediaId: items[1].id, caption: 'Tag 2' },
      { id: 'e3', type: 'video', mediaId: items[2].id },
      { id: 'e4', type: 'photo', mediaId: items[3].id, excluded: true },
      { id: 'e5', type: 'photo', mediaId: items[4].id },
      { id: 'e6', type: 'photo', mediaId: items[5].id, excluded: true }
    ],
    media: items,
    music: ownMusic ? [{ id: idOf(o.song), path: o.song, title: 'Lied', duration: 120, status: 'ready', playback: o.song, beats: [0.5, 1] }] : [],
    people: [{ id: 'p1', name: 'Mia', desc: [[0.1, 0.2]] }],
    settings: structuredClone(DEFAULT_SETTINGS)
  } as Project
}

/** A theme-music folder with one song for Ken Burns ("version 1" catalogue, as 1.2 wrote it). */
function themeFolder(dir: string, content: string): ThemeTrack[] {
  file(join(dir, 'kenburns.m4a'), content)
  return parseThemeCatalog({ version: 1, songs: { kenburns: { file: 'kenburns.m4a', title: 'Morgenlicht', artist: 'Jemand', licence: 'CC0 1.0', source: 'https://example.org/song', duration: 90, beats: [0.5, 1, 1.5] } } }, dir)
}

/** Extracts an archive with the app's own reader (tar.exe and Python check it independently elsewhere). */
async function extract(zip: string, dest: string): Promise<string[]> {
  const fh = await open(zip, 'r')
  try {
    const input = fileInput(fh, (await fh.stat()).size)
    const dir = await readCentralDirectory(input)
    for (const e of dir.entries) {
      const start = await entryDataOffset(input, e)
      const raw = Buffer.alloc(e.compressedSize)
      await fh.read(raw, 0, raw.length, start)
      file(join(dest, ...e.name.split('/')), '')
      writeFileSync(join(dest, ...e.name.split('/')), e.method === 8 ? inflateRawSync(raw) : raw)
    }
    return dir.entries.map((e) => e.name)
  } finally {
    await fh.close()
  }
}

const orig = originals(join(tmp, 'Originale'))
const exported = file(join(tmp, 'Videos', 'Klassenfahrt 1080p.mp4'), `exported ${'e'.repeat(3000)}`)
const docs = join(tmp, 'Dokumente')
let themeTracks: ThemeTrack[]
let otherTracks: ThemeTrack[]
const projects = new Map<string, Project>()

function deps(extra: Partial<ArchiveDeps> = {}): ArchiveDeps {
  return {
    projects: { peek: async (id) => structuredClone(projects.get(id)!) },
    themeMusic: async () => themeTracks,
    exports: {
      jobsOf: async () => [
        { state: 'done', outPath: exported },
        { state: 'error', outPath: join(tmp, 'Videos', 'kaputt.mp4') },
        { state: 'done', outPath: join(tmp, 'Videos', 'geloescht.mp4') }
      ]
    },
    documentsDir: docs,
    appVersion: '1.2.0',
    now: () => NOW,
    freeSpace: async () => 500 * 1024 ** 3,
    ...extra
  }
}

const choice = (patch: Partial<ArchiveChoice> = {}): ArchiveChoice => ({ leftOut: false, withoutFaceData: false, videos: [], lang: 'de', ...patch })

beforeAll(() => {
  mkdirSync(docs, { recursive: true })
  themeTracks = themeFolder(join(tmp, 'app', 'theme-music'), 'theme song as bundled today')
  otherTracks = themeFolder(join(tmp, 'app-later', 'theme-music'), 'another song in a later version')
  projects.set('berlin-own', makeProject(orig, true))
  projects.set('berlin-theme', makeProject(orig, false))
})

describe('what goes into the archive', () => {
  it('the show: originals with Live Photo videos, unique names, own music; left-out items and missing originals stay out', async () => {
    const p = projects.get('berlin-own')!
    const plan = await planArchive(p, { leftOut: false, withoutFaceData: false }, { themeTracks, now: NOW })
    expect(plan.files.map((f) => [f.kind, f.rel])).toEqual([
      ['media', 'media/IMG_0001.JPG'],
      ['media', 'media/IMG_0001.MOV'],
      ['media', 'media/IMG_0001 (2).JPG'],
      ['media', 'media/Ausflug ins Grüne.mp4'],
      ['music', 'music/Lied.mp3']
    ])
    expect(plan.files[0].bytes).toBe(statSync(orig.day1).size)
    expect(plan.projectFile).toBe('Klassenfahrt Berlin.dshow')
    expect(plan.missing).toEqual([orig.gone])
    // like a packed project: relative paths, no cache paths; left-out slides are not in it
    expect(plan.project.entries.map((e) => e.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e5'])
    expect(plan.project.media.map((m) => m.path)).toEqual(['media/IMG_0001.JPG', 'media/IMG_0001 (2).JPG', 'media/Ausflug ins Grüne.mp4', orig.gone])
    expect(plan.project.media[0].live).toEqual({ source: 'media/IMG_0001.MOV', duration: 2.5 })
    for (const m of plan.project.media) {
      expect(m.status).toBe('pending')
      for (const key of ['thumb', 'display', 'playback', 'proxied']) expect(m).not.toHaveProperty(key)
    }
    expect(plan.project.music[0]).toMatchObject({ path: 'music/Lied.mp3', status: 'pending', beats: [0.5, 1] })
    expect(plan.project.music[0]).not.toHaveProperty('playback')
    // own music plays: no theme song
    expect(plan.themeSong).toBeUndefined()
    expect(ARCHIVED_THEME_SONG in plan.project).toBe(false)
    // face data stays unless asked otherwise
    expect(plan.project.people).toHaveLength(1)
    expect(plan.project.media[0].faces).toHaveLength(1)
    // the project itself is not changed
    expect(p.media[0].path).toBe(orig.day1)
  })

  it('with "include left-out items": those too, and their missing originals', async () => {
    const plan = await planArchive(projects.get('berlin-own')!, { leftOut: true, withoutFaceData: false }, { themeTracks, now: NOW })
    expect(plan.files.map((f) => f.rel)).toContain('media/IMG_0099.JPG')
    expect(plan.project.entries.map((e) => e.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'])
    expect(plan.missing.sort()).toEqual([orig.gone, orig.goneLeftOut].sort())
  })

  it('the theme song when the show plays one, with a note in the project', async () => {
    const plan = await planArchive(projects.get('berlin-theme')!, { leftOut: false, withoutFaceData: false }, { themeTracks, now: NOW })
    const theme = plan.files.find((f) => f.kind === 'theme')!
    expect(theme).toMatchObject({ rel: 'music/kenburns.m4a', src: themeTracks[0].path })
    const note = (plan.project as unknown as Record<string, unknown>)[ARCHIVED_THEME_SONG]
    expect(note).toMatchObject({ path: 'music/kenburns.m4a', song: 'kenburns', title: 'Morgenlicht', artist: 'Jemand', licence: 'CC0 1.0', duration: 90, beats: [0.5, 1, 1.5] })
    expect(readArchivedThemeSong(note)?.showSeconds).toBeGreaterThan(5)
    // the theme music setting stays as it is
    expect(plan.project.settings).toMatchObject({ themeMusic: true, themeSong: 'auto' })
  })

  it('without face data when asked: pixelation stays, faces and the people list go', async () => {
    const plan = await planArchive(projects.get('berlin-own')!, { leftOut: false, withoutFaceData: true }, { themeTracks, now: NOW })
    expect(plan.project.people).toBeUndefined()
    expect(plan.project.media.some((m) => m.faces || m.faceDesc)).toBe(false)
    expect(plan.project.faceDataRemovedAt).toBe(NOW)
  })

  it('a network share the user has not allowed counts as missing (it is never opened)', async () => {
    const plan = await planArchive(projects.get('berlin-own')!, { leftOut: false, withoutFaceData: false }, { themeTracks, now: NOW, allowPath: (p) => !p.endsWith('.mp4') })
    expect(plan.files.map((f) => f.rel)).not.toContain('media/Ausflug ins Grüne.mp4')
    expect(plan.missing).toContain(orig.video)
  })

  it('showOnly keeps text slides and drops what is left out', () => {
    const p = showOnly(projects.get('berlin-own')!)
    expect(p.entries.map((e) => e.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e5'])
    expect(p.media).toHaveLength(4)
  })
})

describe('the dialog', () => {
  it('lists the parts with sizes, the finished exports, missing originals and a target with the date', async () => {
    const inv = await archiveInventory(deps(), 'berlin-own')
    const size = (...paths: string[]): number => paths.reduce((n, p) => n + statSync(p).size, 0)
    expect(inv).toMatchObject({
      projectId: 'berlin-own',
      name: 'Klassenfahrt: Berlin',
      deleteAt: DELETE_AT,
      media: { files: 4, bytes: size(orig.day1, orig.day1Mov, orig.day2, orig.video) },
      leftOut: { files: 1, bytes: size(orig.blurry), items: 2 },
      music: { files: 1, bytes: size(orig.song) },
      faceData: true,
      target: join(docs, 'Klassenfahrt Berlin 2026-10-12.zip'),
      free: 500 * 1024 ** 3,
      // small: the drive's file system is not even asked
      maxFile: null
    })
    expect(inv.theme).toBeUndefined()
    // only finished exports whose files are there
    expect(inv.exports).toEqual([{ path: exported, name: 'Klassenfahrt 1080p.mp4', bytes: size(exported), fromQueue: true }])
    expect(inv.missing).toEqual([
      { name: 'fehlt.jpg', path: orig.gone, leftOut: false },
      { name: 'fehlt-auch.jpg', path: orig.goneLeftOut, leftOut: true }
    ])
    expect(inv.project.bytes).toBeGreaterThan(1000)
    // the total grows with left-out items and videos
    const base = archiveSize(inv, false, [])
    expect(archiveSize(inv, true, [])).toBe(base + inv.leftOut.bytes + 400)
    expect(archiveSize(inv, false, inv.exports)).toBe(base + inv.exports[0].bytes + 400)

    const theme = await archiveInventory(deps(), 'berlin-theme')
    expect(theme.theme).toEqual({ title: 'Morgenlicht', bytes: statSync(themeTracks[0].path).size })
    expect(theme.music).toEqual({ files: 0, bytes: 0 })
  })

  it('takes only offered videos and the renderer choice as it should be', async () => {
    const picked = join(tmp, 'Videos', 'Handyvideo.mov')
    file(picked, 'phone video')
    const d = deps()
    expect(await chosenVideos(d, 'berlin-own', [exported, picked, exported], new Set([picked.toLowerCase()]))).toEqual([
      { path: exported, name: 'Klassenfahrt 1080p.mp4', bytes: statSync(exported).size, fromQueue: true },
      { path: picked, name: 'Handyvideo.mov', bytes: statSync(picked).size, fromQueue: false }
    ])
    await expect(chosenVideos(d, 'berlin-own', [join(tmp, 'Originale', 'Tag 1', 'IMG_0001.JPG')], new Set())).rejects.toThrow(/not offered/)
    expect(checkArchiveChoice({ leftOut: 'yes', withoutFaceData: true, videos: [1, 'a.mp4', ''], lang: 'fr' })).toEqual({ leftOut: false, withoutFaceData: true, videos: ['a.mp4'], lang: 'de' })
    expect(defaultTarget('CON', docs, NOW)).toBe(join(docs, 'CON_ 2026-10-12.zip'))
  })
})

describe('writing, checking and opening the archive', () => {
  it('writes a checked ZIP that opens like a packed project; other tools read it', async () => {
    const target = join(tmp, 'USB', 'Klassenfahrt Berlin 2026-10-12.zip')
    mkdirSync(dirname(target), { recursive: true })
    const progress: ArchiveProgress[] = []
    const result = await writeArchive(deps(), 'berlin-own', choice({ videos: [exported] }), [{ path: exported, name: 'Klassenfahrt 1080p.mp4', bytes: statSync(exported).size, fromQueue: true }], target, {
      onProgress: (p) => progress.push(p)
    })
    expect(result).toMatchObject({ path: target, files: 8, media: 4, music: 1, videos: 1, theme: false, deleteAt: DELETE_AT, verified: { entries: 8, checked: 8 } })
    expect(result.missing).toEqual([{ name: 'fehlt.jpg', path: orig.gone }])
    expect(result.bytes).toBe(statSync(target).size)
    // no temp file stays
    expect(readdirSync(dirname(target))).toEqual(['Klassenfahrt Berlin 2026-10-12.zip'])
    expect(progress.some((p) => p.phase === 'write' && p.file === 'IMG_0001.JPG')).toBe(true)
    expect(progress.at(-1)).toMatchObject({ phase: 'verify' })
    expect(progress.at(-1)!.done).toBe(progress.at(-1)!.total)

    const dest = join(tmp, 'Entpackt')
    const names = await extract(target, dest)
    expect(names.sort()).toEqual(
      ['media/IMG_0001.JPG', 'media/IMG_0001.MOV', 'media/IMG_0001 (2).JPG', 'media/Ausflug ins Grüne.mp4', 'music/Lied.mp3', 'videos/Klassenfahrt 1080p.mp4', 'LIESMICH.txt', 'Klassenfahrt Berlin.dshow'].sort()
    )
    expect(readFileSync(join(dest, 'media', 'IMG_0001 (2).JPG'), 'utf8')).toBe('photo day 2')
    expect(readFileSync(join(dest, 'videos', 'Klassenfahrt 1080p.mp4'), 'utf8')).toBe(readFileSync(exported, 'utf8'))
    const readme = readFileSync(join(dest, 'LIESMICH.txt'), 'utf8')
    expect(readme.charCodeAt(0)).toBe(0xfeff)
    expect(readme).toContain('Diashow Studio 1.2.0')
    expect(readme).toContain('12. Oktober 2026')
    expect(readme).toContain('Löschfrist der 12. Januar 2027')
    expect(readme).toContain('fehlt.jpg')
    expect(readme).toContain('„Klassenfahrt Berlin.dshow“')
    expect(readme).toMatch(/\r\n/)

    if (PYTHON) {
      const py = pythonRead(target)
      expect(py.bad).toBeNull()
      expect([...py.names].sort()).toEqual([...names].sort())
      // media stored, text deflated
      expect(py.methods[py.names.indexOf('media/IMG_0001.JPG')]).toBe(0)
      expect(py.methods[py.names.indexOf('LIESMICH.txt')]).toBe(8)
    }
    if (hasTar) expect([...tarExtract(target, join(tmp, 'Entpackt-tar')).keys()].sort()).toEqual(names.sort())

    // "Open project…" on the extracted folder: every file found, ids of the copies
    const store = createProjectStore(join(tmp, 'projekte'))
    const p = await importProjectFile(join(dest, 'Klassenfahrt Berlin.dshow'), store, { themeTracks })
    expect(p.media.map((m) => m.path)).toEqual([join(dest, 'media', 'IMG_0001.JPG'), join(dest, 'media', 'IMG_0001 (2).JPG'), join(dest, 'media', 'Ausflug ins Grüne.mp4'), orig.gone])
    expect(p.media[0].live?.source).toBe(join(dest, 'media', 'IMG_0001.MOV'))
    expect(p.media[0].id).toBe(idOf(join(dest, 'media', 'IMG_0001.JPG')))
    expect(p.music[0]).toMatchObject({ path: join(dest, 'music', 'Lied.mp3'), id: idOf(join(dest, 'music', 'Lied.mp3')) })
    const ids = new Set(p.media.map((m) => m.id))
    expect(p.entries.filter((e) => e.type !== 'text' && !ids.has(e.mediaId))).toEqual([])
    expect(p.deleteAt).toBe(DELETE_AT)

    // the originals were only read
    expect(readFileSync(orig.day2, 'utf8')).toBe('photo day 2')
  })

  it('the theme song: kept as theme music while the app has the same song, the archived copy when it has another one', async () => {
    const target = join(tmp, 'Thema.zip')
    const result = await writeArchive(deps(), 'berlin-theme', choice({ lang: 'en' }), [], target)
    expect(result).toMatchObject({ theme: true, music: 0 })
    const dest = join(tmp, 'Thema')
    const names = await extract(target, dest)
    expect(names).toContain('music/kenburns.m4a')
    expect(names).toContain('README.txt')
    const readme = readFileSync(join(dest, 'README.txt'), 'utf8')
    expect(readme).toContain('the theme song “Morgenlicht” by Jemand (CC0 1.0)')
    expect(readme).toContain('Extract the ZIP archive first')
    expect(readme).toContain('12 January 2027')
    const dshow = join(dest, 'Klassenfahrt Berlin.dshow')
    const note = readArchivedThemeSong(JSON.parse(readFileSync(dshow, 'utf8'))[ARCHIVED_THEME_SONG])!
    expect(note.path).toBe('music/kenburns.m4a')

    // this app plays the very same song: theme music as it was, the note is gone
    const same = await importProjectFile(dshow, createProjectStore(join(tmp, 'p-same')), { themeTracks })
    expect(same.music).toEqual([])
    expect(same.settings).toMatchObject({ themeMusic: true, timing: { mode: 'fitToMusic' } })
    expect(ARCHIVED_THEME_SONG in same).toBe(false)
    const saved = JSON.parse(readFileSync(join(tmp, 'p-same', `${same.id}.dshow`), 'utf8'))
    expect(ARCHIVED_THEME_SONG in saved).toBe(false)

    // a later version with another song (or none): the archived copy plays, looped, the show as long as before
    for (const [label, tracks] of [['other', otherTracks], ['none', []]] as const) {
      const p = await importProjectFile(dshow, createProjectStore(join(tmp, `p-${label}`)), { themeTracks: tracks })
      expect(p.music, label).toHaveLength(1)
      expect(p.music[0]).toMatchObject({ path: join(dest, 'music', 'kenburns.m4a'), title: 'Morgenlicht', artist: 'Jemand', duration: 90, beats: [0.5, 1, 1.5], status: 'pending' })
      expect(p.music[0].id).toBe(idOf(join(dest, 'music', 'kenburns.m4a')))
      expect(p.settings.audio.repeatMusic).toBe(true)
      expect(p.settings.audio.crossfade).toBeGreaterThanOrEqual(3)
      expect(p.settings.timing.mode).toBe('custom')
      expect(p.settings.timing.customTotal).toBeCloseTo(note.showSeconds!, 1)
      expect(ARCHIVED_THEME_SONG in p).toBe(false)
    }
  })

  it('a .dshow double-clicked inside the ZIP (only it extracted to a temp folder) asks to extract first', async () => {
    const zip = join(tmp, 'Zip-Ansicht.zip')
    await writeArchive(deps(), 'berlin-own', choice(), [], zip)
    const full = join(tmp, 'Zip-Ansicht')
    await extract(zip, full)
    for (const folder of ['Temp1_Zip-Ansicht.zip', '7zO8A3F1C2B', 'Rar$DIa1234.5678']) {
      // Explorer, 7-Zip and WinRAR put the one file into such a folder
      const lone = join(tmp, 'AppTemp', folder, 'Klassenfahrt Berlin.dshow')
      file(lone, readFileSync(join(full, 'Klassenfahrt Berlin.dshow'), 'utf8'))
      const store = createProjectStore(join(tmp, `p-zipview-${folder.length}`))
      const err = await importProjectFile(lone, store, { themeTracks }).catch((e: unknown) => e)
      expect(String(err), folder).toMatch(/opened-from-zip/)
      expect(classifyError(err, 'project')).toBe('openedFromZip')
      expect(existsSync(store.dir)).toBe(false)
    }
    // extracted properly into such a folder name, it opens
    const whole = join(tmp, 'AppTemp', 'Temp1_Ganz.zip')
    await extract(zip, whole)
    const p = await importProjectFile(join(whole, 'Klassenfahrt Berlin.dshow'), createProjectStore(join(tmp, 'p-zipview-ok')), { themeTracks })
    expect(p.media[0].path).toBe(join(whole, 'media', 'IMG_0001.JPG'))
  })

  it('a note that points outside its folder is ignored; without the app catalogue it just goes', async () => {
    const p = { ...projects.get('berlin-theme')!, music: [], [ARCHIVED_THEME_SONG]: { path: '../../Windows/win.ini', title: 'x', duration: 5 } } as unknown as Project
    expect(readArchivedThemeSong((p as unknown as Record<string, unknown>)[ARCHIVED_THEME_SONG])).toBeNull()
    const out = await withArchivedThemeSong(p, tmp, otherTracks)
    expect(out.music).toEqual([])
    expect(ARCHIVED_THEME_SONG in out).toBe(false)
    expect(await sameContent(themeTracks[0].path, themeTracks[0].path)).toBe(true)
    expect(await sameContent(themeTracks[0].path, otherTracks[0].path)).toBe(false)
  })

  it('cancelling deletes the partial file and keeps an older archive', async () => {
    const dir = join(tmp, 'Abbruch')
    const target = file(join(dir, 'Klassenfahrt.zip'), 'an older archive')
    const ctrl = new AbortController()
    const run = writeArchive(deps(), 'berlin-own', choice(), [], target, { signal: ctrl.signal, onProgress: (p) => p.file === 'IMG_0001 (2).JPG' && ctrl.abort() })
    await expect(run).rejects.toThrow(/cancelled/)
    expect(readdirSync(dir)).toEqual(['Klassenfahrt.zip'])
    expect(readFileSync(target, 'utf8')).toBe('an older archive')
  })

  it('a full disk is refused before writing, with a friendly error', async () => {
    const dir = join(tmp, 'Voll')
    mkdirSync(dir)
    const err = await writeArchive(deps({ freeSpace: async () => 1000 }), 'berlin-own', choice(), [], join(dir, 'a.zip')).catch((e: unknown) => e)
    expect(String(err)).toMatch(/ENOSPC/)
    expect(classifyError(err, 'save')).toBe('diskFull')
    expect(readdirSync(dir)).toEqual([])
    expect(classifyError(new Error("EBUSY: resource busy or locked, open 'C:\\x.mp4'"), 'save')).toBe('fileLocked')
    expect(classifyError(new Error("ENOENT: no such file or directory, open 'C:\\x.mp4'"), 'save')).toBe('fileMissing')
  })

  it('asks for the FAT32 limit only for archives that may reach it', async () => {
    const asked: string[] = []
    const d = deps({ maxFileSize: async (path) => (asked.push(path), FAT_MAX_FILE) })
    const stick = join('E:', 'Archiv.zip')
    expect(await fileLimitFor(d, stick, 100 * 1024 ** 2)).toBeNull()
    expect(asked).toEqual([])
    expect(await fileLimitFor(d, stick, 5 * 1024 ** 3)).toBe(FAT_MAX_FILE)
    expect(asked).toEqual([stick])
    expect(classifyError(new Error('EFBIG: the archive (5000000000 bytes) is larger than the drive allows for one file (4294967295 bytes, FAT32)'), 'save')).toBe('fileTooLarge')
    // this PC's system drive is NTFS: no limit (asks Windows); a network share is not asked
    if (process.platform === 'win32') expect(await maxFileSizeOf(join(tmp, 'x.zip'))).toBeNull()
    expect(await maxFileSizeOf('//server/share/x.zip')).toBeNull()
  })

  it('refuses targets that are no .zip or one of its own files', async () => {
    await expect(writeArchive(deps(), 'berlin-own', choice(), [], join(tmp, 'a.rar'))).rejects.toThrow(/\.zip/)
    const sneaky = file(join(tmp, 'Videos', 'film.zip'), 'x')
    await expect(writeArchive(deps(), 'berlin-own', choice(), [{ path: sneaky, name: 'film.zip', bytes: 1, fromQueue: false }], sneaky)).rejects.toThrow(/own files/)
  })

  it('a file that vanishes while writing is skipped like a missing original', async () => {
    const o = originals(join(tmp, 'Wackelig'))
    projects.set('wobbly', { ...makeProject(o, true), id: 'wobbly' })
    const target = join(tmp, 'Wackelig.zip')
    const result = await writeArchive(deps(), 'wobbly', choice(), [], target, {
      onProgress: (p) => {
        // moved away while the archive is written (deleting may only mark it while a virus scanner reads it)
        if (p.file === 'IMG_0001.JPG' && existsSync(o.video)) renameSync(o.video, `${o.video}.weg`)
      }
    })
    expect(result.missing.map((m) => m.path).sort()).toEqual([o.gone, o.video].sort())
    expect(result.media).toBe(3)
    const dest = join(tmp, 'Wackelig-entpackt')
    const names = await extract(target, dest)
    expect(names).not.toContain('media/Ausflug ins Grüne.mp4')
    const archived = JSON.parse(readFileSync(join(dest, 'Klassenfahrt Berlin.dshow'), 'utf8')) as Project
    // it points to where the original was, like any missing original
    expect(archived.media.map((m) => m.path)).toContain(o.video)
    expect(readFileSync(join(dest, 'LIESMICH.txt'), 'utf8')).toContain('Ausflug ins Grüne.mp4')
  })

  it('"Pack project" still packs the same files', async () => {
    const out = join(tmp, 'Gepackt')
    mkdirSync(out)
    const dshow = await packProject(projects.get('berlin-own')!, out)
    const root = dirname(dshow)
    expect(readdirSync(join(root, 'media')).sort()).toEqual(['Ausflug ins Grüne.mp4', 'IMG_0001 (2).JPG', 'IMG_0001.JPG', 'IMG_0001.MOV', 'IMG_0099.JPG'].sort())
  })
})

describe('the read-me', () => {
  it('says what is in it, how to open it, and when to delete it', () => {
    const info = {
      name: 'Skilager',
      projectFile: 'Skilager.dshow',
      appVersion: '1.2.0',
      date: NOW,
      media: 120,
      music: 0,
      theme: { file: 'music/kenburns.m4a', title: 'Morgenlicht' },
      videos: ['Skilager 1080p.mp4'],
      leftOut: 'omitted' as const,
      faceData: 'removed' as const,
      missing: []
    }
    const de = readmeText(info, 'de')
    expect(de).toContain('media\\: 120 Fotos und Videos')
    expect(de).toContain('music\\kenburns.m4a: die Titelmusik „Morgenlicht“')
    expect(de).toContain('Aussortierte Fotos und Videos (nicht in der Diashow) sind nicht enthalten.')
    expect(de).toContain('Gesichtsdaten (erkannte Gesichter, Personenliste) sind nicht enthalten')
    expect(de).toContain('Alle extrahieren')
    expect(de).toContain('nach den Fristen deiner Schule')
    expect(de).toContain('Das Aufräumen in Diashow Studio erreicht es nicht')
    expect(de).not.toContain('Löschfrist der')
    const en = readmeText({ ...info, deleteAt: DELETE_AT, leftOut: 'included', faceData: 'kept' }, 'en')
    expect(en).toContain('The deletion date of this slideshow is 12 January 2027')
    expect(en).toContain('left out of the slideshow are included too')
    expect(en).toContain('Face data (detected faces, the people list with names) is included.')
  })
})
