// Loudness (EBU R128) of video sound and music: measured with the processing, filled in lazily for
// older cache entries, undefined for silence.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MediaItem, MusicTrack } from '@shared/types'
import { measureLoudness, parseIntegratedLoudness } from '../src/main/media/loudness'
import { createMediaService } from '../src/main/media/service'
import { ff, FFMPEG_DIR } from './helpers/media'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-loudness-'))
const src = join(tmp, 'src')
const music = join(tmp, 'music')
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

/** Stereo 1 kHz sine with the given peak level in dBFS (same signal in both channels). */
const sine = (dbfs: number, seconds: number): string[] => {
  const a = Math.pow(10, dbfs / 20).toFixed(6)
  return ['-f', 'lavfi', '-i', `aevalsrc=${a}*sin(2*PI*1000*t)|${a}*sin(2*PI*1000*t):s=48000:d=${seconds}`]
}

async function video(name: string, audio: string[] | null): Promise<void> {
  const v = ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4']
  const a = audio ? [...audio, '-c:a', 'aac', '-b:a', '192k'] : []
  await ff.run([...v, ...a, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-shortest', join(src, name)])
}

beforeAll(async () => {
  mkdirSync(src, { recursive: true })
  mkdirSync(music, { recursive: true })
  await video('quiet.mp4', sine(-20, 4))
  await video('loud.mp4', sine(-6, 4))
  await video('silent.mp4', ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=4'])
  await video('mute.mp4', null)
  await ff.run([...sine(-12, 6), '-c:a', 'libmp3lame', '-b:a', '192k', join(music, 'a-native.mp3')])
  // WMA needs a transcode: loudness is measured on the transcoded file
  await ff.run([...sine(-26, 6), '-c:a', 'wmav2', '-b:a', '192k', join(music, 'b-transcoded.wma')])
}, 120_000)

describe('measureLoudness', () => {
  it('parses the ebur128 summary', () => {
    const log = '[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -23.4 LUFS\n    Threshold: -33.4 LUFS\n'
    expect(parseIntegratedLoudness(log)).toBe(-23.4)
    expect(parseIntegratedLoudness('no summary')).toBeUndefined()
  })

  it('matches known sine levels within 1 LU and leaves silence undefined', async () => {
    const quiet = await measureLoudness(ff, join(src, 'quiet.mp4'))
    const loud = await measureLoudness(ff, join(src, 'loud.mp4'))
    // A stereo 1 kHz sine at x dBFS peak measures x LUFS (K-weighting +0.7 dB, -0.691 offset, two channels)
    expect(quiet).toBeCloseTo(-20, 0)
    expect(loud).toBeCloseTo(-6, 0)
    expect(Math.abs(loud! - quiet! - 14)).toBeLessThan(1)
    expect(await measureLoudness(ff, join(src, 'silent.mp4'))).toBeUndefined()
    await expect(measureLoudness(ff, join(src, 'mute.mp4'))).rejects.toThrow()
  })
})

describe('media service', () => {
  it('measures videos with sound during processing and music tracks, emitting updates', async () => {
    const cache = join(tmp, 'cache')
    const updates: MediaItem[] = []
    const trackUpdates: MusicTrack[] = []
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: cache, onUpdate: (i) => updates.push(i), onMusicUpdate: (t) => trackUpdates.push(t) })
    try {
      const items = await svc.importPaths([src])
      const tracks = await svc.importMusic([music])
      await svc.idle()
      const byName = (n: string): MediaItem => svc.get(items.find((i) => i.name === n)!.id)!
      expect(byName('quiet.mp4').loudness).toBeCloseTo(-20, 0)
      expect(byName('loud.mp4').loudness).toBeCloseTo(-6, 0)
      expect(byName('silent.mp4').hasAudio).toBe(true)
      expect(byName('silent.mp4').loudness).toBeUndefined()
      expect(byName('mute.mp4').loudness).toBeUndefined()
      // arrives with the 'ready' update and is stored in meta.json
      const ready = updates.filter((u) => u.name === 'loud.mp4' && u.status === 'ready').pop()!
      expect(ready.loudness).toBeCloseTo(-6, 0)
      const meta = JSON.parse(readFileSync(join(cache, ready.id, 'meta.json'), 'utf8')) as MediaItem
      expect(meta.loudness).toBe(ready.loudness)

      const [native, wma] = tracks.map((t) => svc.getTrack(t.id)!)
      expect(native.loudness).toBeCloseTo(-12, 0)
      expect(wma.playback).toMatch(/music\.m4a$/)
      expect(wma.loudness).toBeCloseTo(-26, 0)
      expect(trackUpdates.some((t) => t.id === native.id && t.loudness !== undefined)).toBe(true)
      const musicJson = JSON.parse(readFileSync(join(cache, wma.id, 'music.json'), 'utf8')) as MusicTrack
      expect(musicJson.loudness).toBe(wma.loudness)
    } finally {
      await svc.dispose()
    }
  })

  it('fills in loudness lazily for cached and restored items that lack it', async () => {
    const cache = join(tmp, 'cache')
    const first = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: cache })
    const items = await first.importPaths([src])
    const tracks = await first.importMusic([music])
    await first.idle()
    const loud = first.get(items.find((i) => i.name === 'loud.mp4')!.id)!
    const track = first.getTrack(tracks[0].id)!
    await first.dispose()

    // Cache written by an older version: no loudness
    const metaPath = join(cache, loud.id, 'meta.json')
    const { loudness: _l, ...old } = JSON.parse(readFileSync(metaPath, 'utf8')) as MediaItem
    writeFileSync(metaPath, JSON.stringify(old))
    const { loudness: _t, ...oldTrack } = track

    const updates: MediaItem[] = []
    const trackUpdates: MusicTrack[] = []
    const again = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: cache, onUpdate: (i) => updates.push(i), onMusicUpdate: (t) => trackUpdates.push(t) })
    try {
      const list = await again.importPaths([join(src, 'loud.mp4'), join(src, 'silent.mp4')])
      expect(list.every((i) => i.status === 'ready')).toBe(true)
      expect(list.find((i) => i.id === loud.id)!.loudness).toBeUndefined()
      const [restored] = await again.restoreMusic([oldTrack])
      expect(restored.loudness).toBeUndefined()
      await again.idle()
      expect(updates.filter((u) => u.id === loud.id).pop()!.loudness).toBeCloseTo(-6, 0)
      // silent audio: measured once, no update, still undefined
      expect(updates.some((u) => u.name === 'silent.mp4')).toBe(false)
      expect(trackUpdates.filter((t) => t.id === track.id).pop()!.loudness).toBeCloseTo(-12, 0)
      expect((JSON.parse(readFileSync(metaPath, 'utf8')) as MediaItem).loudness).toBeCloseTo(-6, 0)
    } finally {
      await again.dispose()
    }
  })
})
