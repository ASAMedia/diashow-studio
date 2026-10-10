// Video frames at given times as JPEG bytes, for face analysis in the renderer: rotation applied,
// HDR tone-mapped and deinterlaced like the proxies, scaled to fit maxEdge (about 720p).
//
// Evenly spaced times (the face analysis samples every 0.5 s) are read in one decoding pass from the
// first of them on: a select filter keeps the first frame at or after each time. Other times are
// read one FFmpeg process each, seeking with -ss before -i. Processes run below normal priority:
// this is background work.
import { constants, setPriority } from 'node:os'
import { abortError } from '../abort'
import type { Ffmpeg } from '../ffmpeg'
import { fitEven, TONEMAP_CHAIN } from './video'
import { analyzeVideo, type VideoInfo } from './videoInfo'

/** Frames per call and the largest edge, as accepted from the renderer. */
export const MAX_FRAMES = 64
export const MAX_EDGE = 1920

/** Probe results of the last videos read (the analysis asks for a clip's frames in several calls). */
const infos = new Map<string, Promise<VideoInfo | null>>()

export function videoInfoCached(ff: Ffmpeg, path: string, signal?: AbortSignal): Promise<VideoInfo | null> {
  let p = infos.get(path)
  if (!p) {
    p = ff.probe(path, signal).then(analyzeVideo)
    p.catch(() => infos.delete(path))
    infos.set(path, p)
    if (infos.size > 16) infos.delete(infos.keys().next().value!)
  }
  return p
}

/** Step of evenly spaced times (within 2 ms), or null. */
export function uniformStep(times: number[]): number | null {
  if (times.length < 2) return null
  const step = times[1] - times[0]
  if (step <= 0.01) return null
  for (let i = 2; i < times.length; i++) if (Math.abs(times[i] - times[i - 1] - step) > 0.002) return null
  return step
}

/** The select expression for evenly spaced times from 0 (relative to the seek point). */
export function selectExpr(step: number): string {
  // register 0 counts the frames taken; a frame is taken once it reaches the next time
  const s = step.toFixed(6)
  return `if(gte(t,ld(0)*${s}-0.002),st(0,ld(0)+1),0)`
}

/** Splits FFmpeg's MJPEG stream (image2pipe) into single JPEG files. */
export function splitJpegs(buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  let start = -1
  for (let i = 0; i + 2 < buf.length; i++) {
    // SOI followed by a marker; FFmpeg's encoder writes no embedded thumbnails
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      if (start >= 0) out.push(buf.subarray(start, i))
      start = i
      i += 2
    }
  }
  if (start >= 0) out.push(buf.subarray(start))
  return out
}

function filters(info: VideoInfo, maxEdge: number, select?: string): string {
  const [w, h] = fitEven(info.width, info.height, maxEdge)
  const parts: string[] = []
  if (info.interlaced) parts.push('bwdif=mode=send_frame')
  if (select) parts.push(`select='${select}'`)
  parts.push(`scale=${w}:${h}:flags=bicubic`)
  if (info.hdr) parts.push(TONEMAP_CHAIN)
  parts.push('setsar=1', 'scale=out_range=pc,format=yuvj420p')
  return parts.join(',')
}

/** Runs FFmpeg below normal priority and returns its stdout. */
function capture(ff: Ffmpeg, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const child = ff.spawn(['-nostdin', '-loglevel', 'error', '-y', ...args])
    try {
      if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      // only scheduling
    }
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout!.on('data', (c: Buffer) => chunks.push(c))
    child.stderr!.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-4000)
    })
    const onAbort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', reject)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(abortError())
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(stderr.trim().split(/\r?\n/).pop() || `ffmpeg exited with code ${code}`))
    })
  })
}

/**
 * JPEG frames at `times` (source seconds, sorted ascending), aligned with `times`; an empty array
 * where no frame could be read (past the end).
 */
export async function videoFrames(ff: Ffmpeg, src: string, info: VideoInfo, times: number[], maxEdge: number, signal?: AbortSignal): Promise<Uint8Array[]> {
  const out: Uint8Array[] = times.map(() => new Uint8Array(0))
  if (!times.length) return out
  const step = uniformStep(times)
  const stream = ['-map', `0:${info.stream.index}`]
  const jpeg = ['-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', 'pipe:1']
  if (step) {
    const t0 = Math.max(0, times[0])
    const buf = await capture(ff, ['-threads', '2', '-ss', t0.toFixed(3), '-i', src, ...stream, '-vf', filters(info, maxEdge, selectExpr(step)), '-fps_mode', 'passthrough', '-frames:v', String(times.length), ...jpeg], signal)
    splitJpegs(buf).forEach((f, i) => i < out.length && (out[i] = new Uint8Array(f.buffer, f.byteOffset, f.byteLength)))
    return out
  }
  for (let i = 0; i < times.length; i++) {
    const buf = await capture(ff, ['-threads', '2', '-ss', Math.max(0, times[i]).toFixed(3), '-i', src, ...stream, '-vf', filters(info, maxEdge), '-frames:v', '1', ...jpeg], signal)
    const [f] = splitJpegs(buf)
    if (f) out[i] = new Uint8Array(f.buffer, f.byteOffset, f.byteLength)
  }
  return out
}
