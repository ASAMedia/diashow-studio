// Wires every IPC channel of the preload contract (src/preload/index.ts) to the main-process services.
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from '@shared/formats'
import type { ExportOptions, ExportProgress, MediaItem, MusicTrack, Project } from '@shared/types'
import { resolveFfmpegDir } from './ffmpeg'
import { endExiftool } from './media/exif'
import { createMediaService, type MediaService } from './media/service'
import { createProjectStore } from './projects'
import { cancelActiveExport, startExport, type ExportJob } from './export/encoder'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function windowOf(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}

function safeFileName(name: string): string {
  const cleaned = (name || 'Diashow').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.replace(/\.mp4$/i, '') || 'Diashow'
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
}

let media: MediaService | null = null

export function registerIpc(): void {
  const ffmpegDir = resolveFfmpegDir({
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    packaged: app.isPackaged
  })
  // DIASHOW_DATA_DIR (used by the e2e tests) keeps cache and projects out of the user's folders
  const dataDir = process.env.DIASHOW_DATA_DIR
  const cacheDir = join(dataDir || app.getPath('userData'), 'cache')
  const projects = createProjectStore(join(dataDir || app.getPath('documents'), 'Diashow Studio'))
  const service = createMediaService({
    ffmpegDir,
    cacheDir,
    onUpdate: (item: MediaItem) => broadcast('media:update', item),
    onMusicUpdate: (track: MusicTrack) => broadcast('music:update', track)
  })
  media = service
  // Warm up encoder detection so the export dialog has it ready
  void service.ffmpeg.encoders()

  let exportJob: ExportJob | null = null
  const sendProgress = (p: ExportProgress): void => broadcast('export:progress', p)

  ipcMain.handle('app:locale', () => app.getLocale())

  ipcMain.handle('media:import', (_e, paths: string[]) => service.importPaths(stringList(paths)))
  ipcMain.handle('media:restore', (_e, items: MediaItem[]) => service.restoreMedia(items))
  ipcMain.handle('music:import', (_e, paths: string[]) => service.importMusic(stringList(paths)))
  ipcMain.handle('music:restore', (_e, tracks: MusicTrack[]) => service.restoreMusic(tracks))
  ipcMain.handle('audio:waveform', (_e, path: string, buckets: number) => service.waveform(path, buckets))

  ipcMain.handle('dialog:media', async (e) => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Fotos und Videos hinzufügen',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Fotos und Videos', extensions: [...IMAGE_EXT, ...VIDEO_EXT] },
        { name: 'Alle Dateien', extensions: ['*'] }
      ]
    }
    const win = windowOf(e)
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('dialog:folder', async (e) => {
    const opts: Electron.OpenDialogOptions = { title: 'Ordner hinzufügen', properties: ['openDirectory', 'multiSelections'] }
    const win = windowOf(e)
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('dialog:music', async (e) => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Musik hinzufügen',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Musik', extensions: AUDIO_EXT },
        { name: 'Alle Dateien', extensions: ['*'] }
      ]
    }
    const win = windowOf(e)
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('dialog:export', async (e, defaultName: string) => {
    const opts: Electron.SaveDialogOptions = {
      title: 'Diashow exportieren',
      defaultPath: join(app.getPath('videos'), `${safeFileName(defaultName)}.mp4`),
      filters: [{ name: 'MPEG-4-Video', extensions: ['mp4'] }]
    }
    const win = windowOf(e)
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    return /\.mp4$/i.test(r.filePath) ? r.filePath : `${r.filePath}.mp4`
  })

  ipcMain.handle('project:list', () => projects.list())
  ipcMain.handle('project:load', (_e, id: string) => projects.load(id))
  ipcMain.handle('project:save', (_e, project: Project) => projects.save(project))
  ipcMain.handle('project:delete', (_e, id: string) => projects.delete(id))

  ipcMain.handle('export:encoders', () => service.ffmpeg.encoders())

  ipcMain.handle('export:start', async (_e, options: ExportOptions) => {
    exportJob = null
    const encoders = await service.ffmpeg.encoders()
    exportJob = await startExport(options, ffmpegDir, join(cacheDir, 'export'), sendProgress, encoders)
  })

  ipcMain.handle('export:frame', async (_e, rgba: Uint8Array) => {
    if (!exportJob) throw new Error('no export running')
    await exportJob.writeFrame(rgba)
  })

  ipcMain.handle('export:finish', async () => {
    if (!exportJob) throw new Error('no export running')
    const job = exportJob
    try {
      return await job.finish()
    } finally {
      if (exportJob === job) exportJob = null
    }
  })

  ipcMain.handle('export:cancel', async () => {
    const job = exportJob
    exportJob = null
    if (job) await job.cancel()
    else await cancelActiveExport()
  })

  ipcMain.handle('win:fullscreen', (e, on: boolean) => {
    windowOf(e)?.setFullScreen(!!on)
  })

  ipcMain.handle('shell:reveal', (_e, path: string) => {
    shell.showItemInFolder(path)
  })

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    const job = exportJob
    exportJob = null
    const cleanup = Promise.allSettled([job ? job.cancel() : cancelActiveExport(), media?.dispose(), endExiftool()])
    // Never let a stuck child process block quitting
    const timeout = new Promise((resolve) => setTimeout(resolve, 4000))
    void Promise.race([cleanup, timeout]).finally(() => app.quit())
  })
}
