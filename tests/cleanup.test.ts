// "Nach dem Projekt aufräumen" in the main process (src/main/cleanup.ts): what a project keeps, which
// paths each category deletes (only inside the app's folders, never originals, never what another
// project uses, never exported videos), and the clean-up and project deletion on a synthetic app folder.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Entry, type MediaItem, type Project, type Rect } from '@shared/types'
import { addMonths, deletionDue, NOTHING, withoutFaceData } from '@shared/cleanup'
import { faceArea, faceCentre } from '@shared/people'
import { cleanupRoots, deleteProjectData, inventoryOf, planCleanup, runCleanup, scanProject, type CleanupDeps } from '../src/main/cleanup'
import { checkChoice } from '../src/main/cleanupMain'
import { createProjectStore } from '../src/main/projects'
import { validateProject } from '../src/main/projectSchema'
import { isInsideRoot } from '../src/main/safeDelete'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-cleanup-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

const axis = (k: number): number[] => Array.from({ length: 128 }, (_, i) => (i === k ? 1 : 0))
const FA: Rect = { x: 0.2, y: 0.3, w: 0.1, h: 0.15 }
const FB: Rect = { x: 0.6, y: 0.3, w: 0.1, h: 0.15 }
const MANUAL: Rect = { x: 0.05, y: 0.05, w: 0.1, h: 0.1 }
const P1 = '1111111111111111' // teacher's photo, also used by project B
const V1 = '2222222222222222' // teacher's video
const U1 = '3333333333333333' // Mia's upload, in the show
const U2 = '4444444444444444' // Ben's upload, left out
const S1 = '5555555555555555' // Mia's other upload, used by project B only
const T1 = '6666666666666666' // song

function file(path: string, bytes: number): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes, 3))
  return path
}

const item = (id: string, path: string, kind: 'photo' | 'video', extra: Partial<MediaItem> = {}): MediaItem => ({
  id, path, name: path.split('\\').pop()!, kind, format: 'JPEG', width: 1600, height: 900, captureTime: 0, status: 'ready', ...extra
})

/** A synthetic app: projects A (the one cleaned) and B, uploads, caches, backups, export jobs. */
function setup(name: string) {
  const root = join(tmp, name)
  const docs = join(root, 'documents', 'Diashow Studio')
  const cacheDir = join(root, 'userData', 'cache')
  const exportsDir = join(root, 'userData', 'exports')
  const uploadsRoot = join(docs, 'Uploads')
  const pictures = join(root, 'Pictures')
  const photo = file(join(pictures, 'trip.jpg'), 400)
  const video = file(join(pictures, 'trip.mp4'), 900)
  const song = file(join(pictures, 'song.mp3'), 300)
  const exported = file(join(pictures, 'Klassenfahrt.mp4'), 700)
  const up = join(uploadsRoot, 'Klassenfahrt')
  const mia = file(join(up, 'Mia', 'a.jpg'), 120)
  const shared = file(join(up, 'Mia', 'shared.jpg'), 130)
  const ben = file(join(up, 'Ben', 'b.jpg'), 140)
  const stray = file(join(up, 'Ben', 'c.jpg'), 150)
  // an export the user saved next to the uploads (not in a pupil's folder): never touched
  const savedThere = file(join(up, 'Klassenfahrt.mp4'), 160)
  for (const [id, bytes] of [[P1, 10], [V1, 20], [U1, 30], [U2, 40], [S1, 50], [T1, 60]] as const) {
    file(join(cacheDir, id, 'thumb.jpg'), bytes)
    file(join(cacheDir, id, 'meta.json'), 2)
  }
  file(join(cacheDir, V1, 'strip-4x64', '000.jpg'), 7)
  const samples = [0.25, 0.75, 1.25].map((t) => ({ t, faces: [{ x: 0.1 + t * 0.1, y: 0.3, w: 0.1, h: 0.15 }], desc: [axis(3)] }))
  const entries: Entry[] = [
    { id: 'title', type: 'text', title: 'Klassenfahrt' },
    { id: 'e1', type: 'photo', mediaId: P1, privacy: [MANUAL] },
    { id: 'e2', type: 'video', mediaId: V1, privacyTracks: [[{ t: 0, r: MANUAL }, { t: 1, r: MANUAL }]] },
    { id: 'e3', type: 'photo', mediaId: U1 },
    { id: 'e4', type: 'photo', mediaId: U2, excluded: true }
  ]
  const a: Project = {
    version: 1, id: 'showA', name: 'Klassenfahrt', createdAt: 1, updatedAt: 2, entries, settings: DEFAULT_SETTINGS,
    media: [
      item(P1, photo, 'photo', { faces: [FA, FB], faceDesc: [axis(3), axis(70)] }),
      item(V1, video, 'video', { duration: 1.5, videoFaces: samples, thumb: join(cacheDir, V1, 'thumb.jpg') }),
      item(U1, mia, 'photo'),
      item(U2, ben, 'photo')
    ],
    music: [{ id: T1, path: song, title: 'Song', duration: 100, status: 'ready' }],
    people: [{ id: 'lena', name: 'Lena', desc: [axis(3)] }],
    deleteAt: addMonths(Date.now(), -1)
  }
  const b: Project = {
    version: 1, id: 'showB', name: 'Andere', createdAt: 1, updatedAt: 2, settings: DEFAULT_SETTINGS, music: [],
    entries: [{ id: 'b1', type: 'photo', mediaId: P1 }, { id: 'b2', type: 'photo', mediaId: S1 }],
    media: [item(P1, photo, 'photo'), item(S1, shared, 'photo')]
  }
  mkdirSync(docs, { recursive: true })
  writeFileSync(join(docs, 'showA.dshow'), JSON.stringify(a))
  writeFileSync(join(docs, 'showB.dshow'), JSON.stringify(b))
  const backup = join(docs, '.backups', 'showA', '20260101-120000.dshow')
  file(backup, 0)
  writeFileSync(backup, JSON.stringify(a))
  file(join(docs, '.backups', 'showA', '20260102-120000.damaged'), 33)
  const jobs = ['j1', 'j2'].map((id) => {
    file(join(exportsDir, id, 'job.json'), 500)
    return { id, dir: join(exportsDir, id), state: 'done' as const, outPath: exported }
  })
  const forgottenJobs: string[] = []
  const forgottenFaces: string[][] = []
  const deps: CleanupDeps = {
    projects: createProjectStore(docs),
    cacheDir,
    uploadsRoot,
    exportsDir,
    media: {
      forgetFaces: async (items) => void forgottenFaces.push(items.map((x) => x.id)),
      releaseCache: (ids) => ids
    },
    exports: {
      jobsOf: async (pid) => (pid === 'showA' ? jobs.filter((j) => !forgottenJobs.includes(j.id)) : []),
      forget: async (id) => void forgottenJobs.push(id)
    }
  }
  return { deps, docs, cacheDir, exportsDir, uploadsRoot, pictures, files: { photo, video, song, exported, mia, shared, ben, stray, savedThere, backup }, jobs, forgottenJobs, forgottenFaces }
}

const readA = (docs: string): Project => JSON.parse(readFileSync(join(docs, 'showA.dshow'), 'utf8')) as Project

describe('inventory', () => {
  it('lists every category with sizes as on disk', async () => {
    const s = setup('inventory')
    const inv = inventoryOf(await scanProject(s.deps, 'showA'))
    expect(inv.name).toBe('Klassenfahrt')
    expect(inv.faces).toMatchObject({ media: 2, faces: 2, people: 1, named: 1, videoFrames: 3, matches: 2 })
    // descriptors: 2 of the photo, 3 of the video, 1 of the person
    expect(inv.faces.descriptors).toBe(6)
    expect(inv.uploads).toEqual({ files: 3, bytes: 120 + 140 + 150, uploaders: 2, inShow: { files: 1, bytes: 120, slides: 1 }, leftOut: { files: 2, bytes: 290 }, shared: 1 })
    // P1 is used by project B too: it stays
    expect(inv.caches).toEqual({ folders: 4, bytes: 20 + 7 + 30 + 40 + 60 + 4 * 2, shared: 1 })
    expect(inv.backups.files).toBe(2)
    expect(inv.backups.bytes).toBe(readFileSync(s.files.backup).length + 33)
    expect(inv.exports).toEqual({ jobs: 2, bytes: 1000, unfinished: 0 })
  })
})

describe('planning', () => {
  it('stays inside the folder of each category and never touches originals, other shows or exports', async () => {
    const s = setup('plan')
    const scan = await scanProject(s.deps, 'showA')
    const roots = cleanupRoots(s.deps)
    const all = planCleanup(scan, { faces: true, uploads: 'all', caches: true, backups: true, exports: true }, roots)
    expect(all.remove.length).toBeGreaterThan(0)
    for (const r of all.remove) {
      expect(isInsideRoot(r.path, roots[r.category]), r.path).toBe(true)
      expect(isInsideRoot(r.path, s.pictures)).toBe(false)
    }
    const paths = all.remove.map((r) => r.path)
    for (const never of [s.files.shared, s.files.savedThere, s.files.photo, s.files.exported, join(s.cacheDir, P1), join(s.cacheDir, S1)]) expect(paths).not.toContain(never)
    expect(all.remove.filter((r) => r.category === 'uploads').map((r) => r.path).sort()).toEqual([s.files.mia, s.files.ben, s.files.stray].sort())
    expect(all.remove.filter((r) => r.category === 'caches').map((r) => r.cacheId).sort()).toEqual([V1, U1, U2, T1].sort())
    expect(all.remove.filter((r) => r.category === 'exports').map((r) => r.jobId)).toEqual(['j1', 'j2'])
    expect(all.dropMedia.sort()).toEqual([U1, U2].sort())

    // only what is not in the show; its cache copy goes with it even when the caches stay
    const leftOut = planCleanup(scan, { ...NOTHING, uploads: 'leftOut' }, roots)
    expect(leftOut.remove.map((r) => [r.category, r.path]).sort()).toEqual([['uploads', s.files.ben], ['uploads', s.files.stray], ['uploads', join(s.cacheDir, U2)]].sort())
    expect(leftOut.dropMedia).toEqual([U2])

    // nothing chosen, nothing planned; an export still to run keeps its sources
    expect(planCleanup(scan, NOTHING, roots).remove).toEqual([])
    const pending = planCleanup({ ...scan, exports: [{ ...scan.exports[0], state: 'queued' }] }, { faces: true, uploads: 'all', caches: true, backups: true, exports: true }, roots)
    expect(pending.remove.filter((r) => r.category === 'uploads' || r.category === 'caches')).toEqual([])
    expect(pending.remove.filter((r) => r.category === 'backups')).toHaveLength(2)
  })

  it('takes only known choices from the renderer', () => {
    expect(checkChoice({ faces: true, uploads: 'everything', caches: 'yes', backups: true })).toEqual({ faces: true, uploads: 'none', caches: false, backups: true, exports: false })
    expect(checkChoice(null)).toEqual(NOTHING)
  })
})

describe('clean-up', () => {
  it('removes everything chosen, keeps the pixelation, the originals and what others use', async () => {
    const s = setup('all')
    const inv = inventoryOf(await scanProject(s.deps, 'showA'))
    const before = readA(s.docs)
    const result = await runCleanup(s.deps, 'showA', { faces: true, uploads: 'all', caches: true, backups: true, exports: true })

    // sizes freed are the sizes listed
    expect(result.removed.uploads).toEqual({ files: 3, bytes: inv.uploads.bytes })
    expect(result.removed.caches.bytes).toBe(inv.caches.bytes)
    expect(result.removed.backups.bytes).toBe(inv.backups.bytes)
    expect(result.removed.exports.bytes).toBe(inv.exports.bytes)
    expect(result.freed).toBe(inv.uploads.bytes + inv.caches.bytes + inv.backups.bytes + inv.exports.bytes)
    expect(result.failed).toEqual([])
    expect(result.faces).toMatchObject({ media: 2, people: 1 })

    // on disk
    for (const gone of [s.files.mia, s.files.ben, s.files.stray, join(s.cacheDir, V1), join(s.cacheDir, U1), join(s.cacheDir, T1), join(s.exportsDir, 'j1'), join(s.uploadsRoot, 'Klassenfahrt', 'Ben')]) expect(existsSync(gone), gone).toBe(false)
    for (const kept of [s.files.photo, s.files.video, s.files.song, s.files.exported, s.files.shared, s.files.savedThere, join(s.cacheDir, P1, 'thumb.jpg'), join(s.cacheDir, S1, 'thumb.jpg'), join(s.docs, 'showB.dshow')]) expect(existsSync(kept), kept).toBe(true)
    expect(readdirSync(join(s.docs, '.backups', 'showA'))).toEqual([])
    expect(s.forgottenJobs).toEqual(['j1', 'j2'])
    // cache folders that stay lose the face data; deleted ones are simply gone
    expect(s.forgottenFaces).toEqual([[P1]])

    // the project: no face data, the slides of the deleted uploads are gone, the pixelation fixed
    const a = readA(s.docs)
    expect(result.project).toEqual(a)
    expect(a.people).toBeUndefined()
    for (const m of a.media) {
      expect(m.faces).toBeUndefined()
      expect(m.faceDesc).toBeUndefined()
      expect(m.videoFaces).toBeUndefined()
    }
    expect(JSON.stringify(a)).not.toContain('Lena')
    expect(a.entries.map((e) => e.id)).toEqual(['title', 'e1', 'e2'])
    expect(a.media.map((m) => m.id)).toEqual([P1, V1])
    // the video's cache went: made again when the show opens; the shared photo's stayed
    expect(a.media.map((m) => m.status)).toEqual(['ready', 'pending'])
    expect(a.media[1].thumb).toBeUndefined()
    expect(a.music[0]).toMatchObject({ id: T1, status: 'ready' })
    const photo = a.entries.find((e) => e.id === 'e1')!
    expect(photo.type === 'photo' && photo.privacy).toEqual([MANUAL, faceArea(FA)])
    const clip = a.entries.find((e) => e.id === 'e2')!
    expect(clip.type === 'video' && clip.privacyTracks?.length).toBe(2)
    expect(a.media[0].faceFocus).toEqual(faceCentre([FA, FB]))
    expect(a.faceDataRemovedAt).toBeGreaterThan(0)
    // the reminder that had come is done
    expect(before.deleteAt).toBeDefined()
    expect(a.deleteAt).toBeUndefined()
  })

  it('face data only: older versions are cleaned the same way and keep their names', async () => {
    const s = setup('faces')
    const result = await runCleanup(s.deps, 'showA', { ...NOTHING, faces: true })
    expect(result.freed).toBe(0)
    const backups = readdirSync(join(s.docs, '.backups', 'showA')).sort()
    expect(backups).toEqual(['20260101-120000.dshow', '20260102-120000.damaged'])
    const old = JSON.parse(readFileSync(s.files.backup, 'utf8')) as Project
    expect(old.people).toBeUndefined()
    expect(old.media.some((m) => m.faceDesc || m.faces || m.videoFaces)).toBe(false)
    expect(old.entries.find((e) => e.id === 'e1')).toMatchObject({ privacy: [MANUAL, faceArea(FA)] })
    // uploads, caches and exports stay
    for (const kept of [s.files.mia, s.files.ben, join(s.cacheDir, V1), join(s.exportsDir, 'j1')]) expect(existsSync(kept)).toBe(true)
    expect(readA(s.docs).entries).toHaveLength(5)
  })

  it('only the uploads that are not in the show', async () => {
    const s = setup('leftout')
    const result = await runCleanup(s.deps, 'showA', { ...NOTHING, uploads: 'leftOut' })
    expect(result.removed.uploads.files).toBe(4) // b.jpg, c.jpg and the cache copy of b.jpg (thumbnail, meta.json)
    expect(existsSync(s.files.mia)).toBe(true)
    expect(existsSync(s.files.ben)).toBe(false)
    expect(existsSync(join(s.cacheDir, U2))).toBe(false)
    expect(existsSync(join(s.cacheDir, U1))).toBe(true)
    const a = readA(s.docs)
    expect(a.entries.map((e) => e.id)).toEqual(['title', 'e1', 'e2', 'e3'])
    // face data was not chosen: it stays
    expect(a.people).toHaveLength(1)
  })
})

describe('deleting a project', () => {
  it('removes the file, its older versions, the face data in the cache and the chosen extras', async () => {
    const s = setup('delete')
    const result = await deleteProjectData(s.deps, 'showA', { caches: true, uploads: true, exports: false })
    expect(existsSync(join(s.docs, 'showA.dshow'))).toBe(false)
    expect(existsSync(join(s.docs, '.backups', 'showA'))).toBe(false)
    // cache folders that stay lose the face data; deleted ones are simply gone
    expect(s.forgottenFaces).toEqual([[P1]])
    expect(existsSync(join(s.cacheDir, V1))).toBe(false)
    expect(existsSync(join(s.cacheDir, P1))).toBe(true)
    expect(existsSync(s.files.mia)).toBe(false)
    expect(existsSync(s.files.shared)).toBe(true)
    expect(existsSync(join(s.exportsDir, 'j1'))).toBe(true)
    for (const kept of [s.files.photo, s.files.video, s.files.song, s.files.exported, s.files.savedThere]) expect(existsSync(kept)).toBe(true)
    expect(result.removed.uploads.files).toBe(3)
    expect(result.freed).toBeGreaterThan(0)
  })
})

describe('project fields', () => {
  it('reminder, removal time and face centre survive a round trip; wrong values are dropped', () => {
    const at = addMonths(Date.now(), 3)
    const cleaned = withoutFaceData(
      { version: 1, id: 'p', name: 'P', createdAt: 1, updatedAt: 1, entries: [], music: [], settings: DEFAULT_SETTINGS, media: [item(P1, 'C:\\a.jpg', 'photo', { faces: [FA] })], deleteAt: at },
      Date.now()
    )
    const ok = validateProject(JSON.parse(JSON.stringify(cleaned)))
    expect(ok.project.deleteAt).toBe(at)
    expect(ok.project.faceDataRemovedAt).toBe(cleaned.faceDataRemovedAt)
    expect(ok.project.media[0].faceFocus).toEqual(faceCentre([FA]))
    expect(ok.report.changes).toEqual([])
    const bad = validateProject({ ...cleaned, deleteAt: 'soon', faceDataRemovedAt: 5, media: [{ ...cleaned.media[0], faceFocus: { x: 2, y: 0.5 } }] })
    expect(bad.project.deleteAt).toBeUndefined()
    expect(bad.project.faceDataRemovedAt).toBeUndefined()
    expect(bad.project.media[0].faceFocus).toBeUndefined()
    expect(bad.report.changes.map((c) => c.code).sort()).toEqual(['basics', 'mediaRepaired'])
  })

  it('reminder dates: months later, due from its day on', () => {
    const jan31 = new Date(2027, 0, 31, 15).getTime()
    expect(new Date(addMonths(jan31, 1)).getDate()).toBe(28)
    expect(new Date(addMonths(jan31, 12)).getFullYear()).toBe(2028)
    expect(deletionDue(undefined)).toBe(false)
    expect(deletionDue(Date.now() - 1000)).toBe(true)
    expect(deletionDue(Date.now() + 86_400_000)).toBe(false)
  })
})
