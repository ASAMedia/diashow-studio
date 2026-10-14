// The trash for slideshows (src/shared/trash.ts): "Delete" on the home screen moves a show here; after
// TRASH_DAYS it is deleted for good, at the start and every few hours while the app runs (expire()),
// only inside the trash folders (safeDelete.ts). Electron-free.
//
// A show in the trash is two folders, each on the drive its files came from, so every move is a
// rename (atomic, never a copy), retried while Windows keeps a file busy (replaceFile.ts):
// - <projects>/.trash/<id>/: trash.json (what was moved from where, the dates), show.json (its .dshow,
//   renamed so that neither the home screen, "Open project…" nor a double-click in Explorer takes it
//   for a show), backups/ (its older versions) and files/<path> (the pupils' uploads and pasted
//   pictures, by their path in the projects folder);
// - <userData>/trash/<id>/: history.json.gz (the undo history) and exports/<job>/ (finished export jobs).
//
// A crash or power cut may stop the app at any moment. Every step is one rename, one write through a
// temp file and a rename, or one deletion, and trash.json (trashEntry.ts) says what is under way before
// it starts: 'moving', 'trashed', 'restoring' (with the uploads that come back under another name) or
// 'purging' (with the uploads the show left in place, to be released). recover() at the next start
// finishes or takes back what was cut off, and running it again changes nothing:
// - moving: everything goes back where it was (the show was not deleted);
// - restoring: the rest comes back, the renamed uploads under their recorded names; the show and its
//   older versions follow them (a second time changes nothing: a free name is never one the show
//   uses); then what is left of the entry goes ('purging');
// - purging: the rest is deleted, then the uploads it left in place are released, then trash.json.
//   Emptying the trash and the expiry mark every show they delete before deleting the first one;
// - a folder without trash.json that holds nothing but temp files (a move cut off before it began, a
//   deletion cut off before its last step) is removed, and so are temp files of trash.json.
// A move or restore that fails while the app runs (a file stays busy) is taken back at once.
//
// Restoring puts everything back where it was, never over anything that is there now: a show whose id
// is taken is refused; an upload whose place is taken comes back under a free name, the show and its
// older versions follow it (with the media id of the file there), and its undo history (which no longer
// fits) goes.
//
// Uploads a show shares with another one (a duplicate) are not moved in (cleanup.ts decides what goes
// along): media() tells the clean-up what the shows in the trash still use, so nothing deletes them
// meanwhile, and the last show using them takes them along when it is deleted for good (setRelease:
// in the same step, so no delete or restore runs in between).
import { mkdir, readdir, readFile, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { validDeleteAt } from '@shared/cleanup'
import { TRASH_DAYS, type TrashContents, type TrashEntry, type TrashProblem, type TrashRefusal, type TrashRemoveResult } from '@shared/trash'
import { listDir, present } from './files'
import { mediaId } from './media/scan'
import { checkProjectId, cleanProjectText } from './projectSchema'
import { BACKUPS, PROJECT_EXT } from './projects'
import { replaceFile } from './replaceFile'
import { removeInside, sizeOf } from './safeDelete'
import { checkKey, checkRel, count, FORMAT, followFiles, ID, MANIFEST, mediaOf, parseManifest, SHOW, TRASH, type Item, type Manifest, type Rename } from './trashEntry'

const DAY = 86_400_000
/** A temp file of trash.json (writeManifest), left by a write that was cut off. */
const MANIFEST_TMP = /^trash\.json\.[\w.-]+\.tmp$/i
const low = (p: string): string => resolve(p).toLowerCase()

export interface TrashOptions {
  /** <Documents>/Diashow Studio: the show, its older versions, uploads and pasted pictures come from here. */
  projectsDir: string
  /** <userData>/trash: the undo history and export jobs go here (they live in userData). */
  dataDir: string
  /** <userData>/history (history.ts) and <userData>/exports (the export queue). */
  historyDir: string
  exportsDir: string
  /** Days in the trash (default TRASH_DAYS). */
  days?: number
  /** Clock, injectable for tests. */
  now?: () => number
  /** Notes for the log: ids and counts only. */
  log?: (message: string) => void
  /** How long a busy file is waited for (replaceFile.ts). */
  retry?: { attempts?: number; delayMs?: number }
}

/** A show to move into the trash. */
export interface TrashMove {
  id: string
  name: string
  slideCount: number
  deleteAt?: number
  faces: boolean
  /** Its uploads and pasted pictures (absolute, inside the projects folder). */
  files: string[]
  /** Its finished export jobs (folder names in exportsDir), already taken out of the queue. */
  jobs: string[]
}

export interface TrashRestored {
  id: string
  name: string
  renamed: number
  history: boolean
  /** It had an undo history that could not come back (it no longer fits the show): deleted with what was left. */
  historyDropped: boolean
  /** Export jobs whose folders are back (the queue takes them in again). */
  jobs: string[]
}

/** A photo or video of a show in the trash: its media id and where its file was (the show refers to it there). */
export interface TrashedMedia {
  id: string
  path: string
  /** A Live Photo's video. */
  live?: string
}

/**
 * Deletes the uploads and pasted pictures a show deleted for good left in place (`gone`: it shared them
 * with another show) that no show uses any more (`kept`: the photos and videos of the shows still in the
 * trash; cleanup.ts releaseMedia). Returns how many files went.
 */
export type ReleaseShared = (gone: TrashedMedia[], kept: TrashedMedia[]) => Promise<number>

/** A refusal the user is told about in plain words (TrashRefusal). */
export class TrashRefusedError extends Error {
  constructor(
    readonly code: TrashRefusal,
    message: string
  ) {
    super(message)
  }
}

export interface Trash {
  /** <projects>/.trash and <userData>/trash. */
  readonly dir: string
  readonly dataDir: string
  /**
   * A show of this id is in the trash: its file lies there (its saves are refused, an imported file gets
   * another id). Not what is left of a move taken back while a file stayed busy: that show is in use.
   */
  has(id: string): Promise<boolean>
  moveIn(move: TrashMove): Promise<TrashEntry>
  /** The shows in the trash, newest first, and what can't be read there. */
  list(): Promise<TrashContents>
  restore(id: string): Promise<TrashRestored>
  /** Deletes one entry for good (a show's id, or the folder name of a problem). */
  purge(key: string): Promise<TrashRemoveResult>
  /** Deletes everything in the trash for good. */
  empty(): Promise<TrashRemoveResult>
  /** Deletes what has been in the trash for its days; returns the keys. */
  expire(): Promise<string[]>
  /** After a crash: takes back a half-done move, finishes a restore or a purge. Returns the export jobs whose folders came back (the queue takes them in again). */
  recover(): Promise<string[]>
  /**
   * The photos and videos of each show in the trash (by id). Uploads and pasted pictures it shared with
   * another show (a duplicate) stayed in place when it moved in: it still uses them (cleanup.ts).
   */
  media(): Promise<Map<string, TrashedMedia[]>>
  /**
   * What deleting a show for good does with the uploads it left in place (cleanupMain.ts): recorded in
   * trash.json first and done before the entry's last file goes. Without it they stay.
   */
  setRelease(release: ReleaseShared | null): void
}

/** `a.jpg` → `a (2).jpg`, `a (3).jpg` …: the first name that is free and not in `avoid` (lower case). */
async function freeName(path: string, avoid: ReadonlySet<string>): Promise<string> {
  const ext = extname(path)
  const stem = path.slice(0, path.length - ext.length)
  for (let n = 2; n < 10_000; n++) {
    const p = `${stem} (${n})${ext}`
    if (!avoid.has(low(p)) && !(await present(p))) return p
  }
  throw new Error('no free name')
}

/** The order in which a restore that failed goes back into the trash: the show first. */
const RANK: Record<Item['kind'], number> = { show: 0, backups: 1, history: 2, job: 3, file: 4 }

export function createTrash(opts: TrashOptions): Trash {
  const projectsDir = resolve(opts.projectsDir)
  const dir = join(projectsDir, TRASH)
  const dataDir = resolve(opts.dataDir)
  const days = opts.days ?? TRASH_DAYS
  const now = opts.now ?? Date.now
  const log = (m: string): void => opts.log?.(m)
  const entryDir = (key: string): string => join(dir, key)
  const dataEntry = (key: string): string => join(dataDir, key)
  const manifestPath = (key: string): string => join(entryDir(key), MANIFEST)
  const named = (key: string): string => (ID.test(key) ? key : '(unnamed)')
  const code = (err: unknown): string => (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? 'error'
  let release: ReleaseShared | null = null

  /** Where an item lives as part of a show, and where it lies in the trash. */
  const place = (id: string, item: Item): string => {
    switch (item.kind) {
      case 'show':
        return join(projectsDir, `${id}${PROJECT_EXT}`)
      case 'backups':
        return join(projectsDir, BACKUPS, id)
      case 'history':
        return join(opts.historyDir, `${id}.json.gz`)
      case 'file':
        return join(projectsDir, item.path)
      case 'job':
        return join(opts.exportsDir, item.job)
    }
  }
  const inTrash = (id: string, item: Item): string => {
    switch (item.kind) {
      case 'show':
        return join(entryDir(id), SHOW)
      case 'backups':
        return join(entryDir(id), 'backups')
      case 'history':
        return join(dataEntry(id), 'history.json.gz')
      case 'file':
        return join(entryDir(id), 'files', item.path)
      case 'job':
        return join(dataEntry(id), 'exports', item.job)
    }
  }
  /** Where a restore puts an item: its place, or the free name recorded for an upload whose place was taken. */
  const destOf = (m: Manifest, item: Item): string => {
    if (item.kind === 'file') {
      const r = m.renames?.find((x) => x.path.toLowerCase() === item.path.toLowerCase())
      if (r) return join(projectsDir, r.to)
    }
    return place(m.id, item)
  }
  /** An absolute path in a subfolder of the projects folder (not the trash, not older versions): all the trash renames or releases. */
  const inProjects = (p: string): boolean => isAbsolute(p) && checkRel(relative(projectsDir, resolve(p))) !== null

  /** Ids with a folder in the trash (damaged ones too), read once. */
  const ids = new Set<string>()
  let loaded: Promise<void> | null = null
  const load = (): Promise<void> =>
    (loaded ??= listDir(dir).then((list) => {
      for (const e of list) if (ID.test(e.name)) ids.add(e.name)
    }))

  /** Changes of the trash run one after another. */
  let chain: Promise<unknown> = Promise.resolve()
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(() => load()).then(task)
    chain = next.catch(() => {})
    return next
  }

  /** Problems are logged once per start (by id; other folder names may hold a name). */
  const reported = new Set<string>()
  const report = (key: string, why: string): void => {
    if (reported.has(key)) return
    reported.add(key)
    log(`trash entry ${named(key)} ignored: ${why}`)
  }

  /** Moves a file or folder; never over something that is there (EEXIST). */
  async function move(from: string, to: string): Promise<void> {
    if (await present(to)) throw Object.assign(new Error(`EEXIST: ${basename(to)} is there already`), { code: 'EEXIST' })
    await mkdir(dirname(to), { recursive: true })
    await replaceFile(from, to, opts.retry)
  }

  async function readManifest(key: string): Promise<Manifest | null> {
    try {
      return parseManifest(await readFile(manifestPath(key), 'utf8'), key)
    } catch {
      return null
    }
  }

  async function writeManifest(m: Manifest): Promise<void> {
    const target = manifestPath(m.id)
    const tmp = `${target}.${process.pid}.${now()}.tmp`
    await writeFile(tmp, JSON.stringify(m, null, 1), 'utf8')
    try {
      await replaceFile(tmp, target, opts.retry)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
  }

  /** The description without what a step under way records. */
  const settled = (m: Manifest): Manifest => {
    const { renames: _renames, release: _release, ...rest } = m
    return rest
  }

  async function bytesOf(key: string): Promise<number> {
    return (await sizeOf(entryDir(key))).bytes + (await sizeOf(dataEntry(key))).bytes
  }

  const entryOf = (m: Manifest, bytes: number): TrashEntry => ({
    id: m.id,
    name: m.name,
    deletedAt: m.deletedAt,
    purgeAt: m.purgeAt,
    ...(m.deleteAt !== undefined ? { deleteAt: m.deleteAt } : {}),
    slideCount: m.slideCount,
    versions: m.versions,
    uploads: m.items.filter((i) => i.kind === 'file').length,
    exports: m.items.filter((i) => i.kind === 'job').length,
    faces: m.faces,
    bytes
  })

  /** The photos and videos of each show in the trash; one being deleted for good uses nothing any more, one that can't be read is never restored. */
  async function mediaNow(): Promise<Map<string, TrashedMedia[]>> {
    const out = new Map<string, TrashedMedia[]>()
    for (const e of await listDir(dir)) {
      if (!e.isDirectory() || !ID.test(e.name)) continue
      const m = await readManifest(e.name)
      if (!m || m.state === 'purging') continue
      const text = await readFile(inTrash(m.id, { kind: 'show' }), 'utf8').catch(() => null)
      if (text !== null) out.set(m.id, mediaOf(text))
    }
    return out
  }

  /** The photos and videos of a show in the trash that it left in place (it shared them with another show when it moved in). */
  async function sharedOf(m: Manifest): Promise<TrashedMedia[]> {
    const text = await readFile(inTrash(m.id, { kind: 'show' }), 'utf8').catch(() => null)
    if (text === null) return []
    const moved = new Set(m.items.flatMap((i) => (i.kind === 'file' ? [low(place(m.id, i))] : [])))
    const left = (p: string | undefined): p is string => !!p && inProjects(p) && !moved.has(low(p))
    return mediaOf(text).flatMap((x) => (left(x.path) ? [left(x.live) ? { id: x.id, path: x.path, live: x.live } : { id: x.id, path: x.path }] : []))
  }

  /** Moves the items of a half-done move back where they were; returns those that could not go back. */
  async function takeBack(id: string, items: Item[]): Promise<Item[]> {
    const left: Item[] = []
    for (const item of [...items].reverse()) {
      const from = inTrash(id, item)
      if (!(await present(from))) continue
      try {
        await move(from, place(id, item))
      } catch (err) {
        left.push(item)
        log(`trash: ${item.kind} of ${id} could not be put back (${code(err)})`)
      }
    }
    return left
  }

  /**
   * Deletes what is left of an entry: everything but its description first; then the uploads it left in
   * place (`shared`) once no show uses them; then the description. A step cut off is finished later.
   */
  async function removeEntry(key: string, shared: readonly TrashedMedia[] = []): Promise<TrashRemoveResult> {
    const entry = entryDir(key)
    const first = await removeInside([dataEntry(key), entry], [dataDir, dir], [manifestPath(key)])
    const failed = [...first.failed, ...first.refused]
    let { files, bytes } = first
    let released = true
    const gone = shared.flatMap((x) => (inProjects(x.path) ? [x.live && !inProjects(x.live) ? { id: x.id, path: x.path } : x] : []))
    if (gone.length && release) {
      try {
        const n = await release(gone, [...(await mediaNow()).values()].flat())
        if (n) log(`trash entry ${named(key)}: ${n} shared uploads deleted, no show uses them any more`)
      } catch (err) {
        // tried again with the next expiry (its description keeps them); busy files are reported like the entry's own
        released = false
        failed.push(...((err as { failed?: string[] }).failed ?? []))
        log(`trash: the shared uploads of ${named(key)} were not released (${code(err)})`)
      }
    }
    if (!failed.length && released) {
      const rest = await removeInside([entry], [dir])
      files += rest.files
      bytes += rest.bytes
      failed.push(...rest.failed, ...rest.refused)
    }
    if (!(await present(entry))) ids.delete(key)
    return { files, bytes, failed }
  }

  /** Marks a show as being deleted for good, with the uploads it left in place: written before anything goes. */
  async function markPurging(m: Manifest): Promise<Manifest> {
    const shared = m.release ?? (release ? await sharedOf(m) : [])
    const next: Manifest = { ...settled(m), state: 'purging', ...(shared.length ? { release: shared } : {}) }
    if (m.state !== 'purging' || (shared.length && !m.release)) await writeManifest(next)
    return next
  }

  async function purgeOne(key: string): Promise<TrashRemoveResult> {
    checkKey(key)
    let m = ID.test(key) ? await readManifest(key) : null
    // a move or restore under way is taken back or finished by recover(), never deleted half
    if (m?.state === 'moving' || m?.state === 'restoring') throw new TrashRefusedError('not-found', `a change of ${key} is under way`)
    if (m) m = await markPurging(m)
    const r = await removeEntry(key, m?.release)
    log(`trash entry ${named(key)} deleted for good: ${r.files} files${r.failed.length ? `, ${r.failed.length} not deleted (in use)` : ''}`)
    return r
  }

  /** The places of a show's uploads and every file its project names: never taken as a free name, so following the renames twice changes nothing. */
  async function namesInUse(m: Manifest): Promise<Set<string>> {
    const names = new Set<string>()
    for (const item of m.items) if (item.kind === 'file') names.add(low(place(m.id, item)))
    for (const r of m.renames ?? []) names.add(low(join(projectsDir, r.to)))
    const text = (await readFile(inTrash(m.id, { kind: 'show' }), 'utf8').catch(() => null)) ?? (await readFile(place(m.id, { kind: 'show' }), 'utf8').catch(() => null))
    for (const x of text === null ? [] : mediaOf(text)) for (const p of [x.path, x.live]) if (p && isAbsolute(p)) names.add(low(p))
    return names
  }

  /**
   * Where each upload still in the trash goes back to: its place, or a free name next to it while
   * another file is there. Returns the description with the renames (the same one when nothing changed);
   * uploads back already keep theirs.
   */
  async function planRenames(m: Manifest): Promise<Manifest> {
    const planned = new Map((m.renames ?? []).map((r) => [r.path.toLowerCase(), r]))
    let names: Set<string> | null = null
    let changed = false
    for (const item of m.items) {
      if (item.kind !== 'file' || !(await present(inTrash(m.id, item)))) continue
      const key = item.path.toLowerCase()
      const to = place(m.id, item)
      const r = planned.get(key)
      if (!(await present(to))) {
        // its place is free (again)
        if (r) {
          planned.delete(key)
          changed = true
        }
        continue
      }
      if (r && !(await present(join(projectsDir, r.to)))) continue
      names ??= await namesInUse(m)
      const free = await freeName(to, names)
      names.add(low(free))
      const rel = checkRel(relative(projectsDir, free))
      if (!rel) throw new Error('no free name')
      planned.set(key, { path: item.path, to: rel })
      changed = true
    }
    if (!changed) return m
    const renames: Rename[] = [...planned.values()]
    const { renames: _old, ...rest } = m
    return renames.length ? { ...rest, renames } : rest
  }

  /** A restore that failed goes back into the trash: everything that left it (also before a crash), the show first. */
  async function takeBackRestore(m: Manifest): Promise<void> {
    const id = m.id
    for (const item of [...m.items].sort((a, b) => RANK[a.kind] - RANK[b.kind])) {
      const from = inTrash(id, item)
      const to = destOf(m, item)
      // still in the trash (also an undo history or a job left there because its place was taken)
      if ((await present(from)) || !(await present(to))) continue
      await move(to, from).catch((e: unknown) => log(`trash: a part of ${id} could not be put back into the trash (${code(e)})`))
    }
    // an upload that could not go back keeps its recorded name: the show follows it when it is restored
    const renames: Rename[] = []
    for (const r of m.renames ?? []) if (!(await present(inTrash(id, { kind: 'file', path: r.path })))) renames.push(r)
    await writeManifest({ ...settled(m), state: 'trashed', ...(renames.length ? { renames } : {}) }).catch(() => {})
  }

  /**
   * Puts a show back (state 'restoring'); on failure everything goes back into the trash. Also finishes a
   * restore a crash cut off: what is no longer in the trash is where the recorded plan put it.
   */
  async function putBack(m0: Manifest): Promise<TrashRestored> {
    const id = m0.id
    const m = await planRenames(m0)
    // a new free name is recorded before anything moves to it
    if (m !== m0) await writeManifest({ ...m, state: 'restoring' })
    const renamed = new Map((m.renames ?? []).map((r) => [low(join(projectsDir, r.path)), join(projectsDir, r.to)]))
    try {
      // the uploads first (the show refers to them), the show itself last
      for (const item of m.items) {
        if (item.kind !== 'file') continue
        const from = inTrash(id, item)
        if (await present(from)) await move(from, destOf(m, item))
      }
      for (const item of m.items) {
        if (item.kind !== 'job') continue
        const from = inTrash(id, item)
        // a job folder of the same name (ids are random): this one goes with the entry
        if ((await present(from)) && !(await present(place(id, item)))) await move(from, place(id, item))
      }
      for (const kind of ['history', 'backups', 'show'] as const) {
        const item = m.items.find((i) => i.kind === kind)
        if (!item) continue
        const from = inTrash(id, item)
        const to = place(id, item)
        if (!(await present(from))) continue // back already (a restore cut off before)
        // the history belongs to the show's text: it doesn't fit once the show follows renamed uploads
        if (kind === 'history' && (renamed.size || (await present(to)))) continue
        if (kind === 'show' && (await present(to))) throw new TrashRefusedError('id-taken', `the id ${id} belongs to another show`)
        await move(from, to)
      }
    } catch (err) {
      await takeBackRestore(m)
      throw err
    }
    if (renamed.size) await followRenamed(id, renamed)
    const jobs: string[] = []
    for (const item of m.items) if (item.kind === 'job' && !(await present(inTrash(id, item))) && (await present(place(id, item)))) jobs.push(item.job)
    const hadHistory = m.items.some((i) => i.kind === 'history')
    const historyDropped = hadHistory && (await present(inTrash(id, { kind: 'history' })))
    // the show is back: what is left in the trash (an undo history that no longer fits, a job whose name
    // was taken) goes for good, and recover() never follows the renames again
    try {
      await writeManifest({ ...settled(m), state: 'purging' })
      await removeEntry(id)
    } catch (err) {
      log(`trash: what is left of ${id} after its restore stays for now (${code(err)})`)
    }
    log(`show ${id} restored from the trash${renamed.size ? `, ${renamed.size} uploads under another name` : ''}${historyDropped ? ', without its undo history' : ''}`)
    return { id, name: m.name, renamed: renamed.size, history: hadHistory && !historyDropped, historyDropped, jobs }
  }

  /**
   * The show and its older versions point at uploads that came back under another name. Each file is
   * rewritten through a temp file with its old times; one rewritten before is left as it is (no free
   * name is one the show uses), so a restore cut off follows them once more without harm.
   */
  async function followRenamed(id: string, renamed: ReadonlyMap<string, string>): Promise<void> {
    // the media ids of the files at their new places (a rename keeps size and time)
    const mids = new Map<string, string>()
    for (const [old, dest] of renamed) {
      const st = await stat(dest).catch(() => null)
      if (st?.isFile()) mids.set(old, mediaId(dest, st.size, st.mtimeMs))
    }
    const files = [place(id, { kind: 'show' })]
    const folder = place(id, { kind: 'backups' })
    for (const n of await readdir(folder).catch(() => [] as string[])) if (n.toLowerCase().endsWith(PROJECT_EXT)) files.push(join(folder, n))
    for (const file of files) {
      const tmp = `${file}.trash.tmp`
      try {
        // what a rewrite cut off left behind
        await rm(tmp, { force: true })
        const st = await stat(file)
        const p = JSON.parse(cleanProjectText(await readFile(file, 'utf8'))) as unknown
        if (!followFiles(p, renamed, mids)) continue
        await writeFile(tmp, JSON.stringify(p, null, 1), 'utf8')
        // an older version's time is in its name, and the show's file time decides its next backup
        await utimes(tmp, st.atime, st.mtime).catch(() => {})
        await replaceFile(tmp, file, opts.retry)
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {})
        log(`trash: a version of ${id} could not follow its renamed uploads (${code(err)})`)
      }
    }
  }

  /** A folder in the trash without a description that holds nothing but temp files of one (and empty folders). */
  async function scratchOnly(key: string): Promise<boolean> {
    if (await present(dataEntry(key))) return false
    const walk = async (folder: string, top: boolean, depth: number): Promise<boolean> => {
      if (depth > 12) return false
      for (const e of await listDir(folder)) {
        if (e.isDirectory() && !e.isSymbolicLink()) {
          if (!(await walk(join(folder, e.name), false, depth + 1))) return false
        } else if (!(top && e.isFile() && MANIFEST_TMP.test(e.name))) return false
      }
      return true
    }
    return walk(entryDir(key), true, 0)
  }

  /** Temp files a write of trash.json left behind. */
  async function removeTemps(key: string): Promise<void> {
    const temps = (await listDir(entryDir(key))).filter((e) => e.isFile() && MANIFEST_TMP.test(e.name)).map((e) => join(entryDir(key), e.name))
    if (temps.length) await removeInside(temps, [dir])
  }

  return {
    dir,
    dataDir,

    async has(id) {
      await load()
      return ids.has(id) && present(inTrash(id, { kind: 'show' }))
    },

    moveIn(mv) {
      return serial(async () => {
        const id = checkProjectId(mv.id)
        if (await present(entryDir(id))) throw new Error(`the trash still holds an entry of ${id}`)
        // what userData kept of an entry whose folder in the projects folder went (it can't come back)
        if (await present(dataEntry(id))) await removeInside([dataEntry(id)], [dataDir])
        if (!(await present(place(id, { kind: 'show' })))) throw new TrashRefusedError('not-found', `no show ${id}`)
        const items: Item[] = [{ kind: 'show' }]
        for (const item of [{ kind: 'backups' }, { kind: 'history' }] as Item[]) if (await present(place(id, item))) items.push(item)
        const seen = new Set<string>()
        for (const f of mv.files) {
          const path = checkRel(relative(projectsDir, resolve(String(f))))
          if (path && !seen.has(path.toLowerCase()) && (await present(join(projectsDir, path)))) {
            seen.add(path.toLowerCase())
            items.push({ kind: 'file', path })
          }
        }
        for (const job of new Set(mv.jobs)) if (ID.test(job) && (await present(place(id, { kind: 'job', job })))) items.push({ kind: 'job', job })
        const versions = (await readdir(place(id, { kind: 'backups' })).catch(() => [] as string[])).filter((n) => n.toLowerCase().endsWith(PROJECT_EXT)).length
        const t = now()
        const m: Manifest = {
          format: FORMAT,
          version: 1,
          id,
          name: String(mv.name ?? '').slice(0, 300),
          state: 'moving',
          deletedAt: t,
          purgeAt: t + days * DAY,
          ...(validDeleteAt(mv.deleteAt) ? { deleteAt: mv.deleteAt } : {}),
          slideCount: count(mv.slideCount),
          versions,
          faces: mv.faces === true,
          items
        }
        await mkdir(entryDir(id), { recursive: true })
        ids.add(id)
        const done: Item[] = []
        try {
          await writeManifest(m)
          // the show first: when it is busy, nothing else has moved yet
          for (const item of items) {
            await move(place(id, item), inTrash(id, item))
            done.push(item)
          }
          await writeManifest({ ...m, state: 'trashed' })
        } catch (err) {
          const left = await takeBack(id, done)
          // what could not go back stays in the trash, where it can be restored; never deleted here
          if (left.length) await writeManifest({ ...m, state: 'trashed', items: left }).catch(() => {})
          else await removeEntry(id).catch(() => {})
          log(`show ${id} not moved to the trash: ${code(err)}`)
          throw err
        }
        log(`show ${id} moved to the trash: ${items.filter((i) => i.kind === 'file').length} uploads, ${items.filter((i) => i.kind === 'job').length} export jobs, ${versions} older versions`)
        return entryOf({ ...m, state: 'trashed' }, await bytesOf(id))
      })
    },

    async list() {
      await load()
      const entries: TrashEntry[] = []
      const problems: TrashProblem[] = []
      const seen = new Set<string>()
      for (const e of await listDir(dir)) {
        const key = e.name
        seen.add(key.toLowerCase())
        const m = e.isDirectory() && ID.test(key) ? await readManifest(key) : null
        // a move or restore under way
        if (m?.state === 'moving' || m?.state === 'restoring') continue
        const bytes = await bytesOf(key)
        if (m?.state === 'trashed') entries.push(entryOf(m, bytes))
        else {
          problems.push({ key, bytes })
          report(key, m ? 'not completely deleted' : 'no readable description')
        }
      }
      // what userData keeps of an entry whose folder in the projects folder is gone
      for (const e of await listDir(dataDir)) {
        if (seen.has(e.name.toLowerCase())) continue
        problems.push({ key: e.name, bytes: (await sizeOf(dataEntry(e.name))).bytes })
        report(e.name, 'only its undo history or export jobs are left')
      }
      entries.sort((a, b) => b.deletedAt - a.deletedAt || a.name.localeCompare(b.name))
      const bytes = entries.reduce((n, x) => n + x.bytes, 0) + problems.reduce((n, x) => n + x.bytes, 0)
      return { entries, problems, bytes }
    },

    restore(id) {
      return serial(async () => {
        checkProjectId(id)
        const m = await readManifest(id)
        if (!m || (m.state !== 'trashed' && m.state !== 'restoring')) throw new TrashRefusedError('not-found', `no show ${id} in the trash`)
        // the id must be free: no show and no older versions under it
        if (await present(place(id, { kind: 'show' }))) throw new TrashRefusedError('id-taken', `the id ${id} belongs to another show`)
        const backups = place(id, { kind: 'backups' })
        if (await present(backups)) {
          if ((await readdir(backups).catch(() => ['?'])).length) throw new TrashRefusedError('id-taken', `older versions of another show ${id}`)
          await rmdir(backups)
        }
        // where each upload goes back to (a free name where another file is now) is recorded before anything moves
        const planned: Manifest = { ...(await planRenames(m)), state: 'restoring' }
        await writeManifest(planned)
        return putBack(planned)
      })
    },

    purge(key) {
      return serial(() => purgeOne(key))
    },

    empty() {
      return serial(async () => {
        const keys = [...new Set([...(await listDir(dir)), ...(await listDir(dataDir))].map((e) => e.name))]
        // every show is marked first (with the uploads it left in place): after a crash the marked ones are finished
        const go: string[] = []
        for (const key of keys) {
          const m = ID.test(key) ? await readManifest(key) : null
          // a move or restore under way is not in the list: recover() takes it back or finishes it
          if (m?.state === 'moving' || m?.state === 'restoring') continue
          if (m) await markPurging(m)
          go.push(key)
        }
        const total: TrashRemoveResult = { files: 0, bytes: 0, failed: [] }
        for (const key of go) {
          const r = await purgeOne(key)
          total.files += r.files
          total.bytes += r.bytes
          total.failed.push(...r.failed)
        }
        return total
      })
    },

    expire() {
      return serial(async () => {
        const t = now()
        const due: string[] = []
        const shows: Manifest[] = []
        const seen = new Set<string>()
        // an unreadable entry goes by the time its folder was last changed
        const old = async (p: string): Promise<boolean> => (await stat(p).then((s) => s.mtimeMs, () => t)) + days * DAY <= t
        for (const e of await listDir(dir)) {
          seen.add(e.name.toLowerCase())
          const m = e.isDirectory() && ID.test(e.name) ? await readManifest(e.name) : null
          if (m ? m.state === 'purging' || (m.state === 'trashed' && m.purgeAt <= t) : await old(entryDir(e.name))) {
            due.push(e.name)
            if (m) shows.push(m)
          }
        }
        for (const e of await listDir(dataDir)) if (!seen.has(e.name.toLowerCase()) && (await old(dataEntry(e.name)))) due.push(e.name)
        // every show that is due is marked first, as when the trash is emptied
        for (const m of shows) await markPurging(m).catch((err: unknown) => log(`trash entry ${m.id} not marked for deletion: ${code(err)}`))
        for (const key of due) await purgeOne(key).catch((err: unknown) => log(`trash entry could not be deleted: ${code(err)}`))
        return due
      })
    },

    recover() {
      return serial(async () => {
        const jobs: string[] = []
        /** The jobs among `items` that are no longer `left` in the trash. */
        const back = (items: Item[], left: Item[]): string[] =>
          items.flatMap((i) => (i.kind === 'job' && !left.some((l) => l.kind === 'job' && l.job === i.job) ? [i.job] : []))
        for (const e of await listDir(dir)) {
          if (!e.isDirectory() || e.isSymbolicLink()) continue
          const m = ID.test(e.name) ? await readManifest(e.name) : null
          try {
            if (!m) {
              // a move cut off before its description was written, a deletion before its last step
              if (await scratchOnly(e.name)) {
                await removeInside([entryDir(e.name)], [dir])
                if (!(await present(entryDir(e.name)))) ids.delete(e.name)
                log(`trash: the empty folder of ${named(e.name)} was removed`)
              }
              continue
            }
            await removeTemps(m.id)
            if (m.state === 'moving') {
              // the app stopped while a show was being moved: it goes back
              const left = await takeBack(m.id, m.items)
              jobs.push(...back(m.items, left))
              if (left.length) await writeManifest({ ...m, state: 'trashed', items: left })
              else await removeEntry(m.id)
              log(`trash: an interrupted move of ${m.id} was taken back`)
            } else if (m.state === 'trashed' && !(await present(inTrash(m.id, { kind: 'show' }))) && (await present(place(m.id, { kind: 'show' })))) {
              // a move taken back while a file stayed busy: the show is in use again, the rest follows it now
              const left = await takeBack(m.id, m.items)
              jobs.push(...back(m.items, left))
              if (left.length) await writeManifest({ ...m, items: left })
              else await removeEntry(m.id)
              log(`trash: what was left of a move of ${m.id} that was taken back ${left.length ? 'stays in the trash (in use)' : 'came back'}`)
            } else if (m.state === 'restoring') {
              jobs.push(...(await putBack(m)).jobs)
              log(`trash: an interrupted restore of ${m.id} was finished`)
            } else if (m.state === 'purging') {
              await purgeOne(m.id)
            }
          } catch (err) {
            log(`trash: ${m?.state} of ${named(e.name)} not finished (${code(err)})`)
          }
        }
        return jobs
      })
    },

    media() {
      return serial(mediaNow)
    },

    setRelease(fn) {
      release = fn
    }
  }
}
