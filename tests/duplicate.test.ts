// "Duplizieren" (src/shared/duplicate.ts, src/main/duplicate.ts): the copy's name, what it holds, the
// copy on disk (new id, no older versions, no undo history), and the pupils' uploads both shows use:
// the clean-up and the trash of one never take what the other uses, also while that one lies in the
// trash, and the last show that used them takes them along when it is deleted for good (releaseShared).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type MediaItem, type Project, type Rect } from '@shared/types'
import { copyName, duplicateProject } from '@shared/duplicate'
import { inventoryOf, releaseShared, runCleanup, scanProject, trashProjectData, type CleanupDeps } from '../src/main/cleanup'
import { copyWord, duplicateShow } from '../src/main/duplicate'
import { mediaId } from '../src/main/media/scan'
import { createProjectStore } from '../src/main/projects'
import { createTrash } from '../src/main/trash'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-duplicate-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

const axis = (k: number): number[] => Array.from({ length: 128 }, (_, i) => (i === k ? 1 : 0))
const FACE: Rect = { x: 0.2, y: 0.3, w: 0.1, h: 0.15 }
const AREA: Rect = { x: 0.05, y: 0.05, w: 0.1, h: 0.1 }

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/** A photo as an import makes it: its id from its path, size and time (media/scan.ts). */
function photo(path: string, extra: Partial<MediaItem> = {}): MediaItem {
  const st = statSync(path)
  return { id: mediaId(path, st.size, st.mtimeMs), path, name: basename(path), kind: 'photo', format: 'JPEG', width: 1600, height: 900, captureTime: 0, status: 'ready', ...extra }
}

/**
 * An app folder with the show "Klassenfahrt": the teacher's photo, Mia's upload in the show and Ben's
 * upload left out; face data, a person, pixelation, a caption and a deletion date.
 */
function app(name: string) {
  const root = join(tmp, name)
  const docs = join(root, 'Diashow Studio')
  const userData = join(root, 'userData')
  const exportsDir = join(userData, 'exports')
  const uploadsRoot = join(docs, 'Uploads')
  const pasted = join(docs, 'Eingefügt')
  const trash = createTrash({ projectsDir: docs, dataDir: join(userData, 'trash'), historyDir: join(userData, 'history'), exportsDir })
  const projects = createProjectStore(docs, { inTrash: (id) => trash.has(id) })
  const deps: CleanupDeps = {
    projects,
    cacheDir: join(userData, 'cache'),
    uploadsRoot,
    pastedRoots: [pasted],
    exportsDir,
    media: { forgetFaces: async () => {}, releaseCache: (ids) => ids },
    exports: { jobsOf: async () => [], forget: async () => {} },
    trash
  }
  const teacher = write(join(root, 'Bilder', 'trip.jpg'), 'the teacher’s photo')
  const mia = write(join(uploadsRoot, 'Klassenfahrt', 'Mia', 'IMG_1.jpg'), 'Mia’s photo')
  const ben = write(join(uploadsRoot, 'Klassenfahrt', 'Ben', 'IMG_2.jpg'), 'Ben’s photo')
  const media = [photo(teacher, { faces: [FACE], faceDesc: [axis(3)] }), photo(mia), photo(ben)]
  const show: Project = {
    version: 1,
    id: 'showA',
    name: 'Klassenfahrt',
    createdAt: 1,
    updatedAt: 2,
    entries: [
      { id: 'title', type: 'text', title: 'Klassenfahrt' },
      { id: 'e1', type: 'photo', mediaId: media[0].id, privacy: [AREA], caption: 'Am Brandenburger Tor' },
      { id: 'e2', type: 'photo', mediaId: media[1].id },
      { id: 'e3', type: 'photo', mediaId: media[2].id, excluded: true }
    ],
    media,
    music: [],
    settings: { ...structuredClone(DEFAULT_SETTINGS), theme: 'magazine' },
    people: [{ id: 'lena', name: 'Lena', desc: [axis(3)] }],
    deleteAt: Date.UTC(2027, 6, 1)
  }
  write(join(docs, 'showA.dshow'), JSON.stringify(show, null, 1))
  /** Deletes a show in the trash for good, as the trash's IPC does (cleanupMain.ts). */
  const purge = async (id: string): Promise<number> => {
    const before = await trash.media()
    await trash.purge(id)
    return releaseShared(deps, before)
  }
  return { root, docs, userData, uploadsRoot, pasted, trash, projects, deps, teacher, mia, ben, show, purge }
}

describe('copy names', () => {
  it('"(Kopie)", then "(Kopie 2)" …; a copy of a copy counts on from the original name', () => {
    expect(copyName('Klassenfahrt', [], 'Kopie')).toBe('Klassenfahrt (Kopie)')
    expect(copyName('Klassenfahrt', ['Klassenfahrt', 'Klassenfahrt (Kopie)'], 'Kopie')).toBe('Klassenfahrt (Kopie 2)')
    // case and spaces don't make a name free
    expect(copyName('Klassenfahrt', ['klassenfahrt  (KOPIE)', 'Klassenfahrt (Kopie 2)'], 'Kopie')).toBe('Klassenfahrt (Kopie 3)')
    expect(copyName('Klassenfahrt (Kopie)', ['Klassenfahrt', 'Klassenfahrt (Kopie)'], 'Kopie')).toBe('Klassenfahrt (Kopie 2)')
    expect(copyName('Klassenfahrt (Kopie 2)', ['Klassenfahrt (Kopie)', 'Klassenfahrt (Kopie 2)'], 'Kopie')).toBe('Klassenfahrt (Kopie 3)')
    // parentheses of the name itself stay
    expect(copyName('Berlin (2026)', [], 'Kopie')).toBe('Berlin (2026) (Kopie)')
    expect(copyName('Field trip', ['Field trip (Copy)'], 'Copy')).toBe('Field trip (Copy 2)')
    expect(copyName('', [], 'Kopie')).toBe('(Kopie)')
  })

  it('takes the word from the renderer as plain, short text', () => {
    expect(copyWord('Kopie')).toBe('Kopie')
    expect(copyWord(' Ko(pie)\n')).toBe('Kopie')
    expect(copyWord('x'.repeat(80))).toHaveLength(30)
    expect(copyWord(5)).toBe('Copy')
    expect(copyWord('()')).toBe('Copy')
  })
})

describe('what a copy holds', () => {
  it('everything the show holds, as an independent copy; only the id, the name and its times are new', () => {
    const a = app('holds')
    const copy = duplicateProject(a.show, 'copy-1', 'Klassenfahrt (Kopie)', 1234)
    const { id, name, createdAt, updatedAt, ...rest } = copy
    const { id: _i, name: _n, createdAt: _c, updatedAt: _u, ...original } = a.show
    expect([id, name, createdAt, updatedAt]).toEqual(['copy-1', 'Klassenfahrt (Kopie)', 1234, 1234])
    // slides, captions, pixelation, settings, music, people and face data, the deletion date; the
    // title slide keeps showing the original's name, not "(Kopie)"
    expect(rest).toEqual({ ...original, settings: { ...original.settings, titleText: 'Klassenfahrt' } })
    expect(a.show.settings.titleText).toBeUndefined()
    // a title of its own stays as it is
    const titled = { ...a.show, settings: { ...a.show.settings, titleText: 'Berlin 2026' } }
    expect(duplicateProject(titled, 'copy-2', 'Klassenfahrt (Kopie)', 1).settings.titleText).toBe('Berlin 2026')
    expect(copy.deleteAt).toBe(a.show.deleteAt)
    expect(copy.people).toEqual(a.show.people)
    expect(copy.media[0].faceDesc).toEqual(a.show.media[0].faceDesc)
    // changing the copy doesn't change the show
    const e1 = copy.entries[1]
    if (e1.type === 'photo') e1.privacy!.push(FACE)
    copy.settings.theme = 'classic'
    copy.people![0].name = 'Mia'
    copy.media[0].faces!.push(AREA)
    expect(a.show.entries[1]).toMatchObject({ privacy: [AREA] })
    expect(a.show.settings.theme).toBe('magazine')
    expect(a.show.people![0].name).toBe('Lena')
    expect(a.show.media[0].faces).toEqual([FACE])
  })
})

describe('duplicating a show on disk', () => {
  it('writes the copy under a new id, without older versions or undo history; the original stays as it was', async () => {
    const a = app('disk')
    const before = readFileSync(join(a.docs, 'showA.dshow'), 'utf8')
    mkdirSync(join(a.docs, '.backups', 'showA'), { recursive: true })
    writeFileSync(join(a.docs, '.backups', 'showA', '20260101-120000.dshow'), before)
    const original = await a.projects.peek('showA')
    const copy = await duplicateShow(a.projects, 'showA', 'Kopie')
    expect(copy.id).not.toBe('showA')
    expect(copy.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(copy.name).toBe('Klassenfahrt (Kopie)')
    expect(copy.createdAt).toBeGreaterThan(original.createdAt)
    expect(await a.projects.peek(copy.id)).toEqual(copy)
    expect({ ...copy, id: 'showA', name: 'Klassenfahrt', createdAt: 1, updatedAt: 2 }).toEqual({ ...original, settings: { ...original.settings, titleText: 'Klassenfahrt' } })
    expect(copy.deleteAt).toBe(a.show.deleteAt)
    expect(existsSync(join(a.docs, '.backups', copy.id))).toBe(false)
    expect(existsSync(join(a.userData, 'history'))).toBe(false)
    expect(readFileSync(join(a.docs, 'showA.dshow'), 'utf8')).toBe(before)
    expect((await a.projects.list()).map((p) => p.name).sort()).toEqual(['Klassenfahrt', 'Klassenfahrt (Kopie)'])

    // again, and a copy of the copy: the next free names
    expect((await duplicateShow(a.projects, 'showA', 'Kopie')).name).toBe('Klassenfahrt (Kopie 2)')
    expect((await duplicateShow(a.projects, copy.id, 'Kopie')).name).toBe('Klassenfahrt (Kopie 3)')
    // changing a copy leaves the original alone
    await a.projects.save({ ...copy, settings: { ...copy.settings, theme: 'classic' }, entries: copy.entries.slice(0, 2) })
    expect(readFileSync(join(a.docs, 'showA.dshow'), 'utf8')).toBe(before)

    // a show that can't be read isn't copied
    writeFileSync(join(a.docs, 'broken.dshow'), '{"id":"broken","name":"Kaputt","entr')
    await expect(duplicateShow(a.projects, 'broken', 'Kopie')).rejects.toThrow()
    expect((await a.projects.list()).length).toBe(4)
  })
})

describe('uploads a show and its copy share', () => {
  it('the clean-up of one keeps what the other uses', async () => {
    const a = app('cleanup')
    const original = await a.projects.peek('showA')
    const copy = await duplicateShow(a.projects, 'showA', 'Kopie')
    // the copy leaves Mia's photo out, and has a pasted picture of its own
    const own = write(join(a.pasted, 'Klassenfahrt (Kopie)', 'Bild 1.png'), 'pasted into the copy')
    const ownItem = photo(own)
    const changed: Project = {
      ...copy,
      entries: [...copy.entries.map((e) => (e.id === 'e2' ? { ...e, excluded: true } : e)), { id: 'p1', type: 'photo', mediaId: ownItem.id }],
      media: [...copy.media, ownItem]
    }
    await a.projects.save(changed)
    const inv = inventoryOf(await scanProject(a.deps, copy.id))
    expect(inv.uploads.shared).toBe(2)
    expect(inv.uploads.files).toBe(1)

    // only what is not in the show: Mia's and Ben's photos are the original's too
    let result = await runCleanup(a.deps, copy.id, { faces: false, uploads: 'leftOut', caches: false, backups: false, exports: false })
    expect(result.removed.uploads.files).toBe(0)
    for (const f of [a.mia, a.ben, own]) expect(existsSync(f), f).toBe(true)
    // everything: only the copy's own pasted picture goes
    result = await runCleanup(a.deps, copy.id, { faces: false, uploads: 'all', caches: false, backups: false, exports: false })
    expect(result.removed.uploads.files).toBe(1)
    expect(existsSync(own)).toBe(false)
    for (const f of [a.mia, a.ben, a.teacher]) expect(existsSync(f), f).toBe(true)
    // the copy keeps its slides of the shared photos; the original is untouched
    expect((await a.projects.peek(copy.id)).entries.map((e) => e.id)).toEqual(['title', 'e1', 'e2', 'e3'])
    expect(await a.projects.peek('showA')).toEqual(original)
  })

  it('the trash of one leaves the other working, also from the trash; the last one takes them along', async () => {
    const a = app('trash')
    const copy = await duplicateShow(a.projects, 'showA', 'Kopie')
    // a photo only the original uses
    const only = write(join(a.uploadsRoot, 'Klassenfahrt', 'Mia', 'IMG_3.jpg'), 'only in the original')
    const onlyItem = photo(only)
    await a.projects.save({ ...a.show, entries: [...a.show.entries, { id: 'e4', type: 'photo', mediaId: onlyItem.id }], media: [...a.show.media, onlyItem] })

    // the original goes into the trash: what the copy uses stays in place, its own photo goes along
    const moved = await trashProjectData(a.deps, 'showA')
    if (!('entry' in moved)) throw new Error('refused')
    expect(moved.entry.uploads).toBe(1)
    expect(existsSync(only)).toBe(false)
    for (const f of [a.mia, a.ben]) expect(existsSync(f), f).toBe(true)
    expect((await a.projects.peek(copy.id)).media.map((m) => m.path)).toEqual([a.teacher, a.mia, a.ben])

    // the copy's clean-up takes nothing the original in the trash uses
    const inv = inventoryOf(await scanProject(a.deps, copy.id))
    expect(inv.uploads).toMatchObject({ files: 0, shared: 2 })
    const result = await runCleanup(a.deps, copy.id, { faces: false, uploads: 'all', caches: false, backups: false, exports: false })
    expect(result.removed.uploads.files).toBe(0)
    for (const f of [a.mia, a.ben]) expect(existsSync(f), f).toBe(true)

    // the copy into the trash too: the shared photos stay in place for the original
    const second = await trashProjectData(a.deps, copy.id)
    if (!('entry' in second)) throw new Error('refused')
    expect(second.entry.uploads).toBe(0)
    for (const f of [a.mia, a.ben]) expect(existsSync(f), f).toBe(true)
    expect([...(await a.trash.media()).keys()].sort()).toEqual([copy.id, 'showA'].sort())

    // the original comes back as it was, with every photo
    await a.trash.restore('showA')
    for (const f of [a.mia, a.ben, only]) expect(existsSync(f), f).toBe(true)
    expect((await a.projects.peek('showA')).media.map((m) => m.path)).toEqual([a.teacher, a.mia, a.ben, only])
    expect((await trashProjectData(a.deps, 'showA')) as object).toHaveProperty('entry')

    // a pupil sends another IMG_3.jpg meanwhile: it lies where the original's was, but it is another file
    write(only, 'a new photo, not the original’s')
    // the original deleted for good: the copy in the trash still uses the shared photos
    expect(await a.purge('showA')).toBe(0)
    for (const f of [a.mia, a.ben, only, a.teacher]) expect(existsSync(f), f).toBe(true)
    // the copy deleted for good: it was the last one using them, they go with it (and Ben's folder)
    expect(await a.purge(copy.id)).toBe(2)
    for (const f of [a.mia, a.ben]) expect(existsSync(f), f).toBe(false)
    expect(existsSync(join(a.uploadsRoot, 'Klassenfahrt', 'Ben'))).toBe(false)
    expect(readdirSync(join(a.uploadsRoot, 'Klassenfahrt', 'Mia'))).toEqual(['IMG_3.jpg'])
    // the teacher's own photo is never touched
    expect(existsSync(a.teacher)).toBe(true)
    expect((await a.trash.list()).entries).toEqual([])
  })

  it('a shared upload stays while an open show still uses it when the other is deleted for good', async () => {
    const a = app('open')
    const copy = await duplicateShow(a.projects, 'showA', 'Kopie')
    expect((await trashProjectData(a.deps, copy.id)) as object).toHaveProperty('entry')
    expect(await a.purge(copy.id)).toBe(0)
    for (const f of [a.mia, a.ben]) expect(existsSync(f), f).toBe(true)
    expect((await a.projects.list()).map((p) => p.id)).toEqual(['showA'])
  })
})
