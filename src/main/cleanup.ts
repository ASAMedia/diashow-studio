// "Nach dem Projekt aufräumen": everything the app keeps for one project (scanProject), what a choice
// removes (planCleanup, pure) and carrying it out (runCleanup); deleting a whole project goes through
// here too (deleteProjectData). Files are only deleted by safeDelete.ts, inside the app's own folders:
// the teacher's photos, videos and music and the exported videos are never touched. Electron-free.
//
// What a project keeps besides its .dshow file:
// - face data in the project (faces, descriptors, video faces, the people list with names), in its
//   older versions and in the media cache (meta.json of each item);
// - the pupils' uploads in <Documents>/Diashow Studio/Uploads/<project name>/<pupil>/;
// - the media cache, one folder per photo, video or song: thumbnails, display images, proxies, 4K
//   versions, stabilised clips, extracted sound, frame strips;
// - older versions in .backups/<id>/ (also damaged files a repair kept);
// - export jobs in <userData>/exports/<job>/: a snapshot of the project (with its face data), the
//   mixed sound and the rendered parts;
// - the undo history in <userData>/history/<id>.json.gz (history.ts): earlier states of the show. It
//   goes when chosen, with face data or uploads, and whenever the clean-up rewrote the show.
import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { ExportJobState } from '@shared/exportQueue'
import type { MediaItem, Project } from '@shared/types'
import {
  CLEANUP_CATEGORIES,
  deletionDue,
  emptyRemoved,
  faceDataStats,
  withoutFaceData,
  withoutMedia,
  type CleanupCategory,
  type CleanupChoice,
  type CleanupInventory,
  type CleanupResult,
  type DeleteExtras
} from '@shared/cleanup'
import { BACKUPS, type ProjectStore } from './projects'
import { isInsideRoot, pruneEmptyDirs, removeInside, sizeOf } from './safeDelete'
import { safeName } from './share/server'

export interface CleanupDeps {
  projects: ProjectStore
  cacheDir: string
  /** <Documents>/Diashow Studio/Uploads */
  uploadsRoot: string
  /**
   * <Documents>/Diashow Studio/Eingefügt and /Pasted (pasteMain.ts): pictures pasted with Ctrl+V, a
   * folder per project. They count as uploads of the project.
   */
  pastedRoots?: string[]
  /** <userData>/exports */
  exportsDir: string
  media: { forgetFaces(items: { id: string; faceFocus?: { x: number; y: number } }[]): Promise<void>; releaseCache(ids: string[]): string[] }
  exports: {
    jobsOf(projectId: string): Promise<{ id: string; dir: string; state: ExportJobState; outPath: string }[]>
    forget(id: string): Promise<void>
  }
  /** The stored undo history (history.ts); it deletes inside its own folder. */
  history?: {
    size(id: string): Promise<{ files: number; bytes: number }>
    clear(id: string): Promise<{ files: number; bytes: number; failed?: string[] }>
    /** Moves the history along when the show is saved outside the editor (the deletion reminder). */
    rebase?(id: string, before: string, after: string): Promise<unknown>
  }
  now?: () => number
}

/** The app's own folders: the only places the clean-up deletes in (the history store deletes in its own). */
export function cleanupRoots(d: Pick<CleanupDeps, 'cacheDir' | 'uploadsRoot' | 'exportsDir' | 'projects'>): Record<Exclude<CleanupCategory, 'faces' | 'history'>, string> {
  return { uploads: d.uploadsRoot, caches: d.cacheDir, backups: join(d.projects.dir, BACKUPS), exports: d.exportsDir }
}

const low = (p: string): string => resolve(p).toLowerCase()
const FINISHED: readonly ExportJobState[] = ['done', 'cancelled', 'error']

export interface UploadFile {
  path: string
  bytes: number
  /** Folder of the pupil who sent it; '' for a pasted picture. */
  uploader: string
  /** In the show, not (left out, removed, never added), or used by another project (stays). */
  use: 'show' | 'leftOut' | 'other'
  /** A pasted picture: the folder of pasted pictures it lies in (uploads lie in uploadsRoot). */
  root?: string
}

export interface SizedPath {
  path: string
  bytes: number
  files: number
}

export interface CacheFolder extends SizedPath {
  id: string
  /** Another project uses it too (or an original lives inside): it stays. */
  shared: boolean
}

export interface JobFolder extends SizedPath {
  id: string
  state: ExportJobState
}

export interface CleanupScan {
  project: Project
  /** Upload folders of the project (Uploads/<project name>, and the ones its media come from). */
  uploadDirs: string[]
  /** Pupils' folders inside them. */
  uploaderDirs: string[]
  uploads: UploadFile[]
  caches: CacheFolder[]
  backups: SizedPath[]
  exports: JobFolder[]
  /** The stored undo history. */
  history: { files: number; bytes: number }
  /** Never deleted: originals any project uses (uploads only another project's), exported videos. */
  keep: string[]
}

/** Upload folders of a project: by its name (where the share dialog puts them) and those its media come from. */
export function uploadDirsOf(project: Project, uploadsRoot: string): string[] {
  const dirs = new Map<string, string>()
  const add = (dir: string): void => void dirs.set(low(dir), resolve(dir))
  add(join(uploadsRoot, safeName(project.name, 60) || 'Diashow'))
  for (const m of project.media) {
    for (const p of [m.path, m.live?.source]) {
      if (typeof p !== 'string' || !isInsideRoot(p, uploadsRoot)) continue
      const first = relative(resolve(uploadsRoot), resolve(p)).split(sep)[0]
      if (first && first !== '..') add(join(uploadsRoot, first))
    }
  }
  return [...dirs.values()]
}

/** Folders of pictures pasted into a project (Eingefügt/<project name>, and the ones its media come from), with their root. */
export function pastedDirsOf(project: Project, roots: readonly string[]): { dir: string; root: string }[] {
  const dirs = new Map<string, { dir: string; root: string }>()
  for (const root of roots) {
    const add = (dir: string): void => void dirs.set(low(dir), { dir: resolve(dir), root })
    add(join(root, safeName(project.name, 60) || 'Diashow'))
    for (const m of project.media) {
      if (typeof m.path !== 'string' || !isInsideRoot(m.path, root)) continue
      const first = relative(resolve(root), resolve(m.path)).split(sep)[0]
      if (first && first !== '..') add(join(root, first))
    }
  }
  return [...dirs.values()]
}

/** In one of the app's folders of received files (uploads, pasted pictures), not the user's own. */
const received = (d: Pick<CleanupDeps, 'uploadsRoot' | 'pastedRoots'>, p: string): boolean =>
  isInsideRoot(p, d.uploadsRoot) || (d.pastedRoots ?? []).some((r) => isInsideRoot(p, r))

async function list(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    const st = await lstat(p)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

/** Files below `dir` (links are not followed), with their sizes, and the folders on the way. */
async function walk(dir: string, files: SizedPath[], dirs: string[], depth = 0): Promise<void> {
  if (depth > 8) return
  for (const e of await list(dir)) {
    const p = join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      dirs.push(p)
      await walk(p, files, dirs, depth + 1)
    } else if (e.isFile()) {
      const s = await sizeOf(p)
      files.push({ path: p, bytes: s.bytes, files: 1 })
    }
  }
}

/** Media of the show (not left out) by file: the photo or video and a Live Photo's video. */
function showPaths(project: Project): Set<string> {
  const used = new Set(project.entries.flatMap((e) => (e.type === 'text' || e.excluded ? [] : [e.mediaId])))
  const out = new Set<string>()
  for (const m of project.media) {
    if (!used.has(m.id)) continue
    out.add(low(m.path))
    if (m.live?.source) out.add(low(m.live.source))
  }
  return out
}

/** Everything the app keeps for a project, with sizes. Throws when the project can't be read. */
export async function scanProject(d: CleanupDeps, id: string): Promise<CleanupScan> {
  const project = await d.projects.peek(id)
  const others = await d.projects.references(id)
  const otherPaths = new Set(others.paths.map(low))

  // uploads: only files inside a pupil's folder (an exported video saved next to them is the user's)
  const inShow = showPaths(project)
  const uploadDirs: string[] = []
  const uploaderDirs: string[] = []
  const uploads: UploadFile[] = []
  for (const dir of uploadDirsOf(project, d.uploadsRoot)) {
    if (!(await isDir(dir))) continue
    uploadDirs.push(dir)
    for (const e of await list(dir)) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue
      const pupil = join(dir, e.name)
      uploaderDirs.push(pupil)
      const files: SizedPath[] = []
      await walk(pupil, files, uploaderDirs)
      for (const f of files) {
        const key = low(f.path)
        uploads.push({ path: f.path, bytes: f.bytes, uploader: e.name, use: otherPaths.has(key) ? 'other' : inShow.has(key) ? 'show' : 'leftOut' })
      }
    }
  }
  // pictures pasted with Ctrl+V: the PNG files the app wrote straight into the project's folder
  for (const { dir, root } of pastedDirsOf(project, d.pastedRoots ?? [])) {
    if (!(await isDir(dir))) continue
    uploadDirs.push(dir)
    for (const e of await list(dir)) {
      if (!e.isFile() || !/\.png$/i.test(e.name)) continue
      const path = join(dir, e.name)
      const key = low(path)
      uploads.push({ path, bytes: (await sizeOf(path)).bytes, uploader: '', root, use: otherPaths.has(key) ? 'other' : inShow.has(key) ? 'show' : 'leftOut' })
    }
  }

  // caches: a folder per media / music id
  const caches: CacheFolder[] = []
  const ids = [...new Set([...project.media.map((m) => m.id), ...project.music.map((t) => t.id)])]
  for (const cid of ids) {
    if (typeof cid !== 'string' || !/^[0-9a-f]{16}$/.test(cid)) continue
    const path = join(d.cacheDir, cid)
    if (!(await isDir(path))) continue
    const s = await sizeOf(path)
    const shared = others.ids.has(cid) || others.paths.some((p) => isInsideRoot(p, path))
    caches.push({ id: cid, path, bytes: s.bytes, files: s.files, shared })
  }

  // older versions (and damaged files a repair kept)
  const backups: SizedPath[] = []
  const folder = d.projects.backupFolder(id)
  for (const e of await list(folder)) {
    if (!e.isFile()) continue
    const p = join(folder, e.name)
    backups.push({ path: p, ...(await sizeOf(p)) })
  }

  // export jobs of this project
  const jobs = await d.exports.jobsOf(id).catch(() => [])
  const exports: JobFolder[] = []
  for (const j of jobs) exports.push({ id: j.id, state: j.state, path: j.dir, ...(await sizeOf(j.dir)) })

  const own = project.media.flatMap((m) => [m.path, m.live?.source]).concat(project.music.map((t) => t.path))
  const keep = [
    ...others.paths,
    ...own.filter((p): p is string => typeof p === 'string' && !received(d, p)),
    ...jobs.map((j) => j.outPath)
  ]
  const history = d.history ? await d.history.size(id).catch(() => ({ files: 0, bytes: 0 })) : { files: 0, bytes: 0 }
  return { project, uploadDirs, uploaderDirs, uploads, caches, backups, exports, history, keep }
}

const sum = (list: { bytes: number }[]): number => list.reduce((n, x) => n + x.bytes, 0)

/** What the dialog lists. */
export function inventoryOf(scan: CleanupScan): CleanupInventory {
  const p = scan.project
  const mine = scan.uploads.filter((f) => f.use !== 'other')
  const show = mine.filter((f) => f.use === 'show')
  const left = mine.filter((f) => f.use === 'leftOut')
  const showFiles = new Set(show.map((f) => low(f.path)))
  const media = new Map(p.media.map((m) => [m.id, m]))
  const slides = p.entries.filter((e) => e.type !== 'text' && !e.excluded && showFiles.has(low(media.get(e.mediaId)?.path ?? ''))).length
  const caches = scan.caches.filter((c) => !c.shared)
  const finished = scan.exports.filter((j) => FINISHED.includes(j.state))
  return {
    projectId: p.id,
    name: p.name,
    ...(p.deleteAt ? { deleteAt: p.deleteAt } : {}),
    ...(p.faceDataRemovedAt ? { faceDataRemovedAt: p.faceDataRemovedAt } : {}),
    faces: faceDataStats(p),
    uploads: {
      files: mine.length,
      bytes: sum(mine),
      uploaders: new Set(mine.filter((f) => f.uploader).map((f) => f.uploader.toLowerCase())).size,
      // pictures pasted with Ctrl+V (only listed when there are some)
      ...(mine.some((f) => !!f.root) ? { pasted: mine.filter((f) => !!f.root).length } : {}),
      inShow: { files: show.length, bytes: sum(show), slides },
      leftOut: { files: left.length, bytes: sum(left) },
      shared: scan.uploads.length - mine.length
    },
    caches: { folders: caches.length, bytes: sum(caches), shared: scan.caches.length - caches.length },
    backups: { files: scan.backups.length, bytes: sum(scan.backups) },
    history: { ...scan.history },
    exports: { jobs: finished.length, bytes: sum(finished), unfinished: scan.exports.length - finished.length }
  }
}

export interface PlannedRemoval {
  category: Exclude<CleanupCategory, 'faces' | 'history'>
  path: string
  /** The app folder it must lie in (an upload's cache copy counts as the upload, but lives in the cache). */
  root: string
  bytes: number
  /** A cache folder (released by the media service first), or an export job's folder (taken out of the queue first). */
  cacheId?: string
  jobId?: string
}

export interface CleanupPlan {
  remove: PlannedRemoval[]
  /** Media whose files are deleted (uploads): they leave the project, with their slides. */
  dropMedia: string[]
  /** The deleted upload files (lowercase), dropped from older versions too. */
  dropPaths: string[]
  /** Upload folders removed once empty. */
  pruneDirs: string[]
  keep: string[]
}

/**
 * What a choice deletes, by category. Every path lies inside the folder of its category (`roots`),
 * nothing another project or the user's exports use is in it. While an export of the project is
 * still to run, its sources (uploads, caches) stay. Pure.
 */
export function planCleanup(scan: CleanupScan, wanted: CleanupChoice, roots: ReturnType<typeof cleanupRoots>): CleanupPlan {
  const pending = scan.exports.some((j) => !FINISHED.includes(j.state))
  const choice: CleanupChoice = pending ? { ...wanted, uploads: 'none', caches: false } : wanted
  const remove: PlannedRemoval[] = []
  const keep = new Set(scan.keep.map(low))
  // `pasted`: the folder of pasted pictures the file lies in, found by scanProject (not the renderer)
  const add = (r: Omit<PlannedRemoval, 'root'>, pasted?: string): void => {
    const root = r.cacheId ? roots.caches : (pasted ?? roots[r.category])
    if (!isInsideRoot(r.path, root) || keep.has(low(r.path))) return
    if (!remove.some((x) => low(x.path) === low(r.path))) remove.push({ ...r, root })
  }

  const files = choice.uploads === 'all' ? scan.uploads.filter((f) => f.use !== 'other') : choice.uploads === 'leftOut' ? scan.uploads.filter((f) => f.use === 'leftOut') : []
  for (const f of files) add({ category: 'uploads', path: f.path, bytes: f.bytes }, f.root)
  const dropPaths = new Set(remove.map((r) => low(r.path)))
  const dropMedia = scan.project.media.filter((m) => dropPaths.has(low(m.path)) || (!!m.live && dropPaths.has(low(m.live.source)))).map((m) => m.id)

  // the cache holds copies of the deleted uploads too (thumbnails, display images, proxies)
  const gone = new Set(dropMedia)
  for (const c of scan.caches) {
    if (c.shared) continue
    if (choice.caches) add({ category: 'caches', path: c.path, bytes: c.bytes, cacheId: c.id })
    else if (gone.has(c.id)) add({ category: 'uploads', path: c.path, bytes: c.bytes, cacheId: c.id })
  }
  if (choice.backups) for (const b of scan.backups) add({ category: 'backups', path: b.path, bytes: b.bytes })
  if (choice.exports) {
    for (const j of scan.exports) if (FINISHED.includes(j.state)) add({ category: 'exports', path: j.path, bytes: j.bytes, jobId: j.id })
  }
  return {
    remove,
    dropMedia,
    dropPaths: [...dropPaths],
    pruneDirs: files.length ? [...scan.uploaderDirs, ...scan.uploadDirs] : [],
    keep: [...scan.keep]
  }
}

const DERIVED = ['thumb', 'display', 'playback', 'audio', 'liveVideo', 'stabilized'] as const

/**
 * Media and songs whose cache folder went: nothing points at the deleted copies any more (the home
 * screen would show a broken cover), and the show makes them again when it is opened.
 */
export function withoutCache(project: Project, ids: ReadonlySet<string>, cacheDir: string): Project {
  if (!ids.size) return project
  const inCache = (v: unknown): boolean => typeof v === 'string' && isInsideRoot(v, cacheDir)
  return {
    ...project,
    media: project.media.map((m) => {
      if (!ids.has(m.id)) return m
      const out: MediaItem = { ...m, status: 'pending' }
      for (const k of DERIVED) if (inCache(out[k])) delete out[k]
      delete out.proxied
      delete out.progress
      delete out.stabilizing
      return out
    }),
    music: project.music.map((t) => {
      if (!ids.has(t.id) || !inCache(t.playback)) return t
      const { playback: _p, ...rest } = t
      return { ...rest, status: 'pending' }
    })
  }
}

/**
 * Deletes what a plan lists (caches in work and exports that came back to life stay); counts into
 * `result`. Returns the ids whose cache folders were deleted.
 */
async function execute(d: CleanupDeps, plan: CleanupPlan, result: CleanupResult): Promise<Set<string>> {
  const roots = cleanupRoots(d)
  const forgotten = new Set<string>()
  for (const r of plan.remove) {
    if (!r.jobId) continue
    try {
      await d.exports.forget(r.jobId)
      forgotten.add(r.jobId)
    } catch {
      // resumed or removed meanwhile: its folder stays
    }
  }
  const cacheIds = plan.remove.flatMap((r) => (r.cacheId ? [r.cacheId] : []))
  const free = new Set(d.media.releaseCache(cacheIds))
  result.busy += cacheIds.length - free.size
  for (const category of CLEANUP_CATEGORIES) {
    if (category === 'faces') continue
    const items = plan.remove.filter((r) => r.category === category && (!r.cacheId || free.has(r.cacheId)) && (!r.jobId || forgotten.has(r.jobId)))
    if (!items.length) continue
    const done = await removeInside(
      items.map((r) => r.path),
      [...new Set(items.map((r) => r.root))],
      plan.keep
    )
    result.removed[category].files += done.files
    result.removed[category].bytes += done.bytes
    result.failed.push(...done.failed, ...done.refused)
  }
  if (plan.pruneDirs.length) await pruneEmptyDirs(plan.pruneDirs, [roots.uploads, ...(d.pastedRoots ?? [])])
  result.freed = CLEANUP_CATEGORIES.reduce((n, c) => n + result.removed[c].bytes, 0)
  return free
}

/**
 * Cleans up a project as chosen. The project file is rewritten first (face data turned into fixed
 * pixelation and removed, slides of deleted uploads dropped), without a backup of the old version;
 * older versions are deleted or cleaned the same way; then the files go.
 */
export async function runCleanup(d: CleanupDeps, id: string, choice: CleanupChoice): Promise<CleanupResult> {
  const now = d.now?.() ?? Date.now()
  const scan = await scanProject(d, id)
  const plan = planCleanup(scan, choice, cleanupRoots(d))
  const result: CleanupResult = { removed: emptyRemoved(), freed: 0, failed: [], busy: 0 }
  const dropPaths = new Set(plan.dropPaths)
  const dropMedia = new Set(plan.dropMedia)
  const dropped = (m: MediaItem): boolean => dropMedia.has(m.id) || dropPaths.has(low(m.path)) || (!!m.live && dropPaths.has(low(m.live.source)))
  const scrub = (p: Project): Project => {
    let out = choice.faces ? withoutFaceData(p, now) : p
    if (dropPaths.size) out = withoutMedia(out, dropped)
    return out
  }
  // a reminder that has come is done with the clean-up
  const reminded = deletionDue(scan.project.deleteAt, now)
  if (choice.faces || dropPaths.size || reminded) {
    if (choice.faces) result.faces = faceDataStats(scan.project)
    const { deleteAt: _at, ...cleaned } = scrub(scan.project)
    result.project = { ...(reminded ? cleaned : { ...cleaned, ...(scan.project.deleteAt ? { deleteAt: scan.project.deleteAt } : {}) }), updatedAt: now }
    await d.projects.overwrite(result.project)
    // older versions hold the same data: cleaned unless they go anyway
    if (!choice.backups && (choice.faces || dropPaths.size)) await d.projects.rewriteBackups(id, scrub)
  }
  const gone = await execute(d, plan, result)
  // the face data in the cache folders that stay (deleted ones are forgotten already)
  if (choice.faces) {
    const focus = new Map((result.project?.media ?? []).map((m) => [m.id, m.faceFocus]))
    await d.media.forgetFaces(scan.project.media.filter((m) => !gone.has(m.id)).map((m) => ({ id: m.id, faceFocus: focus.get(m.id) })))
  }
  const left = result.project ?? scan.project
  if ([...gone].some((cid) => left.media.some((m) => m.id === cid) || left.music.some((t) => t.id === cid))) {
    result.project = { ...withoutCache(left, gone, d.cacheDir), updatedAt: now }
    await d.projects.overwrite(result.project)
  }
  // the undo history holds earlier states of the show: it goes when chosen and whenever the show was rewritten
  if (d.history && (choice.history || result.project)) await removeHistory(d, id, result)
  return result
}

/** Deletes a show's stored undo history, counted into `result`. */
async function removeHistory(d: CleanupDeps, id: string, result: CleanupResult): Promise<void> {
  const h = await d.history!.clear(id)
  result.removed.history = { files: h.files, bytes: h.bytes }
  result.failed.push(...(h.failed ?? []))
  result.freed = CLEANUP_CATEGORIES.reduce((n, c) => n + result.removed[c].bytes, 0)
}

/**
 * Deletes a project: its file and older versions (as before), the face data of its media in the
 * cache, and what `extras` asks for besides (caches, uploads, finished exports), with the same care
 * as the clean-up. A project that can't be read loses its file and older versions only.
 */
export async function deleteProjectData(d: CleanupDeps, id: string, extras?: DeleteExtras): Promise<CleanupResult> {
  const result: CleanupResult = { removed: emptyRemoved(), freed: 0, failed: [], busy: 0 }
  const scan = await scanProject(d, id).catch(() => null)
  await d.projects.delete(id)
  if (scan) {
    result.removed.backups = { files: scan.backups.length, bytes: sum(scan.backups) }
    const choice: CleanupChoice = { faces: false, uploads: extras?.uploads ? 'all' : 'none', caches: !!extras?.caches, backups: false, exports: !!extras?.exports }
    const gone = await execute(d, planCleanup(scan, choice, cleanupRoots(d)), result)
    await d.media.forgetFaces(scan.project.media.filter((m) => !gone.has(m.id)).map((m) => ({ id: m.id })))
  }
  // its undo history goes with it, also when the file couldn't be read
  if (d.history) await removeHistory(d, id, result)
  return result
}
