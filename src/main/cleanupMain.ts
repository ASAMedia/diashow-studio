// IPC of "Nach dem Projekt aufräumen" (cleanup.ts): what a project keeps, the clean-up itself, the
// deletion reminder of a project that is not open in the editor, and deleting a project with its data.
// One clean-up or deletion per project at a time.
import { ipcMain } from 'electron'
import { startOfDay, validDeleteAt, type CleanupChoice, type DeleteExtras, type UploadChoice } from '@shared/cleanup'
import { deleteProjectData, inventoryOf, runCleanup, scanProject, type CleanupDeps } from './cleanup'

function checkId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('invalid project id')
  return id
}

/** The renderer's choice, with anything unknown meaning "no". */
export function checkChoice(raw: unknown): CleanupChoice {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const uploads: UploadChoice = o.uploads === 'all' || o.uploads === 'leftOut' ? o.uploads : 'none'
  return { faces: o.faces === true, uploads, caches: o.caches === true, backups: o.backups === true, exports: o.exports === true, ...(o.history === true ? { history: true } : {}) }
}

function checkExtras(raw: unknown): DeleteExtras {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { caches: o.caches === true, uploads: o.uploads === true, exports: o.exports === true }
}

export function registerCleanup(d: CleanupDeps): void {
  const queues = new Map<string, Promise<unknown>>()
  const serial = <T>(id: string, task: () => Promise<T>): Promise<T> => {
    const next = (queues.get(id) ?? Promise.resolve()).then(task, task)
    const settled = next.catch(() => {})
    queues.set(id, settled)
    void settled.then(() => {
      if (queues.get(id) === settled) queues.delete(id)
    })
    return next
  }

  ipcMain.handle('cleanup:inventory', async (_e, id: unknown) => inventoryOf(await scanProject(d, checkId(id))))
  ipcMain.handle('cleanup:run', (_e, id: unknown, choice: unknown) => {
    const pid = checkId(id)
    return serial(pid, () => runCleanup(d, pid, checkChoice(choice)))
  })
  // a project open in the editor sets its reminder like any other edit; this is for the home screen
  ipcMain.handle('cleanup:delete-at', (_e, id: unknown, at: unknown) => {
    const pid = checkId(id)
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
  ipcMain.handle('project:delete', (_e, id: unknown, extras: unknown) => {
    const pid = checkId(id)
    return serial(pid, () => deleteProjectData(d, pid, checkExtras(extras)))
  })
}
