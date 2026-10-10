// Offline export: renders every frame with the same engine as the preview. Usually the GPU packs
// each finished frame as I420 and FFmpeg encodes it (NVENC/QSV/AMF or x264) together with the
// audio mixed from the same plan. Where WebCodecs offers a hardware encoder, frames are encoded
// right here and FFmpeg only muxes the stream. Odd sizes fall back to RGBA frames.
//
// Exports from the editor go through the queue: a hidden worker window (runExportWorker) renders
// them in segments, so they run in the background and continue after a crash.
import type { ExportQuality, Project, VideoCodec } from '@shared/types'
import type { ExportJobInfo, ExportJobRequest, ExportTask, SegmentInput } from '@shared/exportQueue'
import { buildTimeline, type Timeline } from '@shared/timeline'
import { buildAudioPlan } from '@shared/audioPlan'
import { buildChapters } from '@shared/chapters'
import { Engine, loadFonts } from './engine'
import { Compositor } from './gl'

type ExportPath = 'webcodecs' | 'yuv' | 'rgba'

export interface ExportRequest {
  outPath: string
  width: number
  height: number
  fps: number
  codec: VideoCodec
  quality: ExportQuality
  hardware: boolean
  /** Force a path (tests, troubleshooting); 'webcodecs' then also accepts a software encoder. */
  path?: ExportPath
  /** Override parts of the WebCodecs configuration (tests, troubleshooting). */
  encoder?: Partial<VideoEncoderConfig>
}

export interface ExportTick {
  frame: number
  total: number
  /** Seconds per rendered frame, averaged. */
  speed: number
  /** 'webcodecs': encoded here; 'yuv' / 'rgba': frames go to FFmpeg. */
  path: ExportPath
  /** Average milliseconds per frame spent preparing media, drawing, reading back/encoding and sending. */
  phases: { prepare: number; render: number; encode: number; send: number }
}

/** Bits per second for 1080p30; scaled by pixels and frame rate. */
const BITRATE: Record<ExportQuality, number> = { standard: 10e6, high: 18e6, max: 30e6 }

/** The best WebCodecs encoder configuration for the request, or null. */
export async function webCodecsConfig(req: ExportRequest): Promise<VideoEncoderConfig | null> {
  if ((req.path && req.path !== 'webcodecs') || typeof VideoEncoder === 'undefined') return null
  const hevc = req.codec === 'hevc'
  const bitrate = Math.round(BITRATE[req.quality] * ((req.width * req.height) / (1920 * 1080)) * (req.fps / 30))
  const base = {
    width: req.width,
    height: req.height,
    bitrate,
    framerate: req.fps,
    bitrateMode: 'variable',
    latencyMode: 'quality'
  } as const
  // highest profile/level first; level 5.2 covers 4K60
  const codecs = hevc ? ['hvc1.1.6.L156.B0', 'hvc1.1.6.L153.B0', 'hev1.1.6.L153.B0'] : ['avc1.640034', 'avc1.640033', 'avc1.64002A']
  // Only a hardware encoder is worth it: Electron's software H.264 encoder was about 5x faster than
  // the frame path but stayed well below its quality (SSIM 0.984 vs 0.996 at any bitrate). Electron 44
  // offered no hardware encoder to WebCodecs on the test laptop (Intel + NVIDIA).
  const accel: HardwareAcceleration[] = req.path === 'webcodecs' ? ['prefer-hardware', 'no-preference'] : req.hardware ? ['prefer-hardware'] : []
  for (const hardwareAcceleration of accel) {
    for (const codec of codecs) {
      const config = { ...base, hardwareAcceleration, codec, ...(hevc ? { hevc: { format: 'annexb' } } : { avc: { format: 'annexb' } }), ...req.encoder } as VideoEncoderConfig
      try {
        const r = await VideoEncoder.isConfigSupported(config)
        if (r.supported) return config
      } catch {
        // unknown codec string in this build
      }
    }
  }
  return null
}

/** How frames leave the renderer: an encoded stream if WebCodecs can, else I420 or RGBA frames. */
function chooseInput(req: ExportRequest, config: VideoEncoderConfig | null): SegmentInput {
  if (config) return req.codec === 'hevc' ? 'hevc' : 'h264'
  return req.path !== 'rgba' && Compositor.yuvSupported(req.width, req.height) ? 'yuv' : 'rgba'
}

/** Frames of a show, counted like the main process does from the audio plan. */
export const frameCount = (duration: number, fps: number): number => Math.max(1, Math.ceil(duration * fps - 1e-6))

/** 4K: videos that only have a 1080p proxy get a full-resolution source first. */
export async function withHiresSources(project: Project, maxEdge: number): Promise<Project> {
  const used = new Set(project.entries.flatMap((e) => (e.type === 'text' || e.excluded ? [] : [e.mediaId])))
  const proxied = project.media.filter((m) => used.has(m.id) && m.kind === 'video' && m.proxied && Math.max(m.width, m.height) > 1920)
  if (maxEdge <= 1920 || !proxied.length) return project
  const paths = await window.api.prepareHires(proxied.map((m) => m.id), maxEdge)
  return { ...project, media: project.media.map((m) => (paths[m.id] ? { ...m, playback: paths[m.id] } : m)) }
}

/** One export's engine and canvas; renders any range of frames and keeps timing statistics. */
class FrameRenderer {
  readonly canvas = document.createElement('canvas')
  readonly engine: Engine
  readonly tl: Timeline
  readonly total: number
  private sum = { prepare: 0, render: 0, encode: 0, send: 0 }
  private mark = 0
  private frames = 0
  private t0 = performance.now()

  constructor(
    project: Project,
    private req: ExportRequest,
    locale: string
  ) {
    this.canvas.width = req.width
    this.canvas.height = req.height
    this.engine = new Engine(this.canvas, 'export')
    this.tl = buildTimeline(project, locale)
    this.engine.setProject(project, this.tl)
    this.engine.resize(req.width, req.height)
    this.total = frameCount(this.tl.duration, req.fps)
  }

  private lap(key: keyof FrameRenderer['sum']): void {
    const now = performance.now()
    this.sum[key] += now - this.mark
    this.mark = now
  }

  tick(input: SegmentInput, frame: number): ExportTick {
    const n = Math.max(1, this.frames)
    const s = this.sum
    return {
      frame,
      total: this.total,
      speed: (performance.now() - this.t0) / 1000 / n,
      path: input === 'yuv' || input === 'rgba' ? input : 'webcodecs',
      phases: { prepare: s.prepare / n, render: s.render / n, encode: s.encode / n, send: s.send / n }
    }
  }

  /**
   * Renders frames [from, to). Raw frames go through exportFrame with a few in flight; encoded
   * input uses a fresh encoder starting with a key frame, its stream goes through exportChunk.
   */
  async render(from: number, to: number, input: SegmentInput, config: VideoEncoderConfig | null, signal: AbortSignal | null, onFrame: (i: number) => void): Promise<void> {
    const { req, engine, canvas } = this
    const step = async (i: number): Promise<void> => {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
      const t = i / req.fps
      this.mark = performance.now()
      await engine.prepare(t)
      this.lap('prepare')
      engine.render(t)
      this.lap('render')
    }

    if (input === 'h264' || input === 'hevc') {
      if (!config) throw new Error('no WebCodecs encoder for this export')
      let failure: unknown = null
      // chunks must reach FFmpeg in order: one promise chain
      let sending: Promise<void> = Promise.resolve()
      let pending = 0
      const encoder = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength)
          chunk.copyTo(data)
          pending++
          sending = sending.then(() => window.api.exportChunk(data)).then(() => void pending--)
          sending.catch((e) => (failure ??= e))
        },
        error: (e) => (failure ??= e)
      })
      try {
        encoder.configure(config)
        const usPerFrame = 1e6 / req.fps
        for (let i = from; i < to; i++) {
          if (failure) throw failure
          await step(i)
          const frame = new VideoFrame(canvas, { timestamp: Math.round(i * usPerFrame), duration: Math.round(usPerFrame) })
          encoder.encode(frame, { keyFrame: (i - from) % (req.fps * 2) === 0 })
          frame.close()
          // keep the encoder and the pipe to FFmpeg from running far ahead of each other
          while (encoder.encodeQueueSize > 4) await new Promise((r) => encoder.addEventListener('dequeue', r, { once: true }))
          this.lap('encode')
          if (pending > 30) await sending
          this.lap('send')
          this.frames++
          onFrame(i)
        }
        await encoder.flush()
        await sending
        if (failure) throw failure
      } finally {
        if (encoder.state !== 'closed') encoder.close()
      }
      return
    }

    const yuv = input === 'yuv'
    engine.yuvOutput = yuv
    const buf = new Uint8Array(yuv ? (req.width * req.height * 3) / 2 : req.width * req.height * 4)
    // a few frames in flight, so rendering the next frame overlaps with FFmpeg taking the last ones
    const inflight: Promise<void>[] = []
    const send = async (): Promise<void> => {
      // the frame is copied when it is handed over, so the buffer can be refilled right away
      const sent = window.api.exportFrame(buf)
      sent.catch(() => {})
      inflight.push(sent)
      if (inflight.length > 3) await inflight.shift()
    }
    for (let i = from; i < to; i++) {
      await step(i)
      if (yuv) {
        // frame i is read back while frame i+1 renders; frame i-1 is ready by now
        engine.startYuv()
        if (i > from) await engine.collectYuv(buf)
      } else engine.readPixels(buf)
      this.lap('encode')
      if (!yuv || i > from) await send()
      this.lap('send')
      this.frames++
      onFrame(i)
    }
    if (yuv) {
      await engine.collectYuv(buf)
      await send()
    }
    await Promise.all(inflight)
  }

  dispose(): void {
    this.engine.dispose()
  }
}

/** Exports in one go in this window (tests and troubleshooting; the editor uses the queue). */
export async function exportShow(
  project: Project,
  req: ExportRequest,
  locale: string,
  onTick: (p: ExportTick) => void,
  signal: AbortSignal
): Promise<string> {
  await loadFonts()
  const r = new FrameRenderer(project, req, locale)
  try {
    const audio = buildAudioPlan(project, r.tl)
    const config = await webCodecsConfig(req)
    const input = chooseInput(req, config)
    const { path: _path, encoder: _encoder, ...options } = req
    await window.api.exportStart({ ...options, audio, input })
    await r.render(0, r.total, input, config, signal, (i) => {
      if (i % 5 === 0 || i === r.total - 1) onTick(r.tick(input, i + 1))
    })
    return await window.api.exportFinish()
  } catch (e) {
    await window.api.exportCancel().catch(() => {})
    throw e
  } finally {
    r.dispose()
  }
}

/**
 * Queues an export of a snapshot of the project; the audio plan and the chapter marks are built here
 * like the timeline. Chapters go into the MP4 when `chapters` is on and the show has at least two.
 */
export function queueExport(project: Project, request: ExportJobRequest, name: string, chapters = true): Promise<ExportJobInfo> {
  const tl = buildTimeline(project, request.locale)
  const audio = buildAudioPlan(project, tl)
  const marks = chapters ? buildChapters(project, tl).filter((c) => c.start < audio.duration) : []
  return window.api.queueAdd({ name, project, request, audio, ...(marks.length >= 2 ? { chapters: marks } : {}) })
}

/** The hidden export window (#export-worker): takes jobs from the queue and renders their segments. */
export async function runExportWorker(): Promise<void> {
  await loadFonts()
  for (;;) {
    const task = await window.api.workerNext()
    if (!task) return
    try {
      await renderTask(task)
    } catch (e) {
      await window.api.workerFail(task.jobId, e instanceof Error ? e.message : String(e)).catch(() => {})
    }
  }
}

async function renderTask(task: ExportTask): Promise<void> {
  const { request: q } = task
  const project = q.hires ? await withHiresSources(task.project, Math.max(q.width, q.height)) : task.project
  const req: ExportRequest = { outPath: q.outPath, width: q.width, height: q.height, fps: q.fps, codec: q.codec, quality: q.quality, hardware: q.hardware }
  // a resumed job keeps the input of its finished segments
  const config = !task.input || task.input === q.codec ? await webCodecsConfig(req) : null
  const input = task.input ?? chooseInput(req, config)
  const r = new FrameRenderer(project, req, q.locale)
  try {
    if (r.total !== task.totalFrames) throw new Error(`the show has ${r.total} frames, the export expects ${task.totalFrames}`)
    for (const k of task.segments) {
      await window.api.segmentStart(task.jobId, k, input)
      await r.render(k * task.segmentFrames, Math.min(task.totalFrames, (k + 1) * task.segmentFrames), input, config, null, () => {})
      await window.api.segmentFinish(task.jobId, k)
    }
  } finally {
    r.dispose()
  }
}
