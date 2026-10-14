// IPC of the shows (projects.ts) and their undo history (history.ts): the list, opening (also a .dshow
// file from elsewhere), duplicating, saving, older versions, and the stored history. A show read for the
// editor can get its stored undo history back; an imported, restored or duplicated one starts without.
import { ipcMain } from 'electron'
import type { ProjectReportEvent } from '@shared/diagnostics'
import type { ThemeTrack } from '@shared/themeMusic'
import type { Project } from '@shared/types'
import { showOpen } from './dialogs'
import { duplicateShow } from './duplicate'
import type { HistorySaveStatus, HistoryStore } from './history'
import type { NetTrust } from './netTrust'
import { importProjectFile } from './projectFile'
import { PROJECT_EXT, summarize, type ProjectStore } from './projects'
import { dialogText } from './dialogText'

export interface ProjectsIpcDeps {
  projects: ProjectStore
  history: HistoryStore
  themeMusic: Promise<ThemeTrack[]>
  /** A project that had to be repaired when it was read: the editor shows what changed. */
  onReport: (event: ProjectReportEvent) => void
  net: NetTrust
  /** Settles once a show half moved into the trash (a crash) is back (cleanupMain.ts). */
  trashReady: Promise<void>
  /** The app is quitting: saves write the undo history at once. */
  quitting: () => boolean
}

/** Registers the channels; `settleSaves` settles once no save is on its way, also of saves sent meanwhile. */
export function registerProjects(d: ProjectsIpcDeps): { settleSaves: () => Promise<void> } {
  const { projects, history, onReport } = d
  /** A show read for the editor: its stored undo history can be restored for exactly this text. */
  const loadForEditor = (id: string): Promise<Project> => {
    let read: { text: string; repaired: boolean } | undefined
    return projects.load(id, (text, repaired) => (read = { text, repaired })).then((p) => {
      if (read) history.opened(id, read.text, p, read.repaired)
      return p
    })
  }
  /** Imports a .dshow file; an imported show starts with an empty undo history (its own file opens as usual). */
  const importShow = async (path: string): Promise<Project> => {
    let own = false
    const loadOwn = (id: string): Promise<Project> => {
      own = true
      return loadForEditor(id)
    }
    // an archived show brings its theme song; it plays when this app's song is another one. Its paths on
    // shares the user hasn't trusted are not looked at (not even their size): the editor's banner asks first
    await d.net.loaded
    const p = await importProjectFile(path, projects, { onReport, themeTracks: await d.themeMusic, loadOwn, allowPath: d.net.allowPath })
    if (!own) await history.clear(p.id)
    return p
  }

  ipcMain.handle('project:open-dialog', async (e) => {
    const r = await showOpen(e, {
      title: dialogText('openProject'),
      properties: ['openFile'],
      filters: [{ name: dialogText('project'), extensions: [PROJECT_EXT.slice(1)] }]
    })
    if (r.canceled || !r.filePaths.length) return null
    // a pack the user opened from a share: its files sit next to it on that share
    await d.net.trustPaths([r.filePaths[0]])
    return importShow(r.filePaths[0])
  })

  ipcMain.handle('project:import-file', async (_e, path: string) => {
    if (typeof path !== 'string' || !path) throw new Error('no project file')
    await d.net.trustPaths([path])
    return importShow(path)
  })

  // after a crash, a show half moved into the trash is back first
  ipcMain.handle('project:list', () => d.trashReady.then(() => projects.list()))
  ipcMain.handle('project:load', (_e, id: string) => loadForEditor(id))
  // "Duplizieren": a copy under a new id, without older versions, undo history or export jobs (duplicate.ts)
  ipcMain.handle('project:duplicate', async (_e, id: unknown, word: unknown) => summarize(await duplicateShow(projects, String(id), word)))
  // the editor's saves carry its undo history; it is written a moment after the project file, at once
  // while the app quits (the quit waits for these saves: see before-quit in ipc.ts)
  const saving = new Set<Promise<unknown>>()
  ipcMain.handle('project:save', (_e, project: Project, upload?: unknown) => {
    const run = (async () => {
      const r: { status: HistorySaveStatus } = { status: 'ignored' }
      await projects.save(project, (text) => (r.status = history.saved(project.id, text, upload)))
      if (r.status === 'ok' && (d.quitting() || (upload as { flush?: unknown }).flush === true)) await history.flush(project.id)
      return r.status === 'resend' ? { resendHistory: true } : undefined
    })()
    saving.add(run)
    void run.finally(() => saving.delete(run)).catch(() => {})
    return run
  })
  ipcMain.handle('project:backups', (_e, id: string) => projects.listBackups(id))
  // a restored version starts with an empty undo history
  ipcMain.handle('project:restore-backup', async (_e, file: string) => {
    const p = await projects.restoreBackup(file)
    await history.clear(p.id)
    return p
  })
  ipcMain.handle('history:load', (_e, id: unknown) => history.load(String(id)))
  // Settings → Privacy: the history of one show (id) or of all (null)
  ipcMain.handle('history:clear', (_e, id: unknown) => (id === null ? history.clearAll() : history.clear(String(id))))

  return {
    async settleSaves() {
      while (saving.size) await Promise.allSettled([...saving])
    }
  }
}
