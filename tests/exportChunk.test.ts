// Export with an encoded input (the renderer's WebCodecs output): Annex B chunks → timestamped
// MPEG-TS → MP4 muxed with the audio, frames in the right order also with B-frames.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExportOptions, ExportProgress } from '@shared/types'
import { AnnexBToTs, crc32Mpeg } from '../src/main/export/annexb'
import { startExport } from '../src/main/export/encoder'
import { videoStream } from '../src/main/media/videoInfo'
import { ff, FFMPEG_DIR } from './helpers/media'

const dir = mkdtempSync(join(tmpdir(), 'diashow-chunks-'))
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

const W = 320
const H = 180
const FPS = 30
const streams: Record<string, Buffer> = {}
/** Frame hashes of each stream decoded by FFmpeg directly (display order). */
const reference: Record<string, string[]> = {}

/** testsrc2 with a frame counter, so every frame differs, as an Annex B elementary stream. */
async function encode(name: string, args: string[], format: 'h264' | 'hevc', seconds = 2): Promise<void> {
  const file = join(dir, name)
  await ff.run(['-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=${seconds}`, '-pix_fmt', 'yuv420p', ...args, '-f', format, file])
  streams[name] = readFileSync(file)
  reference[name] = await frameHashes(file, format)
}

async function frameHashes(file: string, format?: string): Promise<string[]> {
  const out = await ff.capture([...(format ? ['-f', format] : []), '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'])
  return out
    .toString()
    .split('\n')
    .filter((l) => /^0,/.test(l))
    .map((l) => l.split(',').pop()!.trim())
}

const x265 = (extra: string): string[] => ['-c:v', 'libx265', '-preset', 'ultrafast', '-g', '30', '-x265-params', `log-level=error${extra}`]
let nvenc = false

beforeAll(async () => {
  // WebCodecs-like: keyframes regularly; with and without B-frames (Chromium's encoders use them)
  await encode('plain.h264', ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-bf', '0'], 'h264')
  await encode('bframes.h264', ['-c:v', 'libx264', '-preset', 'medium', '-g', '30', '-bf', '3', '-x264-params', 'b-pyramid=normal:slices=4'], 'h264')
  await encode('plain.hevc', [...x265(':bframes=0:slices=3')], 'hevc')
  await encode('bframes.hevc', [...x265(':bframes=4:b-pyramid=1:keyint=30:open-gop=0')], 'hevc')
  const hw = (await ff.encoders()).hardware
  nvenc = hw.h264 === 'h264_nvenc' && hw.hevc === 'hevc_nvenc'
  if (nvenc) {
    await encode('nvenc.h264', ['-c:v', 'h264_nvenc', '-bf', '2', '-g', '60'], 'h264')
    await encode('nvenc.hevc', ['-c:v', 'hevc_nvenc', '-bf', '2', '-g', '60'], 'hevc')
  }
  await ff.run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', join(dir, 'tone.wav')])
}, 180_000)

/** Splits a buffer into chunks of pseudo-random sizes 1..max (deterministic). */
function chunks(buf: Buffer, max: number, seed = 7): Uint8Array[] {
  const out: Uint8Array[] = []
  let s = seed
  for (let i = 0; i < buf.length; ) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const n = 1 + (s % max)
    out.push(new Uint8Array(buf.subarray(i, i + n)))
    i += n
  }
  return out
}

const codecOf = (name: string): 'h264' | 'hevc' => (name.endsWith('.hevc') ? 'hevc' : 'h264')
const names = (): string[] => Object.keys(streams).filter((n) => n.endsWith('.h264') || n.endsWith('.hevc'))

describe('AnnexBToTs', () => {
  it('computes the MPEG-2 CRC of PSI sections', () => {
    expect(crc32Mpeg(new TextEncoder().encode('123456789'))).toBe(0x0376e6e7)
  })

  it('counts frames and keeps every byte regardless of chunking', () => {
    for (const name of names()) {
      for (const max of [1, 7, 1000, 1e9]) {
        let bytes = 0
        const muxer = new AnnexBToTs(codecOf(name), FPS, (p) => (bytes += p.length))
        for (const c of chunks(streams[name], max)) muxer.push(c)
        muxer.end()
        expect(muxer.frames, `${name}, chunks <= ${max}`).toBe(60)
        expect(bytes % 188).toBe(0)
        expect(bytes).toBeGreaterThan(streams[name].length)
      }
    }
  })

  it('gives B-frame streams their display order (decoded frames match the source)', async () => {
    for (const name of names()) {
      const packets: Uint8Array[] = []
      const muxer = new AnnexBToTs(codecOf(name), FPS, (p) => packets.push(p))
      for (const c of chunks(streams[name], 5000)) muxer.push(c)
      muxer.end()
      const ts = join(dir, `${name}.ts`)
      writeFileSync(ts, Buffer.concat(packets))
      const mp4 = join(dir, `${name}.mp4`)
      await ff.run(['-f', 'mpegts', '-i', ts, '-c', 'copy', mp4])
      expect(await frameHashes(mp4), name).toEqual(reference[name])
      const vs = videoStream(await ff.probe(mp4))!
      expect(Number(vs.nb_frames), name).toBe(60)
      expect(parseFloat(vs.duration!), name).toBeCloseTo(2, 2)
    }
  })
})

function options(name: string, input: ExportOptions['input'], extra: Partial<ExportOptions> = {}): ExportOptions {
  return {
    outPath: join(dir, name),
    width: W,
    height: H,
    fps: FPS,
    codec: input === 'hevc' ? 'hevc' : 'h264',
    quality: 'standard',
    hardware: true,
    input,
    audio: { duration: 2, clips: [{ id: 'm', kind: 'music', src: join(dir, 'tone.wav'), start: 0, offset: 0, duration: 2, gain: [{ t: 0, g: 0.5 }] }] },
    ...extra
  }
}

describe('startExport with an encoded stream', () => {
  for (const [stream, input] of [
    ['plain.h264', 'h264'],
    ['bframes.h264', 'h264'],
    ['bframes.hevc', 'hevc']
  ] as const) {
    it(`muxes ${stream} chunks with the mixed audio (no re-encode)`, async () => {
      const progress: ExportProgress[] = []
      const opts = options(`${stream}.mp4`, input)
      const job = await startExport(opts, FFMPEG_DIR, join(dir, 'tmp'), (p) => progress.push(p))
      expect(job.encoder).toBe('copy')
      expect(job.input).toBe(input)
      expect(job.totalFrames).toBe(60)
      await expect(job.writeFrame(new Uint8Array(W * H * 4))).rejects.toThrow(/exportChunk/)
      for (const c of chunks(streams[stream], 4096)) await job.writeChunk(c)
      expect(await job.finish()).toBe(opts.outPath)

      const phases = progress.map((p) => p.phase)
      expect(phases[0]).toBe('audio')
      expect(phases.slice(-2)).toEqual(['finishing', 'done'])
      expect(progress.filter((p) => p.phase === 'video').pop()).toMatchObject({ frame: 60, totalFrames: 60 })

      const probe = await ff.probe(opts.outPath)
      const vs = videoStream(probe)!
      expect(vs.codec_name).toBe(input)
      if (input === 'hevc') expect(vs.codec_tag_string).toBe('hvc1')
      expect([vs.width, vs.height]).toEqual([W, H])
      expect(vs.r_frame_rate).toBe('30/1')
      expect(vs.avg_frame_rate).toBe('30/1')
      expect(Number(vs.nb_frames)).toBe(60)
      expect(parseFloat(vs.duration!)).toBeCloseTo(2, 2)
      expect([vs.color_primaries, vs.color_transfer, vs.color_space]).toEqual(['bt709', 'bt709', 'bt709'])
      expect(parseFloat(probe.format.duration!)).toBeCloseTo(2, 1)
      const audio = probe.streams.find((s) => s.codec_type === 'audio')
      expect(audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })
      expect(parseFloat(audio!.duration!)).toBeCloseTo(2, 1)
      // moov in front (+faststart)
      expect(readFileSync(opts.outPath).subarray(0, 64).toString('latin1')).toContain('moov')
      // every frame, in display order
      expect(await frameHashes(opts.outPath)).toEqual(reference[stream])
    })
  }

  it.runIf(process.platform === 'win32')('handles hardware encoder streams with B-frames (NVENC, like Chromium on NVIDIA)', async (ctx) => {
    if (!nvenc) ctx.skip()
    for (const [stream, input] of [
      ['nvenc.h264', 'h264'],
      ['nvenc.hevc', 'hevc']
    ] as const) {
      const job = await startExport(options(`${stream}.mp4`, input), FFMPEG_DIR, join(dir, 'tmp'), () => {})
      for (const c of chunks(streams[stream], 30000)) await job.writeChunk(c)
      const out = await job.finish()
      expect(await frameHashes(out), stream).toEqual(reference[stream])
    }
  })

  it('rejects chunks for RGBA exports, and cancels a chunk export cleanly', async () => {
    const rgba = await startExport(options('rgba.mp4', 'rgba', { audio: { duration: 0.1, clips: [] } }), FFMPEG_DIR, join(dir, 'tmp'), () => {})
    await expect(rgba.writeChunk(new Uint8Array(10))).rejects.toThrow(/exportFrame/)
    await rgba.cancel()

    const progress: ExportProgress[] = []
    const opts = options('cancelled.mp4', 'h264')
    const job = await startExport(opts, FFMPEG_DIR, join(dir, 'tmp'), (p) => progress.push(p))
    const parts = chunks(streams['plain.h264'], 2048)
    for (const c of parts.slice(0, 5)) await job.writeChunk(c)
    await job.cancel()
    expect(progress[progress.length - 1].phase).toBe('cancelled')
    expect(existsSync(opts.outPath)).toBe(false)
    await expect(job.writeChunk(parts[5])).rejects.toThrow(/cancelled/)
  })

  it('reports an error when the data is not H.264', async () => {
    const progress: ExportProgress[] = []
    const job = await startExport(options('garbage.mp4', 'h264'), FFMPEG_DIR, join(dir, 'tmp'), (p) => progress.push(p))
    await job.writeChunk(new Uint8Array(4096).fill(7)).catch(() => {})
    await expect(job.finish()).rejects.toThrow()
    expect(progress[progress.length - 1].phase).toBe('error')
  })
})
