// Export encoder: the renderer renders RGBA frames, FFmpeg encodes them together with the mixed audio.
import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { EncoderInfo, ExportOptions, ExportProgress, ExportQuality, VideoCodec } from '@shared/types'
import { Ffmpeg, summarizeStderr } from '../ffmpeg'
import { fpsRational } from '../media/video'
import { mixAudioPlan } from './audioMix'

export interface ExportJob {
  readonly outPath: string
  readonly totalFrames: number
  readonly encoder: string
  /** One RGBA frame, rows bottom-to-top, width*height*4 bytes. Resolves when FFmpeg accepted it. */
  writeFrame(rgba: Uint8Array): Promise<void>
  /** Closes the input, waits for FFmpeg, removes temp files. Resolves with the output path. */
  finish(): Promise<string>
  /** Kills FFmpeg and deletes the partial output. */
  cancel(): Promise<void>
}

const QUALITY_INDEX: Record<ExportQuality, number> = { standard: 0, high: 1, max: 2 }

/** Encoder for the requested codec: the detected hardware encoder if allowed, else libx264/libx265. */
export function pickEncoder(codec: VideoCodec, hardware: boolean, info: EncoderInfo): string {
  const hw = hardware ? info.hardware[codec] : undefined
  if (hw) return hw
  return codec === 'hevc' ? 'libx265' : 'libx264'
}

export function encoderArgs(encoder: string, codec: VideoCodec, quality: ExportQuality, fps: number): string[] {
  const q = QUALITY_INDEX[quality]
  const gop = String(Math.max(1, Math.round(fps * 2)))
  const hevcTag = codec === 'hevc' ? ['-tag:v', 'hvc1'] : []
  const profile = codec === 'hevc' ? 'main' : 'high'
  if (encoder.endsWith('_nvenc')) {
    const cq = [23, 19, 16][q]
    return ['-c:v', encoder, '-preset', 'p5', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0', '-profile:v', profile, '-g', gop, ...hevcTag]
  }
  if (encoder.endsWith('_qsv')) {
    const gq = [23, 19, 16][q]
    return ['-c:v', encoder, '-preset', 'slow', '-global_quality', String(gq), '-profile:v', profile, '-g', gop, ...hevcTag]
  }
  if (encoder.endsWith('_amf')) {
    const qp = [23, 19, 16][q]
    const b = codec === 'h264' ? ['-qp_b', String(qp + 2)] : []
    return ['-c:v', encoder, '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(qp), '-qp_p', String(qp + 1), ...b, '-profile:v', profile, '-g', gop, ...hevcTag]
  }
  if (encoder === 'libx265') {
    const crf = [24, 21, 18][q]
    return ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(crf), '-g', gop, '-x265-params', 'log-level=error', ...hevcTag]
  }
  const crf = [21, 18, 15][q]
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-profile:v', 'high', '-g', gop]
}

let active: { cancel: () => Promise<void> } | null = null

export function isExporting(): boolean {
  return active !== null
}

/** Cancels the running export (also while the audio is still being mixed). */
export async function cancelActiveExport(): Promise<void> {
  await active?.cancel()
}

/**
 * Mixes the audio plan (phase 'audio'), then spawns FFmpeg reading raw RGBA frames from stdin.
 * Resolves when the encoder is ready for frames. Only one export can run at a time.
 */
export async function startExport(
  options: ExportOptions,
  ffmpegDir: string,
  tmpDir: string,
  onProgress: (p: ExportProgress) => void,
  encoders?: EncoderInfo
): Promise<ExportJob> {
  if (active) throw new Error('An export is already running')
  const { width, height, fps } = options
  if (!(width > 0 && height > 0 && fps > 0)) throw new Error('invalid export size or frame rate')
  const ff = new Ffmpeg(ffmpegDir)
  const abort = new AbortController()
  const jobDir = join(tmpDir, `export-${Date.now().toString(36)}`)
  const frameBytes = width * height * 4
  const totalFrames = Math.max(1, Math.ceil(options.audio.duration * fps - 1e-6))
  let child: ChildProcess | null = null
  let exited: Promise<number | null> | null = null
  let state: 'audio' | 'video' | 'finishing' | 'done' | 'cancelled' | 'error' = 'audio'
  // Closures change `state`; this keeps TypeScript from narrowing it at the call sites
  const cancelled = (): boolean => state === 'cancelled'

  const cleanup = async (): Promise<void> => {
    await rm(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  const cancel = async (): Promise<void> => {
    if (state === 'done' || state === 'cancelled') return
    state = 'cancelled'
    abort.abort()
    if (child && exited) {
      child.kill('SIGKILL')
      await exited
    }
    await rm(options.outPath, { force: true })
    await cleanup()
    active = null
    onProgress({ phase: 'cancelled' })
  }
  active = { cancel }

  try {
    await mkdir(jobDir, { recursive: true })
    onProgress({ phase: 'audio', message: 'mixing' })
    const wav = join(jobDir, 'mix.wav')
    await mixAudioPlan(ff, options.audio, wav, join(jobDir, 'clips'), {
      signal: abort.signal,
      onProgress: (f) => onProgress({ phase: 'audio', message: `${Math.round(f * 100)}%` })
    })
    if (cancelled()) throw new Error('cancelled')

    const info = encoders ?? (await ff.encoders())
    const encoder = pickEncoder(options.codec, options.hardware, info)
    const outW = Math.round(width / 2) * 2
    const outH = Math.round(height / 2) * 2
    const args = [
      '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', fpsRational(fps), '-i', 'pipe:0',
      '-i', wav,
      '-map', '0:v:0', '-map', '1:a:0',
      // setparams tags the frames; FFmpeg takes colour tags from frames rather than -color_* options
      '-vf', `vflip,scale=w=${outW}:h=${outH}:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`,
      ...encoderArgs(encoder, options.codec, options.quality, fps),
      '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
      '-movflags', '+faststart',
      options.outPath
    ]
    const proc = ff.spawn(args, 'pipe')
    child = proc
    let stderr = ''
    proc.stderr!.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
      if (stderr.length > 16_000) stderr = stderr.slice(-8_000)
    })
    proc.stdout!.resume()
    // EPIPE when FFmpeg dies mid-write is reported through the exit code instead
    proc.stdin!.on('error', () => {})
    exited = new Promise((resolve) => {
      proc.on('close', (code) => resolve(code))
      proc.on('error', () => resolve(-1))
    })
    const exitPromise = exited
    if (state !== 'audio') throw new Error('cancelled')
    state = 'video'

    let frame = 0
    let lastEmit = 0
    const failure = (): Error => new Error(summarizeStderr(stderr) || 'encoder stopped unexpectedly')
    const emitVideo = (force = false): void => {
      const now = Date.now()
      if (force || now - lastEmit >= 100) {
        lastEmit = now
        onProgress({ phase: 'video', frame, totalFrames })
      }
    }
    emitVideo(true)

    const fail = async (err: Error): Promise<never> => {
      if (!cancelled()) {
        state = 'error'
        proc.kill('SIGKILL')
        await exitPromise
        await rm(options.outPath, { force: true })
        await cleanup()
        active = null
        onProgress({ phase: 'error', message: err.message })
      }
      throw err
    }

    const job: ExportJob = {
      outPath: options.outPath,
      totalFrames,
      encoder,
      async writeFrame(rgba) {
        if (state !== 'video') throw new Error(state === 'cancelled' ? 'cancelled' : 'export is not accepting frames')
        if (rgba.byteLength !== frameBytes) {
          throw new Error(`frame has ${rgba.byteLength} bytes, expected ${frameBytes} (${width}x${height} RGBA)`)
        }
        const buf = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)
        const stdin = proc.stdin!
        if (proc.exitCode !== null) return fail(failure())
        if (!stdin.write(buf)) {
          const result = await Promise.race([once(stdin, 'drain').then(() => 'drain'), exitPromise.then(() => 'exit')])
          if (result === 'exit' && !cancelled()) return fail(failure())
        }
        frame++
        emitVideo(frame === totalFrames)
      },
      async finish() {
        if (state !== 'video') throw new Error('export is not running')
        state = 'finishing'
        onProgress({ phase: 'finishing', frame, totalFrames })
        proc.stdin!.end()
        const code = await exitPromise
        if (cancelled()) throw new Error('cancelled')
        if (code !== 0) return fail(failure())
        state = 'done'
        await cleanup()
        active = null
        onProgress({ phase: 'done', frame, totalFrames })
        return options.outPath
      },
      cancel
    }
    return job
  } catch (err) {
    if (cancelled()) {
      child?.kill('SIGKILL')
      await rm(options.outPath, { force: true })
      await cleanup()
      throw new Error('cancelled')
    }
    state = 'error'
    child?.kill('SIGKILL')
    await rm(options.outPath, { force: true })
    await cleanup()
    active = null
    const message = err instanceof Error ? err.message : String(err)
    onProgress({ phase: 'error', message })
    throw err
  }
}
