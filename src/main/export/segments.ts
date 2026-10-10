// One segment of an export job: an elementary stream (seg-NNNNN.h264 / .hevc) that starts with an
// IDR picture. Raw frames ('yuv' / 'rgba') are encoded by FFmpeg with the same arguments as a regular
// export; encoded input ('h264' / 'hevc' from WebCodecs) is stored as it comes. Either way the
// segment is checked (frame count, IDR start) before it gets its final name.
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import type { SegmentInput } from '@shared/exportQueue'
import type { ExportQuality, VideoCodec } from '@shared/types'
import { summarizeStderr, type Ffmpeg } from '../ffmpeg'
import { AnnexBFrameCounter } from './annexb'
import { encoderArgs, rawInputArgs, rawVideoFilter } from './encoder'

export interface Segment {
  readonly k: number
  readonly input: SegmentInput
  readonly encoder: string
  readonly expected: number
  /** Frames taken (raw input) or counted in the stream (encoded input). */
  readonly frames: number
  /** One raw frame or the next bytes of the stream. The synchronous part queues the data in order. */
  write(data: Uint8Array): Promise<void>
  /** Validates the segment and renames it to its final name. Deletes the temp file on failure. */
  finish(): Promise<void>
  /** Stops it and deletes the temp file. */
  abort(): Promise<void>
}

/** Frame count and first picture type of an Annex B file. */
async function countFile(path: string, codec: VideoCodec): Promise<AnnexBFrameCounter> {
  const counter = new AnnexBFrameCounter(codec)
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) counter.push(chunk as Buffer)
  counter.end()
  return counter
}

function checkStream(counter: AnnexBFrameCounter, k: number, expected: number): void {
  if (counter.frames !== expected) throw new Error(`segment ${k} has ${counter.frames} frames, expected ${expected}`)
  if (!counter.startsWithIdr) throw new Error(`segment ${k} does not start with an IDR picture (start each segment with a new encoder)`)
}

interface RawSegmentOptions {
  k: number
  input: 'yuv' | 'rgba'
  width: number
  height: number
  fps: number
  codec: VideoCodec
  quality: ExportQuality
  encoder: string
  expected: number
  tmp: string
  final: string
}

/** FFmpeg encodes raw frames like a regular export, but video only, into an elementary stream. */
export function openRawSegment(ff: Ffmpeg, o: RawSegmentOptions): Segment {
  const frameBytes = o.input === 'yuv' ? (o.width * o.height * 3) / 2 : o.width * o.height * 4
  const video = encoderArgs(o.encoder, o.codec, o.quality, o.fps)
  // the hvc1 tag belongs to the MP4 made at the end, not to the raw stream
  const tag = video.indexOf('-tag:v')
  if (tag >= 0) video.splice(tag, 2)
  const args = [
    '-loglevel', 'error', '-y',
    ...rawInputArgs(o.input, o.width, o.height, o.fps),
    '-map', '0:v:0',
    '-vf', rawVideoFilter(o.input, o.width, o.height),
    ...video,
    '-f', o.codec, o.tmp
  ]
  const proc = ff.spawn(args, 'pipe')
  let stderr = ''
  proc.stderr!.on('data', (c: Buffer) => {
    stderr += c.toString('utf8')
    if (stderr.length > 16_000) stderr = stderr.slice(-8_000)
  })
  proc.stdout!.resume()
  // EPIPE when FFmpeg dies mid-write is reported through the exit code instead
  proc.stdin!.on('error', () => {})
  const exited = new Promise<number | null>((done) => {
    proc.on('close', (code) => done(code))
    proc.on('error', () => done(-1))
  })
  let frames = 0
  let state: 'open' | 'finishing' | 'aborted' | 'done' = 'open'
  const failure = (): Error => new Error(summarizeStderr(stderr) || 'encoder stopped unexpectedly')
  // writers waiting for FFmpeg share one wait (the renderer keeps several frames in flight)
  let waiting: Promise<'drain' | 'gone'> | null = null
  const writable = (): Promise<'drain' | 'gone'> =>
    (waiting ??= Promise.race([
      once(proc.stdin!, 'drain').then(() => 'drain' as const, () => 'gone' as const),
      exited.then(() => 'gone' as const)
    ]).finally(() => {
      waiting = null
    }))
  const discard = async (): Promise<void> => {
    proc.kill('SIGKILL')
    await exited
    await rm(o.tmp, { force: true, maxRetries: 5, retryDelay: 100 })
  }

  return {
    k: o.k,
    input: o.input,
    encoder: o.encoder,
    expected: o.expected,
    get frames() {
      return frames
    },
    async write(data) {
      if (state !== 'open') throw new Error(state === 'aborted' ? 'segment discarded' : 'segment is closed')
      if (data.byteLength !== frameBytes) {
        throw new Error(`frame has ${data.byteLength} bytes, expected ${frameBytes} (${o.width}x${o.height} ${o.input === 'yuv' ? 'I420' : 'RGBA'})`)
      }
      if (frames >= o.expected) throw new Error(`segment ${o.k} already has its ${o.expected} frames`)
      if (proc.exitCode !== null) throw failure()
      frames++
      const stdin = proc.stdin!
      if (!stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))) {
        if ((await writable()) === 'gone') {
          // FFmpeg's own message is complete once it exited
          await exited
          if ((state as string) === 'aborted') throw new Error('segment discarded')
          if (state === 'open') throw failure()
        }
      }
    },
    async finish() {
      if (state !== 'open') throw new Error('segment is closed')
      state = 'finishing'
      try {
        if (frames !== o.expected) throw new Error(`segment ${o.k} got ${frames} frames, expected ${o.expected}`)
        proc.stdin!.end()
        const code = await exited
        if ((state as string) === 'aborted') throw new Error('segment discarded')
        if (code !== 0) throw failure()
        checkStream(await countFile(o.tmp, o.codec), o.k, o.expected)
        await rename(o.tmp, o.final)
        state = 'done'
      } catch (err) {
        if ((state as string) !== 'aborted') {
          state = 'aborted'
          await discard()
        }
        throw err
      }
    },
    async abort() {
      if (state === 'aborted' || state === 'done') return
      state = 'aborted'
      await discard()
    }
  }
}

/** Encoded input: the bytes are stored as they come; frames are counted from the stream. */
export function openChunkSegment(o: { k: number; codec: VideoCodec; expected: number; tmp: string; final: string }): Segment {
  const out = createWriteStream(o.tmp)
  let failed: Error | null = null
  out.on('error', (e) => (failed ??= e))
  const counter = new AnnexBFrameCounter(o.codec)
  let state: 'open' | 'finishing' | 'aborted' | 'done' = 'open'
  let waiting: Promise<unknown> | null = null
  const writable = (): Promise<unknown> =>
    (waiting ??= Promise.race([once(out, 'drain'), once(out, 'close')]).finally(() => {
      waiting = null
    }))
  const discard = async (): Promise<void> => {
    out.destroy()
    await finished(out).catch(() => {})
    await rm(o.tmp, { force: true, maxRetries: 5, retryDelay: 100 })
  }

  return {
    k: o.k,
    input: o.codec,
    encoder: 'webcodecs',
    expected: o.expected,
    get frames() {
      return counter.frames
    },
    async write(data) {
      if (state !== 'open') throw new Error(state === 'aborted' ? 'segment discarded' : 'segment is closed')
      if (failed) throw failed
      if (!data.byteLength) return
      counter.push(data)
      if (counter.frames > o.expected) throw new Error(`segment ${o.k} got more than its ${o.expected} frames`)
      if (!out.write(data)) {
        await writable().catch(() => {})
        if (failed) throw failed
        if ((state as string) === 'aborted') throw new Error('segment discarded')
      }
    },
    async finish() {
      if (state !== 'open') throw new Error('segment is closed')
      state = 'finishing'
      try {
        counter.end()
        out.end()
        await finished(out)
        if (failed) throw failed
        if ((state as string) === 'aborted') throw new Error('segment discarded')
        checkStream(counter, o.k, o.expected)
        await rename(o.tmp, o.final)
        state = 'done'
      } catch (err) {
        if ((state as string) !== 'aborted') {
          state = 'aborted'
          await discard()
        }
        throw err
      }
    },
    async abort() {
      if (state === 'aborted' || state === 'done') return
      state = 'aborted'
      await discard()
    }
  }
}
