// Projects are stored as `<id>.dshow` JSON files in Documents\Diashow Studio (directory injected).
// Before a save overwrites a project, the previous version is copied to
// `.backups/<id>/<yyyyMMdd-HHmmss>.dshow` (named by the time it was saved), at most every
// 10 minutes per project; the newest 20 are kept. The first save of a session backs up the version
// on disk only when it is older than that (the state a previous session left), so quick successive
// saves of a new project create no backups.
//
// Every project read from disk is migrated and validated (projectSchema.ts): broken parts are dropped or
// repaired and reported through `onReport`; when data was lost, the file as it was is kept as a backup
// first. Files that cannot be read at all are listed by damaged() and can be rescued with repair().
import { copyFile, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { DamagedProject, ProjectReportEvent, RepairChoice, RepairPlan, RepairReport } from '@shared/diagnostics'
import type { BackupInfo, Project, ProjectSummary } from '@shared/types'
import { validDeleteAt } from '@shared/cleanup'
import { cleanProjectText, formatVersion, hasChanges, lostData, PROJECT_VERSION, ProjectFormatError, readProjectText } from './projectSchema'
import { replaceFile } from './replaceFile'

export const PROJECT_EXT = '.dshow'
export const BACKUPS = '.backups'
const BACKUP_NAME = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.dshow$/i

export interface ProjectStoreOptions {
  /** Minimum time between two backups of a project, ms (default 10 minutes). */
  backupInterval?: number
  /** Backups kept per project (default 20). */
  keepBackups?: number
  /** Clock, injectable for tests. */
  now?: () => number
  /** A project read from disk had to be repaired (dropped or fixed parts). */
  onReport?: (event: ProjectReportEvent) => void
}

export interface ProjectReferences {
  /** Media and music ids used by saved projects. */
  ids: Set<string>
  /** Original files (media, Live Photo videos, music) used by saved projects. */
  paths: string[]
}

export interface ProjectStore {
  readonly dir: string
  list(): Promise<ProjectSummary[]>
  /** `onRead`: the file's text as read, and whether validation had to drop parts of it (for the undo history, history.ts). */
  load(id: string, onRead?: (text: string, repaired: boolean) => void): Promise<Project>
  /** `onWritten`: the text just written, called before the next save of the project may start. */
  save(project: Project, onWritten?: (text: string) => void): Promise<void>
  delete(id: string): Promise<void>
  /** Everything the saved projects (but `except`) refer to (for the cache cleanup). */
  references(except?: string): Promise<ProjectReferences>
  /**
   * The clean-up: writes a project without backing up the version on disk (it holds what was just
   * removed), and rewrites its readable backups with `fn`; the backup's file name (its time) stays.
   */
  overwrite(project: Project): Promise<void>
  rewriteBackups(id: string, fn: (p: Project) => Project): Promise<{ rewritten: number; failed: number }>
  /** Folder of a project's backups (`.backups/<id>`). */
  backupFolder(id: string): string
  /** Backups of a project, newest first. */
  listBackups(id: string): Promise<BackupInfo[]>
  /** Makes a backup the current version (backing up the current one first) and returns it. */
  restoreBackup(file: string): Promise<Project>
  /** A project as load() returns it (`onRead` too), without reporting, backing up or anything else (diagnostics, the deletion reminder). */
  peek(id: string, onRead?: (text: string, repaired: boolean) => void): Promise<Project>
  /** Project files that cannot be opened: unreadable or broken ('damaged'), or from a newer app ('too-new'). */
  damaged(): Promise<DamagedProject[]>
  /** What can be rescued from a damaged project file, and its backups. */
  inspectRepair(id: string): Promise<RepairPlan>
  /**
   * Replaces a damaged project with what could be rescued from it, or with one of its backups. The
   * damaged file is kept next to the backups (`<time>.damaged`).
   */
  repair(id: string, choice: RepairChoice): Promise<Project>
}

/** Ids become file names; only allow safe characters so an id can never escape the folder. */
function checkId(id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`invalid project id: ${String(id)}`)
  return id
}

export function summarize(project: Project): ProjectSummary {
  const media = new Map(project.media.map((m) => [m.id, m]))
  const firstPhoto = project.entries.find((e) => e.type === 'photo')
  const cover = firstPhoto && firstPhoto.type === 'photo' ? media.get(firstPhoto.mediaId)?.thumb : undefined
  const summary: ProjectSummary = {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    slideCount: project.entries.length
  }
  if (cover) summary.cover = cover
  if (validDeleteAt(project.deleteAt)) summary.deleteAt = project.deleteAt
  return summary
}

const pad = (n: number, len = 2): string => String(n).padStart(len, '0')

/** Local time as yyyyMMdd-HHmmss. */
export function backupStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** Save time encoded in a backup file name (local time), or null. */
export function backupTime(name: string): number | null {
  const m = BACKUP_NAME.exec(name)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  const t = new Date(y, mo - 1, d, h, mi, s).getTime()
  return Number.isFinite(t) ? t : null
}

/** The raw JSON of a project file (for summaries and references), or null when unreadable. */
async function readProject(path: string): Promise<Project | null> {
  try {
    const p = JSON.parse(cleanProjectText(await readFile(path, 'utf8'))) as Project
    return p && typeof p === 'object' && Array.isArray(p.entries) ? p : null
  } catch {
    return null
  }
}

/** A project file read, migrated and validated, with its text; throws ProjectFormatError. */
async function readChecked(path: string, opts: { fallbackId?: string; salvage?: boolean } = {}): Promise<{ project: Project; report: RepairReport; text: string }> {
  const text = await readFile(path, 'utf8')
  return { ...readProjectText(text, opts), text }
}

/** The project name in the text of a damaged file, if it is still there. */
function nameIn(text: string): string | undefined {
  const m = /"name"\s*:\s*"((?:[^"\\]|\\.){0,200})"/.exec(text)
  if (!m) return undefined
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return undefined
  }
}

export function createProjectStore(dir: string, opts: ProjectStoreOptions = {}): ProjectStore {
  const interval = opts.backupInterval ?? 10 * 60_000
  const keep = opts.keepBackups ?? 20
  const now = opts.now ?? Date.now
  const file = (id: string): string => join(dir, `${checkId(id)}${PROJECT_EXT}`)
  const backupDir = (id: string): string => join(dir, BACKUPS, checkId(id))
  /** Per project: when this process last made a backup, or first saved it (time of the action). */
  const lastBackup = new Map<string, number>()
  /** Saves and restores of one project run one after another. */
  const queues = new Map<string, Promise<unknown>>()

  function serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const next = (queues.get(id) ?? Promise.resolve()).then(task, task)
    const settled = next.catch(() => {})
    queues.set(id, settled)
    void settled.then(() => {
      if (queues.get(id) === settled) queues.delete(id)
    })
    return next
  }

  /** Writes a project file through a temp file; returns the text written. */
  async function writeAtomic(target: string, project: Project): Promise<string> {
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.${now()}.tmp`
    const text = JSON.stringify(project, null, 1)
    await writeFile(tmp, text, 'utf8')
    try {
      // the project list may be reading the file right now, or a virus scanner may hold it
      await replaceFile(tmp, target)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
    return text
  }

  async function backupNames(id: string): Promise<string[]> {
    try {
      return (await readdir(backupDir(id))).filter((n) => backupTime(n) !== null)
    } catch {
      return []
    }
  }

  /** Copies the current file of a project into its backups (named by its save time); prunes old ones. */
  async function backupCurrent(id: string): Promise<void> {
    const current = file(id)
    let mtime: number
    try {
      mtime = (await stat(current)).mtimeMs
    } catch {
      return // nothing saved yet
    }
    const folder = backupDir(id)
    await mkdir(folder, { recursive: true })
    const name = `${backupStamp(mtime)}${PROJECT_EXT}`
    const names = await backupNames(id)
    // Same save time: this version is already backed up
    if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) await copyFile(current, join(folder, name))
    lastBackup.set(id, now())
    const all = (await backupNames(id)).sort((a, b) => backupTime(b)! - backupTime(a)! || b.localeCompare(a))
    await Promise.all(all.slice(keep).map((n) => rm(join(folder, n), { force: true })))
  }

  async function listBackups(id: string): Promise<BackupInfo[]> {
    const folder = backupDir(id)
    const names = await backupNames(id)
    const list = await Promise.all(
      names.map(async (name): Promise<BackupInfo> => {
        const p = await readProject(join(folder, name))
        return { file: join(folder, name), savedAt: backupTime(name)!, slideCount: p ? p.entries.length : 0 }
      })
    )
    return list.sort((a, b) => b.savedAt - a.savedAt || b.file.localeCompare(a.file))
  }

  return {
    dir,

    async list() {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return []
      }
      const summaries = await Promise.all(
        names
          .filter((n) => n.toLowerCase().endsWith(PROJECT_EXT))
          .map(async (n) => {
            const p = await readProject(join(dir, n))
            if (!p || typeof p.id !== 'string') return null
            // a newer app's project is listed by damaged(): it cannot be opened here
            if ((formatVersion(p) ?? 0) > PROJECT_VERSION) return null
            return summarize({ ...p, media: Array.isArray(p.media) ? p.media : [] })
          })
      )
      return summaries.filter((s): s is ProjectSummary => s !== null).sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async load(id, onRead) {
      const { project: p, report, text } = await readChecked(file(id), { fallbackId: id })
      const renamed = p.id !== id
      if (renamed) p.id = id
      onRead?.(text, renamed || lostData(report))
      if (hasChanges(report)) {
        // the editor saves the repaired project right away: keep the file as it was
        if (lostData(report)) await serial(id, () => backupCurrent(id)).catch(() => {})
        opts.onReport?.({ projectId: id, source: 'open', report })
      }
      return p
    },

    async save(project, onWritten) {
      const id = checkId(project.id)
      return serial(id, async () => {
        const last = lastBackup.get(id)
        let due = last !== undefined && now() - last >= interval
        if (last === undefined) {
          const mtime = await stat(file(id)).then((st) => st.mtimeMs, () => undefined)
          due = mtime !== undefined && now() - mtime >= interval
          lastBackup.set(id, now())
        }
        // A failed backup must never cost the save itself
        if (due) await backupCurrent(id).catch(() => {})
        const text = await writeAtomic(file(id), project)
        onWritten?.(text)
      })
    },

    async delete(id) {
      await rm(file(id), { force: true })
      await rm(backupDir(id), { recursive: true, force: true, maxRetries: 3 })
      lastBackup.delete(id)
    },

    async overwrite(project) {
      const id = checkId(project.id)
      return serial(id, async () => {
        await writeAtomic(file(id), project)
        // the next save backs up this version at the earliest after the interval
        lastBackup.set(id, now())
      })
    },

    async rewriteBackups(id, fn) {
      const folder = backupDir(id)
      let rewritten = 0
      let failed = 0
      return serial(id, async () => {
        for (const name of await backupNames(id)) {
          const path = join(folder, name)
          try {
            const st = await stat(path)
            const { project } = await readChecked(path, { fallbackId: id })
            await writeAtomic(path, fn(project))
            // the list shows the time in the name; the file time follows it
            await utimes(path, st.atime, st.mtime).catch(() => {})
            rewritten++
          } catch {
            failed++
          }
        }
        return { rewritten, failed }
      })
    },

    backupFolder: (id) => backupDir(id),

    async references(except) {
      const ids = new Set<string>()
      const paths: string[] = []
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return { ids, paths }
      }
      const skip = except ? `${except}${PROJECT_EXT}`.toLowerCase() : null
      await Promise.all(
        names
          .filter((n) => n.toLowerCase().endsWith(PROJECT_EXT) && n.toLowerCase() !== skip)
          .map(async (n) => {
            const p = await readProject(join(dir, n))
            if (!p) return
            for (const e of p.entries) if (e && e.type !== 'text' && typeof e.mediaId === 'string') ids.add(e.mediaId)
            for (const m of Array.isArray(p.media) ? p.media : []) {
              if (typeof m?.id === 'string') ids.add(m.id)
              if (typeof m?.path === 'string') paths.push(m.path)
              if (typeof m?.live?.source === 'string') paths.push(m.live.source)
            }
            for (const t of Array.isArray(p.music) ? p.music : []) {
              if (typeof t?.id === 'string') ids.add(t.id)
              if (typeof t?.path === 'string') paths.push(t.path)
            }
          })
      )
      return { ids, paths }
    },

    listBackups,

    async restoreBackup(path) {
      if (typeof path !== 'string' || !path) throw new Error('no backup file')
      const full = resolve(path)
      const folder = dirname(full)
      const id = checkId(basename(folder))
      if (resolve(backupDir(id)).toLowerCase() !== folder.toLowerCase() || backupTime(basename(full)) === null) {
        throw new Error('not a backup of this app')
      }
      const { project: p, report } = await readChecked(full, { fallbackId: id })
      const project: Project = { ...p, id, updatedAt: now() }
      return serial(id, async () => {
        // The version being replaced becomes a backup itself, so the restore can be undone
        await backupCurrent(id)
        await writeAtomic(file(id), project)
        if (hasChanges(report)) opts.onReport?.({ projectId: id, source: 'backup', report })
        return project
      })
    },

    async peek(id, onRead) {
      const { project, report, text } = await readChecked(file(id), { fallbackId: id })
      onRead?.(text, project.id !== id || lostData(report))
      return project
    },

    async damaged() {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return []
      }
      const found = await Promise.all(
        names
          .filter((n) => n.toLowerCase().endsWith(PROJECT_EXT) && /^[A-Za-z0-9_-]{1,128}$/.test(n.slice(0, -PROJECT_EXT.length)))
          .map(async (n): Promise<DamagedProject | null> => {
            const id = n.slice(0, -PROJECT_EXT.length)
            const path = join(dir, n)
            let text: string
            let bytes: number
            let modifiedAt: number
            try {
              const st = await stat(path)
              if (!st.isFile()) return null
              bytes = st.size
              modifiedAt = st.mtimeMs
              text = await readFile(path, 'utf8')
            } catch {
              return null
            }
            try {
              readProjectText(text, { fallbackId: id })
              return null
            } catch (err) {
              const base = { id, file: path, bytes, modifiedAt, backups: (await backupNames(id)).length }
              if (err instanceof ProjectFormatError && err.code === 'too-new') return { ...base, reason: 'too-new', version: err.version }
              const name = nameIn(text)
              return { ...base, reason: 'damaged', ...(name ? { name } : {}) }
            }
          })
      )
      return found.filter((d): d is DamagedProject => d !== null).sort((a, b) => b.modifiedAt - a.modifiedAt)
    },

    async inspectRepair(id) {
      const path = file(id)
      let salvage: RepairPlan['salvage'] = null
      try {
        const { project, report } = await readChecked(path, { fallbackId: id, salvage: true })
        salvage = { name: project.name, slides: project.entries.length, media: project.media.length, music: project.music.length, report }
      } catch {
        // nothing readable (or a newer app's file): only the backups can help
      }
      const backups = await Promise.all(
        (await listBackups(id)).map(async (b) => {
          const readable = await readFile(b.file, 'utf8').then(
            (text) => {
              readProjectText(text, { fallbackId: id })
              return true
            },
            () => false
          ).catch(() => false)
          return readable ? b : { ...b, damaged: true }
        })
      )
      return { id, file: path, salvage, backups }
    },

    async repair(id, choice) {
      checkId(id)
      let result: { project: Project; report: RepairReport }
      if (choice?.kind === 'backup') {
        const full = resolve(String(choice.file ?? ''))
        if (resolve(backupDir(id)).toLowerCase() !== dirname(full).toLowerCase() || backupTime(basename(full)) === null) {
          throw new Error('not a backup of this project')
        }
        result = await readChecked(full, { fallbackId: id })
      } else if (choice?.kind === 'salvage') {
        result = await readChecked(file(id), { fallbackId: id, salvage: true })
      } else throw new Error('unknown repair')
      const project: Project = { ...result.project, id, updatedAt: now() }
      return serial(id, async () => {
        // the damaged file stays next to the backups (neither listed nor pruned with them)
        const current = file(id)
        const mtime = await stat(current).then(
          (st) => st.mtimeMs,
          () => null
        )
        if (mtime !== null) {
          await mkdir(backupDir(id), { recursive: true })
          await copyFile(current, join(backupDir(id), `${backupStamp(mtime)}.damaged`))
        }
        await writeAtomic(current, project)
        lastBackup.set(id, now())
        opts.onReport?.({ projectId: id, source: 'repair', report: result.report })
        return project
      })
    }
  }
}
