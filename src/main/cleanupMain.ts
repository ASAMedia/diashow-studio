// IPC of "Nach dem Projekt aufräumen" (cleanup.ts): what a project keeps, the clean-up itself, the
// deletion reminder of a project that is not open in the editor, deleting a project (into the trash)
// and the trash (trash.ts): listing, restoring, deleting for good, and its expiry after TRASH_DAYS (at
// the start and every hour while the app runs).
//
// One queue (createTrashOps): a clean-up, a deletion, a restore, deleting for good, emptying and the
// expiry run one after another. Each of them decides by what the other shows use (open or in the
// trash) what it may take, so no show may leave or enter the trash in between: else a restore during a
// deletion's scan, or an expiry's release of shared uploads during a restore, would take a pupil's
// upload a show still uses. The reminder runs one per project at a time with them.
import { ipcMain } from 'electron'
import { startOfDay, validDeleteAt, type CleanupChoice, type CleanupResult, type UploadChoice } from '@shared/cleanup'
import type { TrashMoveResult, TrashRemoveResult, TrashRestoreResult } from '@shared/trash'
import { inventoryOf, releaseMedia, runCleanup, scanProject, trashProjectData, type CleanupDeps } from './cleanup'
import { TrashRefusedError, type Trash } from './trash'
import { checkProjectId } from './projectSchema'
import { serialByKey, type SerialByKey } from './serial'

/** How often the trash looks for shows whose days are over. */
const EXPIRE_EVERY_MS = 60 * 60_000

/** The renderer's choice, with anything unknown meaning "no". */
export function checkChoice(raw: unknown): CleanupChoice {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const uploads: UploadChoice = o.uploads === 'all' || o.uploads === 'leftOut' ? o.uploads : 'none'
  return { faces: o.faces === true, uploads, caches: o.caches === true, backups: o.backups === true, exports: o.exports === true, ...(o.history === true ? { history: true } : {}) }
}

export interface CleanupIpcOptions {
  /** Tells every window (trash:changed when the expiry deleted shows). */
  broadcast?: (channel: string, payload: unknown) => void
  log?: (message: string) => void
}

/** The trash and the clean-up, one change at a time (see above). Electron-free. */
export interface TrashOps {
  /** Settles once what a crash cut off is finished or taken back (Trash.recover()). */
  recovered: Promise<void>
  /** Settles once, after that, the shows whose days are over are deleted for good. */
  ready: Promise<void>
  /** Deletes the shows whose days are over (trash:changed when there were some). */
  expire(): Promise<void>
  /** Deletes a show: into the trash. */
  remove(id: string): Promise<TrashMoveResult>
  restore(id: string): Promise<TrashRestoreResult>
  purge(key: string): Promise<TrashRemoveResult>
  empty(): Promise<TrashRemoveResult>
  cleanup(id: string, choice: CleanupChoice): Promise<CleanupResult>
}

export function createTrashOps(d: CleanupDeps & { trash: Trash }, opts: CleanupIpcOptions & { perShow?: SerialByKey } = {}): TrashOps {
  const trash = d.trash
  const perShow = opts.perShow ?? serialByKey()
  const queue = serialByKey()
  const one = <T>(task: () => Promise<T>): Promise<T> => queue('trash', task)
  const forShow = <T>(id: string, task: () => Promise<T>): Promise<T> => perShow(id, () => one(task))
  // a show deleted for good takes the uploads it shared along once no show uses them, in the same step
  trash.setRelease((gone, kept) => releaseMedia(d, gone, kept))
  // after a crash a half-done move goes back first; export jobs that came back go into the queue again
  const recovered = one(() => trash.recover())
    .then(async (jobs) => {
      for (const job of jobs) await d.exports.adopt?.(job).catch(() => {})
    })
    .catch((err: Error) => opts.log?.(`trash recovery failed: ${err.message}`))
  const expire = (): Promise<void> =>
    one(() => trash.expire()).then(
      (keys) => {
        if (keys.length) opts.broadcast?.('trash:changed', null)
      },
      (err: Error) => opts.log?.(`trash expiry failed: ${err.message}`)
    )
  // then what is due goes
  const ready = recovered.then(expire)
  return {
    recovered,
    ready,
    expire,
    async remove(id) {
      await ready
      return forShow(id, () => trashProjectData(d, id))
    },
    async restore(id) {
      await ready
      return forShow(id, async () => {
        try {
          // in the show's queue, like moving it in
          const r = await d.projects.exclusive(id, () => trash.restore(id))
          for (const job of r.jobs) await d.exports.adopt?.(job).catch(() => {})
          return { id: r.id, name: r.name, renamed: r.renamed, history: r.history, ...(r.historyDropped ? { historyDropped: true } : {}), exports: r.jobs.length }
        } catch (err) {
          if (err instanceof TrashRefusedError) return { refused: err.code }
          throw err
        }
      })
    },
    async purge(key) {
      await ready
      return one(() => trash.purge(key))
    },
    async empty() {
      await ready
      return one(() => trash.empty())
    },
    cleanup(id, choice) {
      return forShow(id, () => runCleanup(d, id, choice))
    }
  }
}

/**
 * `ready` settles once a show half moved into the trash (a crash) is back: the list of shows waits for
 * that, not for the expiry after it (deleting a big show for good may take a while).
 */
export function registerCleanup(d: CleanupDeps & { trash: Trash }, opts: CleanupIpcOptions = {}): { ready: Promise<void> } {
  const perShow = serialByKey()
  const ops = createTrashOps(d, { ...opts, perShow })

  ipcMain.handle('cleanup:inventory', async (_e, id: unknown) => inventoryOf(await scanProject(d, checkProjectId(id))))
  ipcMain.handle('cleanup:run', (_e, id: unknown, choice: unknown) => ops.cleanup(checkProjectId(id), checkChoice(choice)))
  // a project open in the editor sets its reminder like any other edit; this is for the home screen
  ipcMain.handle('cleanup:delete-at', (_e, id: unknown, at: unknown) => {
    const pid = checkProjectId(id)
    if (at !== null && !validDeleteAt(at)) throw new Error('invalid date')
    return perShow(pid, async () => {
      let read: { text: string; repaired: boolean } | undefined
      let written: string | undefined
      const project = await d.projects.peek(pid, (text, repaired) => (read = { text, repaired }))
      if (at === null) delete project.deleteAt
      else project.deleteAt = startOfDay(at as number)
      await d.projects.save(project, (text) => (written = text))
      // the show's undo history stays usable (it would not fit the rewritten file any more)
      if (read && !read.repaired && written !== undefined) await d.history?.rebase?.(pid, read.text, written).catch(() => {})
    })
  })

  // ---- the trash
  setInterval(() => void ops.expire(), EXPIRE_EVERY_MS).unref()
  ipcMain.handle('project:delete', async (_e, id: unknown) => ops.remove(checkProjectId(id)))
  ipcMain.handle('trash:list', async () => {
    await ops.ready
    return d.trash.list()
  })
  ipcMain.handle('trash:restore', async (_e, id: unknown) => ops.restore(checkProjectId(id)))
  ipcMain.handle('trash:purge', async (_e, key: unknown) => {
    if (typeof key !== 'string') throw new Error('invalid trash entry')
    return ops.purge(key)
  })
  ipcMain.handle('trash:empty', async () => ops.empty())
  return { ready: ops.recovered }
}
