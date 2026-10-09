// Beat tracking on synthetic click tracks (with a sustained chord and noise underneath).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { MusicTrack } from '@shared/types'
import { BEAT_SR, detectBeats, detectBeatsInFile, type BeatResult } from '../src/main/media/beats'
import { createMediaService } from '../src/main/media/service'
import { ff, FFMPEG_DIR } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-beats-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 31 - 1
  }
}

/** Click track: decaying noise bursts every beat, accented every 4th, over a quiet chord + noise. */
function clickTrack(bpm: number, offset: number, seconds: number, sr = BEAT_SR): { samples: Float32Array; clicks: number[] } {
  const rand = rng(bpm * 1000 + Math.round(offset * 1000))
  const out = new Float32Array(Math.round(seconds * sr))
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    out[i] = 0.06 * Math.sin(2 * Math.PI * 220 * t) + 0.04 * Math.sin(2 * Math.PI * 277.2 * t) + 0.03 * Math.sin(2 * Math.PI * 329.6 * t) + 0.01 * rand()
  }
  const clicks: number[] = []
  for (let n = 0, t = offset; t < seconds - 0.05; n++, t = offset + (n * 60) / bpm) {
    clicks.push(t)
    const start = Math.round(t * sr)
    const gain = n % 4 === 0 ? 0.7 : 0.45
    for (let j = 0; j < 0.04 * sr && start + j < out.length; j++) {
      out[start + j] += gain * Math.exp(-j / (0.006 * sr)) * (0.6 * rand() + 0.4 * Math.sin((2 * Math.PI * 1500 * j) / sr))
    }
  }
  return { samples: out, clicks }
}

function wav(samples: Float32Array, sr: number): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sr, 24)
  h.writeUInt32LE(sr * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

function expectOnBeat(result: BeatResult | null, bpm: number, clicks: number[]): void {
  expect(result).not.toBeNull()
  const r = result!
  expect(Math.abs(r.bpm - bpm) / bpm).toBeLessThan(0.02)
  const errors = r.beats.map((b) => Math.min(...clicks.map((c) => Math.abs(c - b))))
  expect(Math.max(...errors) * 1000).toBeLessThan(40)
  // All but the outermost clicks are found
  const found = clicks.filter((c) => r.beats.some((b) => Math.abs(b - c) < 0.04))
  expect(found.length).toBeGreaterThanOrEqual(clicks.length - 2)
  for (let i = 1; i < r.beats.length; i++) expect(r.beats[i]).toBeGreaterThan(r.beats[i - 1])
}

describe('beat tracking', () => {
  it('96 BPM with an offset', () => {
    const { samples, clicks } = clickTrack(96, 0.37, 30)
    expectOnBeat(detectBeats(samples), 96, clicks)
  })

  it('128 BPM with an offset', () => {
    const { samples, clicks } = clickTrack(128, 1.13, 30)
    expectOnBeat(detectBeats(samples), 128, clicks)
  })

  it('75 and 170 BPM stay in their octave', () => {
    for (const bpm of [75, 170]) {
      const { samples, clicks } = clickTrack(bpm, 0.2, 30)
      expectOnBeat(detectBeats(samples), bpm, clicks)
    }
  })

  it('no pulse in silence or a steady tone', () => {
    expect(detectBeats(new Float32Array(BEAT_SR * 10))).toBeNull()
    expect(detectBeats(new Float32Array(BEAT_SR * 2).fill(0.1))).toBeNull()
  })

  it('decodes a file through FFmpeg (44.1 kHz WAV) with the same timing', async () => {
    const sr = 44100
    const { samples, clicks } = clickTrack(110, 0.81, 25, sr)
    const path = join(tmp, 'clicks.wav')
    writeFileSync(path, wav(samples, sr))
    expectOnBeat(await detectBeatsInFile(ff, path), 110, clicks)
  })
})

describe('music service', () => {
  it('adds beats + bpm to imported tracks via music:update, caches them, and fills them in on restore', async () => {
    const dir = join(tmp, 'music')
    mkdirSync(dir)
    const { samples } = clickTrack(100, 0.5, 20)
    writeFileSync(join(dir, 'clicks.wav'), wav(samples, BEAT_SR))
    const cacheDir = join(tmp, 'cache')
    const seen: MusicTrack[] = []
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir, onMusicUpdate: (t) => seen.push(t) })
    let track: MusicTrack
    try {
      const [imported] = await svc.importMusic([dir])
      // The track is usable right away; beats arrive later
      expect(imported).toMatchObject({ status: 'ready', title: 'clicks' })
      expect(imported.beats).toBeUndefined()
      expect(seen).toHaveLength(0)
      await svc.idle()
      track = svc.getTrack(imported.id)!
      expect(Math.abs(track.bpm! - 100)).toBeLessThan(2)
      expect(track.beats!.length).toBeGreaterThan(25)
      expect(seen[seen.length - 1]).toMatchObject({ id: imported.id, status: 'ready', bpm: track.bpm })
      const cached = JSON.parse(readFileSync(join(cacheDir, imported.id, 'music.json'), 'utf8')) as MusicTrack
      expect(cached.beats).toEqual(track.beats)
    } finally {
      await svc.dispose()
    }

    const again = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir, onMusicUpdate: (t) => seen.push(t) })
    try {
      const count = seen.length
      const [cached] = await again.importMusic([dir])
      expect(cached.beats).toEqual(track.beats)
      // A project saved before beat detection existed
      const { beats: _b, bpm: _p, ...old } = track
      const [restored] = await again.restoreMusic([{ ...old, id: 'old-track' }])
      expect(restored.beats).toBeUndefined()
      await again.idle()
      expect(seen.length).toBe(count + 1)
      expect(again.getTrack('old-track')).toMatchObject({ bpm: track.bpm, beats: track.beats })
    } finally {
      await again.dispose()
    }
  })

  it('a track without a pulse gets an empty beat list', async () => {
    const dir = join(tmp, 'tone')
    mkdirSync(dir)
    await ff.run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=8', '-c:a', 'libmp3lame', join(dir, 'tone.mp3')])
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: join(tmp, 'cache2') })
    try {
      const [t] = await svc.importMusic([dir])
      await svc.idle()
      expect(svc.getTrack(t.id)).toMatchObject({ beats: [] })
      expect(svc.getTrack(t.id)!.bpm).toBeUndefined()
    } finally {
      await svc.dispose()
    }
  })
})
