// Export queue (main process, Electron-free): jobs are stored in <dir>/<jobId>/ and rendered by a
// worker window in segments of 30 s, so they run one after another in the background and continue
// after a crash or a restart from the last finished segment.
//
// The job folders are described in jobStore.ts, the segments in segments.ts. After the last segment
// the streams are joined in order and muxed with mix.wav (assemble.ts).
//
// Window management and IPC live in queueMain.ts.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ExportJobInfo, ExportJobState, ExportTask } from '@shared/exportQueue'
import type { EncoderInfo } from '@shared/types'
import { abortError } from '../abort'
import { Ffmpeg } from '../ffmpeg'
import { rebaseThemeMusic } from '../themeMusic'
import { joinSegments } from './assemble'
import { mixAudioPlan } from './audioMix'
import { pickEncoder } from './encoder'
import {
  chaptersPath, CLIPS_DIR, currentFrame, deleteWorkFiles, loadJobs, makeJob, mixPath, partialOutputPath, remaining, saveJob, segmentCount,
  segmentLength, segmentPath, type Job, type JobFile, type Phase
} from './jobStore'
import { openChunkSegment, openRawSegment } from './segments'
import { validateId, validateInput, validateNewJob } from './validate'

export { partialOutputPath } from './jobStore'

/** Seconds of video per segment: what a crash can cost at most. */
export const SEGMENT_SECONDS = 30
/** States in which a job still holds (or will produce) work files. */
const OPEN_STATES: readonly ExportJobState[] = ['queued', 'running', 'paused', 'error']

function samePath(a: string, b: string): boolean {
  const x = resolve(a)
  const y = resolve(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Calls fn at most every `ms` (first call right away, the last one is never lost). */
export function throttle(fn: () => void, ms: number): { (): void; cancel(): void } {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = (): void => {
    timer = null
    last = Date.now()
    fn()
  }
  const call = (): void => {
    if (timer) return
    const wait = last + ms - Date.now()
    if (wait <= 0) run()
    else timer = setTimeout(run, wait)
  }
  call.cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return call
}

// ------------------------------------------------------------------ the queue

export interface ExportQueueOptions {
  /** Folder with one subfolder per job, e.g. <userData>/exports. */
  dir: string
  ffmpegDir: string
  /** The bundled theme songs, where a resumed job finds its theme song again (themeMusic.ts). */
  themeMusicDir?: string
  /** Encoder detection; defaults to Ffmpeg.encoders(). */
  encoders?: () => Promise<EncoderInfo>
  /** Segment length in seconds (default 30; tests use shorter ones). */
  segmentSeconds?: number
  /** Called on every change (jobs, states, progress). The caller throttles. */
  onChange?: () => void
}

export interface WorkerActivity {
  jobId: string
  phase: Phase
  /** Milliseconds since the worker last delivered something for the job. */
  idleMs: number
}

export interface ExportQueue {
  readonly dir: string
  /** All jobs, oldest first. */
  list(): ExportJobInfo[]
  add(job: unknown): Promise<ExportJobInfo>
  /** Stops a running job; deletes its parts and partial output; state 'cancelled'. No-op when done. */
  cancel(id: unknown): Promise<void>
  /** Deletes a job's folder; not while it runs. */
  remove(id: unknown): Promise<void>
  /** The jobs of a project (by the id in their snapshot), for the clean-up. */
  jobsOf(projectId: string): { id: string; dir: string; state: ExportJobState; outPath: string }[]
  /** The clean-up: a finished (done, cancelled, failed) job leaves the queue; its folder is deleted by the caller. */
  forget(id: unknown): Promise<void>
  /** paused / error → queued. */
  resume(id: unknown): Promise<void>

  // ---- worker
  /**
   * The next task: the running job again when the worker lost it (crash, reload), else the oldest
   * queued job. Waits for a job being joined first. null when nothing is left.
   */
  next(): Promise<ExportTask | null>
  segmentStart(jobId: unknown, k: unknown, input: unknown): Promise<void>
  segmentFinish(jobId: unknown, k: unknown): Promise<void>
  /** The worker gives up on its job: state 'error'. Ignored when the job no longer runs. */
  fail(jobId: unknown, message: unknown): Promise<void>
  /** export:frame while a segment is active. */
  writeFrame(data: unknown): Promise<void>
  /** export:chunk while a segment is active. */
  writeChunk(data: unknown): Promise<void>
  /** Drops the active segment (the worker restarts it with segmentStart). */
  discardSegment(): Promise<void>
  readonly segmentActive: boolean
  /** Abort signal for the worker's source preparation of its job (aborted on cancel / pause). */
  prepareSignal(): AbortSignal | undefined
  /** The worker made progress outside of frames (e.g. preparing sources). */
  touch(): void

  // ---- lifecycle (queueMain.ts)
  /** A job runs (keep the PC awake). */
  readonly busy: boolean
  /** Something for a worker to do: a queued job, or a running one without worker. */
  hasWork(): boolean
  workerActivity(): WorkerActivity | null
  /** The worker window crashed or hung: its job is handed out once more, the second time it fails. */
  workerLost(reason: string): Promise<void>
  /** The running job becomes 'paused' (resumable); its state is saved before this returns a promise. */
  pause(): Promise<void>
  /** pause() and stop everything (app quits). */
  close(): Promise<void>
}

export async function openExportQueue(opts: ExportQueueOptions): Promise<ExportQueue> {
  const root = resolve(opts.dir)
  const ff = new Ffmpeg(opts.ffmpegDir)
  const encoders = opts.encoders ?? (() => ff.encoders())
  const segmentSeconds = opts.segmentSeconds ?? SEGMENT_SECONDS
  const jobs = new Map<string, Job>()
  let lastCreated = 0
  /** Why the worker's data is refused, e.g. after a cancel. */
  let stopped: string | null = null
  let closed = false
  const changed = (): void => {
    try {
      opts.onChange?.()
    } catch {
      // a listener's problem
    }
  }

  // ---- load what is on disk

  await mkdir(root, { recursive: true })
  for (const job of await loadJobs(root)) {
    lastCreated = Math.max(lastCreated, job.file.createdAt)
    jobs.set(job.file.id, job)
  }

  // ---- state

  const sorted = (): Job[] => [...jobs.values()].sort((a, b) => a.file.createdAt - b.file.createdAt || (a.file.id < b.file.id ? -1 : 1))
  const runningJob = (): Job | undefined => sorted().find((j) => j.file.state === 'running')

  const fpsOf = (job: Job): number | undefined => {
    const s = job.samples
    if (!s.length) return undefined
    const span = Date.now() - s[0].t
    if (span < 1000) return undefined
    return Math.round(((currentFrame(job) - s[0].frame) * 10_000) / span) / 10
  }

  const info = (job: Job): ExportJobInfo => {
    const f = job.file
    const running = f.state === 'running'
    return {
      id: f.id,
      name: f.name,
      outPath: f.request.outPath,
      state: f.state,
      ...(running && job.phase ? { phase: job.phase } : {}),
      frame: currentFrame(job),
      totalFrames: f.totalFrames,
      ...(running && job.phase === 'video' ? { fps: fpsOf(job) } : {}),
      ...(f.error ? { error: f.error } : {}),
      createdAt: f.createdAt,
      ...(f.startedAt ? { startedAt: f.startedAt } : {}),
      ...(f.finishedAt ? { finishedAt: f.finishedAt } : {}),
      width: f.request.width,
      height: f.request.height,
      codec: f.request.codec,
      ...(f.chapters?.length ? { chapters: f.chapters } : {})
    }
  }

  const touch = (job: Job): void => {
    const now = Date.now()
    job.lastActivity = now
    const s = job.samples
    if (!s.length || now - s[s.length - 1].t >= 200) s.push({ t: now, frame: currentFrame(job) })
    while (s.length > 1 && now - s[0].t > 5000) s.shift()
  }

  const getJob = (id: unknown): Job => {
    const job = jobs.get(validateId(id))
    if (!job) throw new Error('export job not found')
    return job
  }

  /** The running job the worker has; anything else is refused with the reason. */
  const workerJob = (id: unknown): Job => {
    const job = getJob(id)
    if (job.file.state !== 'running') throw new Error(`export job ${job.file.state}`)
    if (!job.attached) throw new Error('export job is not handed out')
    return job
  }

  const activeJob = (): Job | undefined => {
    for (const job of jobs.values()) if (job.segment) return job
    return undefined
  }

  /** Stops everything the job has going; its state was set (and saved) by the caller. */
  const stopWork = async (job: Job): Promise<void> => {
    job.attached = false
    job.prepareAbort?.abort()
    job.prepareAbort = null
    const segment = job.segment
    job.segment = null
    job.mixAbort?.abort()
    job.assemblyAbort?.abort()
    await Promise.allSettled([segment?.abort(), job.mixing, job.assembling])
  }

  const failJob = async (job: Job, message: string): Promise<void> => {
    if (job.file.state !== 'running') return
    job.file.state = 'error'
    job.file.error = message.slice(0, 1000)
    job.file.finishedAt = Date.now()
    job.phase = undefined
    stopped = `export job failed: ${job.file.error}`
    saveJob(job)
    changed()
    await stopWork(job)
    changed()
  }

  // ---- audio

  /** Mixes the audio plan once (reused on resume). Resolves when mix.wav is there. */
  const ensureMix = (job: Job): Promise<void> => {
    if (existsSync(mixPath(job))) return Promise.resolve()
    if (job.mixing) return job.mixing
    const ctrl = new AbortController()
    const tmp = `${mixPath(job)}.tmp`
    const clips = join(job.dir, CLIPS_DIR)
    let run: Promise<void> | undefined
    run = (async (): Promise<void> => {
      try {
        await mixAudioPlan(ff, rebaseThemeMusic(job.file.audio, opts.themeMusicDir ?? ''), tmp, clips, { signal: ctrl.signal })
        if (ctrl.signal.aborted) throw abortError()
        await rename(tmp, mixPath(job))
      } catch (err) {
        await rm(tmp, { force: true, maxRetries: 5, retryDelay: 100 })
        throw err
      } finally {
        await rm(clips, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        if (job.mixing === run) {
          job.mixing = null
          job.mixAbort = null
        }
      }
    })()
    job.mixing = run
    job.mixAbort = ctrl
    run.catch((err: unknown) => {
      // a failed mix fails the job, unless it was stopped on purpose
      if (!ctrl.signal.aborted) void failJob(job, `Audio could not be mixed: ${errorMessage(err)}`)
    })
    return run
  }

  // ---- joining the parts

  const assemble = async (job: Job): Promise<void> => {
    const ctrl = new AbortController()
    job.assemblyAbort = ctrl
    job.phase = 'finishing'
    job.attached = false
    changed()
    const { request, totalFrames } = job.file
    const partial = partialOutputPath(request.outPath, job.file.id)
    try {
      await ensureMix(job)
      if (ctrl.signal.aborted) throw abortError()
      await joinSegments(ff, {
        segments: Array.from({ length: segmentCount(job) }, (_, k) => segmentPath(job, k)),
        audio: mixPath(job),
        codec: request.codec,
        fps: request.fps,
        totalFrames,
        partial,
        out: request.outPath,
        signal: ctrl.signal,
        ...(job.file.chapters?.length ? { chapters: job.file.chapters, chaptersFile: chaptersPath(job) } : {})
      })
      job.file.state = 'done'
      job.file.finishedAt = Date.now()
      delete job.file.error
      job.phase = undefined
      saveJob(job)
      await deleteWorkFiles(job, false)
      changed()
    } catch (err) {
      await rm(partial, { force: true, maxRetries: 5, retryDelay: 100 })
      if (ctrl.signal.aborted || job.file.state !== 'running') return
      // the parts stay: "Continue" tries the joining again
      job.file.state = 'error'
      job.file.error = `Joining the parts failed: ${errorMessage(err)}`.slice(0, 1000)
      job.file.finishedAt = Date.now()
      job.phase = undefined
      saveJob(job)
      changed()
    } finally {
      if (job.assemblyAbort === ctrl) job.assemblyAbort = null
    }
  }

  const startAssembly = (job: Job): Promise<void> => {
    if (!job.assembling) {
      const run = assemble(job).finally(() => {
        if (job.assembling === run) job.assembling = null
      })
      job.assembling = run
    }
    return job.assembling
  }

  // ---- worker

  const handOut = (job: Job): ExportTask => {
    job.attached = true
    job.phase = 'prepare'
    job.samples = []
    job.prepareAbort?.abort()
    job.prepareAbort = new AbortController()
    stopped = null
    touch(job)
    // the audio is mixed while the worker renders
    void ensureMix(job).catch(() => {})
    changed()
    return {
      jobId: job.file.id,
      project: job.file.project,
      request: job.file.request,
      totalFrames: job.file.totalFrames,
      segmentFrames: job.file.segmentFrames,
      segments: remaining(job),
      ...(job.file.input ? { input: job.file.input } : {}),
      ...(job.file.themeSong ? { themeSong: job.file.themeSong } : {})
    }
  }

  const findNext = async (): Promise<ExportTask | null> => {
    for (;;) {
      if (closed) return null
      const joining = [...jobs.values()].find((j) => j.assembling)
      if (joining) {
        await joining.assembling
        continue
      }
      let job = runningJob()
      if (job) {
        // the worker lost its task (crash, reload): from the last finished segment again
        const segment = job.segment
        job.segment = null
        await segment?.abort()
        if (job.file.state !== 'running') continue
      } else {
        job = sorted().find((j) => j.file.state === 'queued')
        if (!job) return null
        job.file.state = 'running'
        job.file.startedAt ??= Date.now()
        delete job.file.finishedAt
        delete job.file.error
        saveJob(job)
      }
      if (!remaining(job).length) {
        // all parts are there (e.g. the joining failed or was interrupted before)
        await startAssembly(job)
        continue
      }
      return handOut(job)
    }
  }
  let nextChain: Promise<unknown> = Promise.resolve()

  const queue: ExportQueue = {
    dir: root,

    list: () => sorted().map(info),

    async add(raw) {
      if (closed) throw new Error('the export queue is closed')
      const job = validateNewJob(raw)
      for (const other of jobs.values()) {
        if (OPEN_STATES.includes(other.file.state) && samePath(other.file.request.outPath, job.request.outPath)) {
          throw new Error(`"${other.file.name}" in the export queue already writes to this file`)
        }
      }
      const createdAt = Math.max(Date.now(), lastCreated + 1)
      lastCreated = createdAt
      const id = `${createdAt.toString(36)}-${randomBytes(4).toString('hex')}`
      const dir = join(root, id)
      await mkdir(dir, { recursive: true })
      const fps = job.request.fps
      const file: JobFile = {
        version: 1,
        id,
        name: job.name,
        request: job.request,
        state: 'queued',
        totalFrames: Math.max(1, Math.ceil(job.audio.duration * fps - 1e-6)),
        segmentFrames: Math.max(1, Math.round(segmentSeconds * fps)),
        segments: [],
        createdAt,
        project: job.project,
        audio: job.audio,
        ...(job.chapters?.length ? { chapters: job.chapters } : {}),
        ...(job.themeSong ? { themeSong: job.themeSong } : {})
      }
      const entry = makeJob(file, dir)
      saveJob(entry)
      jobs.set(id, entry)
      changed()
      return info(entry)
    },

    async cancel(id) {
      const job = getJob(id)
      if (job.file.state === 'done' || job.file.state === 'cancelled') return
      job.file.state = 'cancelled'
      job.file.finishedAt = Date.now()
      delete job.file.error
      job.phase = undefined
      job.file.segments = []
      stopped = 'export job cancelled'
      saveJob(job)
      changed()
      await stopWork(job)
      await deleteWorkFiles(job, false)
      changed()
    },

    async remove(id) {
      const job = getJob(id)
      if (job.file.state === 'running') throw new Error('the export is running; cancel it first')
      await stopWork(job)
      jobs.delete(job.file.id)
      await rm(partialOutputPath(job.file.request.outPath, job.file.id), { force: true, maxRetries: 5, retryDelay: 100 })
      await rm(job.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      changed()
    },

    jobsOf(projectId) {
      return sorted()
        .filter((j) => j.file.project?.id === projectId)
        .map((j) => ({ id: j.file.id, dir: j.dir, state: j.file.state, outPath: j.file.request.outPath }))
    },

    async forget(id) {
      const job = getJob(id)
      if (!['done', 'cancelled', 'error'].includes(job.file.state)) throw new Error(`a ${job.file.state} export stays in the queue`)
      await stopWork(job)
      jobs.delete(job.file.id)
      changed()
    },

    async resume(id) {
      const job = getJob(id)
      if (job.file.state === 'queued' || job.file.state === 'running') return
      if (job.file.state !== 'paused' && job.file.state !== 'error') throw new Error(`a ${job.file.state} export cannot continue`)
      job.file.state = 'queued'
      delete job.file.error
      delete job.file.finishedAt
      job.retries = 0
      saveJob(job)
      changed()
    },

    next() {
      const run = nextChain.then(findNext)
      nextChain = run.catch(() => {})
      return run
    },

    async segmentStart(jobId, k, input) {
      const job = workerJob(jobId)
      const { request } = job.file
      if (job.phase === 'finishing' || job.assembling) throw new Error('all segments are done')
      if (!(Number.isInteger(k) && (k as number) >= 0 && (k as number) < segmentCount(job))) throw new Error(`invalid segment: ${String(k)}`)
      const index = k as number
      if (job.file.segments.includes(index)) throw new Error(`segment ${index} is done already`)
      const kind = validateInput(input)
      if (job.file.input && job.file.input !== kind) throw new Error(`the segments of this export use '${job.file.input}' input`)
      const raw = kind === 'yuv' || kind === 'rgba'
      if (!raw && kind !== request.codec) throw new Error(`this export is ${request.codec}, the segment is ${kind}`)
      if (kind === 'yuv' && (request.width % 2 || request.height % 2)) throw new Error('yuv input needs an even width and height')
      if (job.segment) {
        const old = job.segment
        job.segment = null
        await old.abort()
      }
      const encoder = raw ? (job.file.encoder ?? pickEncoder(request.codec, request.hardware, await encoders())) : 'webcodecs'
      const qsvLookAhead = encoder.endsWith('_qsv') ? (await encoders()).qsvLookAhead : undefined
      // the job may have been cancelled or paused meanwhile
      if (job.file.state !== 'running' || !job.attached) throw new Error(stopped ?? 'export job stopped')
      if (job.segment) throw new Error('another segment was started meanwhile')
      const tmp = `${segmentPath(job, index)}.tmp`
      await rm(tmp, { force: true })
      const common = { k: index, expected: segmentLength(job, index), tmp, final: segmentPath(job, index) }
      job.segment = raw
        ? openRawSegment(ff, { ...common, input: kind, width: request.width, height: request.height, fps: request.fps, codec: request.codec, quality: request.quality, encoder, qsvLookAhead })
        : openChunkSegment({ ...common, codec: request.codec })
      job.phase = 'video'
      job.prepareAbort = null
      stopped = null
      touch(job)
      changed()
    },

    async segmentFinish(jobId, k) {
      const job = workerJob(jobId)
      const segment = job.segment
      if (!segment || segment.k !== k) throw new Error(`segment ${String(k)} is not active`)
      try {
        await segment.finish()
      } finally {
        if (job.segment === segment) job.segment = null
        changed()
      }
      if (job.file.state !== 'running') {
        // cancelled or paused while it finished
        await rm(segmentPath(job, segment.k), { force: true })
        throw new Error(stopped ?? `export job ${job.file.state}`)
      }
      job.file.segments = [...new Set([...job.file.segments, segment.k])].sort((a, b) => a - b)
      job.file.input ??= segment.input
      job.file.encoder ??= segment.encoder
      // progress again: a later crash gets its own retry
      job.retries = 0
      saveJob(job)
      touch(job)
      changed()
      if (!remaining(job).length) void startAssembly(job)
    },

    async fail(jobId, message) {
      const job = jobs.get(validateId(jobId))
      if (!job || job.file.state !== 'running' || !job.attached) return
      const text = typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : 'unknown error'
      await failJob(job, text)
    },

    async writeFrame(data) {
      const job = activeJob()
      const segment = job?.segment
      if (!job || !segment) throw new Error(stopped ?? 'no export segment is active')
      if (!(data instanceof Uint8Array)) throw new Error('frame must be a Uint8Array')
      if (segment.input !== 'yuv' && segment.input !== 'rgba') throw new Error(`this segment expects encoded ${segment.input} data (exportChunk)`)
      const written = segment.write(data)
      touch(job)
      changed()
      await written
    },

    async writeChunk(data) {
      const job = activeJob()
      const segment = job?.segment
      if (!job || !segment) throw new Error(stopped ?? 'no export segment is active')
      if (!(data instanceof Uint8Array)) throw new Error('chunk must be a Uint8Array')
      if (segment.input === 'yuv' || segment.input === 'rgba') throw new Error('this segment expects raw frames (exportFrame)')
      const written = segment.write(data)
      touch(job)
      changed()
      await written
    },

    async discardSegment() {
      const job = activeJob()
      const segment = job?.segment
      if (!job || !segment) return
      job.segment = null
      await segment.abort()
      changed()
    },

    get segmentActive() {
      return !!activeJob()
    },

    prepareSignal() {
      const job = runningJob()
      return job?.attached ? job.prepareAbort?.signal : undefined
    },

    touch() {
      const job = runningJob()
      if (job?.attached) touch(job)
    },

    get busy() {
      return !!runningJob()
    },

    hasWork() {
      if (closed) return false
      const running = runningJob()
      if (running && !running.attached && !running.assembling) return true
      return [...jobs.values()].some((j) => j.file.state === 'queued')
    },

    workerActivity() {
      const job = runningJob()
      if (!job || !job.attached || !job.phase) return null
      return { jobId: job.file.id, phase: job.phase, idleMs: Date.now() - job.lastActivity }
    },

    async workerLost(reason) {
      const job = runningJob()
      if (!job || !job.attached) return
      job.attached = false
      job.prepareAbort?.abort()
      job.prepareAbort = null
      const segment = job.segment
      job.segment = null
      await segment?.abort()
      if (job.file.state !== 'running') return
      if (job.retries < 1) {
        job.retries++
        job.phase = 'prepare'
        changed()
        return
      }
      await failJob(job, `The export window stopped twice (${reason}).`)
    },

    async pause() {
      const job = runningJob()
      if (!job) return
      job.file.state = 'paused'
      job.phase = undefined
      stopped = 'export job paused'
      saveJob(job)
      changed()
      await stopWork(job)
      // keep the parts, drop temp files and a partial output
      await deleteWorkFiles(job, true)
      changed()
    },

    async close() {
      const paused = queue.pause()
      closed = true
      await paused
      await Promise.allSettled([...jobs.values()].map((j) => stopWork(j)))
    }
  }
  return queue
}
