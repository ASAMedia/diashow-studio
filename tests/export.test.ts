// Encoder integration: synthetic RGBA frames + an audio plan → MP4, verified with ffprobe.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import type { ExportOptions, ExportProgress } from '@shared/types'
import { startExport } from '../src/main/export/encoder'
import { videoStream } from '../src/main/media/videoInfo'
import { ff, FFMPEG_DIR } from './helpers/media'

const dir = mkdtempSync(join(tmpdir(), 'diashow-export-'))
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

const W = 320
const H = 180
const FPS = 30

/** Solid colour frame whose first rows (= bottom of the picture in GL order) are white. */
function frame(i: number): Uint8Array {
  const buf = new Uint8Array(W * H * 4)
  const hue = [
    [220, 30, 30],
    [30, 200, 60],
    [40, 60, 220]
  ][Math.floor(i / 20) % 3]
  for (let p = 0; p < W * H; p++) {
    const white = p < W * 20
    buf[p * 4] = white ? 255 : hue[0]
    buf[p * 4 + 1] = white ? 255 : hue[1]
    buf[p * 4 + 2] = white ? 255 : hue[2]
    buf[p * 4 + 3] = 255
  }
  return buf
}

async function tone(): Promise<string> {
  const src = join(dir, 'tone.wav')
  if (!existsSync(src)) await ff.run(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=4', src])
  return src
}

async function options(name: string, extra: Partial<ExportOptions> = {}): Promise<ExportOptions> {
  return {
    outPath: join(dir, name),
    width: W,
    height: H,
    fps: FPS,
    codec: 'h264',
    quality: 'standard',
    hardware: true,
    audio: {
      duration: 2,
      clips: [{ id: 'a', kind: 'music', src: await tone(), start: 0, offset: 0.5, duration: 2, gain: [{ t: 0, g: 0 }, { t: 0.5, g: 1 }] }]
    },
    ...extra
  }
}

describe('startExport', () => {
  for (const variant of [
    { name: 'h264-hw.mp4', codec: 'h264' as const, hardware: true },
    { name: 'hevc-sw.mp4', codec: 'hevc' as const, hardware: false }
  ]) {
    it(`encodes 60 frames + audio (${variant.codec}, hardware ${variant.hardware})`, async () => {
      const progress: ExportProgress[] = []
      const opts = await options(variant.name, { codec: variant.codec, hardware: variant.hardware })
      const job = await startExport(opts, FFMPEG_DIR, join(dir, 'tmp'), (p) => progress.push(p))
      expect(job.totalFrames).toBe(60)
      const hw = (await ff.encoders()).hardware.h264
      expect(job.encoder).toBe(variant.hardware ? (hw ?? 'libx264') : 'libx265')
      for (let i = 0; i < job.totalFrames; i++) await job.writeFrame(frame(i))
      const out = await job.finish()
      expect(out).toBe(opts.outPath)

      const phases = progress.map((p) => p.phase)
      expect(phases[0]).toBe('audio')
      expect(phases).toContain('video')
      expect(phases[phases.length - 1]).toBe('done')
      expect(progress.filter((p) => p.phase === 'video').pop()).toMatchObject({ frame: 60, totalFrames: 60 })

      const probe = await ff.probe(out)
      const vs = videoStream(probe)!
      expect(vs.codec_name).toBe(variant.codec)
      expect([vs.width, vs.height, vs.pix_fmt]).toEqual([W, H, 'yuv420p'])
      expect(vs.color_primaries).toBe('bt709')
      expect(parseFloat(probe.format.duration!)).toBeCloseTo(2, 1)
      const audio = probe.streams.find((s) => s.codec_type === 'audio')
      expect(audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })

      // rows arrive bottom-to-top: the white rows must end up at the bottom of the picture
      const png = await ff.capture(['-i', out, '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', '-'])
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
      const px = (y: number): number[] => [...data.subarray(y * info.width * info.channels + 40 * info.channels, y * info.width * info.channels + 40 * info.channels + 3)]
      expect(px(H - 5).every((v) => v > 230)).toBe(true)
      expect(px(5)[0]).toBeGreaterThan(180)
      expect(px(5)[1]).toBeLessThan(80)
      // temp audio files are gone
      expect(readdirSync(join(dir, 'tmp'))).toEqual([])
    })
  }

  it('rejects wrong frame sizes, allows only one export at a time and cancels cleanly', async () => {
    const progress: ExportProgress[] = []
    const opts = await options('cancel.mp4', { hardware: false })
    const job = await startExport(opts, FFMPEG_DIR, join(dir, 'tmp'), (p) => progress.push(p))
    await expect(startExport(await options('other.mp4'), FFMPEG_DIR, join(dir, 'tmp'), () => {})).rejects.toThrow(/already running/)
    await expect(job.writeFrame(new Uint8Array(10))).rejects.toThrow(/expected/)
    for (let i = 0; i < 10; i++) await job.writeFrame(frame(i))
    await job.cancel()
    expect(progress[progress.length - 1].phase).toBe('cancelled')
    expect(existsSync(opts.outPath)).toBe(false)
    await expect(job.writeFrame(frame(0))).rejects.toThrow()
    // a new export can start afterwards
    const next = await startExport(await options('after.mp4', { hardware: false, audio: { duration: 0.2, clips: [] } }), FFMPEG_DIR, join(dir, 'tmp'), () => {})
    for (let i = 0; i < next.totalFrames; i++) await next.writeFrame(frame(i))
    expect(existsSync(await next.finish())).toBe(true)
  })
})
