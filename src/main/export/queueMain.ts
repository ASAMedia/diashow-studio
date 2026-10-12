// Electron side of the export queue (queue.ts): the hidden worker window that renders the jobs, the
// queue:* and worker:* IPC channels, throttled updates to the other windows, and keeping the PC
// from sleeping while a job runs.
import { app, BrowserWindow, ipcMain, powerSaveBlocker, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { EncoderInfo, ExportProgress } from '@shared/types'
import type { ExportJobState } from '@shared/exportQueue'
import { denyPopups, loadRenderer, rendererWebPreferences } from '../presentation'
import { openExportQueue, throttle, type ExportQueue } from './queue'

/** No frame for this long while rendering: the worker hangs. */
const VIDEO_STALL_MS = 3 * 60_000
/** Preparing (4K sources) reports progress through prepareHires; nothing for this long: it hangs. */
const PREPARE_STALL_MS = 15 * 60_000
/** A page that stays unresponsive (busy main thread) this long is replaced. */
const UNRESPONSIVE_MS = 60_000
/** A new worker page must ask for work (workerNext) within this time. */
const START_MS = 2 * 60_000
/** Workers in a row that never asked for work before we stop starting new ones (until the next add / resume). */
const MAX_FAILED_STARTS = 2

export interface ExportQueueMain {
  /** export:frame / export:chunk belong to the queue: always from the worker; from other windows while a segment is active and no regular export runs. */
  routes(sender: WebContents, regularExport: boolean): boolean
  isWorker(sender: WebContents): boolean
  writeFrame(data: unknown): Promise<void>
  writeChunk(data: unknown): Promise<void>
  /** exportCancel from the worker: drops the active segment (the job keeps running). */
  discardSegment(): Promise<void>
  /** The worker's prepareHires: aborted with the job (cancel, pause); its progress counts as activity. */
  prepare<T>(run: (signal: AbortSignal, onProgress: (p: ExportProgress) => void) => Promise<T>): Promise<T>
  /** App quits: pauses the running job (resumable) and closes the worker. */
  shutdown(): Promise<void>
  /** The clean-up: a project's jobs, and taking a finished one out of the queue (queue.ts). */
  jobsOf(projectId: string): Promise<{ id: string; dir: string; state: ExportJobState; outPath: string }[]>
  forget(id: string): Promise<void>
}

export function registerExportQueue(cfg: { dir: string; ffmpegDir: string; encoders: () => Promise<EncoderInfo> }): ExportQueueMain {
  let queue: ExportQueue | null = null
  let worker: BrowserWindow | null = null
  let workerContents = -1
  let workerAsked = false
  let failedStarts = 0
  let stopping: Promise<void> | null = null
  let blocker: number | null = null

  const isWorker = (sender: WebContents): boolean => workerContents >= 0 && sender.id === workerContents
  /** Every window but the worker (editor, presentation). */
  const visibleWindows = (except?: BrowserWindow): BrowserWindow[] =>
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== worker && w !== except)

  const sendUpdate = throttle(() => {
    if (!queue) return
    const jobs = queue.list()
    for (const win of visibleWindows()) win.webContents.send('queue:update', jobs)
  }, 250)

  const syncAwake = (): void => {
    const want = !!queue?.busy && !stopping
    if (want && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
    else if (!want && blocker !== null) {
      powerSaveBlocker.stop(blocker)
      blocker = null
    }
  }

  const ready = openExportQueue({
    dir: cfg.dir,
    ffmpegDir: cfg.ffmpegDir,
    encoders: cfg.encoders,
    onChange: () => {
      sendUpdate()
      syncAwake()
    }
  }).then((q) => {
    queue = q
    return q
  })
  ready.catch((err) => console.error('export queue could not open', err))

  // ---- the worker window

  const detach = (): BrowserWindow | null => {
    const win = worker
    worker = null
    workerContents = -1
    return win
  }

  /** The worker crashed, hung or closed: its job is handed out once more (queue.workerLost), then a new worker starts. */
  const lose = (win: BrowserWindow, reason: string): void => {
    if (worker !== win) return
    if (!workerAsked) failedStarts++
    detach()
    if (!win.isDestroyed()) win.destroy()
    if (stopping || !queue) return
    const q = queue
    void q.workerLost(reason).finally(() => ensureWorker())
  }

  function ensureWorker(): void {
    if (stopping || !queue || !queue.hasWork()) return
    if (worker && !worker.isDestroyed()) return
    // the app is closing, or the page keeps failing to start
    if (!visibleWindows().length || failedStarts >= MAX_FAILED_STARTS) return
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      title: 'Diashow Studio – Export',
      webPreferences: rendererWebPreferences()
    })
    worker = win
    workerContents = win.webContents.id
    workerAsked = false
    denyPopups(win)
    const startTimer = setTimeout(() => {
      if (worker === win && !workerAsked) lose(win, 'the export page did not start')
    }, START_MS)
    let unresponsive: ReturnType<typeof setTimeout> | null = null
    win.on('unresponsive', () => {
      unresponsive ??= setTimeout(() => lose(win, 'not responding'), UNRESPONSIVE_MS)
    })
    win.on('responsive', () => {
      if (unresponsive) clearTimeout(unresponsive)
      unresponsive = null
    })
    win.webContents.on('render-process-gone', (_e, details) => lose(win, `render process ${details.reason}`))
    win.webContents.on('did-fail-load', (_e, _code, description, _url, isMainFrame) => {
      if (isMainFrame) lose(win, `page did not load (${description})`)
    })
    win.on('closed', () => {
      clearTimeout(startTimer)
      if (unresponsive) clearTimeout(unresponsive)
      if (worker === win) lose(win, 'window closed')
    })
    void loadRenderer(win, 'export-worker').catch(() => {
      // reported through did-fail-load
    })
  }

  const watchdog = setInterval(() => {
    const win = worker
    if (!queue || !win || win.isDestroyed()) return
    const a = queue.workerActivity()
    if (!a) return
    if (a.phase === 'video' && a.idleMs > VIDEO_STALL_MS) lose(win, 'no frames for 3 minutes')
    else if (a.phase === 'prepare' && a.idleMs > PREPARE_STALL_MS) lose(win, 'no progress for 15 minutes')
  }, 15_000)

  const stop = (): Promise<void> => {
    if (!stopping) {
      clearInterval(watchdog)
      sendUpdate.cancel()
      const win = detach()
      if (win && !win.isDestroyed()) win.destroy()
      // job.json says 'paused' right away; the rest (killing FFmpeg, temp files) follows
      stopping = (queue ? queue.close() : ready.then((q) => q.close())).catch(() => {})
      syncAwake()
    }
    return stopping
  }

  // The last visible window closed during a job: pause it (resumable) and close the worker, so
  // 'window-all-closed' fires and the app quits as usual.
  app.on('browser-window-created', (_e, win) => {
    win.on('closed', () => {
      if (stopping || win === worker) return
      if (!visibleWindows(win).length) void stop()
    })
  })

  // ---- IPC

  const workerOnly = (e: IpcMainInvokeEvent): void => {
    if (!isWorker(e.sender)) throw new Error('only the export worker can do this')
  }

  ipcMain.handle('queue:add', async (_e, job: unknown) => {
    const q = await ready
    const info = await q.add(job)
    failedStarts = 0
    ensureWorker()
    return info
  })
  ipcMain.handle('queue:list', async () => (await ready).list())
  ipcMain.handle('queue:cancel', async (_e, id: unknown) => {
    await (await ready).cancel(id)
  })
  ipcMain.handle('queue:remove', async (_e, id: unknown) => {
    await (await ready).remove(id)
  })
  ipcMain.handle('queue:resume', async (_e, id: unknown) => {
    const q = await ready
    await q.resume(id)
    failedStarts = 0
    ensureWorker()
  })

  ipcMain.handle('worker:next', async (e) => {
    workerOnly(e)
    workerAsked = true
    failedStarts = 0
    const q = await ready
    const task = await q.next()
    if (!task && isWorker(e.sender)) {
      // nothing left: the worker closes after this reply (a job added meanwhile gets a new one)
      const win = detach()
      setImmediate(() => {
        if (win && !win.isDestroyed()) win.destroy()
        ensureWorker()
      })
    }
    return task
  })
  ipcMain.handle('worker:segment-start', async (e, jobId: unknown, k: unknown, input: unknown) => {
    workerOnly(e)
    await (await ready).segmentStart(jobId, k, input)
  })
  ipcMain.handle('worker:segment-finish', async (e, jobId: unknown, k: unknown) => {
    workerOnly(e)
    await (await ready).segmentFinish(jobId, k)
  })
  ipcMain.handle('worker:fail', async (e, jobId: unknown, message: unknown) => {
    workerOnly(e)
    await (await ready).fail(jobId, message)
  })

  const ensureQueue = (): ExportQueue => {
    if (!queue) throw new Error('the export queue is not ready')
    return queue
  }

  return {
    routes: (sender, regularExport) => isWorker(sender) || (!regularExport && !!queue?.segmentActive),
    isWorker,
    // no await before the queue call: frames in flight must reach FFmpeg in the order they came
    writeFrame: (data) => ensureQueue().writeFrame(data),
    writeChunk: (data) => ensureQueue().writeChunk(data),
    discardSegment: () => ensureQueue().discardSegment(),
    async prepare(run) {
      const q = await ready
      const signal = q.prepareSignal()
      if (!signal) throw new Error('no export job is being prepared')
      return run(signal, () => q.touch())
    },
    shutdown: stop,
    jobsOf: async (projectId) => (await ready).jobsOf(projectId),
    forget: async (id) => (await ready).forget(id)
  }
}
