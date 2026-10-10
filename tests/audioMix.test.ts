import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AudioPlan, AudioPlanClip } from '@shared/types'
import { atempoChain, gainAt, MIX_RATE, mixAudioPlan, mixDecodedClips, softClip } from '../src/main/export/audioMix'
import { ff } from './helpers/media'

const dir = mkdtempSync(join(tmpdir(), 'diashow-mix-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Raw interleaved stereo float32 file: fn(frameIndex) → sample value for both channels. */
function rawClip(name: string, seconds: number, fn: (i: number) => number): string {
  const frames = Math.round(seconds * MIX_RATE)
  const data = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) data[i * 2] = data[i * 2 + 1] = fn(i)
  const file = join(dir, name)
  writeFileSync(file, Buffer.from(data.buffer))
  return file
}

function readWav(path: string): { rate: number; channels: number; bits: number; samples: Int16Array } {
  const buf = readFileSync(path)
  expect(buf.toString('latin1', 0, 4)).toBe('RIFF')
  expect(buf.toString('latin1', 8, 12)).toBe('WAVE')
  const dataBytes = buf.readUInt32LE(40)
  expect(buf.length).toBe(44 + dataBytes)
  const samples = new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + 44 + dataBytes))
  return { rate: buf.readUInt32LE(24), channels: buf.readUInt16LE(22), bits: buf.readUInt16LE(34), samples }
}

/** Left-channel value (-1..1) at timeline second t. */
const at = (s: Int16Array, t: number): number => s[Math.round(t * MIX_RATE) * 2] / 32767

function clip(partial: Partial<AudioPlanClip> & Pick<AudioPlanClip, 'start' | 'duration'>): AudioPlanClip {
  return { id: Math.random().toString(36), kind: 'music', src: '', offset: 0, gain: [], ...partial }
}

describe('gainAt', () => {
  const pts = [
    { t: 1, g: 0 },
    { t: 2, g: 1 },
    { t: 4, g: 0.5 }
  ]
  it('interpolates linearly and clamps outside the points', () => {
    expect(gainAt(pts, 0)).toBe(0)
    expect(gainAt(pts, 1)).toBe(0)
    expect(gainAt(pts, 1.5)).toBeCloseTo(0.5)
    expect(gainAt(pts, 2)).toBe(1)
    expect(gainAt(pts, 3)).toBeCloseTo(0.75)
    expect(gainAt(pts, 10)).toBe(0.5)
    expect(gainAt([], 3)).toBe(1)
    expect(gainAt([{ t: 5, g: 0.3 }], 0)).toBe(0.3)
  })
})

describe('softClip', () => {
  it('is transparent below 0.95 and never exceeds 1', () => {
    expect(softClip(0.5)).toBe(0.5)
    expect(softClip(-0.95)).toBe(-0.95)
    expect(softClip(1.6)).toBeLessThan(1)
    expect(softClip(1.6)).toBeGreaterThan(0.95)
    expect(softClip(-3)).toBeGreaterThanOrEqual(-1)
    expect(softClip(1.2)).toBeLessThan(softClip(1.3))
  })
})

describe('mixDecodedClips', () => {
  it('places clips on the timeline, applies gain ramps, pads short sources and sums', async () => {
    const dc = rawClip('dc.f32', 1, () => 0.5)
    const sine = rawClip('sine.f32', 0.5, (i) => 0.25 * Math.sin((2 * Math.PI * 1000 * i) / MIX_RATE))
    const loudA = rawClip('loudA.f32', 0.2, () => 0.8)
    const loudB = rawClip('loudB.f32', 0.2, () => 0.8)
    const plan: AudioPlan = {
      duration: 2,
      clips: []
    }
    const a = clip({ start: 0.25, duration: 1, gain: [{ t: 0.25, g: 0 }, { t: 1.25, g: 1 }] })
    // 0.5 s of source but 0.8 s requested → zero padded from 1.7 s
    const b = clip({ start: 1.2, duration: 0.8, gain: [{ t: 0, g: 1 }] })
    const c = clip({ start: 1.75, duration: 0.2 })
    const d = clip({ start: 1.75, duration: 0.2 })
    plan.clips = [a, b, c, d]
    const out = join(dir, 'mix.wav')
    await mixDecodedClips(plan, [
      { clip: a, file: dc },
      { clip: b, file: sine },
      { clip: c, file: loudA },
      { clip: d, file: loudB }
    ], out)
    const wav = readWav(out)
    expect([wav.rate, wav.channels, wav.bits]).toEqual([48000, 2, 16])
    expect(wav.samples.length).toBe(2 * MIX_RATE * 2)
    expect(at(wav.samples, 0.1)).toBe(0)
    expect(at(wav.samples, 0.75)).toBeCloseTo(0.25, 2) // 0.5 * gain 0.5
    expect(at(wav.samples, 1.0)).toBeCloseTo(0.375, 2) // 0.5 * gain 0.75
    // both channels identical
    const i = Math.round(0.75 * MIX_RATE) * 2
    expect(wav.samples[i]).toBe(wav.samples[i + 1])
    // sine clip present between 1.25 and 1.7 s (dc clip ended at 1.25)
    let peak = 0
    for (let t = 1.3; t < 1.6; t += 1 / MIX_RATE) peak = Math.max(peak, Math.abs(at(wav.samples, t)))
    expect(peak).toBeCloseTo(0.25, 2)
    // padded part of clip b is silent before the loud clips start
    expect(at(wav.samples, 1.72)).toBe(0)
    // 0.8 + 0.8 is soft clipped below full scale
    const loud = at(wav.samples, 1.85)
    expect(loud).toBeGreaterThan(0.95)
    expect(loud).toBeLessThanOrEqual(1)
    expect(at(wav.samples, 1.99)).toBe(0)
  })

  it('writes exact length silence for an empty plan', async () => {
    const out = join(dir, 'silence.wav')
    await mixDecodedClips({ duration: 1.5, clips: [] }, [], out)
    expect(statSync(out).size).toBe(44 + Math.round(1.5 * MIX_RATE) * 4)
  })
})

describe('mixAudioPlan', () => {
  it('decodes sources with FFmpeg (offset + duration) and mixes to the plan length', async () => {
    const src = join(dir, 'tone.m4a')
    await ff.run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3', '-c:a', 'aac', src])
    const plan: AudioPlan = {
      duration: 2.5,
      clips: [
        { id: 'm', kind: 'music', src, start: 0.5, offset: 1, duration: 1.5, gain: [{ t: 0, g: 1 }] },
        { id: 'v', kind: 'video', src: join(dir, 'missing.mp4'), start: 0, offset: 0, duration: 1, gain: [] }
      ]
    }
    const out = join(dir, 'plan.wav')
    await mixAudioPlan(ff, plan, out, join(dir, 'tmp'))
    const wav = readWav(out)
    expect(wav.samples.length).toBe(Math.round(2.5 * MIX_RATE) * 2)
    expect(at(wav.samples, 0.25)).toBe(0)
    let peak = 0
    for (let t = 1; t < 1.2; t += 1 / MIX_RATE) peak = Math.max(peak, Math.abs(at(wav.samples, t)))
    // lavfi sine is 1/8 full scale; FFmpeg upmixes mono to stereo at -3 dB
    expect(peak).toBeGreaterThan(0.08)
    expect(at(wav.samples, 2.2)).toBe(0)
  })

  it('builds atempo chains within 0.5..2 per stage', () => {
    expect(atempoChain(1)).toEqual([])
    expect(atempoChain(2)).toEqual(['atempo=2'])
    expect(atempoChain(0.5)).toEqual(['atempo=0.5'])
    expect(atempoChain(1.25)).toEqual(['atempo=1.25'])
    expect(atempoChain(4)).toEqual(['atempo=2', 'atempo=2'])
    expect(atempoChain(6)).toEqual(['atempo=2', 'atempo=2', 'atempo=1.5'])
    expect(atempoChain(0.2)).toEqual(['atempo=0.5', 'atempo=0.5', 'atempo=0.8'])
    expect(atempoChain(NaN)).toEqual([])
  })

  it('plays video clips at their rate with the pitch kept (slow motion / time lapse)', async () => {
    // 2 s source: 1 s of 1 kHz tone, then 1 s of silence
    const src = join(dir, 'tone-then-silence.wav')
    await ff.run(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=1', '-af', 'apad=whole_dur=2', '-ac', '2', src])
    const rms = (s: Int16Array, from: number, to: number): number => {
      let sum = 0
      let n = 0
      for (let i = Math.round(from * MIX_RATE); i < Math.round(to * MIX_RATE); i++, n++) sum += (s[i * 2] / 32767) ** 2
      return Math.sqrt(sum / Math.max(1, n))
    }
    /** Zero crossings per second of the left channel (2 × frequency). */
    const crossings = (s: Int16Array, from: number, to: number): number => {
      let c = 0
      const a = Math.round(from * MIX_RATE)
      const b = Math.round(to * MIX_RATE)
      for (let i = a + 1; i < b; i++) if (Math.sign(s[i * 2]) !== Math.sign(s[(i - 1) * 2]) && s[i * 2] !== 0) c++
      return c / (to - from)
    }
    const mixed = async (name: string, duration: number, rate: number): Promise<Int16Array> => {
      const out = join(dir, name)
      const c = { id: name, kind: 'video' as const, src, start: 0, offset: 0, duration, gain: [], rate }
      await mixAudioPlan(ff, { duration: 5, clips: [c] }, out, join(dir, 'tmp'))
      return readWav(out).samples
    }

    // rate 2: the whole 2 s source in 1 s of timeline, tone in the first half
    const fast = await mixed('rate2.wav', 1, 2)
    expect(rms(fast, 0.05, 0.42)).toBeGreaterThan(0.05)
    expect(rms(fast, 0.58, 0.95)).toBeLessThan(0.005)
    expect(rms(fast, 1.05, 5)).toBe(0)
    // pitch kept: still 1 kHz (2000 crossings per second), not 2 kHz
    expect(Math.abs(crossings(fast, 0.05, 0.42) - 2000)).toBeLessThan(60)

    // rate 0.5: 2 s of source stretched over 4 s, tone in the first 2 s
    const slow = await mixed('rate05.wav', 4, 0.5)
    expect(rms(slow, 0.1, 1.85)).toBeGreaterThan(0.05)
    expect(rms(slow, 2.15, 3.9)).toBeLessThan(0.005)
    expect(rms(slow, 4.05, 5)).toBe(0)
    expect(Math.abs(crossings(slow, 0.1, 1.85) - 2000)).toBeLessThan(60)
  })
})
