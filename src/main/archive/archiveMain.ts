// IPC of "Diashow als ZIP archivieren" (archive.ts): what the dialog lists, the save dialog for the
// .zip (with the free space on its drive), "Add another video file…", writing with progress and
// cancel. One archive at a time; the PC doesn't sleep while it is written. Only targets and videos
// the user picked in this app's own dialogs (or the show's finished exports) are accepted.
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, type IpcMainInvokeEvent } from 'electron'
import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { ArchiveChoice, ArchiveProgress, ArchiveTarget, ArchiveVideo } from '@shared/archive'
import { VIDEO_EXT } from '@shared/formats'
import { archiveInventory, chosenVideos, fileLimitFor, freeSpaceOf, isVideoFile, writeArchive, type ArchiveDeps } from './archive'

function checkId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('invalid project id')
  return id
}

/** The renderer's choice, with anything unknown meaning "no". */
export function checkArchiveChoice(raw: unknown): ArchiveChoice {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const videos = Array.isArray(o.videos) ? o.videos.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length < 4000).slice(0, 1000) : []
  return { leftOut: o.leftOut === true, withoutFaceData: o.withoutFaceData === true, videos, lang: o.lang === 'en' ? 'en' : 'de' }
}

const key = (p: string): string => resolve(p).toLowerCase()

export function registerArchive(d: ArchiveDeps): void {
  /** Targets and videos picked in the dialogs of this run of the app. */
  const targets = new Set<string>()
  const videos = new Set<string>()
  let running: AbortController | null = null

  const windowOf = (e: IpcMainInvokeEvent): BrowserWindow | undefined => BrowserWindow.fromWebContents(e.sender) ?? undefined

  ipcMain.handle('archive:inventory', (_e, id: unknown) => archiveInventory(d, checkId(id)))

  // `bytes`: about how large the archive becomes (for the FAT32 check)
  ipcMain.handle('archive:pick-target', async (e, suggested: unknown, bytes: unknown): Promise<ArchiveTarget | null> => {
    const opts: Electron.SaveDialogOptions = {
      title: 'Diashow als ZIP archivieren',
      defaultPath: typeof suggested === 'string' && suggested ? suggested : d.documentsDir,
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    }
    const win = windowOf(e)
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const path = /\.zip$/i.test(r.filePath) ? r.filePath : `${r.filePath}.zip`
    targets.add(key(path))
    const size = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
    return { path, free: await freeSpaceOf(dirname(path)), maxFile: await fileLimitFor(d, path, size) }
  })

  ipcMain.handle('archive:pick-videos', async (e): Promise<ArchiveVideo[]> => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Video hinzufügen',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: VIDEO_EXT }]
    }
    const win = windowOf(e)
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled) return []
    const out: ArchiveVideo[] = []
    for (const path of r.filePaths) {
      if (!isVideoFile(path) || (d.allowPath && !d.allowPath(path))) continue
      const st = await stat(path).catch(() => null)
      if (!st?.isFile()) continue
      videos.add(key(path))
      out.push({ path, name: basename(path), bytes: st.size, fromQueue: false })
    }
    return out
  })

  ipcMain.handle('archive:run', async (e, id: unknown, rawChoice: unknown, target: unknown) => {
    const pid = checkId(id)
    const choice = checkArchiveChoice(rawChoice)
    if (typeof target !== 'string' || !targets.has(key(target))) throw new Error('pick where the archive goes first')
    if (running) throw new Error('an archive is being written already')
    const ctrl = new AbortController()
    running = ctrl
    const blocker = powerSaveBlocker.start('prevent-app-suspension')
    const send = (p: ArchiveProgress): void => {
      if (!e.sender.isDestroyed()) e.sender.send('archive:progress', p)
    }
    try {
      const chosen = await chosenVideos(d, pid, choice.videos, videos)
      return await writeArchive(d, pid, choice, chosen, target, { signal: ctrl.signal, onProgress: send })
    } finally {
      powerSaveBlocker.stop(blocker)
      if (running === ctrl) running = null
    }
  })

  ipcMain.handle('archive:cancel', () => {
    running?.abort()
  })
  // quitting stops it too; its temp file is deleted while the app finishes (ipc.ts waits a moment)
  app.on('before-quit', () => running?.abort())
}
