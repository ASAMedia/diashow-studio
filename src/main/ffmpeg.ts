// FFmpeg / ffprobe process helpers. No Electron imports: the binary directory is injected.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setPriority } from 'node:os'
import { join } from 'node:path'
import type { EncoderInfo } from '@shared/types'
import { abortError } from './abort'

const EXE = process.platform === 'win32' ? '.exe' : ''

export interface FfmpegLocation {
  /** process.resourcesPath in a packaged Electron app. */
  resourcesPath?: string
  /** Project root in development (app.getAppPath() or process.cwd()). */
  appPath?: string
  packaged?: boolean
}

/**
 * Directory containing ffmpeg(.exe) and ffprobe(.exe). Packaged builds ship it in
 * resources/ffmpeg, development uses vendor/ffmpeg/bin. Returns '' to fall back to PATH.
 */
export function resolveFfmpegDir(loc: FfmpegLocation = {}): string {
  const candidates: string[] = []
  if (process.env.DIASHOW_FFMPEG_DIR) candidates.push(process.env.DIASHOW_FFMPEG_DIR)
  if (loc.resourcesPath) candidates.push(join(loc.resourcesPath, 'ffmpeg'))
  if (!loc.packaged) {
    if (loc.appPath) candidates.push(join(loc.appPath, 'vendor', 'ffmpeg', 'bin'))
    candidates.push(join(process.cwd(), 'vendor', 'ffmpeg', 'bin'))
  }
  return candidates.find((d) => existsSync(join(d, `ffmpeg${EXE}`))) ?? ''
}

export interface ProbeSideData {
  side_data_type?: string
  rotation?: number
  [key: string]: unknown
}

export interface ProbeStream {
  index: number
  codec_type?: string
  codec_name?: string
  codec_tag_string?: string
  profile?: string
  pix_fmt?: string
  width?: number
  height?: number
  sample_aspect_ratio?: string
  r_frame_rate?: string
  avg_frame_rate?: string
  field_order?: string
  color_range?: string
  color_space?: string
  color_transfer?: string
  color_primaries?: string
  bits_per_raw_sample?: string
  sample_rate?: string
  channels?: number
  duration?: string
  nb_frames?: string
  disposition?: Record<string, number>
  tags?: Record<string, string>
  side_data_list?: ProbeSideData[]
}

export interface ProbeFormat {
  filename?: string
  format_name?: string
  duration?: string
  size?: string
  bit_rate?: string
  tags?: Record<string, string>
}

/** FFmpeg 7.1+ stream groups, e.g. the HEIF "Tile Grid" (its component carries the display matrix). */
export interface ProbeStreamGroup {
  index: number
  type?: string
  components?: Array<{ width?: number; height?: number; side_data_list?: ProbeSideData[] }>
}

export interface ProbeResult {
  format: ProbeFormat
  streams: ProbeStream[]
  stream_groups?: ProbeStreamGroup[]
}

export interface RunOptions {
  /** Called with the output position in seconds (from -progress out_time_us). */
  onProgress?: (seconds: number) => void
  signal?: AbortSignal
  /** Working directory (relative paths in filter options resolve against it). */
  cwd?: string
  /** OS scheduling priority of the process (os.constants.priority); default normal. */
  priority?: number
}

export class FfmpegError extends Error {
  constructor(message: string, readonly stderr: string, readonly code: number | null) {
    super(message)
    this.name = 'FfmpegError'
  }
}

/** Last meaningful stderr line, used as a short human readable error. */
export function summarizeStderr(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(Fontconfig|\[out#|Conversion failed|Error opening output files)/i.test(l))
  const last = lines[lines.length - 1] ?? ''
  return last.length > 200 ? last.slice(0, 200) + '…' : last
}

/** Encoder detection result per FFmpeg binary, shared by all Ffmpeg instances. */
const encoderCache = new Map<string, Promise<EncoderInfo>>()

export class Ffmpeg {
  readonly ffmpegPath: string
  readonly ffprobePath: string

  constructor(readonly dir: string) {
    this.ffmpegPath = dir ? join(dir, `ffmpeg${EXE}`) : 'ffmpeg'
    this.ffprobePath = dir ? join(dir, `ffprobe${EXE}`) : 'ffprobe'
  }

  /** Spawns ffmpeg with -hide_banner; the caller owns the process. */
  spawn(args: string[], stdin: 'pipe' | 'ignore' = 'ignore', cwd?: string): ChildProcess {
    return spawn(this.ffmpegPath, ['-hide_banner', ...args], {
      stdio: [stdin, 'pipe', 'pipe'],
      windowsHide: true,
      cwd
    })
  }

  /** Runs ffmpeg to completion. Progress is read from `-progress pipe:1`. */
  run(args: string[], opts: RunOptions = {}): Promise<void> {
    const full = ['-nostdin', '-loglevel', 'error', '-y']
    if (opts.onProgress) full.push('-progress', 'pipe:1', '-nostats')
    full.push(...args)
    return this.exec(full, opts).then(() => undefined)
  }

  /** Runs ffmpeg and returns everything it wrote to stdout (use an output of `-`/pipe:1). */
  capture(args: string[], opts: { signal?: AbortSignal; onData?: (chunk: Buffer) => void } = {}): Promise<Buffer> {
    return this.exec(['-nostdin', '-loglevel', 'error', '-y', ...args], { ...opts, collect: true })
  }

  /**
   * Runs ffmpeg at the given log level and resolves with its complete log (stderr), e.g. for
   * filters that print their results (ebur128) or device listings.
   */
  async log(args: string[], opts: { signal?: AbortSignal; level?: string } = {}): Promise<string> {
    let text = ''
    await this.exec(['-nostdin', '-loglevel', opts.level ?? 'info', '-nostats', '-y', ...args], {
      signal: opts.signal,
      onStderr: (chunk) => {
        text += chunk
      }
    })
    return text
  }

  private exec(
    args: string[],
    opts: RunOptions & { collect?: boolean; onData?: (chunk: Buffer) => void; onStderr?: (text: string) => void }
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(abortError())
      const child = this.spawn(args, 'ignore', opts.cwd)
      if (opts.priority !== undefined && child.pid) {
        try {
          setPriority(child.pid, opts.priority)
        } catch {
          // only scheduling changes
        }
      }
      const chunks: Buffer[] = []
      let stderr = ''
      let pending = ''
      child.stdout!.on('data', (chunk: Buffer) => {
        if (opts.onData) opts.onData(chunk)
        else if (opts.collect) chunks.push(chunk)
        else if (opts.onProgress) {
          pending += chunk.toString('latin1')
          const lines = pending.split('\n')
          pending = lines.pop() ?? ''
          for (const line of lines) {
            const m = /^out_time_us=(\d+)/.exec(line)
            if (m) opts.onProgress(Number(m[1]) / 1e6)
          }
        }
      })
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        opts.onStderr?.(text)
        stderr += text
        if (stderr.length > 16_000) stderr = stderr.slice(-8_000)
      })
      const onAbort = (): void => {
        child.kill()
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', (err) => {
        opts.signal?.removeEventListener('abort', onAbort)
        reject(err)
      })
      child.on('close', (code) => {
        opts.signal?.removeEventListener('abort', onAbort)
        if (opts.signal?.aborted) return reject(abortError())
        if (code === 0) return resolve(Buffer.concat(chunks))
        const summary = summarizeStderr(stderr) || `ffmpeg exited with code ${code}`
        reject(new FfmpegError(summary, stderr, code))
      })
    })
  }

  /** ffprobe JSON with format, streams, stream groups and side data (display matrix rotation, DOVI). */
  probe(path: string, signal?: AbortSignal): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.ffprobePath,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_stream_groups', path],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      const out: Buffer[] = []
      let err = ''
      child.stdout.on('data', (c: Buffer) => out.push(c))
      child.stderr.on('data', (c: Buffer) => (err += c.toString()))
      const onAbort = (): void => {
        child.kill()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', reject)
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        if (signal?.aborted) return reject(abortError())
        if (code !== 0) return reject(new FfmpegError(summarizeStderr(err) || 'ffprobe failed', err, code))
        try {
          const json = JSON.parse(Buffer.concat(out).toString('utf8')) as Partial<ProbeResult>
          resolve({ format: json.format ?? {}, streams: json.streams ?? [], stream_groups: json.stream_groups ?? [] })
        } catch (e) {
          reject(e)
        }
      })
    })
  }

  /** Available H.264/HEVC encoders; hardware ones are verified with a tiny test encode. Cached. */
  encoders(): Promise<EncoderInfo> {
    let info = encoderCache.get(this.ffmpegPath)
    if (!info) {
      info = this.detectEncoders()
      encoderCache.set(this.ffmpegPath, info)
    }
    return info
  }

  private async detectEncoders(): Promise<EncoderInfo> {
    let listed = ''
    try {
      listed = (await this.capture(['-encoders'])).toString('utf8')
    } catch {
      // keep empty: no encoders known
    }
    const has = (name: string): boolean => new RegExp(`\\s${name}\\s`).test(listed)
    const hwOrder = ['nvenc', 'qsv', 'amf']
    const candidates = hwOrder.flatMap((hw) => [`h264_${hw}`, `hevc_${hw}`]).filter(has)
    const results = await Promise.all(candidates.map(async (enc) => [enc, await this.testEncoder(enc)] as const))
    const working = new Set(results.filter(([, ok]) => ok).map(([enc]) => enc))
    const pick = (codec: 'h264' | 'hevc'): string[] => {
      const hw = hwOrder.map((h) => `${codec}_${h}`).filter((e) => working.has(e))
      const sw = codec === 'h264' ? 'libx264' : 'libx265'
      return has(sw) ? [...hw, sw] : hw
    }
    const h264 = pick('h264')
    const hevc = pick('hevc')
    return {
      h264,
      hevc,
      hardware: {
        h264: h264.find((e) => !e.startsWith('lib')),
        hevc: hevc.find((e) => !e.startsWith('lib'))
      }
    }
  }

  private async testEncoder(encoder: string): Promise<boolean> {
    const signal = AbortSignal.timeout(20_000)
    try {
      await this.run(
        ['-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', '-frames:v', '3', '-pix_fmt', 'yuv420p', '-c:v', encoder, '-f', 'null', '-'],
        { signal }
      )
      return true
    } catch {
      return false
    }
  }
}

/** Parses "30000/1001" or "4:3" style rationals; returns 0 for invalid values. */
export function parseRational(value: string | undefined): number {
  if (!value) return 0
  const [n, d] = value.split(/[/:]/).map(Number)
  if (!Number.isFinite(n)) return 0
  if (d === undefined) return n
  return d ? n / d : 0
}
