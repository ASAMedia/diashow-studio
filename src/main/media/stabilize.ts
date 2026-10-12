// Stabilising shaky clips with libvidstab (in the bundled FFmpeg build): vidstabdetect measures the
// camera shake, vidstabtransform moves each frame against it. The result has the same frames with the
// same timestamps and the same size as its source; a slight zoom hides the moving edges.
//
// Measured on a generated 30 s 1080p clip with hand shake (20 threads, NVENC): detection 2.8 s,
// transform + encode 9.6 s, ~12.5 s in total (2.4x realtime); the shake (RMS of the camera path
// around its 1 s average) went from 21 px to 1.2 px, and no frame showed an edge. vidstab's default
// path smoothing ("gauss") took 10-25 s just to prepare in this build and held even slow pans still;
// averaging ("avg") prepares instantly.
import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { EncoderInfo } from '@shared/types'
import { FfmpegError, type Ffmpeg } from '../ffmpeg'
import { proxyEncoderArgs } from './video'
import { analyzeVideo } from './videoInfo'
import { STABILIZE_ZOOM } from '@shared/people'

/** Zoom in percent: hides the edges that the correction moves into view (the renderer maps pixelated areas with the same value). */
export const STAB_ZOOM = Math.round(STABILIZE_ZOOM * 100)
/** Frames averaged on each side for the smoothed camera path (~0.7 s at 30 fps). */
export const STAB_SMOOTHING = 20

export interface StabilizeOptions {
  signal?: AbortSignal
  encoders?: EncoderInfo
  /** 0..1 over both passes. */
  onProgress?: (fraction: number) => void
}

/** vidstabtransform options: corrections never move further than the zoom margin, so no edge shows. */
export function transformFilter(width: number, height: number, trf: string): string {
  const margin = Math.max(2, Math.floor((Math.min(width, height) * STAB_ZOOM) / 100 / 2))
  return [
    `vidstabtransform=input=${trf}`,
    `smoothing=${STAB_SMOOTHING}`,
    'optalgo=avg',
    'optzoom=0',
    `zoom=${STAB_ZOOM}`,
    `maxshift=${margin}`,
    'maxangle=0.02',
    'interpol=bicubic',
    'crop=keep'
  ].join(':')
}

/**
 * Writes a stabilised copy of `src` (a playable, rotation-free SDR file such as MediaItem.playback)
 * to `out`: H.264 8-bit 4:2:0, video only, every frame with its original timestamp. Uses the hardware
 * H.264 encoder when there is one and falls back to libx264.
 */
export async function stabilizeFile(ff: Ffmpeg, src: string, out: string, opts: StabilizeOptions = {}): Promise<void> {
  const info = analyzeVideo(await ff.probe(src, opts.signal))
  if (!info) throw new Error('no video stream')
  const dir = dirname(out)
  // Filter options take the file name relative to FFmpeg's working directory: no path escaping
  const trf = `${basename(out)}.trf`
  const tmp = `${out}.part.mp4`
  const map = ['-map', `0:${info.stream.index}`]
  const progress = (from: number, span: number) => (s: number): void =>
    opts.onProgress?.(from + span * (info.duration > 0 ? Math.min(1, Math.max(0, s / info.duration)) : 0))
  try {
    await ff.run(['-i', src, ...map, '-vf', `vidstabdetect=shakiness=6:accuracy=15:stepsize=6:result=${trf}`, '-f', 'null', '-'], {
      signal: opts.signal,
      cwd: dir,
      onProgress: progress(0, 0.25)
    })
    if (!existsSync(join(dir, trf))) throw new Error('no motion data')
    const vf = `${transformFilter(info.width, info.height, trf)},format=yuv420p`
    const hw = opts.encoders?.hardware.h264
    const encoders = hw ? [hw, 'libx264'] : ['libx264']
    let lastErr: unknown
    for (const encoder of encoders) {
      try {
        await ff.run(
          [
            '-i', src,
            ...map,
            '-vf', vf,
            // same frames, same timestamps (also for variable frame rate phone clips)
            '-fps_mode', 'passthrough',
            '-enc_time_base', 'demux',
            ...proxyEncoderArgs(encoder, info.fps || 30, { qsvLookAhead: opts.encoders?.qsvLookAhead }),
            '-an', '-sn', '-dn',
            '-map_metadata', '-1',
            '-map_chapters', '-1',
            '-movflags', '+faststart',
            '-f', 'mp4',
            tmp
          ],
          { signal: opts.signal, cwd: dir, onProgress: progress(0.25, 0.75) }
        )
        await rename(tmp, out)
        return
      } catch (err) {
        lastErr = err
        await rm(tmp, { force: true })
        if (opts.signal?.aborted || !(err instanceof FfmpegError)) throw err
      }
    }
    throw lastErr
  } finally {
    await rm(join(dir, trf), { force: true })
    await rm(tmp, { force: true })
  }
}
