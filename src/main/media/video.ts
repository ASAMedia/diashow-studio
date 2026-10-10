// Video pipeline: thumbnail, extracted audio, and H.264 proxies Chromium can always play.
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { EncoderInfo } from '@shared/types'
import { FfmpegError, type Ffmpeg } from '../ffmpeg'
import type { GpuTonemap } from './hdr'
import { loudnessFromLog } from './loudness'
import { THUMB_MAX } from './photo'
import { createLimiter } from './queue'
import type { VideoInfo } from './videoInfo'

export const PROXY_MAX = 1920

/** HDR (PQ/HLG) → SDR BT.709, limited range 8-bit 4:2:0. */
export const TONEMAP_CHAIN =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'

/**
 * libplacebo settings that reproduce TONEMAP_CHAIN on the GPU. Tuned on grey ramps and real phone
 * clips: HLG within ~4/255 mean difference; for PQ, Reinhard follows the CPU curve up to ~600 nits
 * and then rolls highlights off where the CPU chain clips them. Dolby Vision RPUs are ignored like
 * on the CPU (iPhone profile 8.4 is HLG-compatible).
 */
const GPU_TONEMAP: Record<'hlg' | 'pq', string> = {
  hlg: 'tonemapping=hable:peak_detect=0:gamut_mode=clip:gamma=1.25:saturation=1.05',
  pq: 'tonemapping=reinhard:peak_detect=0:gamut_mode=clip'
}

/** Input options for the GPU path: Vulkan device (+ hardware decoding into it). */
export function gpuInputArgs(gpu: GpuTonemap): string[] {
  const args =
    gpu.decode === 'cuda'
      ? ['-init_hw_device', 'cuda=cu', '-init_hw_device', 'vulkan=vk@cu', '-filter_hw_device', 'vk', '-hwaccel', 'cuda', '-hwaccel_device', 'cu', '-hwaccel_output_format', 'cuda']
      : ['-init_hw_device', `vulkan=vk:${gpu.device}`, '-filter_hw_device', 'vk']
  if (gpu.decode === 'vulkan') args.push('-hwaccel', 'vulkan', '-hwaccel_device', 'vk', '-hwaccel_output_format', 'vulkan')
  // libplacebo rotates; the display matrix must neither trigger autorotation nor end up in the proxy
  args.push('-display_rotation', '0')
  return args
}

/**
 * GPU version of videoFilter: scaling, rotation and (HDR) tone mapping in one libplacebo pass, 8-bit
 * 4:2:0 limited range out (HDR: BT.709; SDR keeps its colour space, like the CPU chain). Frames the
 * decoder could not keep on the GPU (unsupported profile) arrive in system memory and are uploaded
 * by libplacebo itself.
 */
export function gpuVideoFilter(info: VideoInfo, maxEdge: number, gpu: GpuTonemap, opts: { fps?: number; shaderCache?: boolean } = {}): string {
  const [w, h] = fitEven(info.width, info.height, maxEdge)
  const parts: string[] = []
  if (opts.fps) parts.push(`fps=${fpsRational(opts.fps)}`)
  if (gpu.decode === 'cuda') parts.push('hwupload')
  const tone = info.hdr ? `${GPU_TONEMAP[info.hdr]}:apply_dolbyvision=0:colorspace=bt709:color_primaries=bt709:color_trc=bt709:` : ''
  // shader_cache is a file name prefix relative to FFmpeg's working directory (no path escaping needed)
  parts.push(`libplacebo=w=${w}:h=${h}:rotate=${info.rotation}:${tone}range=tv:format=yuv420p` + (opts.shaderCache ? ':shader_cache=pl' : ''))
  parts.push('setsar=1')
  return parts.join(',')
}

/** Streams the GPU video decoders (Vulkan video, NVDEC) take: 4:2:0, H.264 8-bit, HEVC / AV1 / VP9 up to 10-bit. */
function gpuDecodable(info: VideoInfo): boolean {
  const codec = info.stream.codec_name ?? ''
  if (info.chroma !== '4:2:0') return false
  if (codec === 'h264') return info.bitDepth === 8
  return ['hevc', 'av1', 'vp9'].includes(codec) && info.bitDepth <= 10
}

/**
 * Sources the GPU path handles: every HDR source (tone mapping), and SDR sources the GPU also decodes
 * (`gpu` given, decode not 'upload'), so their proxy (scaling, rotation) leaves the CPU free for the
 * photos: measured 1.2 s instead of 2.7 s for 8 s of rotated 1080p H.264, same picture. Interlaced
 * sources keep the CPU chain (bwdif).
 */
export function gpuEligible(info: VideoInfo, gpu?: GpuTonemap | null): boolean {
  if (info.interlaced) return false
  if (info.hdr) return true
  return !!gpu && gpu.decode !== 'upload' && gpuDecodable(info)
}

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
  /** GPU tone mapping for HDR sources (detectGpuTonemap); null/undefined = CPU chain only. */
  gpu?: GpuTonemap | null
  /** Folder for libplacebo's compiled shaders: saves ~0.3 s of start-up per GPU transcode. */
  shaderCache?: string
  /**
   * OS priority of the GPU attempt's FFmpeg process. It needs little CPU, but needs it at once to keep
   * decoder, shaders and encoder busy while photos saturate the CPU.
   */
  gpuPriority?: number
}

export interface ProxyResult {
  encoder: string
  /** HDR sources: where the tone mapping ran. */
  tonemap?: 'gpu' | 'cpu'
}

/**
 * Transcodes to an H.264 High 8-bit yuv420p MP4 (long edge <= maxEdge (1920), CFR <= 60 fps, ~1 s GOP,
 * rotation baked in, HDR tone-mapped, no audio). HDR sources try the GPU path first; any failure
 * falls back to the CPU chain, and a failing hardware encoder is retried with libx264.
 */
export async function transcodeProxy(ff: Ffmpeg, src: string, info: VideoInfo, out: string, opts: ProxyOptions = {}): Promise<ProxyResult> {
  const fps = info.proxyFps
  const maxEdge = opts.maxEdge ?? PROXY_MAX
  const vf = videoFilter(info, maxEdge, { fps })
  // Both chains write limited range. Hardware encoders only flag it with a known colour space, which
  // SDR sources often lack, so the flag is set in the bitstream
  const colorTags = info.hdr
    ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv']
    : ['-bsf:v', 'h264_metadata=video_full_range_flag=0']
  const tmp = `${out}.part.mp4`
  const hw = opts.encoders?.hardware.h264
  const order = hw ? [hw, 'libx264'] : ['libx264']
  const attempts: Array<{ input: string[]; vf: string; encoder: string; gpu: boolean }> = []
  const shaderCache = opts.shaderCache && existsSync(opts.shaderCache) ? opts.shaderCache : undefined
  if (opts.gpu && gpuEligible(info, opts.gpu)) {
    const gpuVf = gpuVideoFilter(info, maxEdge, opts.gpu, { fps, shaderCache: !!shaderCache })
    attempts.push({ input: gpuInputArgs(opts.gpu), vf: gpuVf, encoder: order[0], gpu: true })
  }
  for (const encoder of order) attempts.push({ input: [], vf, encoder, gpu: false })
  let lastErr: unknown
  for (const { input, vf, encoder, gpu } of attempts) {
    const args = [
      ...input,
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
        cwd: gpu ? shaderCache : undefined,
        priority: gpu ? opts.gpuPriority : undefined,
        onProgress: (s) => opts.onProgress?.(info.duration > 0 ? Math.min(1, Math.max(0, s / info.duration)) : 0)
      })
      await rename(tmp, out)
      return info.hdr ? { encoder, tonemap: gpu ? 'gpu' : 'cpu' } : { encoder }
    } catch (err) {
      lastErr = err
      await rm(tmp, { force: true })
      if (opts.signal?.aborted || !(err instanceof FfmpegError)) throw err
    }
  }
  throw lastErr
}

/**
 * Copies the video stream as is into an MP4 (no re-encoding, no audio): for streams Chromium plays
 * whose container (MKV, AVI, …) or extra tracks (iPhone spatial audio) it doesn't. The moov box stays
 * at the end: the media protocol serves byte ranges, so moving it would only cost a second write.
 */
export async function remuxVideo(ff: Ffmpeg, src: string, info: VideoInfo, out: string, opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<void> {
  const tmp = `${out}.part.mp4`
  const tag = info.stream.codec_name === 'hevc' ? ['-tag:v', 'hvc1'] : []
  try {
    await ff.run(['-i', src, '-map', `0:${info.stream.index}`, '-c:v', 'copy', ...tag, '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-f', 'mp4', tmp], {
      signal: opts.signal,
      onProgress: (s) => opts.onProgress?.(info.duration > 0 ? Math.min(1, Math.max(0, s / info.duration)) : 0)
    })
    await rename(tmp, out)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
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

/**
 * The video's sound for the preview and the export mixer (first decodable audio stream → .m4a), and
 * its integrated loudness (EBU R128) from the same FFmpeg run, so the file is read and decoded once.
 * `copy` (canCopyAudio) keeps an AAC-LC stream as it is instead of re-encoding it (AAC 192k 48 kHz
 * stereo); loudness is always measured on the 48 kHz stereo signal, like measureLoudness on the
 * re-encoded file. Resolves with the loudness in LUFS (0.1 steps), undefined for silence.
 */
export async function extractAudioWithLoudness(
  ff: Ffmpeg,
  src: string,
  info: VideoInfo,
  out: string,
  opts: { signal?: AbortSignal; copy?: boolean } = {}
): Promise<number | undefined> {
  if (info.audioIndex === null) throw new Error('no audio')
  const tmp = `${out}.part.m4a`
  const a = `0:a:${info.audioIndex}`
  const container = ['-map_metadata', '-1', '-movflags', '+faststart', '-f', 'mp4', tmp]
  // ebur128 logs its summary when the run ends; its pass-through output goes to a null muxer
  const measure = `aresample=48000,aformat=channel_layouts=stereo`
  const args = opts.copy
    ? ['-i', src, '-filter_complex', `[${a}]${measure},ebur128=framelog=quiet[m]`, '-map', a, '-c:a', 'copy', ...container]
    : ['-i', src, '-filter_complex', `[${a}]${measure},asplit=2[enc][l];[l]ebur128=framelog=quiet[m]`, '-map', '[enc]', '-c:a', 'aac', '-b:a', '192k', ...container]
  try {
    const log = await ff.log([...args, '-map', '[m]', '-f', 'null', '-'], { signal: opts.signal })
    await rename(tmp, out)
    return loudnessFromLog(log)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/** Strip frames run as separate FFmpeg processes, a few at a time across all strips. */
const stripLimit = createLimiter(4)

/** Even width for a frame `height` px high with the display aspect of the video. */
export function stripWidth(info: VideoInfo, height: number): number {
  return Math.max(2, Math.round((height * info.width) / Math.max(1, info.height) / 2) * 2)
}

/** File names of a strip's frames: dir/000.jpg, dir/001.jpg, … */
export function stripFiles(dir: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => join(dir, `${String(i).padStart(3, '0')}.jpg`))
}

/** Seconds of frame i of a strip with `count` frames: centres of equal slices of the duration. */
export function stripTimes(duration: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => (duration > 0 ? (duration * (i + 0.5)) / count : 0))
}

/**
 * `count` JPEG frames `height` px high (even width, rotation applied, HDR tone-mapped), spread evenly
 * over the video, written as dir/000.jpg… One FFmpeg process per frame seeking with -ss before -i,
 * so even very long files cost a few hundred ms per frame; when the frames are >= 5 s apart the seek
 * stops at the nearest keyframe instead of decoding up to the exact time.
 */
export async function videoStrip(
  ff: Ffmpeg,
  src: string,
  info: VideoInfo,
  count: number,
  height: number,
  dir: string,
  signal?: AbortSignal
): Promise<string[]> {
  const w = stripWidth(info, height)
  const parts: string[] = []
  if (info.interlaced) parts.push('bwdif=mode=send_frame')
  parts.push(`scale=${w}:${height}:flags=bicubic`)
  if (info.hdr) parts.push(TONEMAP_CHAIN)
  // MJPEG wants full-range YUV
  parts.push('scale=out_range=pc,format=yuvj420p')
  const vf = parts.join(',')
  const keyframes = info.duration / Math.max(1, count) >= 5
  await mkdir(dir, { recursive: true })
  const files = stripFiles(dir, count)
  const grab = async (at: number, out: string): Promise<boolean> => {
    const tmp = `${out}.part`
    await ff.run([
      '-threads', '2',
      ...(keyframes ? ['-noaccurate_seek'] : []),
      '-ss', at.toFixed(3),
      '-i', src,
      '-map', `0:${info.stream.index}`,
      '-frames:v', '1',
      '-vf', vf,
      '-c:v', 'mjpeg', '-q:v', '4',
      '-f', 'mjpeg', tmp
    ], { signal })
    // Past the end FFmpeg succeeds but writes an empty file
    if (!(await stat(tmp).then((st) => st.size > 0, () => false))) {
      await rm(tmp, { force: true })
      return false
    }
    await rename(tmp, out)
    return true
  }
  const times = stripTimes(info.duration, count)
  await Promise.all(
    files.map((out, i) =>
      stripLimit(async () => {
        if (signal?.aborted) throw new Error('cancelled')
        // Damaged tails or odd durations: nothing decodable at that time, take the first frame
        if (!(await grab(times[i], out)) && !(await grab(0, out))) throw new Error('no video frame')
      })
    )
  )
  return files
}
