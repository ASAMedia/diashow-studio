// Wires every IPC channel of the preload contract (src/preload/index.ts) to the main-process services.
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from '@shared/formats'
import type { AppSettings, ExportOptions, ExportProgress, MediaItem, MusicTrack, Project, Rect, VideoFaces } from '@shared/types'
import { createAppSettingsStore } from './appSettings'
import { directDecodeSupport } from './codecSupport'
import { resolveFfmpegDir } from './ffmpeg'
import { createKeepAwake } from './keepAwake'
import { endExiftool } from './media/exif'
import { createMediaService, type MediaService } from './media/service'
import { displayCount, isPresentationWindow, startPresentation, stopPresentation } from './presentation'
import { importProjectFile, packProject } from './projectFile'
import { createProjectStore, PROJECT_EXT } from './projects'
import { cancelActiveExport, startExport, type ExportJob } from './export/encoder'
import { registerExportQueue } from './export/queueMain'
import { registerShare } from './share/shareMain'
import { registerSystemCheck } from './systemCheck'

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
    onMusicUpdate: (track: MusicTrack) => broadcast('music:update', track),
    directDecode: directDecodeSupport
  })
  media = service
  // Warm up encoder detection so the export dialog has it ready
  void service.ffmpeg.encoders()
  const appSettings = createAppSettingsStore(join(app.getPath('userData'), 'settings.json'))
  const awake = createKeepAwake({
    start: () => powerSaveBlocker.start('prevent-display-sleep'),
    stop: (id) => powerSaveBlocker.stop(id)
  })
  const awakeWindows = new Set<number>()

  let exportJob: ExportJob | null = null
  const sendProgress = (p: ExportProgress): void => broadcast('export:progress', p)
  // Hi-res proxies and packing report through export:progress and stop with exportCancel
  const preparing = new Set<AbortController>()
  const prepareRun = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const ctrl = new AbortController()
    preparing.add(ctrl)
    try {
      return await run(ctrl.signal)
    } finally {
      preparing.delete(ctrl)
    }
  }
  // Export queue: jobs in <userData>/exports, rendered one after another by a hidden worker window
  // whose export:frame / export:chunk / export:hires calls go to the queue (export/queueMain.ts)
  const exportQueue = registerExportQueue({
    dir: join(app.getPath('userData'), 'exports'),
    ffmpegDir,
    encoders: () => service.ffmpeg.encoders()
  })

  // DIASHOW_LOCALE (e.g. en-US) overrides the Windows language, for tests in either language
  ipcMain.handle('app:locale', () => process.env.DIASHOW_LOCALE || app.getLocale())

  ipcMain.handle('media:import', (_e, paths: string[]) => service.importPaths(stringList(paths)))
  ipcMain.handle('media:restore', (_e, items: MediaItem[]) => service.restoreMedia(items))
  ipcMain.handle('music:import', (_e, paths: string[]) => service.importMusic(stringList(paths)))
  ipcMain.handle('music:restore', (_e, tracks: MusicTrack[]) => service.restoreMusic(tracks))
  ipcMain.handle('audio:waveform', (_e, path: string, buckets: number) => service.waveform(path, buckets))
  ipcMain.handle('media:faces', (_e, id: string, faces: Rect[], desc?: number[][]) => service.setFaces(id, faces, desc))
  ipcMain.handle('media:video-faces', (_e, id: string, samples: VideoFaces[]) => service.setVideoFaces(id, samples))
  ipcMain.handle('media:frames', (_e, path: string, times: number[], maxEdge: number) => service.videoFrames(path, times, maxEdge))
  ipcMain.handle('media:strip', (_e, path: string, count: number, height: number) => service.videoStrip(path, count, height))
  ipcMain.handle('media:relink', (_e, missing: MediaItem[], folder: string) => service.relinkMedia(missing, folder))
  ipcMain.handle('media:prioritize', (_e, ids: string[]) => service.prioritize(stringList(ids)))
  ipcMain.handle('media:stabilize', (_e, id: string) => service.stabilizeVideo(String(id)))
  // Sharing over the local network: uploads go to <Documents>/Diashow Studio/Uploads/<project>/<name>
  registerShare({ uploadsRoot: join(projects.dir, 'Uploads'), broadcast })
  registerSystemCheck({ ff: service.ffmpeg, cacheDir })
  ipcMain.handle('cache:info', async () => service.cacheInfo(await projects.references()))
  ipcMain.handle('cache:clean', async (_e, what: 'unused' | 'hires' | 'proxies') => service.cleanCache(what, await projects.references()))

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

  ipcMain.handle('dialog:pack', async (e) => {
    const opts: Electron.OpenDialogOptions = { title: 'Projekt mit allen Medien packen – Zielordner', properties: ['openDirectory', 'createDirectory'] }
    const win = windowOf(e)
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })

  ipcMain.handle('project:pack', (_e, project: Project, dir: string) => {
    if (typeof dir !== 'string' || !dir) throw new Error('no target folder')
    return prepareRun((signal) => packProject(project, dir, { signal, onProgress: sendProgress }))
  })

  ipcMain.handle('project:open-dialog', async (e) => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Projekt öffnen',
      properties: ['openFile'],
      filters: [{ name: 'Diashow-Projekt', extensions: [PROJECT_EXT.slice(1)] }]
    }
    const win = windowOf(e)
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths.length) return null
    return importProjectFile(r.filePaths[0], projects)
  })

  ipcMain.handle('project:import-file', (_e, path: string) => {
    if (typeof path !== 'string' || !path) throw new Error('no project file')
    return importProjectFile(path, projects)
  })

  ipcMain.handle('project:list', () => projects.list())
  ipcMain.handle('project:load', (_e, id: string) => projects.load(id))
  ipcMain.handle('project:save', (_e, project: Project) => projects.save(project))
  ipcMain.handle('project:delete', (_e, id: string) => projects.delete(id))
  ipcMain.handle('project:backups', (_e, id: string) => projects.listBackups(id))
  ipcMain.handle('project:restore-backup', (_e, file: string) => projects.restoreBackup(file))

  ipcMain.handle('export:encoders', () => service.ffmpeg.encoders())

  ipcMain.handle('export:hires', (e, ids: string[], maxEdge: number) => {
    // the worker's preparation stops with its job and is not shown in the editor's export dialog
    if (exportQueue.isWorker(e.sender)) {
      return exportQueue.prepare((signal, onProgress) => service.prepareHires(stringList(ids), Number(maxEdge) || 0, { signal, onProgress }))
    }
    return prepareRun((signal) => service.prepareHires(stringList(ids), Number(maxEdge) || 0, { signal, onProgress: sendProgress }))
  })

  ipcMain.handle('export:start', async (e, options: ExportOptions) => {
    if (exportQueue.isWorker(e.sender)) throw new Error('the export worker uses segmentStart')
    exportJob = null
    const encoders = await service.ffmpeg.encoders()
    exportJob = await startExport(options, ffmpegDir, join(cacheDir, 'export'), sendProgress, encoders)
  })

  ipcMain.handle('export:frame', async (e, rgba: Uint8Array) => {
    if (exportQueue.routes(e.sender, !!exportJob)) return exportQueue.writeFrame(rgba)
    if (!exportJob) throw new Error('no export running')
    await exportJob.writeFrame(rgba)
  })

  ipcMain.handle('export:chunk', async (e, data: Uint8Array) => {
    if (exportQueue.routes(e.sender, !!exportJob)) return exportQueue.writeChunk(data)
    if (!exportJob) throw new Error('no export running')
    if (!(data instanceof Uint8Array)) throw new Error('chunk must be a Uint8Array')
    await exportJob.writeChunk(data)
  })

  ipcMain.handle('export:finish', async (e) => {
    if (exportQueue.isWorker(e.sender)) throw new Error('the export worker uses segmentFinish')
    if (!exportJob) throw new Error('no export running')
    const job = exportJob
    try {
      return await job.finish()
    } finally {
      if (exportJob === job) exportJob = null
    }
  })

  ipcMain.handle('export:cancel', async (e) => {
    // from the worker: drop its active segment only, never the editor's export
    if (exportQueue.isWorker(e.sender)) return exportQueue.discardSegment()
    const job = exportJob
    exportJob = null
    const stopped = [...preparing]
    for (const ctrl of stopped) ctrl.abort()
    if (job) await job.cancel()
    else await cancelActiveExport()
    if (stopped.length && !job) sendProgress({ phase: 'cancelled' })
  })

  ipcMain.handle('win:fullscreen', (e, on: boolean) => {
    windowOf(e)?.setFullScreen(!!on)
  })

  ipcMain.handle('shell:reveal', (_e, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('app:displays', () => displayCount())
  ipcMain.handle('app:settings-get', () => appSettings.get())
  ipcMain.handle('app:settings-set', (_e, settings: AppSettings) => appSettings.set(settings))
  ipcMain.handle('app:keep-awake', (e, on: boolean) => {
    const contents = e.sender
    const owner = contents.id
    if (!awakeWindows.has(owner)) {
      awakeWindows.add(owner)
      // A closed window, a reloaded page or a crashed renderer gives up its requests
      const release = (): void => awake.release(owner)
      contents.on('did-navigate', release)
      contents.on('render-process-gone', release)
      contents.once('destroyed', () => {
        awakeWindows.delete(owner)
        release()
      })
    }
    awake.set(owner, !!on)
  })
  ipcMain.handle('present:start', (e) => {
    const win = windowOf(e)
    startPresentation(isPresentationWindow(win) ? undefined : win)
  })
  ipcMain.handle('present:stop', () => stopPresentation())

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    const job = exportJob
    exportJob = null
    for (const ctrl of preparing) ctrl.abort()
    const cleanup = Promise.allSettled([job ? job.cancel() : cancelActiveExport(), exportQueue.shutdown(), media?.dispose(), endExiftool()])
    // Never let a stuck child process block quitting
    const timeout = new Promise((resolve) => setTimeout(resolve, 4000))
    void Promise.race([cleanup, timeout]).finally(() => app.quit())
  })
}
