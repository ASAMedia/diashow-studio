// IPC of the direct export (benchmark, tests: encoder.ts) and of the preparations that report through
// export:progress and stop with export:cancel: 4K versions of videos (export:hires) and packing a
// project (project:pack). The export queue's worker window uses the same channels; its calls go to the
// queue (queueMain.ts).
import { ipcMain } from 'electron'
import { join } from 'node:path'
import type { ExportOptions, ExportProgress, Project } from '@shared/types'
import { checkDirectExport, stringList } from '../ipcGuards'
import type { MediaService } from '../media/service'
import { packProject } from '../projectFile'
import { cancelActiveExport, startExport, type ExportJob } from './encoder'
import type { ExportQueueMain } from './queueMain'

export interface ExportIpcDeps {
  service: MediaService
  ffmpegDir: string
  cacheDir: string
  themeMusicDir: string
  queue: ExportQueueMain
  broadcast: (channel: string, payload: unknown) => void
  /** Originals that may be read (netTrust.ts): packing leaves files on untrusted shares alone. */
  allowPath: (path: string) => boolean
}

/** Registers the channels; `stop` (the app quits) stops the preparations and cancels the direct export. */
export function registerExport(d: ExportIpcDeps): { stop: () => Promise<void> } {
  const { service, queue: exportQueue } = d
  let exportJob: ExportJob | null = null
  const sendProgress = (p: ExportProgress): void => d.broadcast('export:progress', p)
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

  ipcMain.handle('project:pack', (_e, project: Project, dir: string) => {
    if (typeof dir !== 'string' || !dir) throw new Error('no target folder')
    return prepareRun((signal) => packProject(project, dir, { signal, onProgress: sendProgress, themeMusicDir: d.themeMusicDir, allowPath: d.allowPath }))
  })

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
    const encoders = await service.ffmpeg.encoders()
    // a second start while one runs is refused by startExport and must not drop the running export
    exportJob = await startExport(checkDirectExport(options), d.ffmpegDir, join(d.cacheDir, 'export'), sendProgress, encoders)
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

  return {
    async stop() {
      const job = exportJob
      exportJob = null
      for (const ctrl of preparing) ctrl.abort()
      await (job ? job.cancel() : cancelActiveExport())
    }
  }
}
