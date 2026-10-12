// Joining the parts of an export job: the segments' streams in order, muxed with mix.wav like a
// regular WebCodecs export (AnnexBToTs → FFmpeg stream copy → MP4) and the chapter marks (an
// ffmetadata file, -map_chapters), checked, then moved over the output.
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createReadStream, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { VideoCodec } from '@shared/types'
import { chapterMetadata, type Chapter } from '@shared/chapters'
import { abortError } from '../abort'
import { replaceFile } from '../replaceFile'
import { summarizeStderr, type Ffmpeg } from '../ffmpeg'
import { videoStream } from '../media/videoInfo'
import { AnnexBToTs } from './annexb'
import { AUDIO_OUT_ARGS, copyVideoArgs } from './encoder'

export interface JoinOptions {
  /** Segment files in order. */
  segments: string[]
  /** The mixed audio (mix.wav). */
  audio: string
  codec: VideoCodec
  fps: number
  totalFrames: number
  /** Temp MP4 next to the output (partialOutputPath); the caller deletes it when this fails. */
  partial: string
  out: string
  signal: AbortSignal
  /** Chapter marks for the MP4, written to `chaptersFile` (ffmetadata) first. */
  chapters?: Chapter[]
  chaptersFile?: string
}

/** Moves the finished MP4 over the output; a player or Explorer's preview may hold it for seconds. */
async function replaceOutput(from: string, to: string): Promise<void> {
  try {
    await replaceFile(from, to, { attempts: 11, delayMs: 300 })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new Error(`could not replace ${to} (${code ?? (err instanceof Error ? err.message : String(err))}); is it open in another program?`)
  }
}

/** Writes the joined MP4 to `partial`, checks its frames and sound and renames it over `out`. */
export async function joinSegments(ff: Ffmpeg, o: JoinOptions): Promise<void> {
  const { signal, out, partial, totalFrames } = o
  let child: ChildProcess | null = null
  let exited: Promise<number | null> = Promise.resolve(null)
  const check = (): void => {
    if (signal.aborted) throw abortError()
  }
  try {
    for (let k = 0; k < o.segments.length; k++) if (!existsSync(o.segments[k])) throw new Error(`segment ${k} is missing`)
    if (!existsSync(dirname(out))) throw new Error(`the folder ${dirname(out)} does not exist`)
    const chapters = o.chapters?.length && o.chaptersFile ? o.chaptersFile : null
    if (chapters) await writeFile(chapters, chapterMetadata(o.chapters!, totalFrames / o.fps), 'utf8')
    check()
    const proc = ff.spawn(
      [
        '-loglevel', 'error', '-y',
        // MPEG-TS made by AnnexBToTs: the joined stream with pts/dts per frame
        '-f', 'mpegts', '-i', 'pipe:0',
        '-i', o.audio,
        ...(chapters ? ['-f', 'ffmetadata', '-i', chapters, '-map_chapters', '2'] : []),
        '-map', '0:v:0', '-map', '1:a:0',
        ...copyVideoArgs(o.codec),
        ...AUDIO_OUT_ARGS,
        '-movflags', '+faststart',
        partial
      ],
      'pipe'
    )
    child = proc
    let stderr = ''
    proc.stderr!.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
      if (stderr.length > 16_000) stderr = stderr.slice(-8_000)
    })
    proc.stdout!.resume()
    proc.stdin!.on('error', () => {})
    exited = new Promise((done) => {
      proc.on('close', (code) => done(code))
      proc.on('error', () => done(-1))
    })
    const stop = (): void => {
      proc.kill('SIGKILL')
    }
    signal.addEventListener('abort', stop, { once: true })
    const failure = (): Error => new Error(summarizeStderr(stderr) || 'FFmpeg stopped unexpectedly')
    const packets: Uint8Array[] = []
    const flush = async (): Promise<void> => {
      if (!packets.length) return
      if (proc.exitCode !== null) throw failure()
      if (!proc.stdin!.write(Buffer.concat(packets.splice(0)))) {
        const r = await Promise.race([once(proc.stdin!, 'drain').then(() => 'drain', () => 'gone'), exited.then(() => 'gone')])
        check()
        if (r === 'gone') {
          await exited
          throw failure()
        }
      }
    }
    const muxer = new AnnexBToTs(o.codec, o.fps, (p) => packets.push(p))
    for (const path of o.segments) {
      for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
        check()
        muxer.push(chunk as Buffer)
        await flush()
      }
    }
    muxer.end()
    await flush()
    if (muxer.frames !== totalFrames) throw new Error(`the joined video has ${muxer.frames} frames, expected ${totalFrames}`)
    proc.stdin!.end()
    const code = await exited
    check()
    if (code !== 0) throw failure()
    const probe = await ff.probe(partial, signal)
    const frames = Number(videoStream(probe)?.nb_frames)
    if (frames !== totalFrames) throw new Error(`the MP4 has ${frames} frames, expected ${totalFrames}`)
    if (!probe.streams.some((s) => s.codec_type === 'audio')) throw new Error('the MP4 has no sound')
    check()
    await replaceOutput(partial, out)
  } catch (err) {
    child?.kill('SIGKILL')
    await exited
    throw err
  }
}
