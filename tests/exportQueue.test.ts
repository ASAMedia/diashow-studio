// Export queue: jobs rendered in segments by a (here simulated) worker, joined with the mixed audio,
// resumed after a crash, cancelled; driven without Electron.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExportJobInfo, ExportTask, NewExportJob, SegmentInput } from '@shared/exportQueue'
import { DEFAULT_SETTINGS, type Project } from '@shared/types'
import { AnnexBFrameCounter, AnnexBToTs } from '../src/main/export/annexb'
import { openExportQueue, partialOutputPath, throttle, type ExportQueue } from '../src/main/export/queue'
import { videoStream } from '../src/main/media/videoInfo'
import { ff, FFMPEG_DIR } from './helpers/media'

const dir = mkdtempSync(join(tmpdir(), 'diashow-queue-'))
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))

const W = 320
const H = 180
const FPS = 30
/** Short segments for the tests: 15 frames. */
const SEG = 0.5
/** 66 frames: segments of 15, 15, 15, 15 and 6. */
const DURATION = 2.2
const TOTAL = 66

const project: Project = { version: 1, id: 'p1', name: 'Test', createdAt: 0, updatedAt: 0, entries: [], media: [], music: [], settings: DEFAULT_SETTINGS }
let tone = ''

beforeAll(async () => {
  tone = join(dir, 'tone.wav')
  await ff.run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', tone])
})

function newJob(name: string, extra: Partial<NewExportJob['request']> = {}): NewExportJob {
  return {
    name,
    project,
    request: { outPath: join(dir, `${name}.mp4`), width: W, height: H, fps: FPS, codec: 'h264', quality: 'standard', hardware: false, locale: 'de-DE', ...extra },
    audio: { duration: DURATION, clips: [{ id: 'm', kind: 'music', src: tone, start: 0, offset: 0, duration: DURATION, gain: [{ t: 0, g: 0.5 }] }] }
  }
}

const open = (name: string, onChange?: () => void): Promise<ExportQueue> =>
  openExportQueue({ dir: join(dir, name), ffmpegDir: FFMPEG_DIR, segmentSeconds: SEG, onChange })

/** Picture with the frame index as 8 vertical bars (bright = bit set). */
const bit = (i: number, x: number): boolean => ((i >> Math.floor(x / 40)) & 1) === 1

/** I420, top row first, like the GPU packs it. */
function yuvFrame(i: number): Uint8Array {
  const buf = new Uint8Array((W * H * 3) / 2)
  for (let x = 0; x < W; x++) {
    const v = bit(i, x) ? 200 : 40
    for (let y = 0; y < H; y++) buf[y * W + x] = v
  }
  buf.fill(128, W * H)
  return buf
}

/** RGBA, rows bottom-up (WebGL order): the bars fill only the lower half of the picture. */
function rgbaFrame(i: number): Uint8Array {
  const buf = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = y < H / 2 && bit(i, x) ? 230 : 20
      buf.fill(v, (y * W + x) * 4, (y * W + x) * 4 + 3)
      buf[(y * W + x) * 4 + 3] = 255
    }
  }
  return buf
}

/** Decoded frames of a video as their bar indices, read at row y. */
async function decodedIndices(file: string, y = H / 2): Promise<number[]> {
  const raw = await ff.capture(['-i', file, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
  const out: number[] = []
  for (let f = 0; f < raw.length / (W * H); f++) {
    let v = 0
    for (let b = 0; b < 8; b++) if (raw[f * W * H + y * W + b * 40 + 20] > 120) v |= 1 << b
    out.push(v)
  }
  return out
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

/** What the worker page does: every remaining segment, frames sent without waiting for each. */
async function render(q: ExportQueue, task: ExportTask, input: SegmentInput, until = Infinity): Promise<void> {
  for (const k of task.segments) {
    if (k >= until) break
    await q.segmentStart(task.jobId, k, input)
    const from = k * task.segmentFrames
    const to = Math.min(task.totalFrames, from + task.segmentFrames)
    const sent: Promise<void>[] = []
    for (let i = from; i < to; i++) sent.push(q.writeFrame(input === 'rgba' ? rgbaFrame(i) : yuvFrame(i)))
    await Promise.all(sent)
    await q.segmentFinish(task.jobId, k)
  }
}

async function expectExport(out: string, codec: 'h264' | 'hevc'): Promise<void> {
  const probe = await ff.probe(out)
  const vs = videoStream(probe)!
  expect(vs.codec_name).toBe(codec)
  if (codec === 'hevc') expect(vs.codec_tag_string).toBe('hvc1')
  expect([vs.width, vs.height, vs.pix_fmt]).toEqual([W, H, 'yuv420p'])
  expect(Number(vs.nb_frames)).toBe(TOTAL)
  expect(vs.r_frame_rate).toBe('30/1')
  expect(parseFloat(vs.duration!)).toBeCloseTo(DURATION, 2)
  expect([vs.color_primaries, vs.color_transfer, vs.color_space, vs.color_range]).toEqual(['bt709', 'bt709', 'bt709', 'tv'])
  const audio = probe.streams.find((s) => s.codec_type === 'audio')
  expect(audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })
  expect(parseFloat(audio!.duration!)).toBeCloseTo(DURATION, 1)
  expect(parseFloat(probe.format.duration!)).toBeCloseTo(DURATION, 1)
  // moov in front (+faststart)
  expect(readFileSync(out).subarray(0, 64).toString('latin1')).toContain('moov')
}

async function waitFor(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('export queue', () => {
  for (const v of [
    { name: 'yuv-h264', codec: 'h264' as const, hardware: false, input: 'yuv' as const },
    { name: 'yuv-hevc', codec: 'hevc' as const, hardware: false, input: 'yuv' as const },
    { name: 'yuv-h264-hw', codec: 'h264' as const, hardware: true, input: 'yuv' as const },
    { name: 'rgba-h264', codec: 'h264' as const, hardware: false, input: 'rgba' as const }
  ]) {
    it(`renders ${v.input} frames in segments and joins them with the audio (${v.name})`, async () => {
      const seen: ExportJobInfo[] = []
      let q: ExportQueue | null = null
      q = await open(`q-${v.name}`, () => {
        if (q) seen.push(...q.list())
      })
      const info = await q.add(newJob(v.name, { codec: v.codec, hardware: v.hardware }))
      expect(info).toMatchObject({ name: v.name, state: 'queued', frame: 0, totalFrames: TOTAL, width: W, height: H, codec: v.codec })
      expect(q.hasWork()).toBe(true)
      const task = (await q.next())!
      expect(task).toMatchObject({ jobId: info.id, totalFrames: TOTAL, segmentFrames: 15, segments: [0, 1, 2, 3, 4] })
      expect(task.input).toBeUndefined()
      expect(task.request.outPath).toBe(join(dir, `${v.name}.mp4`))
      expect(q.list()[0]).toMatchObject({ state: 'running', phase: 'prepare' })
      expect(q.hasWork()).toBe(false)
      await render(q, task, v.input)
      // waits for the joining, then nothing is left
      expect(await q.next()).toBeNull()
      const [done] = q.list()
      expect(done).toMatchObject({ state: 'done', frame: TOTAL, totalFrames: TOTAL })
      expect(done.finishedAt).toBeGreaterThanOrEqual(done.startedAt!)
      expect(done.error).toBeUndefined()
      const phases = new Set(seen.map((j) => j.phase).filter(Boolean))
      expect([...phases]).toEqual(['prepare', 'video', 'finishing'])
      expect(seen.some((j) => j.phase === 'video' && j.frame > 0 && j.frame < TOTAL)).toBe(true)

      await expectExport(done.outPath, v.codec)
      // every frame once, in order (B-frames and segment joins included)
      expect(await decodedIndices(done.outPath, v.input === 'rgba' ? (H * 3) / 4 : H / 2)).toEqual(range(TOTAL))
      if (v.input === 'rgba') {
        // rows came bottom-up: the bars are in the lower half, the upper half stays dark
        expect(new Set(await decodedIndices(done.outPath, H / 4))).toEqual(new Set([0]))
      }
      // parts and audio are gone, job.json stays with state done
      const jobDir = join(q.dir, done.id)
      expect(readdirSync(jobDir)).toEqual(['job.json'])
      expect(JSON.parse(readFileSync(join(jobDir, 'job.json'), 'utf8'))).toMatchObject({ state: 'done', segments: [0, 1, 2, 3, 4], input: v.input })
      expect(existsSync(partialOutputPath(done.outPath, done.id))).toBe(false)
      await q.close()
    })
  }

  it('continues after a crash from the last finished segment, reusing the mixed audio', async () => {
    const q1 = await open('q-resume')
    const { id, outPath } = await q1.add(newJob('resume'))
    // an older export at the same place gets replaced
    writeFileSync(outPath, 'old export')
    const task = (await q1.next())!
    await render(q1, task, 'yuv', 2)
    expect(q1.list()[0]).toMatchObject({ state: 'running', phase: 'video', frame: 30 })
    await q1.segmentStart(id, 2, 'yuv')
    for (let i = 30; i < 35; i++) await q1.writeFrame(yuvFrame(i))
    expect(q1.list()[0].frame).toBe(35)
    const jobDir = join(q1.dir, id)
    const mix = join(jobDir, 'mix.wav')
    await waitFor(() => existsSync(mix))
    const mixTime = statSync(mix).mtimeMs
    // The app dies here: its segment encoder goes away, leaving a temp file. A part renamed just
    // before job.json was saved and a partial output are left over as well.
    await q1.discardSegment()
    writeFileSync(join(jobDir, 'seg-00002.h264.tmp'), 'half')
    writeFileSync(join(jobDir, 'seg-00003.h264'), 'not in job.json')
    writeFileSync(partialOutputPath(outPath, id), 'partial')

    const q2 = await open('q-resume')
    expect(q2.list()).toHaveLength(1)
    expect(q2.list()[0]).toMatchObject({ id, state: 'paused', frame: 30, totalFrames: TOTAL })
    expect(q2.list()[0].phase).toBeUndefined()
    expect(readdirSync(jobDir).sort()).toEqual(['job.json', 'mix.wav', 'seg-00000.h264', 'seg-00001.h264'])
    expect(existsSync(partialOutputPath(outPath, id))).toBe(false)
    // paused jobs wait for "Continue"
    expect(q2.hasWork()).toBe(false)
    expect(await q2.next()).toBeNull()
    await q2.resume(id)
    expect(q2.list()[0].state).toBe('queued')
    const resumed = (await q2.next())!
    expect(resumed).toMatchObject({ jobId: id, segments: [2, 3, 4], input: 'yuv', segmentFrames: 15 })
    // the parts must match the ones already done
    await expect(q2.segmentStart(id, 2, 'rgba')).rejects.toThrow(/'yuv'/)
    await expect(q2.segmentStart(id, 1, 'yuv')).rejects.toThrow(/done already/)
    await expect(q2.segmentStart(id, 5, 'yuv')).rejects.toThrow(/invalid segment/)
    await render(q2, resumed, 'yuv')
    expect(await q2.next()).toBeNull()
    expect(q2.list()[0]).toMatchObject({ state: 'done', frame: TOTAL })
    // the audio was mixed once (still there right before the joining deleted it: same file)
    expect(mixTime).toBeGreaterThan(0)
    await expectExport(outPath, 'h264')
    expect(await decodedIndices(outPath)).toEqual(range(TOTAL))
    expect(readdirSync(jobDir)).toEqual(['job.json'])
    await q2.close()
  })

  it('keeps the old output and the parts when joining fails; Continue joins again', async () => {
    const q = await open('q-join-fail')
    const { id, outPath } = await q.add(newJob('join-fail'))
    writeFileSync(outPath, 'old export')
    const task = (await q.next())!
    const mix = join(q.dir, id, 'mix.wav')
    await waitFor(() => existsSync(mix))
    await render(q, task, 'yuv', 4)
    // the audio got damaged: FFmpeg fails while joining
    writeFileSync(mix, 'not a wav file')
    await render(q, { ...task, segments: [4] }, 'yuv')
    expect(await q.next()).toBeNull()
    const [failed] = q.list()
    expect(failed).toMatchObject({ state: 'error', frame: TOTAL })
    expect(failed.error).toMatch(/^Joining the parts failed/)
    expect(readFileSync(outPath, 'utf8')).toBe('old export')
    expect(existsSync(partialOutputPath(outPath, id))).toBe(false)
    expect(readdirSync(join(q.dir, id)).filter((n) => n.startsWith('seg-'))).toHaveLength(5)
    // without the broken audio it is mixed again; no segment is rendered again
    rmSync(mix)
    await q.resume(id)
    expect(q.hasWork()).toBe(true)
    expect(await q.next()).toBeNull()
    expect(q.list()[0]).toMatchObject({ state: 'done', frame: TOTAL })
    await expectExport(outPath, 'h264')
    expect(await decodedIndices(outPath)).toEqual(range(TOTAL))
    await q.close()
  })

  it('reuses mix.wav on resume instead of mixing again', async () => {
    const q1 = await open('q-mix')
    const { id } = await q1.add(newJob('mix'))
    await q1.next()
    const mix = join(q1.dir, id, 'mix.wav')
    await waitFor(() => existsSync(mix))
    const before = statSync(mix).mtimeMs
    await q1.close()
    expect(q1.list()[0].state).toBe('paused')
    const q2 = await open('q-mix')
    await q2.resume(id)
    await q2.next()
    await new Promise((r) => setTimeout(r, 500))
    expect(statSync(mix).mtimeMs).toBe(before)
    expect(existsSync(`${mix}.tmp`)).toBe(false)
    await q2.close()
  })

  it('marks running jobs paused on restart; queued jobs stay queued', async () => {
    const q1 = await open('q-restart')
    const a = await q1.add(newJob('restart-a'))
    const b = await q1.add(newJob('restart-b'))
    expect(b.createdAt).toBeGreaterThan(a.createdAt)
    const task = (await q1.next())!
    expect(task.jobId).toBe(a.id)
    const started = q1.list()[0].startedAt
    // (let the audio mix finish, so the dropped first queue writes nothing any more)
    await waitFor(() => existsSync(join(q1.dir, a.id, 'mix.wav')))
    // no close(): the process just ends
    const q2 = await open('q-restart')
    const [ja, jb] = q2.list()
    expect(ja).toMatchObject({ id: a.id, state: 'paused', startedAt: started })
    expect(jb).toMatchObject({ id: b.id, state: 'queued' })
    expect(q2.busy).toBe(false)
    // creation order: after "Continue" the older job runs first again
    await q2.resume(a.id)
    expect((await q2.next())!.jobId).toBe(a.id)
    expect(q2.busy).toBe(true)
    await q2.close()
    expect(q2.list()[0].state).toBe('paused')
    expect(JSON.parse(readFileSync(join(q2.dir, a.id, 'job.json'), 'utf8')).state).toBe('paused')
  })

  it('cancels a running job and deletes its parts and partial files', async () => {
    const q = await open('q-cancel')
    const { id, outPath } = await q.add(newJob('cancel'))
    const task = (await q.next())!
    await render(q, task, 'yuv', 1)
    await q.segmentStart(id, 1, 'yuv')
    for (let i = 15; i < 18; i++) await q.writeFrame(yuvFrame(i))
    const jobDir = join(q.dir, id)
    expect(readdirSync(jobDir)).toContain('seg-00001.h264.tmp')
    await q.cancel(id)
    expect(q.list()[0]).toMatchObject({ id, state: 'cancelled' })
    expect(q.busy).toBe(false)
    // the worker learns it from its next call
    await expect(q.writeFrame(yuvFrame(18))).rejects.toThrow(/cancelled/)
    await expect(q.segmentFinish(id, 1)).rejects.toThrow(/cancelled/)
    await q.fail(id, 'stopped')
    expect(q.list()[0].state).toBe('cancelled')
    expect(readdirSync(jobDir)).toEqual(['job.json'])
    expect(existsSync(outPath)).toBe(false)
    expect(existsSync(partialOutputPath(outPath, id))).toBe(false)
    expect(await q.next()).toBeNull()
    await expect(q.resume(id)).rejects.toThrow(/cannot continue/)
    // cancelling again or a finished job is a no-op; removing deletes the folder
    await q.cancel(id)
    await q.remove(id)
    expect(existsSync(jobDir)).toBe(false)
    expect(q.list()).toEqual([])

    // a queued job: cancelled without ever running
    const other = await q.add(newJob('cancel-queued'))
    await q.cancel(other.id)
    expect(q.list()[0].state).toBe('cancelled')
    expect(await q.next()).toBeNull()
    // a finished job leaves the queue while its show is in the trash, and comes back with it (once)
    await q.forget(other.id)
    expect(q.list()).toEqual([])
    await q.adopt(other.id)
    await q.adopt(other.id)
    expect(q.list()).toMatchObject([{ id: other.id, name: 'cancel-queued', state: 'cancelled' }])
    await q.close()
  })

  it('takes encoded segments (libx264 with B-frames, one encoder per segment) and checks them', async () => {
    // like a fresh WebCodecs encoder per segment: each part starts with an IDR picture
    const parts: Buffer[] = []
    const reference: string[] = []
    for (let k = 0; k < 5; k++) {
      const from = k * 15
      const file = join(dir, `part${k}.h264`)
      await ff.run([
        '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=3`,
        '-vf', `trim=start_frame=${from}:end_frame=${Math.min(TOTAL, from + 15)},setpts=PTS-STARTPTS`,
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-g', '30', '-bf', '3', '-x264-params', 'b-pyramid=normal', '-f', 'h264', file
      ])
      parts.push(readFileSync(file))
      reference.push(...(await frameHashes(file, 'h264')))
    }
    expect(reference).toHaveLength(TOTAL)

    const q = await open('q-chunks')
    const { id, outPath } = await q.add(newJob('chunks'))
    const task = (await q.next())!
    await expect(q.segmentStart(id, 0, 'hevc')).rejects.toThrow(/h264/)
    for (const k of task.segments) {
      await q.segmentStart(id, k, 'h264')
      if (k === 0) await expect(q.writeFrame(yuvFrame(0))).rejects.toThrow(/exportChunk/)
      if (k === 1) {
        // a part with the wrong number of frames is refused; the worker can do it again
        for (const c of chunks(parts[4], 3000)) await q.writeChunk(c)
        await expect(q.segmentFinish(id, 1)).rejects.toThrow(/6 frames, expected 15/)
        await q.segmentStart(id, 1, 'h264')
      }
      for (const c of chunks(parts[k], 4096)) await q.writeChunk(c)
      await q.segmentFinish(id, k)
    }
    expect(await q.next()).toBeNull()
    expect(q.list()[0]).toMatchObject({ state: 'done', frame: TOTAL })
    await expectExport(outPath, 'h264')
    expect(await frameHashes(outPath)).toEqual(reference)
    await q.close()
  })

  it('counts frames like AnnexBToTs and finds the first picture type', async () => {
    const file = join(dir, 'part1.h264')
    const stream = readFileSync(file)
    for (const max of [1, 5, 4096, 1e9]) {
      const counter = new AnnexBFrameCounter('h264')
      for (const c of chunks(stream, max)) counter.push(c)
      counter.end()
      const muxer = new AnnexBToTs('h264', FPS, () => {})
      muxer.push(stream)
      muxer.end()
      expect(counter.frames, `chunks <= ${max}`).toBe(muxer.frames)
      expect(counter.frames).toBe(15)
      expect(counter.startsWithIdr).toBe(true)
    }
    // from the first non-IDR slice on: not a valid segment start
    let at = -1
    for (let i = 0; i + 4 < stream.length; i++) {
      if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1 && (stream[i + 3] & 0x1f) === 1) {
        at = i
        break
      }
    }
    const tail = new AnnexBFrameCounter('h264')
    tail.push(stream.subarray(at))
    tail.end()
    expect(tail.firstType).toBe(1)
    expect(tail.startsWithIdr).toBe(false)
  })

  it('hands a lost job out once more, then fails it; the worker can fail a job itself', async () => {
    const q = await open('q-lost')
    const { id } = await q.add(newJob('lost'))
    await q.next()
    await q.segmentStart(id, 0, 'yuv')
    await q.writeFrame(yuvFrame(0))
    expect(q.workerActivity()).toMatchObject({ jobId: id, phase: 'video' })
    expect(q.workerActivity()!.idleMs).toBeLessThan(5000)
    await q.workerLost('render process crashed')
    expect(q.list()[0]).toMatchObject({ state: 'running', phase: 'prepare' })
    expect(q.segmentActive).toBe(false)
    expect(q.workerActivity()).toBeNull()
    expect(q.hasWork()).toBe(true)
    await expect(q.writeFrame(yuvFrame(1))).rejects.toThrow()
    // the dead worker's calls are refused until the job is handed out again
    await expect(q.segmentStart(id, 0, 'yuv')).rejects.toThrow(/not handed out/)
    const again = (await q.next())!
    expect(again).toMatchObject({ jobId: id, segments: [0, 1, 2, 3, 4] })
    await q.workerLost('not responding')
    expect(q.list()[0]).toMatchObject({ state: 'error' })
    expect(q.list()[0].error).toMatch(/twice.*not responding/)
    expect(q.hasWork()).toBe(false)
    expect(q.busy).toBe(false)

    await q.resume(id)
    expect(q.list()[0]).toMatchObject({ state: 'queued' })
    expect(q.list()[0].error).toBeUndefined()
    await q.next()
    expect(q.prepareSignal()?.aborted).toBe(false)
    const signal = q.prepareSignal()!
    await q.fail(id, 'Video "a.mov" could not be read')
    expect(signal.aborted).toBe(true)
    expect(q.list()[0]).toMatchObject({ state: 'error', error: 'Video "a.mov" could not be read' })
    expect(await q.next()).toBeNull()
    await q.close()
  })

  it('validates what the renderer sends', async () => {
    const q = await open('q-validate')
    const base = newJob('valid')
    const bad = async (patch: Record<string, unknown>, request: Record<string, unknown> = {}): Promise<void> => {
      await q.add({ ...base, ...patch, request: { ...base.request, ...request } })
    }
    await expect(bad({}, { outPath: 'relative.mp4' })).rejects.toThrow(/absolute/)
    await expect(bad({}, { outPath: join(dir, 'a.txt') })).rejects.toThrow(/\.mp4/)
    await expect(bad({}, { outPath: join(dir, 'missing-folder', 'a.mp4') })).rejects.toThrow(/does not exist/)
    await expect(bad({}, { width: 0 })).rejects.toThrow(/width/)
    await expect(bad({}, { height: 10.5 })).rejects.toThrow(/height/)
    await expect(bad({}, { fps: Number.NaN })).rejects.toThrow(/frame rate/)
    await expect(bad({}, { codec: 'vp9' })).rejects.toThrow(/codec/)
    await expect(bad({}, { quality: 'ultra' })).rejects.toThrow(/quality/)
    await expect(bad({ name: '  ' })).rejects.toThrow(/name/)
    await expect(bad({ project: null })).rejects.toThrow(/project/)
    await expect(bad({ audio: { duration: -1, clips: [] } })).rejects.toThrow(/duration/)
    await expect(bad({ audio: { duration: 2, clips: [{ ...base.audio.clips[0], src: 'http://example.com/a.mp3' }] } })).rejects.toThrow(/source/)
    await expect(bad({ audio: { duration: 2, clips: [{ ...base.audio.clips[0], gain: [{ t: 0, g: Infinity }] }] } })).rejects.toThrow(/gain/)
    expect(q.list()).toEqual([])

    const ok = await q.add(base)
    // the same output twice in the queue
    await expect(q.add(newJob('valid'))).rejects.toThrow(/already writes to this file/)
    for (const id of ['../x', 'nope', 42, null]) {
      await expect(q.cancel(id)).rejects.toThrow(/invalid export job id/)
      await expect(q.segmentStart(id, 0, 'yuv')).rejects.toThrow(/invalid export job id/)
    }
    await expect(q.remove('aaaaaa-00000000')).rejects.toThrow(/not found/)
    await q.next()
    await expect(q.segmentStart(ok.id, 0, 'png')).rejects.toThrow(/unknown segment input/)
    await expect(q.segmentStart(ok.id, -1, 'yuv')).rejects.toThrow(/invalid segment/)
    await expect(q.segmentStart(ok.id, 0.5, 'yuv')).rejects.toThrow(/invalid segment/)
    await expect(q.remove(ok.id)).rejects.toThrow(/running/)
    await q.segmentStart(ok.id, 0, 'yuv')
    await expect(q.writeFrame(new Uint8Array(10))).rejects.toThrow(/expected/)
    await expect(q.writeFrame('frame')).rejects.toThrow(/Uint8Array/)
    await expect(q.writeChunk(new Uint8Array(10))).rejects.toThrow(/exportFrame/)
    await expect(q.segmentFinish(ok.id, 0)).rejects.toThrow(/0 frames, expected 15/)
    await q.close()
  })

  it('throttles updates to the given rate without losing the last one', async () => {
    let calls = 0
    const t = throttle(() => calls++, 100)
    for (let i = 0; i < 50; i++) t()
    expect(calls).toBe(1)
    await new Promise((r) => setTimeout(r, 150))
    expect(calls).toBe(2)
    t.cancel()
  })
})

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

async function frameHashes(file: string, format?: string): Promise<string[]> {
  const out = await ff.capture([...(format ? ['-f', format] : []), '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'])
  return out
    .toString()
    .split('\n')
    .filter((l) => /^0,/.test(l))
    .map((l) => l.split(',').pop()!.trim())
}
