// The trash for slideshows (src/main/trash.ts) on a synthetic app folder: a show moves in with its
// older versions, undo history, uploads, pasted pictures and export jobs; it is listed with its dates;
// restoring brings it back as it was, also after a restart; after 30 days (injected clock) it goes for
// good; emptying; never restoring over another show or file; busy files (Windows keeps a file open:
// the move waits, or is taken back); damaged entries (reported, never in the way); deleting only
// inside the trash folders; finishing what a crash interrupted.
//
// A crash or power cut at any moment: the move, a restore (with and without renamed uploads, and one
// taken back), deleting for good, emptying and the expiry, with uploads shared between shows, are cut
// off at each of their changes on disk (and their recovery too); a new start must end in one of the
// states the operation passes through cleanly (nothing lost, nothing left over, the show's paths right,
// shared uploads released exactly when no show uses them). And the expiry, restores and deletions at
// the same moment (cleanupMain.ts: one queue).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type MediaItem, type Project } from '@shared/types'
import type { Trash } from '../src/main/trash'

// renames of a "busy" source fail like Windows does while another program holds the file
const busy = new Map<string, number>()

/**
 * A crash or power cut: once armed, the `at`-th change on disk (a rename, a write, a deletion, a new
 * folder, a file's time) is cut off (a write half done) and every change after it fails, until the
 * app starts again (disarm). `trace` names the changes, for the messages.
 */
const crash = { armed: false, at: Infinity, changes: 0, dead: false, trace: [] as string[] }
const powerCut = (): Error => Object.assign(new Error('ECRASH: the power went off'), { code: 'ECRASH' })
/** Counts a change on disk; true when it is the one the power cut stops. */
function cutOff(what: string, path: unknown): boolean {
  if (crash.dead) throw powerCut()
  if (!crash.armed) return false
  crash.changes++
  crash.trace.push(`${what} ${basename(String(path))}`)
  if (crash.changes < crash.at) return false
  crash.dead = true
  return true
}
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const guard =
    <A extends unknown[], R>(what: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (cutOff(what, args[0])) throw powerCut()
      return fn(...args)
    }
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (cutOff('rename', from)) throw powerCut()
      const key = resolve(from).toLowerCase()
      const left = busy.get(key) ?? 0
      if (left > 0) {
        busy.set(key, left - 1)
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}' -> '${to}'`), { code: 'EBUSY' })
      }
      return fs.rename(from, to)
    },
    writeFile: async (path: string, data: string, options?: unknown) => {
      if (cutOff('write', path)) {
        // half written when the power went off
        await fs.writeFile(path, String(data).slice(0, String(data).length >> 1))
        throw powerCut()
      }
      return fs.writeFile(path, data, options as Parameters<typeof fs.writeFile>[2])
    },
    mkdir: guard('mkdir', fs.mkdir),
    rm: guard('rm', fs.rm),
    rmdir: guard('rmdir', fs.rmdir),
    // a busy file can't be deleted either
    unlink: async (path: string) => {
      if (cutOff('unlink', path)) throw powerCut()
      const key = resolve(path).toLowerCase()
      const left = busy.get(key) ?? 0
      if (left > 0) {
        busy.set(key, left - 1)
        throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: 'EBUSY' })
      }
      return fs.unlink(path)
    },
    utimes: guard('utimes', fs.utimes),
    chmod: guard('chmod', fs.chmod)
  }
})

const { createTrash, TrashRefusedError } = await import('../src/main/trash')
const { createProjectStore } = await import('../src/main/projects')
const { importProjectFile } = await import('../src/main/projectFile')
const { mediaId } = await import('../src/main/media/scan')
const { releaseMedia } = await import('../src/main/cleanup')
const { createTrashOps } = await import('../src/main/cleanupMain')

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
    expect(r).toEqual({ id: 'trip', name: 'Klassenfahrt', renamed: 0, history: true, historyDropped: false, jobs: ['job-trip'] })
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
    expect(r).toMatchObject({ renamed: 1, history: false, historyDropped: true })
    const moved = join(dirname(s.upload), 'IMG_1 (2).jpg')
    expect(readFileSync(s.upload, 'utf8')).toBe('someone else')
    expect(readFileSync(moved, 'utf8')).toBe('upload of trip')
    // under another name it is another file to the media ids (path, size, time): it gets the id an import
    // would give it, and its slide follows; else opening the show takes it for an edited original every
    // time (processed again, its face data dropped: media/restore.ts)
    const st = statSync(moved)
    const id = mediaId(moved, st.size, st.mtimeMs)
    for (const f of [s.file, ...s.backups]) {
      const p = JSON.parse(readFileSync(f, 'utf8')) as Project
      expect(p.media.map((m) => m.path)).toEqual([moved, s.pasted, s.photo])
      expect(p.media.map((m) => m.id)).toEqual([id, 'a000000000000002', 'a000000000000003'])
      expect(p.entries.map((e) => (e.type === 'text' ? '' : e.mediaId))).toEqual([id, 'a000000000000002', 'a000000000000003'])
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

  it('a move whose take-back meets a busy file too: the show works on, the rest comes back at the next start', async () => {
    const a = app('busy-back')
    const s = show(a, 'trip')
    const projects = createProjectStore(a.docs, { inTrash: (id) => a.trash.has(id) })
    setBusy(s.pasted, 99)
    setBusy(join(a.trash.dir, 'trip', 'backups'), 99)
    await expect(a.trash.moveIn(s.move)).rejects.toMatchObject({ code: 'EBUSY' })
    busy.clear()
    // the show is back, its older versions are still in the trash
    expect(readFileSync(s.file, 'utf8')).toBe(s.text)
    for (const f of s.backups) expect(existsSync(f), f).toBe(false)
    // so it is no show in the trash: its saves go through
    expect(await a.trash.has('trip')).toBe(false)
    await projects.save({ ...s.project, name: 'Klassenfahrt 2' })
    // the next start brings the rest back
    const again = a.open()
    await again.recover()
    for (const f of s.backups) expect(existsSync(f), f).toBe(true)
    expect(await again.list()).toEqual({ entries: [], problems: [], bytes: 0 })
    expect(await again.has('trip')).toBe(false)
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
    // the export jobs that came back are named, so the queue takes them in again (cleanupMain.ts)
    expect((await trash.recover()).sort()).toEqual(['job-moving', 'job-restoring'])
    for (const f of [...moving.all, ...restoring.all]) expect(existsSync(f), f).toBe(true)
    expect(readFileSync(moving.file, 'utf8')).toBe(moving.text)
    for (const f of purging.all) expect(existsSync(f), f).toBe(false)
    expect(readdirSync(join(a.docs, '.trash'))).toEqual([])
    expect(readdirSync(join(a.userData, 'trash'))).toEqual([])
    expect(await trash.has('moving')).toBe(false)
  })
})

// ---------------------------------------------------------------- a crash or power cut at any moment

/** Arms the power cut at the `at`-th change on disk from now on. */
function arm(at: number): void {
  Object.assign(crash, { armed: true, at, changes: 0, dead: false, trace: [] })
}
/** The app starts again; returns how many changes were made (or tried) while armed. */
function disarm(): number {
  const n = crash.changes
  Object.assign(crash, { armed: false, at: Infinity, dead: false })
  return n
}

const T0 = Date.UTC(2026, 9, 1, 8)
const FILE_TIME = new Date(Date.UTC(2026, 8, 20, 12))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A file with a fixed time: its media id is the same in every run of a scenario. */
function put(path: string, text: string): string {
  write(path, text)
  utimesSync(path, FILE_TIME, FILE_TIME)
  return path
}

/** A photo as an import makes it: its id from its path, size and time (media/scan.ts). */
function photo(path: string): MediaItem {
  const st = statSync(path)
  return { id: mediaId(path, st.size, st.mtimeMs), path, name: basename(path), kind: 'photo', format: 'JPEG', width: 10, height: 10, captureTime: 0, status: 'ready' }
}

/**
 * A fresh app folder, the same path in every run of a scenario (media ids hold the paths): projects,
 * userData, and the trash as the app sets it up, releasing shared uploads when a show goes for good.
 */
function world(name: string) {
  const root = join(tmp, name)
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  const docs = join(root, 'Diashow Studio')
  const userData = join(root, 'userData')
  const historyDir = join(userData, 'history')
  const exportsDir = join(userData, 'exports')
  const uploadsRoot = join(docs, 'Uploads')
  const pasted = join(docs, 'Eingefügt')
  mkdirSync(docs, { recursive: true })
  const clock = { t: T0 }
  const deps = { projects: createProjectStore(docs), uploadsRoot, pastedRoots: [pasted] }
  const open = (): Trash => {
    const trash = createTrash({ projectsDir: docs, dataDir: join(userData, 'trash'), historyDir, exportsDir, now: () => clock.t, retry: { attempts: 3, delayMs: 1 } })
    trash.setRelease((gone, kept) => releaseMedia(deps, gone, kept))
    return trash
  }
  return { root, docs, userData, historyDir, exportsDir, uploadsRoot, pasted, clock, open }
}
type World = ReturnType<typeof world>

/** A show of the teacher's photo and `files`, with older versions, its undo history and an export job when asked. */
function addShow(w: World, id: string, files: string[], extra: { versions?: number; history?: boolean; job?: boolean } = {}) {
  const teacher = put(join(w.root, 'Bilder', `${id}.jpg`), `the teacher’s photo of ${id}`)
  const media = [teacher, ...files].map(photo)
  const project: Project = {
    version: 1,
    id,
    name: `Show ${id}`,
    createdAt: 1,
    updatedAt: 2,
    entries: media.map((m, i) => ({ id: `e${i}`, type: 'photo' as const, mediaId: m.id })),
    media,
    music: [],
    settings: structuredClone(DEFAULT_SETTINGS)
  }
  put(join(w.docs, `${id}.dshow`), JSON.stringify(project, null, 1))
  for (let k = 1; k <= (extra.versions ?? 0); k++) put(join(w.docs, '.backups', id, `2026091${k}-100000.dshow`), JSON.stringify(project))
  if (extra.history) put(join(w.historyDir, `${id}.json.gz`), `history of ${id}`)
  const jobs = extra.job ? [`job-${id}`] : []
  for (const job of jobs) put(join(w.exportsDir, job, 'job.json'), `{"id":"${job}"}`)
  return { id, project, jobs }
}
type Show = ReturnType<typeof addShow>

/** Moves a show in with the uploads it owns; those it shares stay in place (cleanup.ts decides). */
const moveIn = (trash: Trash, s: Show, own: string[]) => trash.moveIn({ id: s.id, name: s.project.name, slideCount: s.project.entries.length, faces: false, files: own, jobs: s.jobs })

type Snapshot = Record<string, string>

/** Every file below the app folder with its content, and what lies directly in the two trash folders. */
function snapshot(w: World): Snapshot {
  const out: Snapshot = {}
  for (const e of readdirSync(w.root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const p = join(e.parentPath, e.name)
    out[p.slice(w.root.length + 1)] = readFileSync(p, 'utf8')
  }
  for (const d of [join(w.docs, '.trash'), join(w.userData, 'trash')]) out[`<${d.slice(w.root.length + 1)}>`] = existsSync(d) ? readdirSync(d).sort().join(' | ') : ''
  return out
}

const differences = (a: Snapshot, b: Snapshot): number => new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => a[k] !== b[k])).size

/** The end state is one of `allowed` (returns its index); else the difference to the nearest one fails the test. */
function oneOf(allowed: Snapshot[], snap: Snapshot, what: string): number {
  const i = allowed.findIndex((a) => isDeepStrictEqual(a, snap))
  if (i < 0) expect(snap, what).toEqual(allowed.reduce((best, a) => (differences(a, snap) < differences(best, snap) ? a : best)))
  return i
}

type Step<C> = (w: World, trash: Trash, c: C) => Promise<unknown>

interface Scenario<C> {
  /** The state before the operation, built in a fresh folder. */
  setup: (w: World, trash: Trash) => Promise<C>
  /** The operation the power cut stops. */
  op: Step<C>
  /** The states it may end in after the next start: each one reached from the setup by these steps, without a crash. */
  ends: Step<C>[]
  /** After every `nested`-th power cut of the operation, the start after it is cut off at each of its changes too. */
  nested?: number
  /** Before the next start (a file that stayed busy is free again). */
  restart?: () => void
}

/**
 * The cut-off starts after a power cut are the slow part: day to day every third of them runs, the
 * release check (DIASHOW_FULL_CRASH=1, scripts/release-check.mjs) runs all of them.
 */
const NESTED_EVERY = process.env.DIASHOW_FULL_CRASH === '1' ? 1 : 3

/**
 * Runs `op` with a power cut at each of its changes on disk, then starts again (a new trash on the same
 * folders, recover(), and once more); returns which `ends` were reached and how many runs it took.
 */
async function everyCrash<C>(name: string, s: Scenario<C>): Promise<{ reached: number[]; runs: number; changes: number }> {
  const build = async (): Promise<{ w: World; c: C }> => {
    const w = world(name)
    return { w, c: await s.setup(w, w.open()) }
  }
  const allowed: Snapshot[] = []
  for (const end of s.ends) {
    const { w, c } = await build()
    await end(w, w.open(), c)
    allowed.push(snapshot(w))
  }
  // without a power cut: how many changes the operation makes
  const clean = await build()
  arm(Infinity)
  await s.op(clean.w, clean.w.open(), clean.c).catch(() => {})
  const changes = disarm()
  s.restart?.()
  oneOf(allowed, snapshot(clean.w), 'without a power cut')
  expect(changes).toBeGreaterThan(3)

  const reached = new Set<number>()
  let runs = 0
  // k = changes + 1: the power goes off right after the last change
  for (let k = 1; k <= changes + 1; k++) {
    for (let j = 0; j < 1000; j++) {
      const { w, c } = await build()
      arm(k)
      await s.op(w, w.open(), c).catch(() => {})
      const where = crash.trace[k - 1] ?? 'after the last one'
      disarm()
      s.restart?.()
      let cut = false
      if (j > 0) {
        arm(j)
        await w
          .open()
          .recover()
          .catch(() => {})
        cut = crash.dead
        disarm()
      }
      await w.open().recover()
      const snap = snapshot(w)
      reached.add(oneOf(allowed, snap, `power cut at change ${k} (${where})${j ? `, and at change ${j} of the start after it` : ''}`))
      // starting once more changes nothing
      await w.open().recover()
      expect(snapshot(w), `another start after the power cut at change ${k}`).toEqual(snap)
      runs++
      if (!s.nested || k % (s.nested * NESTED_EVERY) || (j > 0 && !cut)) break
    }
  }
  return { reached: [...reached].sort(), runs, changes }
}

/** Show X: two older versions, its undo history, an export job, its own upload and pasted picture, and an upload it shares with the open show O. */
function fahrt(w: World) {
  const shared = put(join(w.uploadsRoot, 'Fahrt', 'Mia', 'shared.jpg'), 'X and O')
  const own = [put(join(w.uploadsRoot, 'Fahrt', 'Mia', 'IMG_1.jpg'), 'only X'), put(join(w.pasted, 'Fahrt', 'Bild 1.png'), 'pasted into X')]
  const x = addShow(w, 'showX', [...own, shared], { versions: 2, history: true, job: true })
  addShow(w, 'showO', [shared])
  return { x, own, shared }
}

/** X with two photos of one pupil in the trash; meanwhile another pupil's file took the first one's place. */
async function renamed(w: World, trash: Trash) {
  const one = put(join(w.uploadsRoot, 'Fahrt', 'Mia', 'IMG_1.jpg'), 'X’s first photo')
  const two = put(join(w.uploadsRoot, 'Fahrt', 'Mia', 'IMG_1 (2).jpg'), 'X’s second photo')
  const x = addShow(w, 'showX', [one, two], { versions: 2, history: true, job: true })
  await moveIn(trash, x, [one, two])
  put(one, 'another pupil’s photo')
  return { x, one, two }
}

/**
 * In the trash: X and Y share Mia's photo `u`; Q left a pasted picture `q` in place (a show that used
 * it too then is gone since); W shares Lea's photo `v` with the open show O. Each has an upload of its
 * own in the trash. Y and W came ten days later. "broken": a folder the app can't read, 31 days old.
 */
async function sharing(w: World, trash: Trash) {
  const u = put(join(w.uploadsRoot, 'Fahrt', 'Mia', 'shared.jpg'), 'X and Y')
  const v = put(join(w.uploadsRoot, 'Fest', 'Lea', 'v.jpg'), 'W and O')
  const q = put(join(w.pasted, 'Ausflug', 'Bild 1.png'), 'Q, left in place')
  const own = {
    x: put(join(w.uploadsRoot, 'Fahrt', 'Mia', 'IMG_1.jpg'), 'only X'),
    y: put(join(w.uploadsRoot, 'Fahrt', 'Ben', 'IMG_2.jpg'), 'only Y'),
    w: put(join(w.uploadsRoot, 'Fest', 'Lea', 'w.jpg'), 'only W'),
    q: put(join(w.uploadsRoot, 'Ausflug', 'Tom', 'q.jpg'), 'only Q')
  }
  const x = addShow(w, 'showX', [own.x, u], { versions: 1, history: true, job: true })
  const y = addShow(w, 'showY', [own.y, u])
  const sw = addShow(w, 'showW', [own.w, v])
  const sq = addShow(w, 'showQ', [own.q, q])
  addShow(w, 'showO', [v])
  await moveIn(trash, x, [own.x])
  await moveIn(trash, sq, [own.q])
  w.clock.t = T0 + 10 * DAY
  await moveIn(trash, y, [own.y])
  await moveIn(trash, sw, [own.w])
  w.clock.t = T0
  const broken = join(w.docs, '.trash', 'broken')
  put(join(broken, 'trash.json'), '{nope')
  utimesSync(broken, new Date(T0 - DAY), new Date(T0 - DAY))
  return { u, v, q }
}

/** Deletes these entries for good, one after another. */
function purged<C>(...keys: string[]): Step<C> {
  return async (_w, trash) => {
    for (const key of keys) await trash.purge(key)
  }
}
const nothing = async (): Promise<void> => {}

describe('a crash or power cut at any moment', () => {
  it('moving a show in: afterwards it is back as it was, or completely in the trash', async () => {
    const r = await everyCrash('crash-move', {
      setup: async (w) => fahrt(w),
      op: (_w, trash, c) => moveIn(trash, c.x, c.own),
      ends: [nothing, (_w, trash, c) => moveIn(trash, c.x, c.own)],
      nested: 4
    })
    expect(r.reached).toEqual([0, 1])
  })

  it('a move taken back (a picture stays busy): the show stays as it was', async () => {
    const r = await everyCrash('crash-move-busy', {
      setup: async (w) => fahrt(w),
      op: (_w, trash, c) => {
        setBusy(c.own[1], 99)
        return moveIn(trash, c.x, c.own)
      },
      restart: () => busy.clear(),
      ends: [nothing],
      nested: 8
    })
    expect(r.reached).toEqual([0])
  })

  it('restoring: afterwards the show is back with everything, or still completely in the trash', async () => {
    const r = await everyCrash('crash-restore', {
      setup: async (w, trash) => {
        const c = fahrt(w)
        await moveIn(trash, c.x, c.own)
        return c
      },
      op: (_w, trash) => trash.restore('showX'),
      ends: [nothing, (_w, trash) => trash.restore('showX')],
      nested: 6
    })
    expect(r.reached).toEqual([0, 1])
  })

  it('restoring with an upload whose place is taken: the show follows its new name, also when cut off', async () => {
    const r = await everyCrash('crash-rename', {
      setup: renamed,
      op: (_w, trash) => trash.restore('showX'),
      ends: [nothing, (_w, trash) => trash.restore('showX')],
      nested: 5
    })
    expect(r.reached).toEqual([0, 1])
    // the end: the first photo came back as "IMG_1 (3).jpg" ("(2)" is the show's own second photo)
    const w = world('crash-rename')
    const c = await renamed(w, w.open())
    expect(await w.open().restore('showX')).toMatchObject({ renamed: 1, history: false, historyDropped: true, jobs: ['job-showX'] })
    const moved = join(dirname(c.one), 'IMG_1 (3).jpg')
    expect([readFileSync(c.one, 'utf8'), readFileSync(moved, 'utf8'), readFileSync(c.two, 'utf8')]).toEqual(['another pupil’s photo', 'X’s first photo', 'X’s second photo'])
    const [teacher, , second] = c.x.project.media
    const id = photo(moved).id
    const versions = readdirSync(join(w.docs, '.backups', 'showX')).map((n) => join(w.docs, '.backups', 'showX', n))
    expect(versions).toHaveLength(2)
    for (const f of [join(w.docs, 'showX.dshow'), ...versions]) {
      const p = JSON.parse(readFileSync(f, 'utf8')) as Project
      expect(p.media.map((m) => [m.path, m.id])).toEqual([
        [teacher.path, teacher.id],
        [moved, id],
        [c.two, second.id]
      ])
      expect(p.entries.map((e) => (e.type === 'text' ? '' : e.mediaId))).toEqual([teacher.id, id, second.id])
      // rewritten with its old time (an older version's time is in its name)
      expect(statSync(f).mtimeMs).toBe(FILE_TIME.getTime())
    }
    expect(existsSync(join(w.historyDir, 'showX.json.gz'))).toBe(false)
    expect(readdirSync(join(w.docs, '.trash'))).toEqual([])
    expect(readdirSync(join(w.userData, 'trash'))).toEqual([])
  })

  it('a restore taken back (its show stays busy): back in the trash, or finished at the next start when cut off', async () => {
    const r = await everyCrash('crash-restore-busy', {
      setup: renamed,
      op: (w, trash) => {
        setBusy(join(w.docs, '.trash', 'showX', 'show.json'), 99)
        return trash.restore('showX')
      },
      restart: () => busy.clear(),
      ends: [nothing, (_w, trash) => trash.restore('showX')],
      nested: 8
    })
    expect(r.reached).toEqual([0, 1])
  })

  it('deleting for good: the rest goes, and an upload it shared goes with the last show that used it', async () => {
    const cases: [string, string[]][] = [
      ['showQ', []],
      ['showX', []],
      ['showX', ['showY']],
      ['showW', []]
    ]
    for (const [key, before] of cases) {
      const r = await everyCrash(`crash-purge-${key}-${before.length}`, {
        setup: async (w, trash) => {
          const c = await sharing(w, trash)
          for (const k of before) await trash.purge(k)
          return c
        },
        op: purged(key),
        ends: [nothing, purged(key)],
        nested: 5
      })
      expect(r.reached, key).toEqual([0, 1])
    }
    // what each one takes along
    const w = world('purge-releases')
    const c = await sharing(w, w.open())
    const trash = w.open()
    await trash.purge('showQ')
    expect(existsSync(c.q)).toBe(false)
    await trash.purge('showW')
    expect(readFileSync(c.v, 'utf8')).toBe('W and O')
    await trash.purge('showX')
    expect(readFileSync(c.u, 'utf8')).toBe('X and Y')
    await trash.purge('showY')
    expect(existsSync(c.u)).toBe(false)
    expect(await trash.list()).toMatchObject({ entries: [], problems: [{ key: 'broken' }] })
  })

  it('emptying the trash: the shows it marked are finished, the others stay as they were', async () => {
    const r = await everyCrash('crash-empty', {
      setup: sharing,
      op: (_w, trash) => trash.empty(),
      // every show is marked before the first one goes (in the order of the folder); the unreadable entry has no mark
      ends: [nothing, purged('showQ'), purged('showQ', 'showW'), purged('showQ', 'showW', 'showX'), purged('showQ', 'showW', 'showX', 'showY'), purged('broken', 'showQ', 'showW', 'showX', 'showY')],
      nested: 12
    })
    expect(r.reached).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('the expiry: the shows that are due are marked first and finished after a crash; a shared upload stays while a show uses it', async () => {
    const r = await everyCrash('crash-expire', {
      setup: sharing,
      op: (w, trash) => {
        w.clock.t = T0 + 30 * DAY
        return trash.expire()
      },
      ends: [nothing, purged('showQ'), purged('showQ', 'showX'), purged('broken', 'showQ', 'showX')],
      nested: 8
    })
    expect(r.reached).toEqual([0, 1, 2, 3])
  })

  it('a shared upload that stays busy when its last show goes: reported, kept in trash.json and released by the next expiry', async () => {
    const w = world('release-busy')
    const c = await sharing(w, w.open())
    const trash = w.open()
    await trash.purge('showY')
    setBusy(c.u, 2)
    const r = await trash.purge('showX')
    busy.clear()
    expect(r.failed).toEqual([c.u])
    expect(readFileSync(c.u, 'utf8')).toBe('X and Y')
    // its own files went; what is to be released stays recorded
    expect(readdirSync(join(w.docs, '.trash', 'showX'))).toEqual(['trash.json'])
    expect(JSON.parse(readFileSync(join(w.docs, '.trash', 'showX', 'trash.json'), 'utf8'))).toMatchObject({ state: 'purging', release: [{ path: c.u }] })
    expect((await trash.list()).problems.map((p) => p.key).sort()).toEqual(['broken', 'showX'])
    expect(await w.open().expire()).toEqual(['showX'])
    expect(existsSync(c.u)).toBe(false)
    expect(existsSync(join(w.docs, '.trash', 'showX'))).toBe(false)
  })

  it('a restore cut off by an older version of the app (no renames recorded) is finished without taking another file', async () => {
    const w = world('crash-legacy')
    const c = await renamed(w, w.open())
    const manifest = join(w.docs, '.trash', 'showX', 'trash.json')
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), state: 'restoring' }))
    await w.open().recover()
    expect(readFileSync(c.one, 'utf8')).toBe('another pupil’s photo')
    expect(readFileSync(join(dirname(c.one), 'IMG_1 (3).jpg'), 'utf8')).toBe('X’s first photo')
    const p = JSON.parse(readFileSync(join(w.docs, 'showX.dshow'), 'utf8')) as Project
    expect(p.media.map((m) => basename(m.path))).toEqual(['showX.jpg', 'IMG_1 (3).jpg', 'IMG_1 (2).jpg'])
    expect(readdirSync(join(w.docs, '.trash'))).toEqual([])
  })
})

describe('at the same moment', () => {
  it('the expiry while a show is restored: one after another, the upload they share stays', async () => {
    for (const first of ['expire', 'restore']) {
      const w = world(`same-${first}`)
      const c = await sharing(w, w.open())
      const trash = w.open()
      w.clock.t = T0 + 30 * DAY
      // X is due and shares Mia's photo with Y, which comes back meanwhile
      await Promise.all(first === 'expire' ? [trash.expire(), trash.restore('showY')] : [trash.restore('showY'), trash.expire()])
      expect(readFileSync(c.u, 'utf8'), first).toBe('X and Y')
      expect(existsSync(join(w.docs, 'showY.dshow'))).toBe(true)
      expect(existsSync(join(w.docs, '.trash', 'showX'))).toBe(false)
      expect(existsSync(c.q)).toBe(false)
    }
  })

  /** The app's handlers (cleanupMain.ts) on a world; `slow`: how long a look at the other shows takes after reading them. */
  async function handlers(w: World, slow = 0) {
    const trash = w.open()
    const store = createProjectStore(w.docs, { inTrash: (id) => trash.has(id) })
    const projects = {
      ...store,
      references: async (except?: string) => {
        const r = await store.references(except)
        await sleep(slow)
        return r
      }
    }
    const deps = {
      projects,
      cacheDir: join(w.userData, 'cache'),
      uploadsRoot: w.uploadsRoot,
      pastedRoots: [w.pasted],
      exportsDir: w.exportsDir,
      media: { forgetFaces: async () => {}, releaseCache: (ids: string[]) => ids },
      exports: { jobsOf: async () => [], forget: async () => {}, adopt: async () => {} },
      trash
    }
    const ops = createTrashOps(deps)
    await ops.ready
    return { trash, ops, store }
  }

  it('deleting a show while another one that shares its upload is restored: one queue, the upload stays for both', async () => {
    const w = world('same-delete-restore')
    const u = put(join(w.uploadsRoot, 'Fahrt', 'Mia', 'shared.jpg'), 'Y and Z')
    const y1 = put(join(w.uploadsRoot, 'Fahrt', 'Ben', 'IMG_2.jpg'), 'only Y')
    const z1 = put(join(w.uploadsRoot, 'Fahrt', 'Mia', 'IMG_3.jpg'), 'only Z')
    const y = addShow(w, 'showY', [y1, u])
    addShow(w, 'showZ', [z1, u])
    await moveIn(w.open(), y, [y1])
    // the deletion reads the other shows while Y is in the trash; without one queue Y would come back
    // before the deletion looks into the trash, and Z would take the photo along
    const { ops, trash, store } = await handlers(w, 60)
    const [deleted, restored] = await Promise.all([ops.remove('showZ'), ops.restore('showY')])
    expect(deleted).toHaveProperty('entry.uploads', 1)
    expect(restored).toMatchObject({ id: 'showY', renamed: 0 })
    expect(readFileSync(u, 'utf8')).toBe('Y and Z')
    expect(existsSync(z1)).toBe(false)
    expect((await store.peek('showY')).media.map((m) => m.path)).toContain(u)
    expect((await trash.list()).entries.map((e) => e.id)).toEqual(['showZ'])
    // and Z comes back as it was
    expect(await ops.restore('showZ')).toMatchObject({ id: 'showZ', renamed: 0 })
    expect(existsSync(z1)).toBe(true)
  })

  it('the expiry while a show that shares an upload with a due one is deleted: the upload stays where the show finds it', async () => {
    for (const first of ['expire', 'remove']) {
      const w = world(`same-expire-${first}`)
      const u = put(join(w.uploadsRoot, 'Fahrt', 'Mia', 'shared.jpg'), 'X and Z')
      const x1 = put(join(w.uploadsRoot, 'Fahrt', 'Ben', 'IMG_1.jpg'), 'only X')
      const x = addShow(w, 'showX', [x1, u])
      addShow(w, 'showZ', [u])
      await moveIn(w.open(), x, [x1])
      const { ops, trash } = await handlers(w, 20)
      w.clock.t = T0 + 30 * DAY
      await Promise.all(first === 'expire' ? [ops.expire(), ops.remove('showZ')] : [ops.remove('showZ'), ops.expire()])
      expect((await trash.list()).entries.map((e) => e.id), first).toEqual(['showZ'])
      expect(existsSync(join(w.docs, '.trash', 'showX'))).toBe(false)
      expect(await ops.restore('showZ')).toMatchObject({ id: 'showZ', renamed: 0 })
      expect(readFileSync(u, 'utf8')).toBe('X and Z')
    }
  })
})
