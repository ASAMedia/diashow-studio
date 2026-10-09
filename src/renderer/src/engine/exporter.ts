// Offline export: renders every frame with the same engine as the preview. Usually the GPU packs
// each finished frame as I420 and FFmpeg encodes it (NVENC/QSV/AMF or x264) together with the
// audio mixed from the same plan. Where WebCodecs offers a hardware encoder, frames are encoded
// right here and FFmpeg only muxes the stream. Odd sizes fall back to RGBA frames.
import type { ExportQuality, Project, VideoCodec } from '@shared/types'
import { buildTimeline } from '@shared/timeline'
import { buildAudioPlan } from '@shared/audioPlan'
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

export async function exportShow(
  project: Project,
  req: ExportRequest,
  locale: string,
  onTick: (p: ExportTick) => void,
  signal: AbortSignal
): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = req.width
  canvas.height = req.height
  const engine = new Engine(canvas, 'export')
  let encoder: VideoEncoder | null = null
  try {
    await loadFonts()
    const tl = buildTimeline(project, locale)
    engine.setProject(project, tl)
    engine.resize(req.width, req.height)
    const audio = buildAudioPlan(project, tl)
    const total = Math.max(1, Math.ceil(tl.duration * req.fps))
    const t0 = performance.now()
    const config = await webCodecsConfig(req)
    const sum = { prepare: 0, render: 0, encode: 0, send: 0 }
    let mark = 0
    const lap = (key: keyof typeof sum): void => {
      const now = performance.now()
      sum[key] += now - mark
      mark = now
    }
    const tick = (i: number): void => {
      if (i % 5 && i !== total - 1) return
      const n = i + 1
      const phases = { prepare: sum.prepare / n, render: sum.render / n, encode: sum.encode / n, send: sum.send / n }
      onTick({ frame: n, total, speed: (performance.now() - t0) / 1000 / n, path, phases })
    }
    const yuv = req.path !== 'rgba' && Compositor.yuvSupported(req.width, req.height)
    const path: ExportPath = config ? 'webcodecs' : yuv ? 'yuv' : 'rgba'
    const { path: _path, encoder: _encoder, ...options } = req

    if (config) {
      await window.api.exportStart({ ...options, audio, input: req.codec === 'hevc' ? 'hevc' : 'h264' })
      let failure: unknown = null
      // chunks must reach FFmpeg in order: one promise chain
      let sending: Promise<void> = Promise.resolve()
      let pending = 0
      encoder = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength)
          chunk.copyTo(data)
          pending++
          sending = sending.then(() => window.api.exportChunk(data)).then(() => void pending--)
          sending.catch((e) => (failure ??= e))
        },
        error: (e) => (failure ??= e)
      })
      encoder.configure(config)
      const usPerFrame = 1e6 / req.fps
      for (let i = 0; i < total; i++) {
        if (signal.aborted) throw new DOMException('cancelled', 'AbortError')
        if (failure) throw failure
        const t = i / req.fps
        mark = performance.now()
        await engine.prepare(t)
        lap('prepare')
        engine.render(t)
        lap('render')
        const frame = new VideoFrame(canvas, { timestamp: Math.round(i * usPerFrame), duration: Math.round(usPerFrame) })
        encoder.encode(frame, { keyFrame: i % (req.fps * 2) === 0 })
        frame.close()
        // keep the encoder and the pipe to FFmpeg from running far ahead of each other
        while (encoder.encodeQueueSize > 4) await new Promise((r) => encoder!.addEventListener('dequeue', r, { once: true }))
        lap('encode')
        if (pending > 30) await sending
        lap('send')
        tick(i)
      }
      await encoder.flush()
      await sending
      if (failure) throw failure
      encoder.close()
      encoder = null
      return await window.api.exportFinish()
    }

    engine.yuvOutput = yuv
    await window.api.exportStart({ ...options, audio, input: yuv ? 'yuv' : 'rgba' })
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
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError')
      const t = i / req.fps
      mark = performance.now()
      await engine.prepare(t)
      lap('prepare')
      engine.render(t)
      lap('render')
      if (yuv) {
        // frame i is read back while frame i+1 renders; frame i-1 is ready by now
        engine.startYuv()
        if (i > 0) await engine.collectYuv(buf)
      } else engine.readPixels(buf)
      lap('encode')
      if (!yuv || i > 0) await send()
      lap('send')
      tick(i)
    }
    if (yuv) {
      await engine.collectYuv(buf)
      await send()
    }
    await Promise.all(inflight)
    return await window.api.exportFinish()
  } catch (e) {
    await window.api.exportCancel().catch(() => {})
    throw e
  } finally {
    if (encoder && encoder.state !== 'closed') encoder.close()
    engine.dispose()
  }
}
