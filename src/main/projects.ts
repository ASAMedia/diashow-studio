// Projects are stored as `<id>.dshow` JSON files in Documents\Diashow Studio (directory injected).
// Before a save overwrites a project, the previous version is copied to
// `.backups/<id>/<yyyyMMdd-HHmmss>.dshow` (named by the time it was saved), at most every
// 10 minutes per project; the newest 20 are kept. The first save of a session backs up the version
// on disk only when it is older than that (the state a previous session left), so quick successive
// saves of a new project create no backups.
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { BackupInfo, Project, ProjectSummary } from '@shared/types'

export const PROJECT_EXT = '.dshow'
const BACKUPS = '.backups'
const BACKUP_NAME = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.dshow$/i

export interface ProjectStoreOptions {
  /** Minimum time between two backups of a project, ms (default 10 minutes). */
  backupInterval?: number
  /** Backups kept per project (default 20). */
  keepBackups?: number
  /** Clock, injectable for tests. */
  now?: () => number
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
  load(id: string): Promise<Project>
  save(project: Project): Promise<void>
  delete(id: string): Promise<void>
  /** Everything the saved projects refer to (for the cache cleanup). */
  references(): Promise<ProjectReferences>
  /** Backups of a project, newest first. */
  listBackups(id: string): Promise<BackupInfo[]>
  /** Makes a backup the current version (backing up the current one first) and returns it. */
  restoreBackup(file: string): Promise<Project>
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

async function readProject(path: string): Promise<Project | null> {
  try {
    const p = JSON.parse(await readFile(path, 'utf8')) as Project
    return p && typeof p === 'object' && Array.isArray(p.entries) ? p : null
  } catch {
    return null
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

  async function writeAtomic(target: string, project: Project): Promise<void> {
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.${now()}.tmp`
    await writeFile(tmp, JSON.stringify(project, null, 1), 'utf8')
    try {
      await rename(tmp, target)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
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
            return summarize({ ...p, media: Array.isArray(p.media) ? p.media : [] })
          })
      )
      return summaries.filter((s): s is ProjectSummary => s !== null).sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async load(id) {
      const p = JSON.parse(await readFile(file(id), 'utf8')) as Project
      if (p.id !== id) p.id = id
      return p
    },

    async save(project) {
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
        await writeAtomic(file(id), project)
      })
    },

    async delete(id) {
      await rm(file(id), { force: true })
      await rm(backupDir(id), { recursive: true, force: true, maxRetries: 3 })
      lastBackup.delete(id)
    },

    async references() {
      const ids = new Set<string>()
      const paths: string[] = []
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return { ids, paths }
      }
      await Promise.all(
        names
          .filter((n) => n.toLowerCase().endsWith(PROJECT_EXT))
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

    async listBackups(id) {
      const folder = backupDir(id)
      const names = await backupNames(id)
      const list = await Promise.all(
        names.map(async (name): Promise<BackupInfo> => {
          const p = await readProject(join(folder, name))
          return { file: join(folder, name), savedAt: backupTime(name)!, slideCount: p ? p.entries.length : 0 }
        })
      )
      return list.sort((a, b) => b.savedAt - a.savedAt || b.file.localeCompare(a.file))
    },

    async restoreBackup(path) {
      if (typeof path !== 'string' || !path) throw new Error('no backup file')
      const full = resolve(path)
      const folder = dirname(full)
      const id = checkId(basename(folder))
      if (resolve(backupDir(id)).toLowerCase() !== folder.toLowerCase() || backupTime(basename(full)) === null) {
        throw new Error('not a backup of this app')
      }
      const p = await readProject(full)
      if (!p) throw new Error('backup is damaged')
      const project: Project = { ...p, id, updatedAt: now() }
      return serial(id, async () => {
        // The version being replaced becomes a backup itself, so the restore can be undone
        await backupCurrent(id)
        await writeAtomic(file(id), project)
        return project
      })
    }
  }
}
