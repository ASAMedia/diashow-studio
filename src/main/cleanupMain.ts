// IPC of "Nach dem Projekt aufräumen" (cleanup.ts): what a project keeps, the clean-up itself, the
// deletion reminder of a project that is not open in the editor, deleting a project (into the trash)
// and the trash (trash.ts): listing, restoring, deleting for good, and its expiry after TRASH_DAYS (at
// the start and every hour while the app runs). One clean-up, deletion or restore per project at a time.
import { ipcMain } from 'electron'
import { startOfDay, validDeleteAt, type CleanupChoice, type UploadChoice } from '@shared/cleanup'
import type { TrashRestoreResult } from '@shared/trash'
import { inventoryOf, releaseShared, runCleanup, scanProject, trashProjectData, type CleanupDeps } from './cleanup'
import { TrashRefusedError, type Trash, type TrashedMedia } from './trash'
import { checkProjectId } from './projectSchema'
import { serialByKey } from './serial'

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

/**
 * `ready` settles once a show half moved into the trash (a crash) is back: the list of shows waits for
 * that, not for the expiry after it (deleting a big show for good may take a while).
 */
export function registerCleanup(d: CleanupDeps & { trash: Trash }, opts: CleanupIpcOptions = {}): { ready: Promise<void> } {
  const trash = d.trash
  const serial = serialByKey()

  ipcMain.handle('cleanup:inventory', async (_e, id: unknown) => inventoryOf(await scanProject(d, checkProjectId(id))))
  ipcMain.handle('cleanup:run', (_e, id: unknown, choice: unknown) => {
    const pid = checkProjectId(id)
    return serial(pid, () => runCleanup(d, pid, checkChoice(choice)))
  })
  // a project open in the editor sets its reminder like any other edit; this is for the home screen
  ipcMain.handle('cleanup:delete-at', (_e, id: unknown, at: unknown) => {
    const pid = checkProjectId(id)
    if (at !== null && !validDeleteAt(at)) throw new Error('invalid date')
    return serial(pid, async () => {
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
  /** Deletes shows for good; then the uploads they shared with another show go once no show uses them (releaseShared). */
  const forGood = async <T>(task: () => Promise<T>): Promise<T> => {
    const before = await trash.media().catch(() => new Map<string, TrashedMedia[]>())
    const result = await task()
    await releaseShared(d, before).catch((err: Error) => opts.log?.(`shared uploads not released: ${err.message}`))
    return result
  }
  // after a crash a half-done move goes back first, then what is due goes
  const expire = (): Promise<void> =>
    forGood(() => trash.expire()).then(
      (keys) => {
        if (keys.length) opts.broadcast?.('trash:changed', null)
      },
      (err: Error) => opts.log?.(`trash expiry failed: ${err.message}`)
    )
  // export jobs that came back with a show go into the queue again
  const recovered = trash
    .recover()
    .then(async (jobs) => {
      for (const job of jobs) await d.exports.adopt?.(job).catch(() => {})
    })
    .catch((err: Error) => opts.log?.(`trash recovery failed: ${err.message}`))
  const ready = recovered.then(expire)
  setInterval(() => void expire(), EXPIRE_EVERY_MS).unref()

  ipcMain.handle('project:delete', async (_e, id: unknown) => {
    const pid = checkProjectId(id)
    await ready
    return serial(pid, () => trashProjectData(d, pid))
  })
  ipcMain.handle('trash:list', async () => {
    await ready
    return trash.list()
  })
  ipcMain.handle('trash:restore', async (_e, id: unknown): Promise<TrashRestoreResult> => {
    const pid = checkProjectId(id)
    await ready
    return serial(pid, async () => {
      try {
        // in the show's queue, like moving it in
        const r = await d.projects.exclusive(pid, () => trash.restore(pid))
        for (const job of r.jobs) await d.exports.adopt?.(job).catch(() => {})
        return { id: r.id, name: r.name, renamed: r.renamed, history: r.history, exports: r.jobs.length }
      } catch (err) {
        if (err instanceof TrashRefusedError) return { refused: err.code }
        throw err
      }
    })
  })
  ipcMain.handle('trash:purge', async (_e, key: unknown) => {
    if (typeof key !== 'string') throw new Error('invalid trash entry')
    await ready
    return forGood(() => trash.purge(key))
  })
  ipcMain.handle('trash:empty', async () => {
    await ready
    return forGood(() => trash.empty())
  })
  return { ready: recovered }
}
