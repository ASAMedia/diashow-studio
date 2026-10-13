// Wires every IPC channel of the preload contract (src/preload/index.ts) to the main-process services.
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from '@shared/formats'
import type { AppSettings, ExportOptions, ExportProgress, GpuChoiceInfo, MediaItem, MusicTrack, Project, Rect, VideoFaces } from '@shared/types'
import { createAppSettingsStore } from './appSettings'
import { directDecodeSupport } from './codecSupport'
import { resolveFfmpegDir } from './ffmpeg'
import { createKeepAwake } from './keepAwake'
import { endExiftool } from './media/exif'
import { createMediaService, type MediaService } from './media/service'
import { displayCount, isPresentationWindow, startPresentation, stopPresentation } from './presentation'
import { importProjectFile, packProject } from './projectFile'
import { createProjectStore, PROJECT_EXT } from './projects'
import { createHistoryStore, type HistorySaveStatus } from './history'
import { cancelActiveExport, startExport, type ExportJob } from './export/encoder'
import { registerExportQueue } from './export/queueMain'
import { registerShare } from './share/shareMain'
import { pastedRoots, registerPaste } from './pasteMain'
import { registerCleanup } from './cleanupMain'
import { registerArchive } from './archive/archiveMain'
import { registerSystemCheck } from './systemCheck'
import { appVersion, registerAbout } from './about'
import { registerReportProblem } from './reportProblem'
import type { ProjectReportEvent } from '@shared/diagnostics'
import { log, registerDiagnostics } from './diagnostics'
import { checkDirectExport, checkLocalFile } from './ipcGuards'
import { registerProjectRepair } from './projectRepair'
import { collectSystemInfo, gpuDevices } from './systemCheck'
import { gpuOverride, runningGpuPreference } from './gpuChoice'
import { uncHost, validHost } from '@shared/netPaths'
import { setMediaPathPolicy, setThemeMusicDir } from './protocol'
import { loadThemeMusic, resolveThemeMusicDir } from './themeMusic'

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
  // the bundled theme songs: dsmedia:// serves them wherever the app is installed (protocol.ts)
  const themeMusicDir = resolveThemeMusicDir({ resourcesPath: process.resourcesPath, appPath: app.getAppPath(), packaged: app.isPackaged })
  setThemeMusicDir(themeMusicDir)
  const themeMusic = loadThemeMusic(themeMusicDir)
  // DIASHOW_DATA_DIR (used by the e2e tests) keeps cache and projects out of the user's folders
  const dataDir = process.env.DIASHOW_DATA_DIR
  const cacheDir = join(dataDir || app.getPath('userData'), 'cache')
  // a project that had to be repaired when it was read: the editor shows what changed
  const onReport = (event: ProjectReportEvent): void => broadcast('project:report', event)
  const projects = createProjectStore(join(dataDir || app.getPath('documents'), 'Diashow Studio'), { onReport })
  // the undo history of each show, in userData (history.ts): never next to the .dshow
  const history = createHistoryStore({ dir: join(app.getPath('userData'), 'history'), log: (m) => log().info('history', m) })
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
    // an archived show brings its theme song; it plays when this app's song is another one
    const p = await importProjectFile(path, projects, { onReport, themeTracks: await themeMusic, loadOwn })
    if (!own) await history.clear(p.id)
    return p
  }
  // Network shares: trusted hosts come from the app settings; until they are read, none are
  const trustedHosts = new Set<string>()
  const allowPath = (p: string): boolean => {
    const host = uncHost(p)
    return !host || trustedHosts.has(host)
  }
  const service = createMediaService({
    ffmpegDir,
    cacheDir,
    allowPath,
    onUpdate: (item: MediaItem) => broadcast('media:update', item),
    onMusicUpdate: (track: MusicTrack) => broadcast('music:update', track),
    directDecode: directDecodeSupport,
    themeMusicDir
  })
  media = service
  // Warm up encoder detection so the export dialog has it ready
  void service.ffmpeg.encoders()
  const appSettings = createAppSettingsStore(join(app.getPath('userData'), 'settings.json'))
  const hostsLoaded = appSettings
    .get()
    .then((s) => (s.trustedHosts ?? []).forEach((h) => trustedHosts.add(h)))
    .catch(() => {})
  setMediaPathPolicy(allowPath)
  /** Shares the user picked files or folders on themselves are trusted from then on. */
  const trustPaths = async (paths: string[]): Promise<void> => {
    const fresh = [...new Set(paths.map(uncHost).filter((h): h is string => !!h && !trustedHosts.has(h)))]
    if (!fresh.length) return
    fresh.forEach((h) => trustedHosts.add(h))
    await appSettings.update({ trustedHosts: [...trustedHosts] }).catch(() => {})
  }
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
    themeMusicDir,
    encoders: () => service.ffmpeg.encoders()
  })

  // DIASHOW_LOCALE (e.g. en-US) overrides the Windows language, for tests in either language
  ipcMain.handle('app:locale', () => process.env.DIASHOW_LOCALE || app.getLocale())

  ipcMain.handle('media:import', async (_e, paths: string[]) => {
    await trustPaths(stringList(paths))
    return service.importPaths(stringList(paths))
  })
  ipcMain.handle('media:restore', async (_e, items: MediaItem[]) => {
    await hostsLoaded
    return service.restoreMedia(items)
  })
  ipcMain.handle('music:import', async (_e, paths: string[]) => {
    await trustPaths(stringList(paths))
    return service.importMusic(stringList(paths))
  })
  ipcMain.handle('music:restore', async (_e, tracks: MusicTrack[]) => {
    await hostsLoaded
    return service.restoreMusic(tracks)
  })
  ipcMain.handle('music:theme-songs', () => themeMusic)
  // the user agreed to open files on these network hosts (banner in the editor)
  ipcMain.handle('net:trust-hosts', async (_e, hosts: unknown) => {
    const list = Array.isArray(hosts) ? hosts.filter(validHost).map((h) => h.toLowerCase()) : []
    list.forEach((h) => trustedHosts.add(h))
    await appSettings.update({ trustedHosts: [...trustedHosts] })
  })
  // paths FFmpeg reads for the renderer: existing files only, never URLs (ipcGuards.ts)
  ipcMain.handle('audio:waveform', async (_e, path: string, buckets: number) => service.waveform(await checkLocalFile(path), buckets))
  ipcMain.handle('media:faces', (_e, id: string, faces: Rect[], desc?: number[][]) => service.setFaces(id, faces, desc))
  ipcMain.handle('media:video-faces', (_e, id: string, samples: VideoFaces[]) => service.setVideoFaces(id, samples))
  ipcMain.handle('media:frames', async (_e, path: string, times: number[], maxEdge: number) => service.videoFrames(await checkLocalFile(path), times, maxEdge))
  ipcMain.handle('media:strip', async (_e, path: string, count: number, height: number) => service.videoStrip(await checkLocalFile(path), count, height))
  ipcMain.handle('media:relink', async (_e, missing: MediaItem[], folder: string) => {
    await trustPaths([String(folder)])
    return service.relinkMedia(missing, folder)
  })
  ipcMain.handle('media:prioritize', (_e, ids: string[]) => service.prioritize(stringList(ids)))
  ipcMain.handle('media:stabilize', (_e, id: string) => service.stabilizeVideo(String(id)))
  // Sharing over the local network: uploads go to <Documents>/Diashow Studio/Uploads/<project>/<name>
  registerShare({ uploadsRoot: join(projects.dir, 'Uploads'), broadcast })
  // Ctrl+V: copied files, or a copied picture saved to <Documents>/Diashow Studio/Eingefügt/<project>
  registerPaste({ projectsDir: projects.dir, locale: () => process.env.DIASHOW_LOCALE || app.getLocale() })
  // "Nach dem Projekt aufräumen" and deleting a project with its data (cleanup.ts, safeDelete.ts)
  registerCleanup({ projects, cacheDir, uploadsRoot: join(projects.dir, 'Uploads'), pastedRoots: pastedRoots(projects.dir), exportsDir: join(app.getPath('userData'), 'exports'), media: service, exports: exportQueue, history })
  // "Diashow als ZIP archivieren" (archive/archive.ts): reads originals only, through the same share policy
  registerArchive({ projects, themeMusic: () => themeMusic, themeMusicDir, exports: exportQueue, allowPath, documentsDir: app.getPath('documents'), appVersion: appVersion() })
  registerSystemCheck({ ff: service.ffmpeg, cacheDir })
  // About dialog, third-party notices and the update hint
  registerAbout({ ff: service.ffmpeg, ffmpegDir, settings: appSettings })
  // "Problem melden": the bug form on GitHub with version, Windows and graphics card filled in
  registerReportProblem()
  // Damaged project files ("Projekt reparieren"), the error log and the diagnostics package
  // a repaired show starts with an empty undo history
  registerProjectRepair({ projects, onReport, onReplaced: (id) => history.clear(id).then(() => {}) })
  registerDiagnostics({
    loadProject: (id) => projects.peek(id),
    themeMusic: () => themeMusic,
    projectCounts: async () => (await projects.list()).map((p) => ({ slides: p.slideCount })),
    damaged: async () => (await projects.damaged()).map((d) => ({ reason: d.reason, bytes: d.bytes, backups: d.backups })),
    settings: () => appSettings.get(),
    systemInfo: () => collectSystemInfo({ ff: service.ffmpeg, cacheDir }, 15_000),
    ffmpegVersion: async () => /ffmpeg version (\S+)/.exec((await service.ffmpeg.capture(['-version'])).toString('utf8'))?.[1] ?? 'unknown'
  })
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
    return prepareRun((signal) => packProject(project, dir, { signal, onProgress: sendProgress, themeMusicDir }))
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
    // a pack the user opened from a share: its files sit next to it on that share
    await trustPaths([r.filePaths[0]])
    return importShow(r.filePaths[0])
  })

  ipcMain.handle('project:import-file', async (_e, path: string) => {
    if (typeof path !== 'string' || !path) throw new Error('no project file')
    await trustPaths([path])
    return importShow(path)
  })

  ipcMain.handle('project:list', () => projects.list())
  ipcMain.handle('project:load', (_e, id: string) => loadForEditor(id))
  // the editor's saves carry its undo history; it is written a moment after the project file
  ipcMain.handle('project:save', async (_e, project: Project, upload?: unknown) => {
    const r: { status: HistorySaveStatus } = { status: 'ignored' }
    await projects.save(project, (text) => (r.status = history.saved(project.id, text, upload)))
    if (r.status === 'ok' && (upload as { flush?: unknown }).flush === true) await history.flush(project.id)
    return r.status === 'resend' ? { resendHistory: true } : undefined
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
    exportJob = await startExport(checkDirectExport(options), ffmpegDir, join(cacheDir, 'export'), sendProgress, encoders)
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
  ipcMain.handle('app:gpu-choice', async (): Promise<GpuChoiceInfo> => {
    // Windows' software adapter ("Microsoft Basic Render Driver") is no second chip
    const chips = (await gpuDevices().catch(() => [])).filter((d) => !/microsoft|basic render/i.test(`${d.vendor} ${d.device}`)).length
    return { running: runningGpuPreference(), override: !!gpuOverride, chips }
  })
  ipcMain.handle('app:settings-get', () => appSettings.get())
  // merges: each part of the app (kiosk, update hint, …) writes only its own fields
  ipcMain.handle('app:settings-set', (_e, settings: AppSettings) => appSettings.update(settings))
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
    // the undo history waiting to be written goes to disk too
    const cleanup = Promise.allSettled([job ? job.cancel() : cancelActiveExport(), exportQueue.shutdown(), media?.dispose(), endExiftool(), history.flush()])
    // Never let a stuck child process block quitting
    const timeout = new Promise((resolve) => setTimeout(resolve, 4000))
    void Promise.race([cleanup, timeout]).finally(() => app.quit())
  })
}
