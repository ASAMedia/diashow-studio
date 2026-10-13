// Electron side of diagnostics: the log file (<userData>/logs/diashow.log, rotated), what goes into it
// (app start with versions and GPU, main-process errors, unhandled rejections, crashed renderers and
// helper processes, errors the windows report through `diag:log`), and the diagnostics package.
import { app, BrowserWindow, dialog, ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { readFileSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { arch, homedir, release, version } from 'node:os'
import { join } from 'node:path'
import type { DiagnosticsInput, DiagnosticsPreview, RendererLogEntry } from '@shared/diagnostics'
import type { SystemInfo } from '@shared/systemCheck'
import type { ThemeTrack } from '@shared/themeMusic'
import type { Project } from '@shared/types'
import { trustedSender } from '../security'
import { createLogger, type Logger } from './logger'
import { packageFileName, packageFiles, previewOf, zipOf, type PackageSources } from './package'

let logger: Logger | null = null

/** The app's logger; a no-op stand-in before initLogging ran. */
export function log(): Pick<Logger, 'info' | 'warn' | 'error'> {
  return logger ?? { info: () => {}, warn: () => {}, error: () => {} }
}

/** package.json's version (a development run reports Electron's version as the app's otherwise). */
function appVersion(): string {
  if (app.isPackaged) return app.getVersion()
  for (const dir of [app.getAppPath(), process.cwd()]) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (pkg.name === 'diashow-studio' && pkg.version) return pkg.version
    } catch {
      // not here
    }
  }
  return app.getVersion()
}

/** Which window a web contents is: the editor, the presentation or the export worker. */
export function pageOf(contents: WebContents | null | undefined): string {
  try {
    const hash = contents ? new URL(contents.getURL()).hash : ''
    return hash === '#present' ? 'presentation' : hash === '#export-worker' ? 'export-worker' : contents ? 'editor' : '?'
  } catch {
    return '?'
  }
}

/** Allows `burst` events at once and one more every `everyMs`. */
export function rateLimiter(burst: number, everyMs: number, now: () => number = Date.now): () => boolean {
  let tokens = burst
  let last = now()
  return () => {
    const t = now()
    tokens = Math.min(burst, tokens + (t - last) / everyMs)
    last = t
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}

/**
 * Starts the log. Call once, early (after DIASHOW_DATA_DIR moved userData): it records the start and
 * hooks the process' error events and the crash events of renderers and helper processes.
 */
export function initLogging(): Logger {
  if (logger) return logger
  const l = createLogger({ dir: join(app.getPath('userData'), 'logs'), home: homedir() })
  logger = l
  l.info('app', `Diashow Studio ${appVersion()} starts`, {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    os: `${version()} ${release()} ${arch()}`,
    packaged: app.isPackaged
  })

  process.on('uncaughtExceptionMonitor', (err, origin) => l.error('main', `${origin}: ${err?.message ?? String(err)}`, err?.stack))
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : null
    l.error('main', `unhandled rejection: ${err ? err.message : String(reason)}`, err?.stack)
  })
  // what the main process itself reports on the console goes into the log too (rate-limited)
  const allow = rateLimiter(60, 2000)
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      if (allow()) l[level]('main', args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : typeof a === 'string' ? a : safeText(a))).join(' '))
    }
  }

  app.on('render-process-gone', (_e, contents, details) => {
    l.error('renderer', `${pageOf(contents)} window: render process gone (${details.reason}, exit code ${details.exitCode})`)
  })
  app.on('child-process-gone', (_e, details) => {
    const level = details.reason === 'clean-exit' ? 'info' : 'error'
    l[level]('process', `${details.type}${details.name ? ` (${details.name})` : ''} gone: ${details.reason}, exit code ${details.exitCode}`)
  })
  app.on('browser-window-created', (_e, win) => {
    win.on('unresponsive', () => l.warn('window', `${pageOf(win.webContents)} window is not responding`))
    win.on('responsive', () => l.info('window', `${pageOf(win.webContents)} window responds again`))
  })
  app.on('will-quit', () => l.info('app', 'quits'))

  void app.whenReady().then(async () => {
    try {
      const info = (await Promise.race([app.getGPUInfo('basic'), new Promise((r) => setTimeout(() => r(null), 5000))])) as {
        gpuDevice?: { vendorId?: number; deviceId?: number; active?: boolean; driverVersion?: string }[]
      } | null
      const gpus = (info?.gpuDevice ?? []).map((d) => `${(d.vendorId ?? 0).toString(16).padStart(4, '0')}:${(d.deviceId ?? 0).toString(16).padStart(4, '0')}${d.driverVersion ? ` driver ${d.driverVersion}` : ''}${d.active ? ' active' : ''}`)
      const features = app.getGPUFeatureStatus() as unknown as Record<string, string>
      l.info('app', `ready; locale ${app.getLocale()}; GPU ${gpus.join(', ') || 'unknown'}`, {
        webgl: features.webgl,
        webgl2: features.webgl2,
        video_decode: features.video_decode,
        gpu_compositing: features.gpu_compositing
      })
    } catch (err) {
      l.warn('app', 'GPU information unavailable', err)
    }
  })
  return l
}

function safeText(v: unknown): string {
  if (v === null || v === undefined) return String(v)
  if (Array.isArray(v)) return `[array of ${v.length}]`
  if (typeof v === 'object') return `{${Object.keys(v as object).slice(0, 10).join(', ')}}`
  return String(v)
}

const clip = (v: unknown, max: number): string => (typeof v === 'string' ? v : v === undefined ? '' : String(v)).slice(0, max)

/** A renderer's report, checked and capped. */
export function cleanEntry(raw: unknown): RendererLogEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const kinds: RendererLogEntry['kind'][] = ['error', 'rejection', 'console', 'export', 'media', 'info']
  const kind = kinds.includes(e.kind as RendererLogEntry['kind']) ? (e.kind as RendererLogEntry['kind']) : 'error'
  const message = clip(e.message, 2000)
  if (!message) return null
  const out: RendererLogEntry = { kind, message }
  if (e.stack) out.stack = clip(e.stack, 4000)
  if (e.where) out.where = clip(e.where, 200)
  if (typeof e.repeat === 'number' && Number.isFinite(e.repeat) && e.repeat > 1) out.repeat = Math.min(1e6, Math.floor(e.repeat))
  return out
}

export interface DiagnosticsConfig {
  /** The open project as saved (null when unknown). */
  loadProject: (id: string) => Promise<Project | null>
  /** The bundled theme songs, to tell whether the open project plays one. */
  themeMusic?: () => Promise<ThemeTrack[]>
  /** All saved projects, counted. */
  projectCounts: () => Promise<PackageSources['projects']>
  damaged: () => Promise<PackageSources['damaged']>
  /** The trash, counted (trash.ts). */
  trash?: () => Promise<NonNullable<PackageSources['trash']>>
  settings: () => Promise<unknown>
  systemInfo: () => Promise<SystemInfo>
  ffmpegVersion: () => Promise<string>
}

/** Registers diag:log (reports from the windows) and the diagnostics package (preview and save). */
export function registerDiagnostics(cfg: DiagnosticsConfig): void {
  const l = initLogging()
  const limits = new Map<number, () => boolean>()
  let dropped = 0
  ipcMain.on('diag:log', (e: IpcMainEvent, raw: unknown) => {
    if (!trustedSender(e)) return
    const id = e.sender.id
    let allow = limits.get(id)
    if (!allow) {
      // 20 at once, then one every 3 s per window
      allow = rateLimiter(20, 3000)
      limits.set(id, allow)
      e.sender.once('destroyed', () => limits.delete(id))
    }
    if (!allow()) {
      if (dropped++ % 100 === 0) l.warn('renderer', `${pageOf(e.sender)}: too many reports, some are left out`)
      return
    }
    const entry = cleanEntry(raw)
    if (!entry) return
    const level = entry.kind === 'info' ? 'info' : 'error'
    const repeat = entry.repeat ? ` (×${entry.repeat})` : ''
    l[level](`renderer:${pageOf(e.sender)}`, `${entry.kind}: ${entry.message}${repeat}${entry.where ? ` @ ${entry.where}` : ''}`, entry.stack)
  })

  const sources = async (input: DiagnosticsInput): Promise<PackageSources> => {
    const safe = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback)
    const projectId = typeof input?.projectId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.projectId) ? input.projectId : null
    const [system, settings, project, projects, damaged, ffmpeg, themeTracks, trash] = await Promise.all([
      cfg.systemInfo().catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })),
      safe(cfg.settings(), {}),
      projectId ? safe(cfg.loadProject(projectId), null) : Promise.resolve(null),
      safe(cfg.projectCounts(), []),
      safe(cfg.damaged(), []),
      safe(cfg.ffmpegVersion(), 'unknown'),
      safe(cfg.themeMusic?.() ?? Promise.resolve([]), []),
      safe(cfg.trash?.() ?? Promise.resolve(undefined), undefined)
    ])
    const sizes = new Map<string, number>()
    if (project && project.media.length <= 5000) {
      // file sizes of the originals (no content is read); a few at a time
      const list = project.media.slice()
      await Promise.all(
        Array.from({ length: 16 }, async () => {
          for (let m = list.shift(); m; m = list.shift()) {
            const size = await stat(m.path).then((st) => st.size, () => undefined)
            if (size !== undefined) sizes.set(m.id, size)
          }
        })
      )
    }
    const logs: PackageSources['logs'] = []
    for (const file of logger?.files() ?? []) {
      const text = await readFile(file, 'utf8').catch(() => null)
      if (text !== null) logs.push({ name: file.split(/[\\/]/).pop()!, text })
    }
    return {
      now: Date.now(),
      home: homedir(),
      versions: {
        app: appVersion(),
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node,
        v8: process.versions.v8 ?? '',
        ffmpeg,
        os: `${version()} (${release()}, ${arch()})`,
        packaged: String(app.isPackaged),
        locale: app.getLocale()
      },
      system,
      settings,
      input: sanitizeInput(input),
      project,
      sizes,
      themeTracks,
      projects,
      damaged,
      ...(trash ? { trash } : {}),
      logs
    }
  }

  ipcMain.handle('diag:preview', async (_e, input: DiagnosticsInput): Promise<DiagnosticsPreview> => {
    const src = await sources(input)
    const files = packageFiles(src)
    return { files: previewOf(files), bytes: zipOf(files, src.now).length, fileName: packageFileName(src.now) }
  })

  ipcMain.handle('diag:save', async (e, input: DiagnosticsInput): Promise<string | null> => {
    const now = Date.now()
    const opts: Electron.SaveDialogOptions = {
      title: 'Diagnosepaket speichern',
      defaultPath: join(app.getPath('desktop'), packageFileName(now)),
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const target = /\.zip$/i.test(r.filePath) ? r.filePath : `${r.filePath}.zip`
    const src = await sources(input)
    await writeFile(target, zipOf(packageFiles(src), src.now))
    l.info('diagnostics', `package saved (${target})`)
    return target
  })
}

/** Only the fields the package uses, with plain values. */
function sanitizeInput(raw: DiagnosticsInput): DiagnosticsInput {
  const out: DiagnosticsInput = {}
  if (raw?.renderer && typeof raw.renderer === 'object') {
    out.renderer = {}
    for (const [k, v] of Object.entries(raw.renderer).slice(0, 30)) {
      if (['string', 'number', 'boolean'].includes(typeof v) || v === null) out.renderer[k.slice(0, 40)] = typeof v === 'string' ? v.slice(0, 300) : v
    }
  }
  if (Array.isArray(raw?.exportJobs)) {
    out.exportJobs = raw.exportJobs.slice(-50).map((j) => ({
      state: clip(j?.state, 20),
      width: Number(j?.width) || 0,
      height: Number(j?.height) || 0,
      codec: clip(j?.codec, 10),
      ...(Number(j?.fps) ? { fps: Number(j.fps) } : {}),
      ...(j?.error ? { error: clip(j.error, 500) } : {})
    }))
  }
  return out
}
