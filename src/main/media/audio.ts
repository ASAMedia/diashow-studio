// Music tracks (probe, tags, transcode when Chromium can't play them) and waveform peaks.
import { rename, rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { extOf, NATIVE_AUDIO_EXT } from '@shared/formats'
import type { Ffmpeg, ProbeResult } from '../ffmpeg'

/** Codecs Chromium's <audio> decodes (in a container matching NATIVE_AUDIO_EXT). */
const NATIVE_CODECS = ['mp3', 'aac', 'flac', 'vorbis', 'opus', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8']

export interface MusicProbe {
  title: string
  artist?: string
  duration: number
  codec: string
  native: boolean
}

function tag(tags: Record<string, string> | undefined, name: string): string | undefined {
  if (!tags) return undefined
  const key = Object.keys(tags).find((k) => k.toLowerCase() === name)
  const v = key ? tags[key]?.trim() : undefined
  return v || undefined
}

export function analyzeMusic(path: string, probe: ProbeResult): MusicProbe {
  const audio = probe.streams.find((s) => s.codec_type === 'audio')
  if (!audio) throw new Error('no audio stream')
  const codec = audio.codec_name ?? 'unknown'
  const tags = { ...(audio.tags ?? {}), ...(probe.format.tags ?? {}) }
  const name = basename(path)
  const ext = extOf(path)
  return {
    title: tag(tags, 'title') ?? (ext ? name.slice(0, -(ext.length + 1)) : name),
    artist: tag(tags, 'artist') ?? tag(tags, 'album_artist'),
    duration: parseFloat(probe.format.duration ?? '') || parseFloat(audio.duration ?? '') || 0,
    codec,
    native: NATIVE_AUDIO_EXT.includes(ext) && NATIVE_CODECS.includes(codec)
  }
}

/** AAC 256k m4a for WMA, AIFF, ALAC and anything else Chromium cannot play. */
export async function transcodeMusic(ff: Ffmpeg, src: string, out: string, signal?: AbortSignal): Promise<void> {
  const tmp = `${out}.part.m4a`
  try {
    await ff.run(['-i', src, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', tmp], { signal })
    await rename(tmp, out)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

const WAVE_RATE = 8000
const BLOCK = 80 // 10 ms

/** Peak values 0..1 in `buckets` equal slices of the file (mono, decoded at 8 kHz). */
export async function computeWaveform(ff: Ffmpeg, path: string, buckets: number, signal?: AbortSignal): Promise<number[]> {
  const n = Math.max(1, Math.min(20_000, Math.floor(buckets)))
  // Reduce while streaming to 10 ms block peaks so long files never sit in memory as PCM
  const blocks: number[] = []
  let peak = 0
  let inBlock = 0
  let carry: Buffer | null = null
  await ff.capture(['-i', path, '-vn', '-ac', '1', '-ar', String(WAVE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', '-'], {
    signal,
    onData: (chunk) => {
      let buf = chunk
      if (carry) {
        buf = Buffer.concat([carry, chunk])
        carry = null
      }
      const usable = buf.length - (buf.length % 2)
      if (usable < buf.length) carry = buf.subarray(usable)
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i))
        if (v > peak) peak = v
        if (++inBlock === BLOCK) {
          blocks.push(peak)
          peak = 0
          inBlock = 0
        }
      }
    }
  })
  if (inBlock) blocks.push(peak)
  const out = new Array<number>(n).fill(0)
  if (!blocks.length) return out
  for (let b = 0; b < n; b++) {
    const from = Math.floor((b * blocks.length) / n)
    const to = Math.max(from + 1, Math.floor(((b + 1) * blocks.length) / n))
    let m = 0
    for (let i = from; i < to && i < blocks.length; i++) if (blocks[i] > m) m = blocks[i]
    out[b] = Math.min(1, m / 32768)
  }
  return out
}
