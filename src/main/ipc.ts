// Wires every IPC channel of the preload contract (src/preload/index.ts) to the main-process services:
// it makes the stores and services, hands them to the modules that register each area's channels
// (appMain, mediaMain, projectsMain, dialogs, export/exportMain and the other *Main modules), and
// lets the app quit only after exports, saves and the undo history are settled.
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { MediaItem, MusicTrack } from '@shared/types'
import type { ProjectReportEvent } from '@shared/diagnostics'
import { createAppSettingsStore } from './appSettings'
import { appLocale, registerApp } from './appMain'
import { directDecodeSupport } from './codecSupport'
import { registerDialogs } from './dialogs'
import { resolveFfmpegDir } from './ffmpeg'
import { endExiftool } from './media/exif'
import { createMediaService } from './media/service'
import { registerMedia } from './mediaMain'
import { createNetTrust } from './netTrust'
import { createProjectStore } from './projects'
import { registerProjects } from './projectsMain'
import { createHistoryStore } from './history'
import { createTrash } from './trash'
import { registerExport } from './export/exportMain'
import { registerExportQueue } from './export/queueMain'
import { registerShare } from './share/shareMain'
import { pastedRoots, registerPaste } from './pasteMain'
import { registerCleanup } from './cleanupMain'
import { registerArchive } from './archive/archiveMain'
import { collectSystemInfo, registerSystemCheck } from './systemCheck'
import { appVersion, registerAbout } from './about'
import { registerReportProblem } from './reportProblem'
import { log, registerDiagnostics } from './diagnostics'
import { registerProjectRepair } from './projectRepair'
import { setMediaPathPolicy, setThemeMusicDir } from './protocol'
import { loadThemeMusic, resolveThemeMusicDir } from './themeMusic'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

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
  const projectsDir = join(dataDir || app.getPath('documents'), 'Diashow Studio')
  // a deleted show lies in the trash for 30 days (trash.ts): in .trash of the projects folder, its undo
  // history and export jobs in <userData>/trash. DIASHOW_TRASH_CLOCK_DAYS puts its clock ahead (tests).
  const trashAhead = (Number(process.env.DIASHOW_TRASH_CLOCK_DAYS) || 0) * 86_400_000
  const trash = createTrash({
    projectsDir,
    dataDir: join(app.getPath('userData'), 'trash'),
    historyDir: join(app.getPath('userData'), 'history'),
    exportsDir: join(app.getPath('userData'), 'exports'),
    now: () => Date.now() + trashAhead,
    log: (m) => log().info('trash', m)
  })
  const projects = createProjectStore(projectsDir, { onReport, inTrash: (id) => trash.has(id) })
  // the undo history of each show, in userData (history.ts): never next to the .dshow
  const history = createHistoryStore({ dir: join(app.getPath('userData'), 'history'), log: (m) => log().info('history', m) })
  const appSettings = createAppSettingsStore(join(app.getPath('userData'), 'settings.json'))
  // files on network shares open only on trusted hosts (netTrust.ts)
  const net = createNetTrust(appSettings)
  const service = createMediaService({
    ffmpegDir,
    cacheDir,
    allowPath: net.allowPath,
    onUpdate: (item: MediaItem) => broadcast('media:update', item),
    onMusicUpdate: (track: MusicTrack) => broadcast('music:update', track),
    directDecode: directDecodeSupport,
    themeMusicDir
  })
  // Warm up encoder detection so the export dialog has it ready
  void service.ffmpeg.encoders()
  setMediaPathPolicy(net.allowPath)
  // Export queue: jobs in <userData>/exports, rendered one after another by a hidden worker window
  // whose export:frame / export:chunk / export:hires calls go to the queue (export/queueMain.ts)
  const exportQueue = registerExportQueue({
    dir: join(app.getPath('userData'), 'exports'),
    ffmpegDir,
    themeMusicDir,
    encoders: () => service.ffmpeg.encoders()
  })

  registerApp({ settings: appSettings })
  registerMedia({ service, projects, themeMusic, net })
  // Sharing over the local network: uploads go to <Documents>/Diashow Studio/Uploads/<project>/<name>
  registerShare({ uploadsRoot: join(projects.dir, 'Uploads'), broadcast })
  // Ctrl+V: copied files, or a copied picture saved to <Documents>/Diashow Studio/Eingefügt/<project>
  registerPaste({ projectsDir: projects.dir, locale: appLocale })
  // "Nach dem Projekt aufräumen", deleting a project into the trash and the trash (cleanup.ts, trash.ts, safeDelete.ts)
  const { ready: trashReady } = registerCleanup(
    { projects, cacheDir, uploadsRoot: join(projects.dir, 'Uploads'), pastedRoots: pastedRoots(projects.dir), exportsDir: join(app.getPath('userData'), 'exports'), media: service, exports: exportQueue, history, trash },
    { broadcast, log: (m) => log().info('trash', m) }
  )
  // "Diashow als ZIP archivieren" (archive/archive.ts): reads originals only, through the same share policy
  registerArchive({ projects, themeMusic: () => themeMusic, themeMusicDir, exports: exportQueue, allowPath: net.allowPath, documentsDir: app.getPath('documents'), appVersion: appVersion() })
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
    // shows in the trash: counted, never named
    trash: async () => {
      const t = await trash.list()
      return { shows: t.entries.length, damaged: t.problems.length }
    },
    settings: () => appSettings.get(),
    systemInfo: () => collectSystemInfo({ ff: service.ffmpeg, cacheDir }, 15_000),
    ffmpegVersion: async () => /ffmpeg version (\S+)/.exec((await service.ffmpeg.capture(['-version'])).toString('utf8'))?.[1] ?? 'unknown'
  })
  registerDialogs()
  const exports = registerExport({ service, ffmpegDir, cacheDir, themeMusicDir, queue: exportQueue, broadcast })
  let quitting = false
  const shows = registerProjects({ projects, history, themeMusic, onReport, net, trashReady, quitting: () => quitting })

  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    // the direct export and the preparations stop at once
    const exportStopped = exports.stop()
    // the undo history waiting to be written goes to disk too, also of saves the windows send while
    // they close: a project file written without its history would drop that history on the next start
    const cleanup = (async () => {
      await Promise.allSettled([exportStopped, exportQueue.shutdown(), service.dispose(), endExiftool(), history.flush()])
      await shows.settleSaves()
      await history.flush()
    })()
    // Never let a stuck child process block quitting
    const timeout = new Promise((resolve) => setTimeout(resolve, 4000))
    void Promise.race([cleanup, timeout]).finally(() => app.quit())
  })
}
