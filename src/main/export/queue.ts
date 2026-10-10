// Export queue (main process, Electron-free): jobs are stored in <dir>/<jobId>/ and rendered by a
// worker window in segments of 30 s, so they run one after another in the background and continue
// after a crash or a restart from the last finished segment.
//
// Per job folder: job.json (the NewExportJob snapshot + state), mix.wav (the audio plan, mixed once
// at the first start while the worker renders), and seg-NNNNN.h264 / .hevc, one elementary stream
// per finished segment, each starting with an IDR picture. Raw segments ('yuv' / 'rgba' frames) are
// encoded by FFmpeg with the same arguments as a regular export; encoded segments ('h264' / 'hevc'
// from WebCodecs) are stored as they come. After the last segment the streams are joined in order
// and muxed with mix.wav like a regular WebCodecs export (AnnexBToTs → FFmpeg stream copy → MP4).
//
// Window management and IPC live in queueMain.ts.
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import type { ExportJobInfo, ExportJobRequest, ExportJobState, ExportTask, NewExportJob, SegmentInput } from '@shared/exportQueue'
import type { AudioPlan, AudioPlanClip, EncoderInfo, ExportQuality, Project, VideoCodec } from '@shared/types'
import { Ffmpeg, summarizeStderr } from '../ffmpeg'
import { videoStream } from '../media/videoInfo'
import { AnnexBFrameCounter, AnnexBToTs } from './annexb'
import { mixAudioPlan } from './audioMix'
import { AUDIO_OUT_ARGS, copyVideoArgs, encoderArgs, pickEncoder, rawInputArgs, rawVideoFilter } from './encoder'

/** Seconds of video per segment: what a crash can cost at most. */
export const SEGMENT_SECONDS = 30
const JOB_FILE = 'job.json'
const MIX_FILE = 'mix.wav'
const CLIPS_DIR = 'clips'
const ID_RE = /^[0-9a-z]{6,12}-[0-9a-f]{8}$/
const OUT_EXT = /\.(mp4|m4v|mov)$/i
const QUALITIES: readonly ExportQuality[] = ['standard', 'high', 'max']
const INPUTS: readonly SegmentInput[] = ['yuv', 'rgba', 'h264', 'hevc']
/** States in which a job still holds (or will produce) work files. */
const OPEN_STATES: readonly ExportJobState[] = ['queued', 'running', 'paused', 'error']

// ------------------------------------------------------------------ stored jobs

interface JobFile {
  version: 1
  id: string
  name: string
  request: ExportJobRequest
  state: ExportJobState
  totalFrames: number
  segmentFrames: number
  /** Finished segments, ascending. */
  segments: number[]
  /** Fixed by the first finished segment: all segments of a job use the same input and encoder. */
  input?: SegmentInput
  /** FFmpeg encoder of raw segments, 'webcodecs' for encoded ones. */
  encoder?: string
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  project: Project
  audio: AudioPlan
}

type Phase = NonNullable<ExportJobInfo['phase']>

interface Job {
  file: JobFile
  dir: string
  /** "project" and "audio" of job.json, serialized once. */
  snapshotJson: string
  phase?: Phase
  /** The worker has this job's task. */
  attached: boolean
  /** Automatic retries after the worker window crashed or hung. */
  retries: number
  segment: Segment | null
  mixing: Promise<void> | null
  mixAbort: AbortController | null
  assembling: Promise<void> | null
  assemblyAbort: AbortController | null
  prepareAbort: AbortController | null
  /** (time, frame) samples of the last seconds for the fps average. */
  samples: Array<{ t: number; frame: number }>
  lastActivity: number
}

const segmentName = (k: number, codec: VideoCodec): string => `seg-${String(k).padStart(5, '0')}.${codec}`

/** Temp name of the MP4 next to the output, renamed over it once complete. */
export function partialOutputPath(outPath: string, jobId: string): string {
  const ext = extname(outPath)
  return join(dirname(outPath), `${basename(outPath, ext)}.part-${jobId}${ext}`)
}

function samePath(a: string, b: string): boolean {
  const x = resolve(a)
  const y = resolve(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ------------------------------------------------------------------ validation (data from the renderer)

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function validateRequest(raw: unknown): ExportJobRequest {
  if (!isObject(raw)) throw new Error('export request missing')
  const { outPath, width, height, fps, codec, quality, hardware, locale, hires } = raw
  if (typeof outPath !== 'string' || !outPath || outPath.length > 1000 || outPath.includes('\0') || !isAbsolute(outPath)) {
    throw new Error('the output must be an absolute file path')
  }
  if (!OUT_EXT.test(outPath)) throw new Error('the output must be an .mp4, .m4v or .mov file')
  const out = resolve(outPath)
  let folder = false
  try {
    folder = statSync(dirname(out)).isDirectory()
  } catch {
    // missing
  }
  if (!folder) throw new Error(`the folder ${dirname(out)} does not exist`)
  for (const [key, v] of [['width', width], ['height', height]] as const) {
    if (!(Number.isInteger(v) && (v as number) >= 16 && (v as number) <= 8192)) throw new Error(`invalid ${key}`)
  }
  if (!(finite(fps) && fps >= 1 && fps <= 240)) throw new Error('invalid frame rate')
  if (codec !== 'h264' && codec !== 'hevc') throw new Error('invalid codec')
  if (!QUALITIES.includes(quality as ExportQuality)) throw new Error('invalid quality')
  if (typeof locale !== 'string' || !/^[A-Za-z0-9-]{1,35}$/.test(locale)) throw new Error('invalid locale')
  if (hires !== undefined && typeof hires !== 'boolean') throw new Error('invalid hires flag')
  return {
    outPath: out,
    width: width as number,
    height: height as number,
    fps,
    codec,
    quality: quality as ExportQuality,
    hardware: hardware === true,
    locale,
    ...(hires !== undefined ? { hires } : {})
  }
}

function validateClip(raw: unknown, i: number): AudioPlanClip {
  if (!isObject(raw)) throw new Error(`audio clip ${i} invalid`)
  const { id, kind, src, start, offset, duration, gain } = raw
  const rate = (raw as { rate?: unknown }).rate
  if (typeof id !== 'string' || id.length > 200) throw new Error(`audio clip ${i}: invalid id`)
  if (kind !== 'music' && kind !== 'video') throw new Error(`audio clip ${i}: invalid kind`)
  // FFmpeg reads it: a local file only, never a URL or protocol
  if (typeof src !== 'string' || !src || src.length > 2000 || src.includes('\0') || !isAbsolute(src)) throw new Error(`audio clip ${i}: invalid source`)
  for (const [key, v] of [['start', start], ['offset', offset], ['duration', duration]] as const) {
    if (!(finite(v) && v >= 0)) throw new Error(`audio clip ${i}: invalid ${key}`)
  }
  if (!Array.isArray(gain) || gain.length > 100_000) throw new Error(`audio clip ${i}: invalid gain`)
  const points = gain.map((p) => {
    if (!isObject(p) || !finite(p.t) || !finite(p.g) || p.g < 0) throw new Error(`audio clip ${i}: invalid gain point`)
    return { t: p.t, g: p.g }
  })
  if (rate !== undefined && !(finite(rate) && rate > 0 && rate <= 100)) throw new Error(`audio clip ${i}: invalid rate`)
  const clip: AudioPlanClip = { id, kind, src, start: start as number, offset: offset as number, duration: duration as number, gain: points }
  if (rate !== undefined) (clip as AudioPlanClip & { rate?: number }).rate = rate
  return clip
}

function validateAudio(raw: unknown): AudioPlan {
  if (!isObject(raw)) throw new Error('audio plan missing')
  const { duration, clips } = raw
  if (!(finite(duration) && duration > 0 && duration <= 24 * 3600)) throw new Error('invalid show duration')
  if (!Array.isArray(clips) || clips.length > 10_000) throw new Error('invalid audio clips')
  return { duration, clips: clips.map(validateClip) }
}

/** Checks a job coming from the renderer; returns a clean copy. */
export function validateNewJob(raw: unknown): NewExportJob {
  if (!isObject(raw)) throw new Error('invalid export job')
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 200) : ''
  if (!name) throw new Error('the export job needs a name')
  const project = raw.project
  if (!isObject(project) || typeof project.id !== 'string' || !Array.isArray(project.media) || !Array.isArray(project.entries) || !isObject(project.settings)) {
    throw new Error('the export job needs a project')
  }
  return { name, project: project as unknown as Project, request: validateRequest(raw.request), audio: validateAudio(raw.audio) }
}

function validateId(id: unknown): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('invalid export job id')
  return id
}

function validateInput(input: unknown): SegmentInput {
  if (!INPUTS.includes(input as SegmentInput)) throw new Error(`unknown segment input: ${String(input)}`)
  return input as SegmentInput
}

// ------------------------------------------------------------------ segments

interface Segment {
  readonly k: number
  readonly input: SegmentInput
  readonly encoder: string
  readonly expected: number
  /** Frames taken (raw input) or counted in the stream (encoded input). */
  readonly frames: number
  /** One raw frame or the next bytes of the stream. The synchronous part queues the data in order. */
  write(data: Uint8Array): Promise<void>
  /** Validates the segment and renames it to its final name. Deletes the temp file on failure. */
  finish(): Promise<void>
  /** Stops it and deletes the temp file. */
  abort(): Promise<void>
}

/** Frame count and first picture type of an Annex B file. */
async function countFile(path: string, codec: VideoCodec): Promise<AnnexBFrameCounter> {
  const counter = new AnnexBFrameCounter(codec)
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) counter.push(chunk as Buffer)
  counter.end()
  return counter
}

function checkStream(counter: AnnexBFrameCounter, k: number, expected: number): void {
  if (counter.frames !== expected) throw new Error(`segment ${k} has ${counter.frames} frames, expected ${expected}`)
  if (!counter.startsWithIdr) throw new Error(`segment ${k} does not start with an IDR picture (start each segment with a new encoder)`)
}

interface RawSegmentOptions {
  k: number
  input: 'yuv' | 'rgba'
  width: number
  height: number
  fps: number
  codec: VideoCodec
  quality: ExportQuality
  encoder: string
  expected: number
  tmp: string
  final: string
}

/** FFmpeg encodes raw frames like a regular export, but video only, into an elementary stream. */
function openRawSegment(ff: Ffmpeg, o: RawSegmentOptions): Segment {
  const frameBytes = o.input === 'yuv' ? (o.width * o.height * 3) / 2 : o.width * o.height * 4
  const video = encoderArgs(o.encoder, o.codec, o.quality, o.fps)
  // the hvc1 tag belongs to the MP4 made at the end, not to the raw stream
  const tag = video.indexOf('-tag:v')
  if (tag >= 0) video.splice(tag, 2)
  const args = [
    '-loglevel', 'error', '-y',
    ...rawInputArgs(o.input, o.width, o.height, o.fps),
    '-map', '0:v:0',
    '-vf', rawVideoFilter(o.input, o.width, o.height),
    ...video,
    '-f', o.codec, o.tmp
  ]
  const proc = ff.spawn(args, 'pipe')
  let stderr = ''
  proc.stderr!.on('data', (c: Buffer) => {
    stderr += c.toString('utf8')
    if (stderr.length > 16_000) stderr = stderr.slice(-8_000)
  })
  proc.stdout!.resume()
  // EPIPE when FFmpeg dies mid-write is reported through the exit code instead
  proc.stdin!.on('error', () => {})
  const exited = new Promise<number | null>((done) => {
    proc.on('close', (code) => done(code))
    proc.on('error', () => done(-1))
  })
  let frames = 0
  let state: 'open' | 'finishing' | 'aborted' | 'done' = 'open'
  const failure = (): Error => new Error(summarizeStderr(stderr) || 'encoder stopped unexpectedly')
  // writers waiting for FFmpeg share one wait (the renderer keeps several frames in flight)
  let waiting: Promise<'drain' | 'gone'> | null = null
  const writable = (): Promise<'drain' | 'gone'> =>
    (waiting ??= Promise.race([
      once(proc.stdin!, 'drain').then(() => 'drain' as const, () => 'gone' as const),
      exited.then(() => 'gone' as const)
    ]).finally(() => {
      waiting = null
    }))
  const discard = async (): Promise<void> => {
    proc.kill('SIGKILL')
    await exited
    await rm(o.tmp, { force: true, maxRetries: 5, retryDelay: 100 })
  }

  return {
    k: o.k,
    input: o.input,
    encoder: o.encoder,
    expected: o.expected,
    get frames() {
      return frames
    },
    async write(data) {
      if (state !== 'open') throw new Error(state === 'aborted' ? 'segment discarded' : 'segment is closed')
      if (data.byteLength !== frameBytes) {
        throw new Error(`frame has ${data.byteLength} bytes, expected ${frameBytes} (${o.width}x${o.height} ${o.input === 'yuv' ? 'I420' : 'RGBA'})`)
      }
      if (frames >= o.expected) throw new Error(`segment ${o.k} already has its ${o.expected} frames`)
      if (proc.exitCode !== null) throw failure()
      frames++
      const stdin = proc.stdin!
      if (!stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))) {
        if ((await writable()) === 'gone') {
          // FFmpeg's own message is complete once it exited
          await exited
          if ((state as string) === 'aborted') throw new Error('segment discarded')
          if (state === 'open') throw failure()
        }
      }
    },
    async finish() {
      if (state !== 'open') throw new Error('segment is closed')
      state = 'finishing'
      try {
        if (frames !== o.expected) throw new Error(`segment ${o.k} got ${frames} frames, expected ${o.expected}`)
        proc.stdin!.end()
        const code = await exited
        if ((state as string) === 'aborted') throw new Error('segment discarded')
        if (code !== 0) throw failure()
        checkStream(await countFile(o.tmp, o.codec), o.k, o.expected)
        await rename(o.tmp, o.final)
        state = 'done'
      } catch (err) {
        if ((state as string) !== 'aborted') {
          state = 'aborted'
          await discard()
        }
        throw err
      }
    },
    async abort() {
      if (state === 'aborted' || state === 'done') return
      state = 'aborted'
      await discard()
    }
  }
}

/** Encoded input: the bytes are stored as they come; frames are counted from the stream. */
function openChunkSegment(o: { k: number; codec: VideoCodec; expected: number; tmp: string; final: string }): Segment {
  const out = createWriteStream(o.tmp)
  let failed: Error | null = null
  out.on('error', (e) => (failed ??= e))
  const counter = new AnnexBFrameCounter(o.codec)
  let state: 'open' | 'finishing' | 'aborted' | 'done' = 'open'
  let waiting: Promise<unknown> | null = null
  const writable = (): Promise<unknown> =>
    (waiting ??= Promise.race([once(out, 'drain'), once(out, 'close')]).finally(() => {
      waiting = null
    }))
  const discard = async (): Promise<void> => {
    out.destroy()
    await finished(out).catch(() => {})
    await rm(o.tmp, { force: true, maxRetries: 5, retryDelay: 100 })
  }

  return {
    k: o.k,
    input: o.codec,
    encoder: 'webcodecs',
    expected: o.expected,
    get frames() {
      return counter.frames
    },
    async write(data) {
      if (state !== 'open') throw new Error(state === 'aborted' ? 'segment discarded' : 'segment is closed')
      if (failed) throw failed
      if (!data.byteLength) return
      counter.push(data)
      if (counter.frames > o.expected) throw new Error(`segment ${o.k} got more than its ${o.expected} frames`)
      if (!out.write(data)) {
        await writable().catch(() => {})
        if (failed) throw failed
        if ((state as string) === 'aborted') throw new Error('segment discarded')
      }
    },
    async finish() {
      if (state !== 'open') throw new Error('segment is closed')
      state = 'finishing'
      try {
        counter.end()
        out.end()
        await finished(out)
        if (failed) throw failed
        if ((state as string) === 'aborted') throw new Error('segment discarded')
        checkStream(counter, o.k, o.expected)
        await rename(o.tmp, o.final)
        state = 'done'
      } catch (err) {
        if ((state as string) !== 'aborted') {
          state = 'aborted'
          await discard()
        }
        throw err
      }
    },
    async abort() {
      if (state === 'aborted' || state === 'done') return
      state = 'aborted'
      await discard()
    }
  }
}

// ------------------------------------------------------------------ helpers

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

function abortError(): Error {
  const e = new Error('cancelled')
  e.name = 'AbortError'
  return e
}

/** rename that retries a moment when the target is busy (Explorer preview, virus scanner). */
async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt < 10 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, 300))
        continue
      }
      throw new Error(`could not replace ${to} (${code ?? errorMessage(err)}); is it open in another program?`)
    }
  }
}

// ------------------------------------------------------------------ the queue

export interface ExportQueueOptions {
  /** Folder with one subfolder per job, e.g. <userData>/exports. */
  dir: string
  ffmpegDir: string
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

  // ---- job files

  const segmentCount = (job: Job): number => Math.ceil(job.file.totalFrames / job.file.segmentFrames)
  const segmentLength = (job: Job, k: number): number =>
    Math.min(job.file.totalFrames, (k + 1) * job.file.segmentFrames) - k * job.file.segmentFrames
  const segmentPath = (job: Job, k: number): string => join(job.dir, segmentName(k, job.file.request.codec))
  const remaining = (job: Job): number[] => {
    const done = new Set(job.file.segments)
    const out: number[] = []
    for (let k = 0; k < segmentCount(job); k++) if (!done.has(k)) out.push(k)
    return out
  }
  const doneFrames = (job: Job): number => job.file.segments.reduce((n, k) => n + segmentLength(job, k), 0)
  const currentFrame = (job: Job): number => (job.file.state === 'done' ? job.file.totalFrames : doneFrames(job) + (job.segment?.frames ?? 0))

  /** Writes job.json atomically (synchronously, so it also holds when the app quits right after). */
  const save = (job: Job): void => {
    const { project: _p, audio: _a, ...state } = job.file
    const json = JSON.stringify(state)
    const tmp = join(job.dir, `${JOB_FILE}.tmp`)
    writeFileSync(tmp, `${json.slice(0, -1)},${job.snapshotJson}}`)
    renameSync(tmp, join(job.dir, JOB_FILE))
  }

  const makeJob = (file: JobFile, dir: string): Job => ({
    file,
    dir,
    snapshotJson: `"project":${JSON.stringify(file.project)},"audio":${JSON.stringify(file.audio)}`,
    attached: false,
    retries: 0,
    segment: null,
    mixing: null,
    mixAbort: null,
    assembling: null,
    assemblyAbort: null,
    prepareAbort: null,
    samples: [],
    lastActivity: Date.now()
  })

  /** Deletes everything but job.json (and, unless `keepParts`, the finished segments and mix.wav). */
  const deleteWorkFiles = async (job: Job, keepParts: boolean): Promise<void> => {
    const keep = new Set([JOB_FILE])
    if (keepParts) {
      keep.add(MIX_FILE)
      for (const k of job.file.segments) keep.add(segmentName(k, job.file.request.codec))
    }
    let names: string[] = []
    try {
      names = await readdir(job.dir)
    } catch {
      return
    }
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => rm(join(job.dir, n), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
    await rm(partialOutputPath(job.file.request.outPath, job.file.id), { force: true, maxRetries: 5, retryDelay: 100 })
  }

  // ---- load what is on disk

  await mkdir(root, { recursive: true })
  for (const name of readdirSync(root)) {
    if (!ID_RE.test(name)) continue
    const dir = join(root, name)
    let file: JobFile
    try {
      file = JSON.parse(readFileSync(join(dir, JOB_FILE), 'utf8')) as JobFile
    } catch {
      continue
    }
    if (file.version !== 1 || file.id !== name || !isObject(file.request) || !(file.totalFrames > 0) || !(file.segmentFrames > 0) || !finite(file.createdAt)) continue
    const job = makeJob(file, dir)
    let dirty = false
    // only segments whose file is there count
    const listed = Array.isArray(file.segments) ? file.segments : []
    file.segments = [...new Set(listed)]
      .filter((k) => Number.isInteger(k) && k >= 0 && k < segmentCount(job) && existsSync(segmentPath(job, k)))
      .sort((a, b) => a - b)
    if (file.segments.length !== listed.length) dirty = true
    if (file.state === 'running') {
      // the app stopped while it ran (crash, power loss): it continues when the user says so
      file.state = 'paused'
      dirty = true
    }
    lastCreated = Math.max(lastCreated, file.createdAt)
    jobs.set(name, job)
    if (dirty) save(job)
    // temp files, unlisted segments, a partial output and the decoded audio clips of an interrupted run
    await deleteWorkFiles(job, file.state !== 'cancelled' && file.state !== 'done')
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
      codec: f.request.codec
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
    save(job)
    changed()
    await stopWork(job)
    changed()
  }

  // ---- audio

  const mixPath = (job: Job): string => join(job.dir, MIX_FILE)

  /** Mixes the audio plan once (reused on resume). Resolves when mix.wav is there. */
  const ensureMix = (job: Job): Promise<void> => {
    if (existsSync(mixPath(job))) return Promise.resolve()
    if (job.mixing) return job.mixing
    const ctrl = new AbortController()
    const tmp = join(job.dir, `${MIX_FILE}.tmp`)
    const clips = join(job.dir, CLIPS_DIR)
    let run: Promise<void> | undefined
    run = (async (): Promise<void> => {
      try {
        await mixAudioPlan(ff, job.file.audio, tmp, clips, { signal: ctrl.signal })
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
    const out = request.outPath
    const partial = partialOutputPath(out, job.file.id)
    let child: ChildProcess | null = null
    let exited: Promise<number | null> = Promise.resolve(null)
    const check = (): void => {
      if (ctrl.signal.aborted) throw abortError()
    }
    try {
      await ensureMix(job)
      check()
      for (let k = 0; k < segmentCount(job); k++) if (!existsSync(segmentPath(job, k))) throw new Error(`segment ${k} is missing`)
      if (!existsSync(dirname(out))) throw new Error(`the folder ${dirname(out)} does not exist`)
      const proc = ff.spawn(
        [
          '-loglevel', 'error', '-y',
          // MPEG-TS made by AnnexBToTs: the joined stream with pts/dts per frame
          '-f', 'mpegts', '-i', 'pipe:0',
          '-i', mixPath(job),
          '-map', '0:v:0', '-map', '1:a:0',
          ...copyVideoArgs(request.codec),
          ...AUDIO_OUT_ARGS,
          '-movflags', '+faststart',
          partial
        ],
        'pipe'
      )
      child = proc
      let stderr = ''
      proc.stderr!.on('data', (c: Buffer) => {
        stderr += c.toString('utf8')
        if (stderr.length > 16_000) stderr = stderr.slice(-8_000)
      })
      proc.stdout!.resume()
      proc.stdin!.on('error', () => {})
      exited = new Promise((done) => {
        proc.on('close', (code) => done(code))
        proc.on('error', () => done(-1))
      })
      const stop = (): void => {
        proc.kill('SIGKILL')
      }
      ctrl.signal.addEventListener('abort', stop, { once: true })
      const failure = (): Error => new Error(summarizeStderr(stderr) || 'FFmpeg stopped unexpectedly')
      const packets: Uint8Array[] = []
      const flush = async (): Promise<void> => {
        if (!packets.length) return
        if (proc.exitCode !== null) throw failure()
        if (!proc.stdin!.write(Buffer.concat(packets.splice(0)))) {
          const r = await Promise.race([once(proc.stdin!, 'drain').then(() => 'drain', () => 'gone'), exited.then(() => 'gone')])
          check()
          if (r === 'gone') {
            await exited
            throw failure()
          }
        }
      }
      const muxer = new AnnexBToTs(request.codec, request.fps, (p) => packets.push(p))
      for (let k = 0; k < segmentCount(job); k++) {
        for await (const chunk of createReadStream(segmentPath(job, k), { highWaterMark: 1 << 20 })) {
          check()
          muxer.push(chunk as Buffer)
          await flush()
        }
      }
      muxer.end()
      await flush()
      if (muxer.frames !== totalFrames) throw new Error(`the joined video has ${muxer.frames} frames, expected ${totalFrames}`)
      proc.stdin!.end()
      const code = await exited
      check()
      if (code !== 0) throw failure()
      const probe = await ff.probe(partial, ctrl.signal)
      const frames = Number(videoStream(probe)?.nb_frames)
      if (frames !== totalFrames) throw new Error(`the MP4 has ${frames} frames, expected ${totalFrames}`)
      if (!probe.streams.some((s) => s.codec_type === 'audio')) throw new Error('the MP4 has no sound')
      check()
      await replaceFile(partial, out)
      job.file.state = 'done'
      job.file.finishedAt = Date.now()
      delete job.file.error
      job.phase = undefined
      save(job)
      await deleteWorkFiles(job, false)
      changed()
    } catch (err) {
      child?.kill('SIGKILL')
      await exited
      await rm(partial, { force: true, maxRetries: 5, retryDelay: 100 })
      if (ctrl.signal.aborted || job.file.state !== 'running') return
      // the parts stay: "Continue" tries the joining again
      job.file.state = 'error'
      job.file.error = `Joining the parts failed: ${errorMessage(err)}`.slice(0, 1000)
      job.file.finishedAt = Date.now()
      job.phase = undefined
      save(job)
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
      ...(job.file.input ? { input: job.file.input } : {})
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
        save(job)
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
        audio: job.audio
      }
      const entry = makeJob(file, dir)
      save(entry)
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
      save(job)
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

    async resume(id) {
      const job = getJob(id)
      if (job.file.state === 'queued' || job.file.state === 'running') return
      if (job.file.state !== 'paused' && job.file.state !== 'error') throw new Error(`a ${job.file.state} export cannot continue`)
      job.file.state = 'queued'
      delete job.file.error
      delete job.file.finishedAt
      job.retries = 0
      save(job)
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
      // the job may have been cancelled or paused meanwhile
      if (job.file.state !== 'running' || !job.attached) throw new Error(stopped ?? 'export job stopped')
      if (job.segment) throw new Error('another segment was started meanwhile')
      const tmp = `${segmentPath(job, index)}.tmp`
      await rm(tmp, { force: true })
      const common = { k: index, expected: segmentLength(job, index), tmp, final: segmentPath(job, index) }
      job.segment = raw
        ? openRawSegment(ff, { ...common, input: kind, width: request.width, height: request.height, fps: request.fps, codec: request.codec, quality: request.quality, encoder })
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
      save(job)
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
      save(job)
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

