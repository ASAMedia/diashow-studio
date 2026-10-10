// Music: songs are read at import (tags, duration); formats Chromium can't play are transcoded
// (music.m4a). Beats and loudness are added in the background once the CPU-heavy part of media
// processing is done.
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { MusicTrack } from '@shared/types'
import { analyzeMusic, computeWaveform, transcodeMusic } from './audio'
import { detectBeatsInFile } from './beats'
import { MUSIC_META, persistTrack, readJson } from './cacheMeta'
import { mediaId, scanPaths, type ScannedFile } from './scan'
import { clean, once, shortError, type ServiceContext } from './serviceContext'

const trackWantsLoudness = (ctx: ServiceContext, t: MusicTrack): boolean =>
  t.status === 'ready' && !!t.playback && t.loudness === undefined && !ctx.loudnessTried.has(t.id)

const wantsBeats = (t: MusicTrack): boolean => t.status !== 'error' && !t.beats

function scheduleMusic(ctx: ServiceContext, transcode: string[], beats: string[], loudness: string[] = []): void {
  if (transcode.length || beats.length || loudness.length) {
    setImmediate(() => {
      for (const id of transcode) startMusicJob(ctx, id)
      for (const id of beats) startBeatJob(ctx, id)
      for (const id of loudness) startTrackLoudness(ctx, id)
    })
  }
}

/**
 * Music analysis (beats, loudness) waits for the CPU-heavy part of media processing (thumbnails,
 * display images), not for proxies: it is cheap, and beat sync and the beat lane should not wait
 * minutes for the graphics card.
 */
async function afterCpuWork(ctx: ServiceContext, id: string): Promise<void> {
  await ctx.thumbGate.wait(id)
  await ctx.displayGate.wait(id)
}

/** Loudness of the playable file of a ready track; emits music:update when there is a value. */
function startTrackLoudness(ctx: ServiceContext, id: string): void {
  const key = `loudness:${id}`
  if (ctx.jobs.has(key) || ctx.disposed) return
  const job = afterCpuWork(ctx, id).then(() => ctx.musicLimit(async () => {
    const t = ctx.tracks.get(id)
    if (!t || ctx.disposed || !trackWantsLoudness(ctx, t)) return
    ctx.loudnessTried.add(id)
    const loudness = await ctx.loudnessOf(t.playback!)
    if (loudness === undefined || ctx.disposed || ctx.tracks.get(id)?.playback !== t.playback) return
    ctx.updateTrack(id, { loudness })
    await mkdir(ctx.folder(id), { recursive: true })
    await persistTrack(ctx, id)
  })).catch(() => {})
  ctx.trackJob(key, job)
}

function startMusicJob(ctx: ServiceContext, id: string): void {
  if (ctx.jobs.has(`music:${id}`) || ctx.disposed) return
  const leaveEssential = once(ctx.essentialGate)
  const job = ctx.musicLimit(async () => {
    if (ctx.disposed) return
    const track = ctx.updateTrack(id, { status: 'processing', error: undefined })
    try {
      await mkdir(ctx.folder(id), { recursive: true })
      const out = join(ctx.folder(id), 'music.m4a')
      await transcodeMusic(ctx.ff, track.path, out, ctx.signal)
      ctx.updateTrack(id, { status: 'ready', playback: out, loudness: undefined })
      await persistTrack(ctx, id)
      startTrackLoudness(ctx, id)
    } catch (err) {
      if (!ctx.disposed) ctx.updateTrack(id, { status: 'error', error: shortError('Audio could not be converted', err) })
    }
  }).finally(leaveEssential)
  ctx.trackJob(`music:${id}`, job)
}

/** Beats are added to a track that is already usable; failures leave `beats` unset (retried on restore). */
function startBeatJob(ctx: ServiceContext, id: string): void {
  const key = `beats:${id}`
  if (ctx.jobs.has(key) || ctx.disposed) return
  const job = afterCpuWork(ctx, id).then(() => ctx.beatLimit(async () => {
    const t = ctx.tracks.get(id)
    if (!t || t.beats || t.status === 'error' || ctx.disposed) return
    await mkdir(ctx.folder(id), { recursive: true })
    const r = await detectBeatsInFile(ctx.ff, t.path, ctx.signal)
    if (ctx.disposed || !ctx.tracks.has(id)) return
    // No pulse found: an empty list, so it is not analysed again
    ctx.updateTrack(id, r ? { beats: r.beats, bpm: r.bpm } : { beats: [], bpm: undefined })
    await persistTrack(ctx, id)
  })).catch(() => {})
  ctx.trackJob(key, job)
}

async function prepareTrack(ctx: ServiceContext, file: ScannedFile): Promise<MusicTrack> {
  const id = mediaId(file.path, file.size, file.mtimeMs)
  const current = ctx.tracks.get(id)
  if (current && current.status !== 'error') return current
  const cached = await readJson<MusicTrack>(join(ctx.folder(id), MUSIC_META))
  if (cached && cached.status === 'ready' && cached.playback && existsSync(cached.playback)) {
    ctx.tracks.set(id, cached)
    return cached
  }
  const base: MusicTrack = { id, path: file.path, title: file.base, duration: 0, status: 'pending' }
  let track: MusicTrack
  try {
    const m = analyzeMusic(file.path, await ctx.ff.probe(file.path, ctx.signal))
    track = clean({ ...base, title: m.title, artist: m.artist, duration: m.duration })
    if (m.native) track = { ...track, status: 'ready', playback: file.path }
  } catch (err) {
    track = { ...base, status: 'error', error: shortError('Unsupported audio file', err) }
  }
  ctx.tracks.set(id, track)
  return track
}

export async function importMusic(ctx: ServiceContext, paths: string[]): Promise<MusicTrack[]> {
  const files = await scanPaths(paths, ['audio'])
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  const result = await Promise.all(files.map((f) => ctx.metaLimit(() => prepareTrack(ctx, f))))
  const now = Date.now()
  for (const t of result) ctx.recent.set(t.id, now)
  scheduleMusic(
    ctx,
    result.filter((t) => t.status === 'pending').map((t) => t.id),
    result.filter(wantsBeats).map((t) => t.id),
    result.filter((t) => trackWantsLoudness(ctx, t)).map((t) => t.id)
  )
  return result.map((t) => ({ ...(ctx.tracks.get(t.id) ?? t) }))
}

export async function restoreMusic(ctx: ServiceContext, list: MusicTrack[]): Promise<MusicTrack[]> {
  const requeue: string[] = []
  const beats: string[] = []
  const loudness: string[] = []
  const result = await Promise.all(
    list.map(async (t) => {
      const current = ctx.tracks.get(t.id)
      if (current && current.status !== 'error') return { ...current }
      if (!existsSync(t.path)) return { ...t, status: 'error' as const, error: 'missing' }
      if (t.status === 'ready' && t.playback && existsSync(t.playback)) {
        ctx.tracks.set(t.id, t)
        if (wantsBeats(t)) beats.push(t.id)
        if (trackWantsLoudness(ctx, t)) loudness.push(t.id)
        return { ...t }
      }
      let fresh: MusicTrack = clean({ ...t, status: 'pending' as const, playback: undefined, error: undefined })
      // Cache gone or a packed project from another PC: formats Chromium plays need no transcode
      try {
        const m = analyzeMusic(t.path, await ctx.ff.probe(t.path, ctx.signal))
        if (m.native) fresh = { ...fresh, status: 'ready', playback: t.path, duration: fresh.duration || m.duration }
      } catch {
        // the transcode job reports what is wrong with the file
      }
      ctx.tracks.set(t.id, fresh)
      if (fresh.status === 'pending') requeue.push(t.id)
      if (wantsBeats(fresh)) beats.push(t.id)
      if (trackWantsLoudness(ctx, fresh)) loudness.push(t.id)
      return { ...fresh }
    })
  )
  scheduleMusic(ctx, requeue, beats, loudness)
  return result
}

export function waveform(ctx: ServiceContext, path: string, buckets: number): Promise<number[]> {
  const key = `${path}|${buckets}`
  let p = ctx.waveforms.get(key)
  if (!p) {
    p = computeWaveform(ctx.ff, path, buckets, ctx.signal)
    p.catch(() => ctx.waveforms.delete(key))
    ctx.waveforms.set(key, p)
  }
  return p
}
