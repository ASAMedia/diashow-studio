// Export queue: jobs are kept by the main process and rendered by a hidden worker window in
// segments, so exports run in the background one after another and resume after a crash or a
// restart from the last finished segment.
import type { AudioPlan, ExportQuality, Project, VideoCodec } from './types'
import type { Chapter } from './chapters'

export interface ExportJobRequest {
  outPath: string
  width: number
  height: number
  fps: number
  codec: VideoCodec
  quality: ExportQuality
  /** Use NVENC / QSV / AMF when available. */
  hardware: boolean
  /** Locale for generated texts (day titles), e.g. 'de-DE'. */
  locale: string
  /** Prepare full-resolution video sources first (4K exports). */
  hires?: boolean
}

export interface NewExportJob {
  /** Shown in the queue, e.g. "Skicamp 2026 · YouTube 1080p". */
  name: string
  /** Snapshot of the project; later edits don't change the job. */
  project: Project
  request: ExportJobRequest
  /** Built by the renderer from the snapshot (buildAudioPlan). */
  audio: AudioPlan
  /** Chapter marks written into the MP4 (buildChapters), ascending; none when left out. */
  chapters?: Chapter[]
}

export type ExportJobState = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'

export interface ExportJobInfo {
  id: string
  name: string
  outPath: string
  state: ExportJobState
  /** While running: preparing sources, mixing audio / rendering, or joining the parts. */
  phase?: 'prepare' | 'video' | 'finishing'
  /** Frames done (finished segments + the current one) and in total. */
  frame: number
  totalFrames: number
  /** Rendered frames per second, recent average. */
  fps?: number
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  width: number
  height: number
  codec: VideoCodec
  /** Chapter marks of the export, when it has them. */
  chapters?: Chapter[]
}

/** Work handed to the worker window. */
export interface ExportTask {
  jobId: string
  project: Project
  request: ExportJobRequest
  totalFrames: number
  /** Segment k covers frames [k * segmentFrames, min(totalFrames, (k + 1) * segmentFrames)). */
  segmentFrames: number
  /** Segments still to render, ascending. */
  segments: number[]
  /** Frame input of the segments already done, so resumed segments match them. */
  input?: SegmentInput
}

/** How the worker delivers a segment: raw frames through exportFrame, or its own encoded stream through exportChunk. */
export type SegmentInput = 'yuv' | 'rgba' | 'h264' | 'hevc'
