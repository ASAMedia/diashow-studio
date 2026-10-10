// Renders an AudioPlan to a 48 kHz stereo 16-bit WAV. Each clip is decoded once to raw float32
// in a temp folder; the mix is then built block by block so the show never sits in memory.
import { closeSync, openSync, readSync, writeSync, fstatSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioPlan, AudioPlanClip, GainPoint } from '@shared/types'
import type { Ffmpeg } from '../ffmpeg'

export const MIX_RATE = 48_000
const CHANNELS = 2
const FRAME_BYTES = CHANNELS * 4

/** Linear interpolation of gain points at timeline time t; clamped before the first/after the last. */
export function gainAt(points: GainPoint[], t: number): number {
  if (!points.length) return 1
  if (t <= points[0].t) return points[0].g
  const last = points[points.length - 1]
  if (t >= last.t) return last.g
  let lo = 0
  let hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = points[lo]
  const b = points[hi]
  return b.t === a.t ? b.g : a.g + ((b.g - a.g) * (t - a.t)) / (b.t - a.t)
}

/** Smooth limiter: linear up to 0.95, then a tanh knee that never exceeds 1. */
export function softClip(x: number): number {
  const a = Math.abs(x)
  if (a <= 0.95) return x
  const y = 0.95 + 0.05 * Math.tanh((a - 0.95) / 0.05)
  return x < 0 ? -y : y
}

function wavHeader(frames: number): Buffer {
  const dataBytes = frames * CHANNELS * 2
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'latin1')
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8, 'latin1')
  h.write('fmt ', 12, 'latin1')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(CHANNELS, 22)
  h.writeUInt32LE(MIX_RATE, 24)
  h.writeUInt32LE(MIX_RATE * CHANNELS * 2, 28)
  h.writeUInt16LE(CHANNELS * 2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'latin1')
  h.writeUInt32LE(dataBytes, 40)
  return h
}

export interface DecodedClip {
  clip: AudioPlanClip
  /** Raw interleaved stereo float32 little-endian at 48 kHz, starting at clip.offset. */
  file: string
}

/**
 * Pure mixing step: sums decoded clips into a WAV of exactly round(duration * 48000) frames.
 * Clip sample k plays at timeline frame round(start * 48000) + k, for at most duration seconds;
 * sources shorter than requested are zero padded. Gain points use timeline time.
 */
export async function mixDecodedClips(
  plan: AudioPlan,
  decoded: DecodedClip[],
  outPath: string,
  onProgress?: (fraction: number) => void
): Promise<void> {
  const total = Math.max(0, Math.round(plan.duration * MIX_RATE))
  const block = MIX_RATE
  const mix = new Float32Array(block * CHANNELS)
  const src = new Float32Array(block * CHANNELS)
  const srcBytes = Buffer.from(src.buffer)
  const pcm = new Int16Array(block * CHANNELS)
  const pcmBytes = Buffer.from(pcm.buffer)
  const sources = decoded.map((d) => {
    const fd = openSync(d.file, 'r')
    const frames = Math.floor(fstatSync(fd).size / FRAME_BYTES)
    const start = Math.round(d.clip.start * MIX_RATE)
    const length = Math.min(Math.round(d.clip.duration * MIX_RATE), Math.max(0, total - start))
    const points = [...d.clip.gain].sort((a, b) => a.t - b.t)
    return { fd, frames, start, end: start + length, points }
  })
  const out = openSync(outPath, 'w')
  try {
    writeSync(out, wavHeader(total))
    for (let b0 = 0; b0 < total; b0 += block) {
      const n = Math.min(block, total - b0)
      mix.fill(0, 0, n * CHANNELS)
      for (const s of sources) {
        const from = Math.max(b0, s.start)
        const to = Math.min(b0 + n, s.end)
        if (to <= from) continue
        const count = to - from
        const srcFrame = from - s.start
        const available = Math.max(0, Math.min(count, s.frames - srcFrame))
        if (available > 0) readSync(s.fd, srcBytes, 0, available * FRAME_BYTES, srcFrame * FRAME_BYTES)
        // Gain changes slowly; evaluate it every 32 frames and interpolate in between
        const STEP = 32
        let gPrev = gainAt(s.points, from / MIX_RATE)
        for (let i = 0; i < available; i += STEP) {
          const j = Math.min(i + STEP, available)
          const gNext = gainAt(s.points, (from + j) / MIX_RATE)
          const span = j - i
          for (let k = i; k < j; k++) {
            const g = gPrev + ((gNext - gPrev) * (k - i)) / span
            const o = (from - b0 + k) * CHANNELS
            mix[o] += src[k * CHANNELS] * g
            mix[o + 1] += src[k * CHANNELS + 1] * g
          }
          gPrev = gNext
        }
      }
      for (let i = 0; i < n * CHANNELS; i++) pcm[i] = Math.round(softClip(mix[i]) * 32767)
      writeSync(out, pcmBytes, 0, n * CHANNELS * 2)
      onProgress?.(Math.min(1, (b0 + n) / Math.max(1, total)))
      // Yield now and then so the Electron main process keeps answering IPC during long mixes
      if ((b0 / block) % 8 === 7) await new Promise((r) => setImmediate(r))
    }
  } finally {
    closeSync(out)
    for (const s of sources) closeSync(s.fd)
  }
}

/** Playback rate of a clip's source (slow motion / time lapse), 1 when unset or invalid. */
export function clipRate(clip: AudioPlanClip): number {
  const rate = (clip as { rate?: unknown }).rate
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1
}

/**
 * atempo stages for a playback rate (pitch kept, like <audio>.playbackRate with preservesPitch).
 * Each stage stays within 0.5..2, where atempo sounds best. Empty for rate 1.
 */
export function atempoChain(rate: number): string[] {
  if (!(Number.isFinite(rate) && rate > 0) || Math.abs(rate - 1) < 1e-6) return []
  const stages: number[] = []
  let r = rate
  while (r > 2) {
    stages.push(2)
    r /= 2
  }
  while (r < 0.5) {
    stages.push(0.5)
    r /= 0.5
  }
  if (Math.abs(r - 1) > 1e-6) stages.push(r)
  return stages.map((s) => `atempo=${Number(s.toFixed(6))}`)
}

/**
 * Decodes a clip to raw float32 stereo 48 kHz: duration * rate seconds of the source from offset,
 * played at `rate`, so the result covers `duration` seconds of the timeline.
 */
export async function decodeClip(ff: Ffmpeg, clip: AudioPlanClip, outFile: string, signal?: AbortSignal): Promise<void> {
  const rate = clipRate(clip)
  const tempo = atempoChain(rate)
  const span = Math.max(0, clip.duration) * rate
  await ff.run(
    [
      '-ss', Math.max(0, clip.offset).toFixed(6), '-t', span.toFixed(6), '-i', clip.src,
      '-vn', '-sn', '-dn', '-map', '0:a:0',
      ...(tempo.length ? ['-af', tempo.join(',')] : []),
      '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', String(CHANNELS), '-ar', String(MIX_RATE), outFile
    ],
    { signal }
  )
}

/** Decodes every clip (3 in parallel) and mixes the plan into outPath. Temp files live in tmpDir. */
export async function mixAudioPlan(
  ff: Ffmpeg,
  plan: AudioPlan,
  outPath: string,
  tmpDir: string,
  opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}
): Promise<void> {
  await mkdir(tmpDir, { recursive: true })
  const clips = plan.clips.filter((c) => c.duration > 0 && c.start < plan.duration)
  const decoded: DecodedClip[] = []
  const temp = clips.map((_, i) => join(tmpDir, `clip-${i}.f32`))
  try {
    let next = 0
    let done = 0
    const worker = async (): Promise<void> => {
      while (next < clips.length) {
        const i = next++
        const file = temp[i]
        try {
          await decodeClip(ff, clips[i], file, opts.signal)
          decoded[i] = { clip: clips[i], file }
        } catch (err) {
          if (opts.signal?.aborted) throw err
          // A clip whose source has no decodable audio is skipped (silence) instead of failing the export
        }
        opts.onProgress?.((++done / Math.max(1, clips.length)) * 0.8)
      }
    }
    await Promise.all([worker(), worker(), worker()])
    await mixDecodedClips(plan, decoded.filter(Boolean), outPath, (f) => opts.onProgress?.(0.8 + f * 0.2))
  } finally {
    await Promise.all(temp.map((f) => rm(f, { force: true })))
  }
}
