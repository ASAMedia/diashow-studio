// Media import + background processing. Electron-free: the IPC layer injects directories and
// forwards onUpdate / onMusicUpdate to the renderer.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaItem, MusicTrack } from '@shared/types'
import { Ffmpeg, FfmpegError, type ProbeResult } from '../ffmpeg'
import { analyzeMusic, computeWaveform, transcodeMusic } from './audio'
import { captureTimeOf, deviceOf, endExiftool, makeOf, orientationOf, readTags, type Tags } from './exif'
import { extractMotionVideo, isMotionPhoto } from './motion'
import { photoFormatLabel, renderPhoto } from './photo'
import { createLimiter } from './queue'
import { RawDecoderPool, type RawDecoding } from './raw'
import { mediaId, pairFiles, scanPaths, type ImportGroup, type ScannedFile } from './scan'
import { extractAudio, transcodeProxy, videoThumb } from './video'
import { analyzeVideo, isDirectPlayable, videoFormatLabel, type VideoInfo } from './videoInfo'

export interface MediaServiceConfig {
  ffmpegDir: string
  cacheDir: string
  onUpdate?: (item: MediaItem) => void
  onMusicUpdate?: (track: MusicTrack) => void
  photoConcurrency?: number
  videoConcurrency?: number
  /** Injected for tests; defaults to two libraw-wasm worker threads. */
  rawDecoder?: RawDecoding
}

export interface MediaService {
  readonly ffmpeg: Ffmpeg
  importPaths(paths: string[]): Promise<MediaItem[]>
  restoreMedia(items: MediaItem[]): Promise<MediaItem[]>
  importMusic(paths: string[]): Promise<MusicTrack[]>
  restoreMusic(tracks: MusicTrack[]): Promise<MusicTrack[]>
  waveform(path: string, buckets: number): Promise<number[]>
  get(id: string): MediaItem | undefined
  /** Resolves when no import/transcode job is queued or running. */
  idle(): Promise<void>
  dispose(): Promise<void>
}

/** A Live Photo's motion part is ~3 s; a longer same-named MOV is treated as a separate video. */
const LIVE_MAX_SECONDS = 10
const META = 'meta.json'
const MUSIC_META = 'music.json'

interface Context {
  tags?: Tags
  probe?: ProbeResult
  liveProbe?: ProbeResult
}

function clean<T extends object>(obj: T): T {
  const out = { ...obj }
  for (const k of Object.keys(out) as Array<keyof T>) if (out[k] === undefined) delete out[k]
  return out
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function shortError(context: string, err: unknown): string {
  if (isAbort(err)) return 'cancelled'
  const msg = err instanceof FfmpegError || err instanceof Error ? err.message : String(err)
  const text = msg ? `${context}: ${msg}` : context
  return text.length > 180 ? text.slice(0, 180) + '…' : text
}

const DERIVED: Array<keyof MediaItem> = ['thumb', 'display', 'audio', 'liveVideo']

function cacheFilesPresent(item: MediaItem): boolean {
  for (const key of DERIVED) {
    const v = item[key]
    if (typeof v === 'string' && !existsSync(v)) return false
  }
  if (item.kind === 'photo' && !item.display) return false
  if (item.kind === 'video' && (!item.playback || !existsSync(item.playback) || !item.thumb)) return false
  if (item.live && !existsSync(item.live.source)) return false
  return true
}

function stripDerived(item: MediaItem): MediaItem {
  const { thumb: _t, display: _d, playback: _p, audio: _a, liveVideo: _l, proxied: _x, progress: _g, error: _e, ...rest } = item
  return { ...rest, status: 'pending' }
}

/** Sony XAVC sidecar (C0001M01.XML): CreationDate with offset and the camera model. */
async function sonySidecar(file: ScannedFile): Promise<{ time?: number; device?: string }> {
  for (const suffix of ['M01.XML', 'M01.xml']) {
    const p = join(file.dir, `${file.base}${suffix}`)
    if (!existsSync(p)) continue
    try {
      const xml = await readFile(p, 'utf8')
      const date = /<CreationDate\s+value="([^"]+)"/.exec(xml)?.[1]
      const model = /<Device\b[^>]*\bmodelName="([^"]+)"/.exec(xml)?.[1]
      const time = date ? Date.parse(date) : NaN
      return { time: Number.isFinite(time) ? time : undefined, device: model }
    } catch {
      return {}
    }
  }
  return {}
}

function probeTime(probe: ProbeResult): number | undefined {
  const tags = probe.format.tags ?? {}
  const raw = tags['com.apple.quicktime.creationdate'] ?? tags.creation_time
  const t = raw ? Date.parse(raw) : NaN
  return Number.isFinite(t) && t > Date.UTC(1980, 0, 1) ? t : undefined
}

export function createMediaService(config: MediaServiceConfig): MediaService {
  const ff = new Ffmpeg(config.ffmpegDir)
  const raw = config.rawDecoder ?? new RawDecoderPool(2)
  const abort = new AbortController()
  const signal = abort.signal
  const items = new Map<string, MediaItem>()
  const contexts = new Map<string, Context>()
  const preparing = new Map<string, Promise<MediaItem[]>>()
  const jobs = new Map<string, Promise<void>>()
  const tracks = new Map<string, MusicTrack>()
  const waveforms = new Map<string, Promise<number[]>>()
  const metaLimit = createLimiter(8)
  const photoLimit = createLimiter(config.photoConcurrency ?? 4)
  const videoLimit = createLimiter(config.videoConcurrency ?? 2)
  const musicLimit = createLimiter(2)
  let disposed = false

  const folder = (id: string): string => join(config.cacheDir, id)

  function emit(item: MediaItem): void {
    if (!disposed) config.onUpdate?.({ ...item })
  }

  function update(id: string, patch: Partial<MediaItem>): MediaItem {
    const next = clean({ ...items.get(id)!, ...patch })
    items.set(id, next)
    emit(next)
    return next
  }

  async function writeJson(path: string, data: unknown): Promise<void> {
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(data))
    await rename(tmp, path)
  }

  async function readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------------ import

  async function prepareVideo(file: ScannedFile, id: string): Promise<MediaItem> {
    const base: MediaItem = {
      id,
      path: file.path,
      name: file.name,
      kind: 'video',
      format: file.ext.toUpperCase(),
      width: 0,
      height: 0,
      captureTime: file.mtimeMs,
      status: 'pending'
    }
    const [tags, sidecar] = await Promise.all([readTags(file.path, true), sonySidecar(file)])
    let probe: ProbeResult
    try {
      probe = await ff.probe(file.path, signal)
    } catch (err) {
      return { ...base, status: 'error', error: shortError('Unsupported or damaged video', err) }
    }
    const info = analyzeVideo(probe)
    if (!info) return { ...base, status: 'error', error: 'No video stream' }
    contexts.set(id, { tags, probe })
    return clean({
      ...base,
      format: videoFormatLabel(file.path, probe, info, makeOf(tags)),
      device: deviceOf(tags) ?? sidecar.device,
      width: info.width,
      height: info.height,
      duration: info.duration,
      fps: info.fps,
      hasAudio: info.hasAudio,
      hdr: !!info.hdr,
      captureTime: sidecar.time ?? captureTimeOf(tags) ?? probeTime(probe) ?? file.mtimeMs
    })
  }

  async function preparePhoto(group: ImportGroup, id: string): Promise<MediaItem[]> {
    const file = group.file
    const tags = await readTags(file.path, false)
    const t = tags as Record<string, unknown>
    const orientation = orientationOf(tags)
    let w = Number(t.ImageWidth) || 0
    let h = Number(t.ImageHeight) || 0
    if (orientation >= 5) [w, h] = [h, w]
    const item: MediaItem = clean({
      id,
      path: file.path,
      name: file.name,
      kind: 'photo' as const,
      format: photoFormatLabel(file.path, tags),
      device: deviceOf(tags),
      width: w,
      height: h,
      captureTime: captureTimeOf(tags) ?? file.mtimeMs,
      status: 'pending' as const
    })
    const ctx: Context = { tags }
    const extra: MediaItem[] = []
    if (group.live) {
      try {
        const liveProbe = await ff.probe(group.live.path, signal)
        const info = analyzeVideo(liveProbe)
        if (info && info.duration <= LIVE_MAX_SECONDS) {
          item.live = { source: group.live.path, duration: info.duration }
          ctx.liveProbe = liveProbe
        }
      } catch {
        // unreadable MOV: handled as a separate (error) video below
      }
      if (!item.live) {
        const mov = group.live
        const movId = mediaId(mov.path, mov.size, mov.mtimeMs)
        extra.push(items.get(movId) ?? (await fromCache(movId)) ?? (await prepareVideo(mov, movId)))
      }
    }
    contexts.set(id, ctx)
    return [item, ...extra]
  }

  async function fromCache(id: string): Promise<MediaItem | null> {
    const cached = await readJson<MediaItem>(join(folder(id), META))
    if (!cached || cached.id !== id || cached.status !== 'ready' || !cacheFilesPresent(cached)) return null
    return cached
  }

  function prepare(group: ImportGroup): Promise<MediaItem[]> {
    const f = group.file
    const id = mediaId(f.path, f.size, f.mtimeMs)
    const current = items.get(id)
    if (current && current.status !== 'error') return Promise.resolve([current])
    const running = preparing.get(id)
    if (running) return running
    const task = metaLimit(async () => {
      const cached = await fromCache(id)
      if (cached) {
        items.set(id, cached)
        return [cached]
      }
      const result = f.kind === 'video' ? [await prepareVideo(f, id)] : await preparePhoto(group, id)
      for (const it of result) items.set(it.id, it)
      return result
    }).finally(() => preparing.delete(id))
    preparing.set(id, task)
    return task
  }

  // -------------------------------------------------------------- processing

  /**
   * Called once an API call has its complete result: jobs start on the next macrotask, so the IPC
   * reply carrying the 'pending' items reaches the renderer before the first media:update for them.
   */
  function schedule(ids: string[]): void {
    if (ids.length) setImmediate(() => ids.forEach(startJob))
  }

  function startJob(id: string): void {
    if (jobs.has(id) || disposed) return
    const item = items.get(id)
    if (!item) return
    const limit = item.kind === 'photo' ? photoLimit : videoLimit
    const job = limit(() => runJob(id)).finally(() => jobs.delete(id))
    jobs.set(id, job)
  }

  async function runJob(id: string): Promise<void> {
    if (disposed) return
    const item = update(id, { status: 'processing', progress: 0, error: undefined })
    try {
      await mkdir(folder(id), { recursive: true })
      if (item.kind === 'photo') await processPhoto(id)
      else await processVideo(id)
      const done = update(id, { status: 'ready', progress: undefined })
      await writeJson(join(folder(id), META), done)
    } catch (err) {
      if (disposed) return
      const context = item.kind === 'photo' ? 'Photo could not be read' : 'Video could not be converted'
      update(id, { status: 'error', progress: undefined, error: shortError(context, err) })
    } finally {
      contexts.delete(id)
    }
  }

  async function processPhoto(id: string): Promise<void> {
    let item = items.get(id)!
    const ctx = contexts.get(id) ?? {}
    const tags = ctx.tags ?? (await readTags(item.path, false))
    const dir = folder(id)
    const out = await renderPhoto({ ff, raw }, item.path, tags, { display: join(dir, 'display.jpg'), thumb: join(dir, 'thumb.jpg') }, signal)
    item = update(id, { width: out.width, height: out.height, display: join(dir, 'display.jpg'), thumb: join(dir, 'thumb.jpg') })

    let live = item.live && existsSync(item.live.source) ? item.live : undefined
    let liveProbe = live ? ctx.liveProbe : undefined
    if (!live && isMotionPhoto(tags)) {
      try {
        const motion = join(dir, 'motion.mp4')
        await extractMotionVideo(item.path, tags, motion)
        liveProbe = await ff.probe(motion, signal)
        const info = analyzeVideo(liveProbe)
        if (info) live = { source: motion, duration: info.duration }
      } catch (err) {
        if (isAbort(err)) throw err
        live = undefined
      }
    }
    if (!live) {
      update(id, { live: undefined, liveVideo: undefined })
      return
    }
    try {
      liveProbe ??= await ff.probe(live.source, signal)
      const info = analyzeVideo(liveProbe)
      if (!info) throw new Error('no video stream')
      let liveVideo = live.source
      if (!isDirectPlayable(live.source, liveProbe, info)) {
        const target = join(dir, 'live.mp4')
        const encoders = await ff.encoders()
        await videoLimit(() => transcodeProxy(ff, live!.source, info, target, { signal, encoders }))
        liveVideo = target
      }
      update(id, { live, liveVideo })
    } catch (err) {
      if (isAbort(err)) throw err
      // The still is fine; only the motion part is unusable
      update(id, { live: undefined, liveVideo: undefined })
    }
  }

  async function processVideo(id: string): Promise<void> {
    const item = items.get(id)!
    const ctx = contexts.get(id) ?? {}
    const probe = ctx.probe ?? (await ff.probe(item.path, signal))
    const info: VideoInfo | null = analyzeVideo(probe)
    if (!info) throw new Error('no video stream')
    const dir = folder(id)
    const thumb = join(dir, 'thumb.jpg')
    await videoThumb(ff, item.path, info, thumb, signal)
    update(id, { thumb })

    if (info.hasAudio) {
      const audio = join(dir, 'audio.m4a')
      try {
        await extractAudio(ff, item.path, info, audio, signal)
        update(id, { audio, hasAudio: true })
      } catch (err) {
        if (isAbort(err)) throw err
        update(id, { audio: undefined, hasAudio: false })
      }
    }

    if (isDirectPlayable(item.path, probe, info)) {
      update(id, { playback: item.path, proxied: false })
      return
    }
    const proxy = join(dir, 'proxy.mp4')
    const encoders = await ff.encoders()
    let last = 0
    let lastAt = 0
    await transcodeProxy(ff, item.path, info, proxy, {
      signal,
      encoders,
      onProgress: (p) => {
        const now = Date.now()
        if (p - last >= 0.01 && now - lastAt >= 200) {
          last = p
          lastAt = now
          update(id, { progress: Math.round(p * 1000) / 1000 })
        }
      }
    })
    update(id, { playback: proxy, proxied: true, progress: 1 })
  }

  // ------------------------------------------------------------------- music

  function emitTrack(track: MusicTrack): void {
    if (!disposed) config.onMusicUpdate?.({ ...track })
  }

  function updateTrack(id: string, patch: Partial<MusicTrack>): MusicTrack {
    const next = clean({ ...tracks.get(id)!, ...patch })
    tracks.set(id, next)
    emitTrack(next)
    return next
  }

  function scheduleMusic(ids: string[]): void {
    if (ids.length) setImmediate(() => ids.forEach(startMusicJob))
  }

  function startMusicJob(id: string): void {
    if (jobs.has(`music:${id}`) || disposed) return
    const job = musicLimit(async () => {
      if (disposed) return
      const track = updateTrack(id, { status: 'processing', error: undefined })
      try {
        await mkdir(folder(id), { recursive: true })
        const out = join(folder(id), 'music.m4a')
        await transcodeMusic(ff, track.path, out, signal)
        const done = updateTrack(id, { status: 'ready', playback: out })
        await writeJson(join(folder(id), MUSIC_META), done)
      } catch (err) {
        if (!disposed) updateTrack(id, { status: 'error', error: shortError('Audio could not be converted', err) })
      }
    }).finally(() => jobs.delete(`music:${id}`))
    jobs.set(`music:${id}`, job)
  }

  async function prepareTrack(file: ScannedFile): Promise<MusicTrack> {
    const id = mediaId(file.path, file.size, file.mtimeMs)
    const current = tracks.get(id)
    if (current && current.status !== 'error') return current
    const cached = await readJson<MusicTrack>(join(folder(id), MUSIC_META))
    if (cached && cached.status === 'ready' && cached.playback && existsSync(cached.playback)) {
      tracks.set(id, cached)
      return cached
    }
    const base: MusicTrack = { id, path: file.path, title: file.base, duration: 0, status: 'pending' }
    let track: MusicTrack
    try {
      const m = analyzeMusic(file.path, await ff.probe(file.path, signal))
      track = clean({ ...base, title: m.title, artist: m.artist, duration: m.duration })
      if (m.native) track = { ...track, status: 'ready', playback: file.path }
    } catch (err) {
      track = { ...base, status: 'error', error: shortError('Unsupported audio file', err) }
    }
    tracks.set(id, track)
    return track
  }

  // -------------------------------------------------------------------- API

  return {
    ffmpeg: ff,

    async importPaths(paths) {
      const files = await scanPaths(paths)
      const groups = pairFiles(files)
      const lists = await Promise.all(groups.map((g) => prepare(g)))
      const seen = new Set<string>()
      const result: MediaItem[] = []
      for (const it of lists.flat()) {
        if (seen.has(it.id)) continue
        seen.add(it.id)
        result.push({ ...(items.get(it.id) ?? it) })
      }
      schedule(result.filter((it) => it.status === 'pending').map((it) => it.id))
      return result.sort((a, b) => a.captureTime - b.captureTime || a.name.localeCompare(b.name, undefined, { numeric: true }))
    },

    async restoreMedia(list) {
      const requeue: string[] = []
      const result = await Promise.all(
        list.map(async (it) => {
          const current = items.get(it.id)
          if (current && current.status !== 'error') return { ...current }
          let changed = false
          try {
            const st = await stat(it.path)
            // Same id scheme as import: a different size/mtime means the original was edited
            changed = mediaId(it.path, st.size, st.mtimeMs) !== it.id
          } catch {
            return clean({ ...it, status: 'error' as const, error: 'missing', progress: undefined })
          }
          if (!changed && it.status === 'ready' && cacheFilesPresent(it)) {
            items.set(it.id, it)
            return { ...it }
          }
          const fresh = stripDerived(it)
          if (fresh.live && !existsSync(fresh.live.source)) delete fresh.live
          items.set(it.id, fresh)
          requeue.push(it.id)
          return { ...fresh }
        })
      )
      schedule(requeue)
      return result
    },

    async importMusic(paths) {
      const files = await scanPaths(paths, ['audio'])
      files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
      const result = await Promise.all(files.map((f) => metaLimit(() => prepareTrack(f))))
      scheduleMusic(result.filter((t) => t.status === 'pending').map((t) => t.id))
      return result.map((t) => ({ ...(tracks.get(t.id) ?? t) }))
    },

    async restoreMusic(list) {
      const requeue: string[] = []
      const result = list.map((t) => {
        const current = tracks.get(t.id)
        if (current && current.status !== 'error') return { ...current }
        if (!existsSync(t.path)) return { ...t, status: 'error' as const, error: 'missing' }
        if (t.status === 'ready' && t.playback && existsSync(t.playback)) {
          tracks.set(t.id, t)
          return { ...t }
        }
        const fresh: MusicTrack = clean({ ...t, status: 'pending' as const, playback: undefined, error: undefined })
        tracks.set(t.id, fresh)
        requeue.push(t.id)
        return { ...fresh }
      })
      scheduleMusic(requeue)
      return result
    },

    waveform(path, buckets) {
      const key = `${path}|${buckets}`
      let p = waveforms.get(key)
      if (!p) {
        p = computeWaveform(ff, path, buckets, signal)
        p.catch(() => waveforms.delete(key))
        waveforms.set(key, p)
      }
      return p
    },

    get(id) {
      const it = items.get(id)
      return it ? { ...it } : undefined
    },

    async idle() {
      do {
        await new Promise((r) => setImmediate(r))
        await Promise.allSettled([...jobs.values(), ...preparing.values()])
      } while (jobs.size || preparing.size)
    },

    async dispose() {
      if (disposed) return
      disposed = true
      abort.abort()
      raw.dispose()
      await Promise.allSettled([...jobs.values()])
      await endExiftool()
    }
  }
}
