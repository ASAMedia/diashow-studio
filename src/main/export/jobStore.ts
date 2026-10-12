// Export jobs on disk, one folder per job (<dir>/<jobId>/): job.json (the NewExportJob snapshot +
// state), mix.wav (the audio plan, mixed once at the first start while the worker renders) and
// seg-NNNNN.h264 / .hevc, one elementary stream per finished segment (segments.ts).
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { ExportJobInfo, ExportJobRequest, ExportJobState, SegmentInput } from '@shared/exportQueue'
import type { AudioPlan, Project, VideoCodec } from '@shared/types'
import type { Chapter } from '@shared/chapters'
import type { ThemeTrack } from '@shared/themeMusic'
import type { Segment } from './segments'
import { finite, ID_RE, isObject } from './validate'

const JOB_FILE = 'job.json'
const MIX_FILE = 'mix.wav'
/** The chapter marks as an FFmpeg ffmetadata file, written for the joining. */
const CHAPTERS_FILE = 'chapters.txt'
/** Decoded audio clips while the mix is made. */
export const CLIPS_DIR = 'clips'

export interface JobFile {
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
  /** Chapter marks for the MP4 (NewExportJob.chapters). */
  chapters?: Chapter[]
  /** NewExportJob.themeSong. */
  themeSong?: ThemeTrack
}

export type Phase = NonNullable<ExportJobInfo['phase']>

export interface Job {
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

export const segmentCount = (job: Job): number => Math.ceil(job.file.totalFrames / job.file.segmentFrames)
export const segmentLength = (job: Job, k: number): number =>
  Math.min(job.file.totalFrames, (k + 1) * job.file.segmentFrames) - k * job.file.segmentFrames
export const segmentPath = (job: Job, k: number): string => join(job.dir, segmentName(k, job.file.request.codec))
export const mixPath = (job: Job): string => join(job.dir, MIX_FILE)
export const chaptersPath = (job: Job): string => join(job.dir, CHAPTERS_FILE)

/** Segments still to render, ascending. */
export const remaining = (job: Job): number[] => {
  const done = new Set(job.file.segments)
  const out: number[] = []
  for (let k = 0; k < segmentCount(job); k++) if (!done.has(k)) out.push(k)
  return out
}

const doneFrames = (job: Job): number => job.file.segments.reduce((n, k) => n + segmentLength(job, k), 0)
export const currentFrame = (job: Job): number => (job.file.state === 'done' ? job.file.totalFrames : doneFrames(job) + (job.segment?.frames ?? 0))

/** Writes job.json atomically (synchronously, so it also holds when the app quits right after). */
export function saveJob(job: Job): void {
  const { project: _p, audio: _a, ...state } = job.file
  const json = JSON.stringify(state)
  const tmp = join(job.dir, `${JOB_FILE}.tmp`)
  writeFileSync(tmp, `${json.slice(0, -1)},${job.snapshotJson}}`)
  renameSync(tmp, join(job.dir, JOB_FILE))
}

export const makeJob = (file: JobFile, dir: string): Job => ({
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
export async function deleteWorkFiles(job: Job, keepParts: boolean): Promise<void> {
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

/** The jobs stored in `root` (which exists), as left by the last run. */
export async function loadJobs(root: string): Promise<Job[]> {
  const jobs: Job[] = []
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
    jobs.push(job)
    if (dirty) saveJob(job)
    // temp files, unlisted segments, a partial output and the decoded audio clips of an interrupted run
    await deleteWorkFiles(job, file.state !== 'cancelled' && file.state !== 'done')
  }
  return jobs
}
