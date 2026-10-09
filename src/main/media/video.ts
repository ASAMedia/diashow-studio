// Video pipeline: thumbnail, extracted audio, and H.264 proxies Chromium can always play.
import { rename, rm } from 'node:fs/promises'
import sharp from 'sharp'
import type { EncoderInfo } from '@shared/types'
import { FfmpegError, type Ffmpeg } from '../ffmpeg'
import { THUMB_MAX } from './photo'
import type { VideoInfo } from './videoInfo'

export const PROXY_MAX = 1920

/** HDR (PQ/HLG) → SDR BT.709, limited range 8-bit 4:2:0. */
export const TONEMAP_CHAIN =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'

/** Scales (w, h) so the long edge is <= max (never upscales) with even dimensions. */
export function fitEven(w: number, h: number, max: number): [number, number] {
  const s = Math.min(1, max / Math.max(w, h, 1))
  const even = (v: number): number => Math.max(2, Math.round((v * s) / 2) * 2)
  return [even(w), even(h)]
}

/** 29.97 → "30000/1001" so NTSC rates stay exact; integers and others stay as they are. */
export function fpsRational(fps: number): string {
  const ntsc = Math.round(fps * 1.001)
  if (!Number.isInteger(fps) && Math.abs(fps * 1.001 - ntsc) < 0.01) return `${ntsc * 1000}/1001`
  return String(fps)
}

/**
 * Filter chain for proxies and thumbnails. FFmpeg's autorotate runs before the graph, so the
 * graph already sees the display orientation; explicit output dimensions + setsar=1 also bake
 * in non-square pixels (AVCHD 1440x1080).
 */
export function videoFilter(info: VideoInfo, maxEdge: number, opts: { fps?: number } = {}): string {
  const [w, h] = fitEven(info.width, info.height, maxEdge)
  const parts: string[] = []
  if (info.interlaced) parts.push('bwdif=mode=send_frame')
  if (opts.fps) parts.push(`fps=${fpsRational(opts.fps)}`)
  if (info.hdr) {
    parts.push(`scale=${w}:${h}:flags=bicubic`, TONEMAP_CHAIN)
  } else {
    parts.push(`scale=${w}:${h}:flags=bicubic:out_range=tv`, 'format=yuv420p')
  }
  parts.push('setsar=1')
  return parts.join(',')
}

export function proxyEncoderArgs(encoder: string, fps: number): string[] {
  const gop = String(Math.max(1, Math.round(fps)))
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-profile:v', 'high', '-g', gop]
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '21', '-profile:v', 'high', '-g', gop]
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22', '-qp_b', '24', '-profile:v', 'high', '-g', gop]
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-g', gop]
  }
}

export interface ProxyOptions {
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
  encoders?: EncoderInfo
  /** Long edge limit, default PROXY_MAX (export uses up to 3840). */
  maxEdge?: number
}

/**
 * Transcodes to an H.264 High 8-bit yuv420p MP4 (long edge <= maxEdge (1920), CFR <= 60 fps, ~1 s GOP,
 * rotation baked in, HDR tone-mapped, no audio). A failing hardware encoder is retried with libx264.
 */
export async function transcodeProxy(ff: Ffmpeg, src: string, info: VideoInfo, out: string, opts: ProxyOptions = {}): Promise<string> {
  const fps = info.proxyFps
  const vf = videoFilter(info, opts.maxEdge ?? PROXY_MAX, { fps })
  const colorTags = info.hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'] : []
  const tmp = `${out}.part.mp4`
  const hw = opts.encoders?.hardware.h264
  const order = hw ? [hw, 'libx264'] : ['libx264']
  let lastErr: unknown
  for (const encoder of order) {
    const args = [
      '-i', src,
      '-map', `0:${info.stream.index}`,
      '-vf', vf,
      '-fps_mode', 'cfr',
      '-pix_fmt', 'yuv420p',
      ...proxyEncoderArgs(encoder, fps),
      ...colorTags,
      '-an', '-sn', '-dn',
      '-map_metadata', '-1',
      '-map_chapters', '-1',
      '-movflags', '+faststart',
      '-f', 'mp4',
      tmp
    ]
    try {
      await ff.run(args, {
        signal: opts.signal,
        onProgress: (s) => opts.onProgress?.(info.duration > 0 ? Math.min(1, Math.max(0, s / info.duration)) : 0)
      })
      await rename(tmp, out)
      return encoder
    } catch (err) {
      lastErr = err
      await rm(tmp, { force: true })
      if (opts.signal?.aborted || !(err instanceof FfmpegError)) throw err
    }
  }
  throw lastErr
}

/** Frame at ~10 % of the duration → JPEG, long edge 360. */
export async function videoThumb(ff: Ffmpeg, src: string, info: VideoInfo, out: string, signal?: AbortSignal): Promise<void> {
  const vf = videoFilter(info, THUMB_MAX)
  // Two decoder threads: thumbnails run many at a time, where frame threading only adds overhead
  const grab = (at: number): Promise<Buffer> =>
    ff.capture(
      ['-threads', '2', '-ss', at.toFixed(3), '-i', src, '-map', `0:${info.stream.index}`, '-frames:v', '1', '-vf', vf, '-c:v', 'png', '-f', 'image2pipe', '-'],
      { signal }
    )
  let png = await grab(info.duration > 1 ? info.duration * 0.1 : 0)
  if (!png.length) png = await grab(0)
  if (!png.length) throw new Error('no video frame')
  const tmp = `${out}.part`
  await sharp(png).jpeg({ quality: 80 }).toFile(tmp)
  await rename(tmp, out)
}

/** First decodable audio stream → AAC 192k, 48 kHz stereo (multichannel downmixed). */
export async function extractAudio(ff: Ffmpeg, src: string, info: VideoInfo, out: string, signal?: AbortSignal): Promise<void> {
  if (info.audioIndex === null) throw new Error('no audio')
  const tmp = `${out}.part.m4a`
  try {
    await ff.run(
      ['-i', src, '-map', `0:a:${info.audioIndex}`, '-vn', '-sn', '-dn', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-map_metadata', '-1', '-movflags', '+faststart', '-f', 'mp4', tmp],
      { signal }
    )
    await rename(tmp, out)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
