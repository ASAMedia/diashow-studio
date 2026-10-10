// Export encoder: the renderer renders frames (I420 packed on the GPU, or RGBA), FFmpeg encodes them
// together with the mixed audio. Alternatively the renderer encodes itself (WebCodecs) and FFmpeg only
// muxes its H.264/HEVC stream.
import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { EncoderInfo, ExportOptions, ExportProgress, ExportQuality, VideoCodec } from '@shared/types'
import { Ffmpeg, summarizeStderr } from '../ffmpeg'
import { fpsRational } from '../media/video'
import { AnnexBToTs } from './annexb'
import { mixAudioPlan } from './audioMix'

export interface ExportJob {
  readonly outPath: string
  readonly totalFrames: number
  /** FFmpeg encoder, or 'copy' when the renderer sends an encoded stream. */
  readonly encoder: string
  readonly input: 'rgba' | 'yuv' | 'h264' | 'hevc'
  /**
   * One frame. 'rgba': rows bottom-to-top, width*height*4 bytes. 'yuv': I420 (BT.709 limited range),
   * rows top-to-bottom, width*height*1.5 bytes. Resolves when FFmpeg accepted it.
   */
  writeFrame(frame: Uint8Array): Promise<void>
  /** Next bytes of the Annex B stream (input 'h264' / 'hevc'), any chunking. Resolves when FFmpeg accepted them. */
  writeChunk(data: Uint8Array): Promise<void>
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
    // p4 rather than p5: same quality and size (SSIM 0.9966 vs 0.9968), but H.264 4K runs at
    // 93 instead of 36 frames/s on a laptop RTX, which made the encoder the 4K bottleneck
    return ['-c:v', encoder, '-preset', 'p4', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0', '-profile:v', profile, '-g', gop, ...hevcTag]
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

/** FFmpeg input options for raw frames on stdin ('yuv': I420 top row first; 'rgba': rows bottom-up). */
export function rawInputArgs(input: 'rgba' | 'yuv', width: number, height: number, fps: number): string[] {
  return ['-f', 'rawvideo', '-pix_fmt', input === 'yuv' ? 'yuv420p' : 'rgba', '-s', `${width}x${height}`, '-r', fpsRational(fps), '-i', 'pipe:0']
}

/** Video filter for raw frames: BT.709 limited range tags; RGBA is flipped and converted first. */
export function rawVideoFilter(input: 'rgba' | 'yuv', width: number, height: number): string {
  const outW = Math.round(width / 2) * 2
  const outH = Math.round(height / 2) * 2
  // setparams tags the frames; FFmpeg takes colour tags from frames rather than -color_* options
  const tags = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv'
  // the GPU already packed I420 the right way up; RGBA still needs flipping and converting
  return input === 'yuv' ? tags : `vflip,scale=w=${outW}:h=${outH}:out_color_matrix=bt709:out_range=tv,format=yuv420p,${tags}`
}

/** Stream copy of an encoded stream: these options become the container's colour tags. */
export function copyVideoArgs(codec: VideoCodec): string[] {
  return [
    '-c:v', 'copy',
    ...(codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'
  ]
}

/** Audio encoding of the mixed WAV for MP4 exports. */
export const AUDIO_OUT_ARGS = ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000']

let active: { cancel: () => Promise<void> } | null = null

export function isExporting(): boolean {
  return active !== null
}

/** Cancels the running export (also while the audio is still being mixed). */
export async function cancelActiveExport(): Promise<void> {
  await active?.cancel()
}

/**
 * Mixes the audio plan (phase 'audio'), then spawns FFmpeg reading raw RGBA frames from stdin, or for
 * input 'h264' / 'hevc' the renderer's Annex B stream, which gets constant-rate timestamps in display
 * order (B-frames allowed) and is copied, not re-encoded. Resolves when ready for frames. Only one
 * export can run at a time.
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
  const input = options.input ?? 'rgba'
  if (input !== 'rgba' && input !== 'yuv' && input !== 'h264' && input !== 'hevc') throw new Error(`unknown export input: ${String(input)}`)
  if (input === 'yuv' && (width % 2 || height % 2)) throw new Error('yuv input needs an even width and height')
  const raw = input === 'rgba' || input === 'yuv'
  const ff = new Ffmpeg(ffmpegDir)
  const abort = new AbortController()
  const jobDir = join(tmpDir, `export-${Date.now().toString(36)}`)
  const frameBytes = input === 'yuv' ? (width * height * 3) / 2 : width * height * 4
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

    let encoder: string
    let args: string[]
    const audioOut = [...AUDIO_OUT_ARGS, '-movflags', '+faststart', options.outPath]
    if (input === 'rgba' || input === 'yuv') {
      const info = encoders ?? (await ff.encoders())
      encoder = pickEncoder(options.codec, options.hardware, info)
      args = [
        '-loglevel', 'error', '-y',
        ...rawInputArgs(input, width, height, fps),
        '-i', wav,
        '-map', '0:v:0', '-map', '1:a:0',
        '-vf', rawVideoFilter(input, width, height),
        ...encoderArgs(encoder, options.codec, options.quality, fps),
        ...audioOut
      ]
    } else {
      encoder = 'copy'
      args = [
        '-loglevel', 'error', '-y',
        // MPEG-TS made by AnnexBToTs: the stream with pts/dts per frame
        '-f', 'mpegts', '-i', 'pipe:0',
        '-i', wav,
        '-map', '0:v:0', '-map', '1:a:0',
        ...copyVideoArgs(input),
        ...audioOut
      ]
    }
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

    const write = async (data: Uint8Array): Promise<void> => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      const stdin = proc.stdin!
      if (proc.exitCode !== null) return fail(failure())
      if (!stdin.write(buf)) {
        const result = await Promise.race([once(stdin, 'drain').then(() => 'drain'), exitPromise.then(() => 'exit')])
        if (result === 'exit' && !cancelled()) return fail(failure())
      }
    }
    const ts: Uint8Array[] = []
    const muxer = raw ? null : new AnnexBToTs(input, fps, (packet) => ts.push(packet))
    const flushTs = async (): Promise<void> => {
      if (ts.length) await write(Buffer.concat(ts.splice(0)))
    }

    const job: ExportJob = {
      outPath: options.outPath,
      totalFrames,
      encoder,
      input,
      async writeFrame(data) {
        if (state !== 'video') throw new Error(state === 'cancelled' ? 'cancelled' : 'export is not accepting frames')
        if (!raw) throw new Error(`this export expects encoded ${input} data (exportChunk)`)
        if (data.byteLength !== frameBytes) {
          throw new Error(`frame has ${data.byteLength} bytes, expected ${frameBytes} (${width}x${height} ${input === 'yuv' ? 'I420' : 'RGBA'})`)
        }
        await write(data)
        frame++
        emitVideo(frame === totalFrames)
      },
      async writeChunk(data) {
        if (state !== 'video') throw new Error(state === 'cancelled' ? 'cancelled' : 'export is not accepting data')
        if (!muxer) throw new Error('this export expects raw frames (exportFrame)')
        if (!data.byteLength) return
        // Frames are counted from the stream itself, so any chunking gives the same progress
        muxer.push(data)
        await flushTs()
        const reachedEnd = muxer.frames >= totalFrames && frame < totalFrames
        frame = muxer.frames
        emitVideo(reachedEnd)
      },
      async finish() {
        if (state !== 'video') throw new Error('export is not running')
        if (muxer) {
          // The last pictures were waiting for their display order
          muxer.end()
          await flushTs()
          frame = muxer.frames
          emitVideo(true)
        }
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
