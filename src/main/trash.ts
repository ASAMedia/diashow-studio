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
// trash.json records how far a change got ('moving', 'trashed', 'restoring', 'purging'): after a crash,
// recover() takes a half-done move back and finishes a restore or a purge. A move or restore that fails
// (a file stays busy) is taken back at once. trash.json and how it is checked when read: trashEntry.ts.
//
// Restoring puts everything back where it was, never over anything that is there now: a show whose id
// is taken is refused; an upload whose place is taken comes back under a free name, the show and its
// older versions follow it, and its undo history (which no longer fits) goes.
//
// Uploads a show shares with another one (a duplicate) are not moved in (cleanup.ts decides what goes
// along): media() tells the clean-up what the shows in the trash still use, so nothing deletes them
// meanwhile, and the last show using them takes them along when it is deleted for good.
import { mkdir, readdir, readFile, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { validDeleteAt } from '@shared/cleanup'
import { TRASH_DAYS, type TrashContents, type TrashEntry, type TrashProblem, type TrashRefusal, type TrashRemoveResult } from '@shared/trash'
import { listDir, present } from './files'
import { checkProjectId, cleanProjectText } from './projectSchema'
import { BACKUPS, PROJECT_EXT } from './projects'
import { replaceFile } from './replaceFile'
import { removeInside, sizeOf } from './safeDelete'
import { checkKey, checkRel, count, FORMAT, followFiles, ID, MANIFEST, mediaOf, parseManifest, SHOW, TRASH, type Item, type Manifest } from './trashEntry'

const DAY = 86_400_000

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
  /** A show of this id is in the trash (its saves are refused, an imported file gets another id). */
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
  /** After a crash: takes back a half-done move, finishes a restore or a purge. */
  recover(): Promise<void>
  /**
   * The photos and videos of each show in the trash (by id). Uploads and pasted pictures it shared with
   * another show (a duplicate) stayed in place when it moved in: it still uses them (cleanup.ts).
   */
  media(): Promise<Map<string, TrashedMedia[]>>
}

/** `a.jpg` → `a (2).jpg`, `a (3).jpg` …: the first name that is free. */
async function freeName(path: string): Promise<string> {
  const ext = extname(path)
  const stem = path.slice(0, path.length - ext.length)
  for (let n = 2; n < 10_000; n++) {
    const p = `${stem} (${n})${ext}`
    if (!(await present(p))) return p
  }
  throw new Error('no free name')
}

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
    log(`trash entry ${ID.test(key) ? key : '(unnamed)'} ignored: ${why}`)
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
        log(`trash: ${item.kind} of ${id} could not be put back (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
      }
    }
    return left
  }

  /** Deletes what is left of an entry (a description first, so a cut-off purge is finished later). */
  async function removeEntry(key: string): Promise<TrashRemoveResult> {
    const entry = entryDir(key)
    const first = await removeInside([dataEntry(key), entry], [dataDir, dir], [manifestPath(key)])
    const failed = [...first.failed, ...first.refused]
    let { files, bytes } = first
    if (!failed.length) {
      const rest = await removeInside([entry], [dir])
      files += rest.files
      bytes += rest.bytes
      failed.push(...rest.failed, ...rest.refused)
    }
    if (!(await present(entry))) ids.delete(key)
    return { files, bytes, failed }
  }

  async function purgeOne(key: string): Promise<TrashRemoveResult> {
    checkKey(key)
    const m = ID.test(key) ? await readManifest(key) : null
    if (m && m.state !== 'purging') await writeManifest({ ...m, state: 'purging' }).catch(() => {})
    const r = await removeEntry(key)
    log(`trash entry ${ID.test(key) ? key : '(unnamed)'} deleted for good: ${r.files} files${r.failed.length ? `, ${r.failed.length} not deleted (in use)` : ''}`)
    return r
  }

  /** Puts a show back (state 'restoring'); on failure everything goes back into the trash. */
  async function putBack(m: Manifest): Promise<TrashRestored> {
    const id = m.id
    const done: [string, string][] = []
    const renamed = new Map<string, string>()
    const jobs: string[] = []
    let history = false
    const back = async (from: string, to: string): Promise<void> => {
      await move(from, to)
      done.push([from, to])
    }
    try {
      // the uploads first (the show refers to them), the show itself last
      for (const item of m.items) {
        if (item.kind !== 'file') continue
        const from = inTrash(id, item)
        const to = place(id, item)
        if (!(await present(from))) continue // back already (a restore cut off before)
        const dest = (await present(to)) ? await freeName(to) : to
        await back(from, dest)
        if (dest !== to) renamed.set(resolve(to).toLowerCase(), dest)
      }
      for (const item of m.items) {
        if (item.kind !== 'job') continue
        const from = inTrash(id, item)
        // a job folder of the same name (ids are random): this one goes with the entry
        if (!(await present(from)) || (await present(place(id, item)))) continue
        await back(from, place(id, item))
        jobs.push(item.job)
      }
      for (const kind of ['history', 'backups', 'show'] as const) {
        const item = m.items.find((i) => i.kind === kind)
        if (!item) continue
        const from = inTrash(id, item)
        const to = place(id, item)
        if (!(await present(from))) continue
        // the history belongs to the show's text: it doesn't fit once the show follows renamed uploads
        if (kind === 'history' && (renamed.size || (await present(to)))) continue
        if (kind === 'show' && (await present(to))) throw new TrashRefusedError('id-taken', `the id ${id} belongs to another show`)
        await back(from, to)
        if (kind === 'history') history = true
      }
    } catch (err) {
      for (const [from, to] of done.reverse()) {
        await move(to, from).catch((e: NodeJS.ErrnoException) => log(`trash: a part of ${id} could not be put back into the trash (${e.code ?? 'error'})`))
      }
      await writeManifest({ ...m, state: 'trashed' }).catch(() => {})
      throw err
    }
    if (renamed.size) await followRenamed(id, renamed)
    // done: the description goes first (the show is no longer in the trash), then what is left
    await removeInside([manifestPath(id)], [dir])
    ids.delete(id)
    await removeEntry(id)
    log(`show ${id} restored from the trash${renamed.size ? `, ${renamed.size} uploads under another name` : ''}${history ? '' : ', without its undo history'}`)
    return { id, name: m.name, renamed: renamed.size, history, jobs }
  }

  /** The show and its older versions point at uploads that came back under another name. */
  async function followRenamed(id: string, renamed: ReadonlyMap<string, string>): Promise<void> {
    const files = [place(id, { kind: 'show' })]
    const folder = place(id, { kind: 'backups' })
    for (const n of await readdir(folder).catch(() => [] as string[])) if (n.toLowerCase().endsWith(PROJECT_EXT)) files.push(join(folder, n))
    for (const file of files) {
      try {
        const st = await stat(file)
        const p = JSON.parse(cleanProjectText(await readFile(file, 'utf8'))) as unknown
        if (!followFiles(p, renamed)) continue
        const tmp = `${file}.${process.pid}.${now()}.tmp`
        await writeFile(tmp, JSON.stringify(p, null, 1), 'utf8')
        await replaceFile(tmp, file, opts.retry)
        // an older version's time is in its name, and the show's file time decides its next backup
        await utimes(file, st.atime, st.mtime).catch(() => {})
      } catch (err) {
        log(`trash: a version of ${id} could not follow its renamed uploads (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
      }
    }
  }

  return {
    dir,
    dataDir,

    async has(id) {
      await load()
      return ids.has(id)
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
          else await removeEntry(id)
          log(`show ${id} not moved to the trash: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`)
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
        await writeManifest({ ...m, state: 'restoring' })
        return putBack(m)
      })
    },

    purge(key) {
      return serial(() => purgeOne(key))
    },

    empty() {
      return serial(async () => {
        const keys = new Set([...(await listDir(dir)), ...(await listDir(dataDir))].map((e) => e.name))
        const total: TrashRemoveResult = { files: 0, bytes: 0, failed: [] }
        for (const key of keys) {
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
        const seen = new Set<string>()
        // an unreadable entry goes by the time its folder was last changed
        const old = async (p: string): Promise<boolean> => (await stat(p).then((s) => s.mtimeMs, () => t)) + days * DAY <= t
        for (const e of await listDir(dir)) {
          seen.add(e.name.toLowerCase())
          const m = e.isDirectory() && ID.test(e.name) ? await readManifest(e.name) : null
          if (m ? m.state === 'purging' || (m.state === 'trashed' && m.purgeAt <= t) : await old(entryDir(e.name))) due.push(e.name)
        }
        for (const e of await listDir(dataDir)) if (!seen.has(e.name.toLowerCase()) && (await old(dataEntry(e.name)))) due.push(e.name)
        for (const key of due) await purgeOne(key).catch((err: Error) => log(`trash entry could not be deleted: ${err.message}`))
        return due
      })
    },

    recover() {
      return serial(async () => {
        for (const e of await listDir(dir)) {
          if (!e.isDirectory() || !ID.test(e.name)) continue
          const m = await readManifest(e.name)
          try {
            if (m?.state === 'moving') {
              // the app stopped while a show was being moved: it goes back
              const left = await takeBack(m.id, m.items)
              if (left.length) await writeManifest({ ...m, state: 'trashed' })
              else await removeEntry(m.id)
              log(`trash: an interrupted move of ${m.id} was taken back`)
            } else if (m?.state === 'restoring') {
              await putBack(m)
            } else if (m?.state === 'purging') {
              await purgeOne(m.id)
            }
          } catch (err) {
            log(`trash: ${m?.state} of ${e.name} not finished (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`)
          }
        }
      })
    },

    media() {
      return serial(async () => {
        const out = new Map<string, TrashedMedia[]>()
        for (const e of await listDir(dir)) {
          if (!e.isDirectory() || !ID.test(e.name)) continue
          // an entry being deleted for good uses nothing any more; one that can't be read is never restored
          const m = await readManifest(e.name)
          if (!m || m.state === 'purging') continue
          const text = await readFile(inTrash(m.id, { kind: 'show' }), 'utf8').catch(() => null)
          if (text !== null) out.set(m.id, mediaOf(text))
        }
        return out
      })
    }
  }
}
