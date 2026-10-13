// The trash for slideshows (src/main/trash.ts) on a synthetic app folder: a show moves in with its
// older versions, undo history, uploads, pasted pictures and export jobs; it is listed with its dates;
// restoring brings it back as it was, also after a restart; after 30 days (injected clock) it goes for
// good; emptying; never restoring over another show or file; busy files (Windows keeps a file open:
// the move waits, or is taken back); damaged entries (reported, never in the way); deleting only
// inside the trash folders; finishing what a crash interrupted.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Project } from '@shared/types'

// renames of a "busy" source fail like Windows does while another program holds the file
const busy = new Map<string, number>()
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      const key = resolve(from).toLowerCase()
      const left = busy.get(key) ?? 0
      if (left > 0) {
        busy.set(key, left - 1)
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}' -> '${to}'`), { code: 'EBUSY' })
      }
      return fs.rename(from, to)
    }
  }
})

const { createTrash, TrashRefusedError } = await import('../src/main/trash')
const { createProjectStore } = await import('../src/main/projects')
const { importProjectFile } = await import('../src/main/projectFile')

const tmp = mkdtempSync(join(tmpdir(), 'diashow-trash-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

const DAY = 86_400_000
const setBusy = (path: string, times: number): void => void busy.set(resolve(path).toLowerCase(), times)

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/** An app folder: projects in Documents, history, export jobs and the trash's second half in userData. */
function app(name: string) {
  const root = join(tmp, name)
  const docs = join(root, 'Diashow Studio')
  const userData = join(root, 'userData')
  const historyDir = join(userData, 'history')
  const exportsDir = join(userData, 'exports')
  const clock = { t: Date.now() }
  const logs: string[] = []
  const open = () => createTrash({ projectsDir: docs, dataDir: join(userData, 'trash'), historyDir, exportsDir, now: () => clock.t, log: (m) => logs.push(m), retry: { attempts: 3, delayMs: 1 } })
  return { root, docs, userData, historyDir, exportsDir, clock, logs, open, trash: open() }
}
type App = ReturnType<typeof app>

/** A show on disk: its .dshow (a pupil's upload and a pasted picture in it), two older versions, its undo history, an export job. */
function show(a: App, id: string, name = 'Klassenfahrt') {
  const upload = write(join(a.docs, 'Uploads', name, 'Mia', 'IMG_1.jpg'), `upload of ${id}`)
  const pasted = write(join(a.docs, 'Eingefügt', name, 'Bild 1.png'), `pasted into ${id}`)
  const photo = write(join(a.root, 'Bilder', `${id}.jpg`), 'the teacher’s photo')
  const media = (mid: string, path: string) => ({ id: mid, path, name: 'x.jpg', kind: 'photo' as const, format: 'JPEG', width: 10, height: 10, captureTime: 0, status: 'ready' as const })
  const project: Project = {
    version: 1,
    id,
    name,
    createdAt: 1,
    updatedAt: 2,
    entries: [
      { id: 'e1', type: 'photo', mediaId: 'a000000000000001' },
      { id: 'e2', type: 'photo', mediaId: 'a000000000000002' },
      { id: 'e3', type: 'photo', mediaId: 'a000000000000003' }
    ],
    media: [media('a000000000000001', upload), media('a000000000000002', pasted), media('a000000000000003', photo)],
    music: [],
    settings: structuredClone(DEFAULT_SETTINGS)
  }
  const file = write(join(a.docs, `${id}.dshow`), JSON.stringify(project, null, 1))
  const backups = [write(join(a.docs, '.backups', id, '20261001-100000.dshow'), JSON.stringify(project)), write(join(a.docs, '.backups', id, '20261001-110000.dshow'), JSON.stringify(project))]
  const history = write(join(a.historyDir, `${id}.json.gz`), `history of ${id}`)
  const job = write(join(a.exportsDir, `job-${id}`, 'job.json'), '{}')
  const move = { id, name, slideCount: 3, faces: true, files: [upload, pasted], jobs: [`job-${id}`] }
  return { id, project, file, text: readFileSync(file, 'utf8'), upload, pasted, photo, backups, history, job, move, all: [file, ...backups, history, job, upload, pasted] }
}

/** Every file below a folder (relative paths). */
function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort()
}

describe('moving a show into the trash', () => {
  it('takes its older versions, undo history, uploads and export jobs, and lists it with its dates', async () => {
    const a = app('move')
    const s = show(a, 'trip')
    const entry = await a.trash.moveIn({ ...s.move, deleteAt: Date.UTC(2026, 5, 1) })
    for (const f of s.all) expect(existsSync(f), f).toBe(false)
    // the teacher's own photo stays where it is
    expect(existsSync(s.photo)).toBe(true)
    // empty upload folders are pruned by the caller (cleanup.ts); the files are in the trash
    expect(filesIn(join(a.docs, '.trash', 'trip'))).toEqual([
      'backups\\20261001-100000.dshow',
      'backups\\20261001-110000.dshow',
      'files\\Eingefügt\\Klassenfahrt\\Bild 1.png',
      'files\\Uploads\\Klassenfahrt\\Mia\\IMG_1.jpg',
      'show.json',
      'trash.json'
    ])
    expect(filesIn(join(a.userData, 'trash', 'trip'))).toEqual(['exports\\job-trip\\job.json', 'history.json.gz'])
    expect(entry).toMatchObject({ id: 'trip', name: 'Klassenfahrt', deletedAt: a.clock.t, purgeAt: a.clock.t + 30 * DAY, deleteAt: Date.UTC(2026, 5, 1), slideCount: 3, versions: 2, uploads: 2, exports: 1, faces: true })
    const list = await a.trash.list()
    expect(list.entries).toEqual([entry])
    expect(list.problems).toEqual([])
    expect(list.bytes).toBe(entry.bytes)
    expect(entry.bytes).toBeGreaterThan(s.text.length)
  })

  it('is no show any more: not listed, not saved again, an imported copy gets another id', async () => {
    const a = app('gone')
    const s = show(a, 'trip')
    const store = createProjectStore(a.docs, { inTrash: (id) => a.trash.has(id) })
    await a.trash.moveIn(s.move)
    expect(await store.list()).toEqual([])
    expect(await store.damaged()).toEqual([])
    expect(await a.trash.has('trip')).toBe(true)
    // a late save from a window that still had it open
    await expect(store.save(s.project)).rejects.toThrow(/in the trash/)
    expect(existsSync(s.file)).toBe(false)
    // its file, opened from elsewhere (a USB stick), comes in as another show
    const copy = write(join(a.root, 'USB', 'trip.dshow'), s.text)
    const imported = await importProjectFile(copy, store)
    expect(imported.id).not.toBe('trip')
    // other shows save as usual
    await store.save({ ...s.project, id: 'other' })
    expect((await store.list()).map((p) => p.id).sort()).toEqual([imported.id, 'other'].sort())
  })
})

describe('restoring', () => {
  it('brings everything back as it was, also after a restart', async () => {
    const a = app('restore')
    const s = show(a, 'trip')
    await a.trash.moveIn(s.move)
    // a new start of the app
    const trash = a.open()
    expect((await trash.list()).entries.map((e) => e.id)).toEqual(['trip'])
    const r = await trash.restore('trip')
    expect(r).toEqual({ id: 'trip', name: 'Klassenfahrt', renamed: 0, history: true, jobs: ['job-trip'] })
    for (const f of s.all) expect(existsSync(f), f).toBe(true)
    // byte for byte: its undo history (anchored to the file's text) still fits
    expect(readFileSync(s.file, 'utf8')).toBe(s.text)
    expect(readFileSync(s.history, 'utf8')).toBe('history of trip')
    expect(readFileSync(s.upload, 'utf8')).toBe('upload of trip')
    expect(await trash.list()).toEqual({ entries: [], problems: [], bytes: 0 })
    expect(readdirSync(trash.dir)).toEqual([])
    expect(readdirSync(trash.dataDir)).toEqual([])
    expect(await trash.has('trip')).toBe(false)
    const store = createProjectStore(a.docs, { inTrash: (id) => trash.has(id) })
    await store.save(s.project)
    expect((await store.listBackups('trip')).length).toBe(2)
  })

  it('never over another show: a taken id is refused and nothing moves', async () => {
    const a = app('taken')
    const s = show(a, 'trip')
    await a.trash.moveIn(s.move)
    write(s.file, '{"another":"show"}')
    await expect(a.trash.restore('trip')).rejects.toMatchObject({ code: 'id-taken' })
    expect(readFileSync(s.file, 'utf8')).toBe('{"another":"show"}')
    expect(existsSync(s.upload)).toBe(false)
    expect((await a.trash.list()).entries.map((e) => e.id)).toEqual(['trip'])
    // older versions of another show under that id: the same
    rmSync(s.file)
    write(join(a.docs, '.backups', 'trip', '20261005-100000.dshow'), '{}')
    await expect(a.trash.restore('trip')).rejects.toBeInstanceOf(TrashRefusedError)
    rmSync(join(a.docs, '.backups', 'trip'), { recursive: true })
    // free again: it comes back
    await a.trash.restore('trip')
    expect(readFileSync(s.file, 'utf8')).toBe(s.text)
    expect(await a.trash.restore('trip').catch((e: InstanceType<typeof TrashRefusedError>) => e.code)).toBe('not-found')
  })

  it('an upload whose place is taken comes back under a free name; the show and its versions follow, the history goes', async () => {
    const a = app('renamed')
    const s = show(a, 'trip')
    await a.trash.moveIn(s.move)
    // meanwhile a pupil of another show with the same name sent a file with the same name
    write(s.upload, 'someone else')
    const r = await a.trash.restore('trip')
    expect(r).toMatchObject({ renamed: 1, history: false })
    const moved = join(dirname(s.upload), 'IMG_1 (2).jpg')
    expect(readFileSync(s.upload, 'utf8')).toBe('someone else')
    expect(readFileSync(moved, 'utf8')).toBe('upload of trip')
    for (const f of [s.file, ...s.backups]) {
      const p = JSON.parse(readFileSync(f, 'utf8')) as Project
      expect(p.media.map((m) => m.path)).toEqual([moved, s.pasted, s.photo])
    }
    expect(existsSync(s.history)).toBe(false)
    expect(readdirSync(a.trash.dataDir)).toEqual([])
  })
})

describe('deleting for good', () => {
  it('after 30 days, not before (injected clock), at the start or later', async () => {
    const a = app('expire')
    const s = show(a, 'trip')
    const t0 = a.clock.t
    await a.trash.moveIn(s.move)
    a.clock.t = t0 + 30 * DAY - 1
    expect(await a.trash.expire()).toEqual([])
    expect((await a.trash.list()).entries).toHaveLength(1)
    a.clock.t = t0 + 30 * DAY
    expect(await a.open().expire()).toEqual(['trip'])
    expect(readdirSync(join(a.docs, '.trash'))).toEqual([])
    expect(readdirSync(join(a.userData, 'trash'))).toEqual([])
    for (const f of s.all) expect(existsSync(f), f).toBe(false)
    expect(existsSync(s.photo)).toBe(true)
    expect(a.logs.some((m) => m.includes('trip deleted for good'))).toBe(true)
  })

  it('empties the trash: every show and what can’t be read', async () => {
    const a = app('empty')
    const one = show(a, 'one', 'Eins')
    const two = show(a, 'two', 'Zwei')
    await a.trash.moveIn(one.move)
    await a.trash.moveIn(two.move)
    write(join(a.docs, '.trash', 'broken', 'trash.json'), '{nope')
    const before = await a.trash.list()
    expect(before.entries.map((e) => e.name)).toEqual(['Eins', 'Zwei'])
    expect(before.problems.map((p) => p.key)).toEqual(['broken'])
    const r = await a.trash.empty()
    expect(r.failed).toEqual([])
    expect(r.bytes).toBe(before.bytes)
    expect(readdirSync(join(a.docs, '.trash'))).toEqual([])
    expect(readdirSync(join(a.userData, 'trash'))).toEqual([])
    expect(await a.trash.list()).toEqual({ entries: [], problems: [], bytes: 0 })
  })

  it('only inside the trash folders: a junction is removed, never followed; keys can’t lead out', async () => {
    const a = app('inside')
    const s = show(a, 'trip')
    await a.trash.moveIn(s.move)
    const outside = write(join(a.root, 'Bilder', 'Klasse', 'kind.jpg'), 'keep me')
    symlinkSync(dirname(outside), join(a.docs, '.trash', 'trip', 'files', 'link'), 'junction')
    await a.trash.purge('trip')
    expect(readFileSync(outside, 'utf8')).toBe('keep me')
    expect(readdirSync(join(a.docs, '.trash'))).toEqual([])
    for (const key of ['..', '.', 'a\\b', 'a/b', 'C:x', '']) await expect(a.trash.purge(key)).rejects.toThrow(/invalid/)
    expect(existsSync(a.docs)).toBe(true)
    // a description that points outside the projects folder is no show to restore
    write(
      join(a.docs, '.trash', 'evil', 'trash.json'),
      JSON.stringify({ format: 'diashow-trash', version: 1, id: 'evil', name: 'x', state: 'trashed', deletedAt: 1, purgeAt: 2, items: [{ kind: 'show' }, { kind: 'file', path: '..\\..\\Bilder\\Klasse\\kind.jpg' }] })
    )
    expect((await a.trash.list()).problems.map((p) => p.key)).toEqual(['evil'])
    await expect(a.trash.restore('evil')).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('busy files', () => {
  it('a file Windows keeps busy for a moment is waited for', async () => {
    const a = app('busy-short')
    const s = show(a, 'trip')
    setBusy(s.file, 2)
    await a.trash.moveIn(s.move)
    expect(existsSync(s.file)).toBe(false)
    setBusy(join(a.trash.dir, 'trip', 'show.json'), 2)
    await a.trash.restore('trip')
    expect(readFileSync(s.file, 'utf8')).toBe(s.text)
  })

  it('a file that stays busy: the move is taken back, the show stays as it was', async () => {
    const a = app('busy-long')
    const s = show(a, 'trip')
    setBusy(s.pasted, 99)
    await expect(a.trash.moveIn(s.move)).rejects.toMatchObject({ code: 'EBUSY' })
    busy.clear()
    for (const f of s.all) expect(existsSync(f), f).toBe(true)
    expect(readFileSync(s.file, 'utf8')).toBe(s.text)
    expect(await a.trash.list()).toEqual({ entries: [], problems: [], bytes: 0 })
    expect(await a.trash.has('trip')).toBe(false)
    expect(a.logs.some((m) => m.includes('not moved to the trash'))).toBe(true)
    // and a restore whose show stays busy: everything goes back into the trash, to be restored later
    await a.trash.moveIn(s.move)
    setBusy(join(a.trash.dir, 'trip', 'show.json'), 99)
    await expect(a.trash.restore('trip')).rejects.toMatchObject({ code: 'EBUSY' })
    busy.clear()
    expect(existsSync(s.upload)).toBe(false)
    expect((await a.trash.list()).entries.map((e) => e.id)).toEqual(['trip'])
    await a.trash.restore('trip')
    for (const f of s.all) expect(existsSync(f), f).toBe(true)
  })
})

describe('damaged entries and crashes', () => {
  it('what can’t be read is reported and never blocks the list; it goes after its days or when deleted', async () => {
    const a = app('damaged')
    const s = show(a, 'trip')
    await a.trash.moveIn(s.move)
    write(join(a.docs, '.trash', 'broken', 'trash.json'), '{nope')
    write(join(a.docs, '.trash', 'no description', 'show.json'), '{}')
    write(join(a.userData, 'trash', 'orphan', 'history.json.gz'), 'old history')
    const list = await a.trash.list()
    expect(list.entries.map((e) => e.id)).toEqual(['trip'])
    expect(list.problems.map((p) => p.key).sort()).toEqual(['broken', 'no description', 'orphan'])
    expect(list.problems.every((p) => p.bytes > 0)).toBe(true)
    expect(a.logs.filter((m) => m.includes('ignored'))).toHaveLength(3)
    // listed again: not logged again
    await a.trash.list()
    expect(a.logs.filter((m) => m.includes('ignored'))).toHaveLength(3)
    await expect(a.trash.restore('broken')).rejects.toMatchObject({ code: 'not-found' })
    await a.trash.purge('broken')
    // the others go by the time they were last changed
    const old = new Date(a.clock.t - 31 * DAY)
    utimesSync(join(a.docs, '.trash', 'no description'), old, old)
    expect(await a.trash.expire()).toEqual(['no description'])
    a.clock.t += 31 * DAY
    expect((await a.trash.expire()).sort()).toEqual(['orphan', 'trip'])
    expect(readdirSync(join(a.docs, '.trash'))).toEqual([])
    expect(readdirSync(join(a.userData, 'trash'))).toEqual([])
  })

  it('after a crash a half-done move goes back, a restore or a purge is finished', async () => {
    const a = app('crash')
    const setState = (id: string, state: string): void => {
      const path = join(a.docs, '.trash', id, 'trash.json')
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), state }))
    }
    const moving = show(a, 'moving', 'Eins')
    const restoring = show(a, 'restoring', 'Zwei')
    const purging = show(a, 'purging', 'Drei')
    for (const s of [moving, restoring, purging]) await a.trash.moveIn(s.move)
    setState('moving', 'moving')
    setState('restoring', 'restoring')
    setState('purging', 'purging')
    // under way: not listed as shows
    expect((await a.trash.list()).entries).toEqual([])
    const trash = a.open()
    await trash.recover()
    for (const f of [...moving.all, ...restoring.all]) expect(existsSync(f), f).toBe(true)
    expect(readFileSync(moving.file, 'utf8')).toBe(moving.text)
    for (const f of purging.all) expect(existsSync(f), f).toBe(false)
    expect(readdirSync(join(a.docs, '.trash'))).toEqual([])
    expect(readdirSync(join(a.userData, 'trash'))).toEqual([])
    expect(await trash.has('moving')).toBe(false)
  })
})
