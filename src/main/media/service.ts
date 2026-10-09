// Media import + background processing. Electron-free: the IPC layer injects directories and
// forwards onUpdate / onMusicUpdate to the renderer.
//
// Processing runs in phases so big imports stay responsive: every item first gets its thumbnail
// (photos straight from the original, videos one frame), then photos get their display JPEG and
// analysis (hash, sharpness), and only when no thumbnail/display work is left do video proxies start.
// Each item emits few updates: thumbnail ready (status 'processing'), then 'ready' or 'error'.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { extOf, SHARP_IMAGE_EXT } from '@shared/formats'
import type { ExportProgress, MediaItem, MusicTrack, Rect } from '@shared/types'
import { Ffmpeg, FfmpegError, type ProbeResult } from '../ffmpeg'
import { analyzeImage, imageHash } from './analysis'
import { analyzeMusic, computeWaveform, transcodeMusic } from './audio'
import { detectBeatsInFile } from './beats'
import { captureTimeOf, deviceOf, endExiftool, makeOf, orientationOf, readTags, type Tags } from './exif'
import { extractMotionVideo, isMotionPhoto } from './motion'
import { photoFormatLabel, renderPhoto, renderThumb } from './photo'
import { createLimiter, createPriorityLimiter } from './queue'
import { quickPhotoMeta } from './quickMeta'
import { RawDecoderPool, type RawDecoding } from './raw'
import { mediaId, pairFiles, scanPaths, type ImportGroup, type ScannedFile } from './scan'
import { extractAudio, PROXY_MAX, transcodeProxy, videoThumb } from './video'
import { analyzeVideo, isDirectPlayable, videoFormatLabel, type VideoInfo } from './videoInfo'

export interface MediaServiceConfig {
  ffmpegDir: string
  cacheDir: string
  onUpdate?: (item: MediaItem) => void
  onMusicUpdate?: (track: MusicTrack) => void
  /** Parallel thumbnail / display image / analysis tasks; default half the CPU threads, 2..8. */
  photoConcurrency?: number
  videoConcurrency?: number
  /** Injected for tests; defaults to two libraw-wasm worker threads. */
  rawDecoder?: RawDecoding
}

export interface HiresOptions {
  signal?: AbortSignal
  /** Phase 'prepare': frame/totalFrames count source frames, message is "2/5" (current/total clips). */
  onProgress?: (p: ExportProgress) => void
}

export interface MediaService {
  readonly ffmpeg: Ffmpeg
  importPaths(paths: string[]): Promise<MediaItem[]>
  restoreMedia(items: MediaItem[]): Promise<MediaItem[]>
  importMusic(paths: string[]): Promise<MusicTrack[]>
  restoreMusic(tracks: MusicTrack[]): Promise<MusicTrack[]>
  waveform(path: string, buckets: number): Promise<number[]>
  /** Stores face rects (normalised, clamped to 0..1) on a known item, persists and emits it. */
  setFaces(id: string, faces: Rect[]): Promise<void>
  /** Video id → playable path at up to maxEdge (hi-res proxies are created and cached as needed). */
  prepareHires(ids: string[], maxEdge: number, opts?: HiresOptions): Promise<Record<string, string>>
  get(id: string): MediaItem | undefined
  getTrack(id: string): MusicTrack | undefined
  /** Resolves when no import/transcode/analysis job is queued or running. */
  idle(): Promise<void>
  dispose(): Promise<void>
}

/** A Live Photo's motion part is ~3 s; a longer same-named MOV is treated as a separate video. */
const LIVE_MAX_SECONDS = 10
const META = 'meta.json'
const MUSIC_META = 'music.json'
const PRI_THUMB = 0
const PRI_DISPLAY = 1
const PRI_ANALYSIS = 2

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

function abortError(): Error {
  const e = new Error('cancelled')
  e.name = 'AbortError'
  return e
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

/** Ready items from older versions lack the analysis fields; they are filled in lazily. */
function needsAnalysis(item: MediaItem): boolean {
  if (item.status !== 'ready') return false
  if (item.kind === 'photo') return !!item.display && (item.hash === undefined || item.sharpness === undefined)
  return !!item.thumb && item.hash === undefined
}

/** Keeps well-formed rects, clamped into the unit square. */
export function sanitizeFaces(faces: unknown): Rect[] {
  if (!Array.isArray(faces)) return []
  const out: Rect[] = []
  const unit = (v: number): number => Math.min(1, Math.max(0, v))
  for (const f of faces.slice(0, 256)) {
    if (!f || typeof f !== 'object') continue
    const { x, y, w, h } = f as Record<string, unknown>
    if (![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) continue
    const x0 = unit(x as number)
    const y0 = unit(y as number)
    const x1 = unit((x as number) + (w as number))
    const y1 = unit((y as number) + (h as number))
    // Rounded: clamping arithmetic must not turn 0.3 into 0.30000000000000004
    const r6 = (v: number): number => Math.round(v * 1e6) / 1e6
    if (x1 > x0 && y1 > y0) out.push({ x: r6(x0), y: r6(y0), w: r6(x1 - x0), h: r6(y1 - y0) })
  }
  return out
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
  const writes = new Map<string, Promise<void>>()
  const tracks = new Map<string, MusicTrack>()
  const waveforms = new Map<string, Promise<number[]>>()
  const metaLimit = createLimiter(16)
  const threads = availableParallelism()
  const workers = config.photoConcurrency ?? Math.max(2, Math.min(8, Math.floor(threads / 2)))
  const work = createPriorityLimiter(workers)
  // Many images in parallel with few libvips threads each beats few images with many threads
  // (measured on 50 MP JPEGs: -35 % per photo); needs UV_THREADPOOL_SIZE >= workers (see threadpool.ts)
  sharp.concurrency(Math.max(1, Math.round(threads / workers)))
  const videoLimit = createLimiter(config.videoConcurrency ?? 2)
  const musicLimit = createLimiter(2)
  const beatLimit = createLimiter(1)
  let disposed = false

  const folder = (id: string): string => join(config.cacheDir, id)

  function emit(item: MediaItem): void {
    if (!disposed) config.onUpdate?.({ ...item })
  }

  /** Changes an item without telling the renderer (intermediate state inside a phase). */
  function set(id: string, patch: Partial<MediaItem>): MediaItem {
    const next = clean({ ...items.get(id)!, ...patch })
    items.set(id, next)
    return next
  }

  function update(id: string, patch: Partial<MediaItem>): MediaItem {
    const next = set(id, patch)
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

  /**
   * Writes a cache JSON file with the latest state, one write per file at a time (several jobs can
   * touch the same item: processing, lazy analysis, faces). A failed write only costs the cache.
   */
  function persistFile(path: string, data: () => unknown): Promise<void> {
    const next = (writes.get(path) ?? Promise.resolve())
      .then(async () => {
        const value = data()
        if (value) await writeJson(path, value)
      })
      .catch(() => {})
    writes.set(path, next)
    void next.finally(() => {
      if (writes.get(path) === next) writes.delete(path)
    })
    return next
  }

  const persist = (id: string): Promise<void> =>
    persistFile(join(folder(id), META), () => {
      const it = items.get(id)
      return it && it.status === 'ready' ? it : null
    })

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
    const [tags, sidecar, probed] = await Promise.all([
      readTags(file.path, true),
      sonySidecar(file),
      ff.probe(file.path, signal).then(
        (probe) => ({ probe }),
        (err: unknown) => ({ err })
      )
    ])
    if ('err' in probed) return { ...base, status: 'error', error: shortError('Unsupported or damaged video', probed.err) }
    const probe = probed.probe
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
    const base = { id, path: file.path, name: file.name, kind: 'photo' as const, status: 'pending' as const }
    const ctx: Context = {}
    let item: MediaItem
    // JPEG & co. with a zoned EXIF date: header-only read, exiftool runs later in the background
    const quick = SHARP_IMAGE_EXT.includes(file.ext) ? await quickPhotoMeta(file.path) : null
    if (quick?.captureTime !== undefined) {
      item = clean({
        ...base,
        format: photoFormatLabel(file.path, {} as Tags),
        device: deviceOf({ Make: quick.make, Model: quick.model } as Tags),
        width: quick.width,
        height: quick.height,
        captureTime: quick.captureTime
      })
    } else {
      const tags = await readTags(file.path, false)
      const t = tags as Record<string, unknown>
      let w = Number(t.ImageWidth) || quick?.width || 0
      let h = Number(t.ImageHeight) || quick?.height || 0
      if (t.ImageWidth && orientationOf(tags) >= 5) [w, h] = [h, w]
      item = clean({
        ...base,
        format: photoFormatLabel(file.path, tags),
        device: deviceOf(tags),
        width: w,
        height: h,
        captureTime: captureTimeOf(tags) ?? file.mtimeMs
      })
      ctx.tags = tags
    }
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
  function schedule(ids: string[], analyze: string[] = []): void {
    if (ids.length || analyze.length) {
      setImmediate(() => {
        ids.forEach(startJob)
        analyze.forEach(startAnalysis)
      })
    }
  }

  function trackJob(key: string, job: Promise<void>): void {
    const tracked = job.finally(() => {
      if (jobs.get(key) === tracked) jobs.delete(key)
    })
    jobs.set(key, tracked)
  }

  function startJob(id: string): void {
    if (jobs.has(id) || disposed || !items.has(id)) return
    trackJob(id, runJob(id))
  }

  async function runJob(id: string): Promise<void> {
    if (disposed) return
    const item = items.get(id)!
    try {
      await mkdir(folder(id), { recursive: true })
      if (item.kind === 'photo') await processPhoto(id)
      else await processVideo(id)
      if (disposed) return
      update(id, { status: 'ready', progress: undefined, error: undefined })
      await persist(id)
    } catch (err) {
      if (disposed) return
      const context = item.kind === 'photo' ? 'Photo could not be read' : 'Video could not be converted'
      update(id, { status: 'error', progress: undefined, error: shortError(context, err) })
    } finally {
      contexts.delete(id)
    }
  }

  async function processPhoto(id: string): Promise<void> {
    const item = items.get(id)!
    const ctx = contexts.get(id) ?? {}
    const dir = folder(id)
    const thumb = join(dir, 'thumb.jpg')
    const display = join(dir, 'display.jpg')
    let quickThumb = false
    if (SHARP_IMAGE_EXT.includes(extOf(item.path))) {
      quickThumb = await work(async () => {
        if (disposed) throw abortError()
        try {
          await renderThumb(item.path, thumb)
          return true
        } catch {
          return false // the display pass below reports the real problem
        }
      }, PRI_THUMB)
      if (quickThumb) update(id, { status: 'processing', thumb, error: undefined })
    }
    // Full tags (motion photo markers, RAW previews). Read after the thumbnail pass so exiftool's
    // ~120 ms per photo doesn't compete with it, and before the display slot is taken.
    const tags = ctx.tags ?? (await readTags(item.path, false))
    await work(async () => {
      if (disposed) throw abortError()
      if (!quickThumb) update(id, { status: 'processing', error: undefined })
      const out = await renderPhoto({ ff, raw }, item.path, tags, { display, thumb: quickThumb ? undefined : thumb }, signal)
      set(id, { width: out.width, height: out.height, display, thumb })
      try {
        set(id, await analyzeImage(display))
      } catch {
        // analysis is optional; restore retries it
      }
    }, PRI_DISPLAY)

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
      set(id, { live: undefined, liveVideo: undefined })
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
      set(id, { live, liveVideo })
    } catch (err) {
      if (isAbort(err)) throw err
      // The still is fine; only the motion part is unusable
      set(id, { live: undefined, liveVideo: undefined })
    }
  }

  async function processVideo(id: string): Promise<void> {
    const item = items.get(id)!
    const ctx = contexts.get(id) ?? {}
    const dir = folder(id)
    const thumb = join(dir, 'thumb.jpg')
    const { probe, info: vi } = await work(async () => {
      if (disposed) throw abortError()
      const probe = ctx.probe ?? (await ff.probe(item.path, signal))
      const info = analyzeVideo(probe)
      if (!info) throw new Error('no video stream')
      await videoThumb(ff, item.path, info, thumb, signal)
      const hash = await imageHash(thumb).catch(() => undefined)
      update(id, { status: 'processing', thumb, hash, error: undefined })
      return { probe, info }
    }, PRI_THUMB)
    // Photos first: proxies would compete with the display images for the CPU
    await work.drained(PRI_DISPLAY)
    await videoLimit(async () => {
      if (disposed) throw abortError()
      if (vi.hasAudio) {
        const audio = join(dir, 'audio.m4a')
        try {
          await extractAudio(ff, item.path, vi, audio, signal)
          set(id, { audio, hasAudio: true })
        } catch (err) {
          if (isAbort(err)) throw err
          set(id, { audio: undefined, hasAudio: false })
        }
      }
      if (isDirectPlayable(item.path, probe, vi)) {
        set(id, { playback: item.path, proxied: false })
        return
      }
      const proxy = join(dir, 'proxy.mp4')
      const encoders = await ff.encoders()
      let last = 0
      let lastAt = 0
      await transcodeProxy(ff, item.path, vi, proxy, {
        signal,
        encoders,
        onProgress: (p) => {
          const now = Date.now()
          if (p - last >= 0.02 && now - lastAt >= 500) {
            last = p
            lastAt = now
            update(id, { progress: Math.round(p * 1000) / 1000 })
          }
        }
      })
      set(id, { playback: proxy, proxied: true })
    })
  }

  function startAnalysis(id: string): void {
    const key = `analysis:${id}`
    if (jobs.has(key) || disposed) return
    const job = work(async () => {
      const it = items.get(id)
      if (!it || disposed || !needsAnalysis(it)) return
      if (it.kind === 'photo') update(id, await analyzeImage(it.display!))
      else update(id, { hash: await imageHash(it.thumb!) })
      await persist(id)
    }, PRI_ANALYSIS).catch(() => {})
    trackJob(key, job)
  }

  // ------------------------------------------------------------------ hi-res

  async function prepareHires(ids: string[], maxEdge: number, opts: HiresOptions = {}): Promise<Record<string, string>> {
    const edge = Math.round(maxEdge)
    const stop = opts.signal ? AbortSignal.any([signal, opts.signal]) : signal
    const result: Record<string, string> = {}
    const todo: Array<{ id: string; src: string; out: string; info: VideoInfo; frames: number }> = []
    for (const id of new Set(ids)) {
      const it = items.get(id)
      if (!it || it.kind !== 'video' || !it.playback) continue
      result[id] = it.playback
      if (!it.proxied || !(edge > PROXY_MAX) || Math.max(it.width, it.height) <= PROXY_MAX) continue
      const out = join(folder(id), `proxy_${edge}.mp4`)
      if (existsSync(out)) {
        result[id] = out
        continue
      }
      try {
        const info = analyzeVideo(await ff.probe(it.path, stop))
        if (info) todo.push({ id, src: it.path, out, info, frames: Math.max(1, Math.round(info.duration * info.proxyFps)) })
      } catch {
        // unreadable now: keep the regular proxy
        if (stop.aborted) throw abortError()
      }
    }
    if (!todo.length) return result
    const totalFrames = todo.reduce((n, t) => n + t.frames, 0)
    const report = opts.onProgress ?? (() => {})
    const encoders = await ff.encoders()
    let done = 0
    for (let i = 0; i < todo.length; i++) {
      const t = todo[i]
      const message = `${i + 1}/${todo.length}`
      report({ phase: 'prepare', frame: done, totalFrames, message })
      let lastAt = 0
      try {
        await mkdir(folder(t.id), { recursive: true })
        await transcodeProxy(ff, t.src, t.info, t.out, {
          signal: stop,
          encoders,
          maxEdge: edge,
          onProgress: (p) => {
            const now = Date.now()
            if (now - lastAt >= 250) {
              lastAt = now
              report({ phase: 'prepare', frame: done + Math.round(p * t.frames), totalFrames, message })
            }
          }
        })
        result[t.id] = t.out
      } catch (err) {
        if (stop.aborted || isAbort(err)) throw abortError()
        // keep the regular proxy for this clip
      }
      done += t.frames
    }
    report({ phase: 'prepare', frame: totalFrames, totalFrames, message: `${todo.length}/${todo.length}` })
    return result
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

  const persistTrack = (id: string): Promise<void> =>
    persistFile(join(folder(id), MUSIC_META), () => {
      const t = tracks.get(id)
      return t && t.status === 'ready' ? t : null
    })

  function scheduleMusic(transcode: string[], beats: string[]): void {
    if (transcode.length || beats.length) {
      setImmediate(() => {
        transcode.forEach(startMusicJob)
        beats.forEach(startBeatJob)
      })
    }
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
        updateTrack(id, { status: 'ready', playback: out })
        await persistTrack(id)
      } catch (err) {
        if (!disposed) updateTrack(id, { status: 'error', error: shortError('Audio could not be converted', err) })
      }
    })
    trackJob(`music:${id}`, job)
  }

  /** Beats are added to a track that is already usable; failures leave `beats` unset (retried on restore). */
  function startBeatJob(id: string): void {
    const key = `beats:${id}`
    if (jobs.has(key) || disposed) return
    const job = beatLimit(async () => {
      const t = tracks.get(id)
      if (!t || t.beats || t.status === 'error' || disposed) return
      await mkdir(folder(id), { recursive: true })
      const r = await detectBeatsInFile(ff, t.path, signal)
      if (disposed || !tracks.has(id)) return
      // No pulse found: an empty list, so it is not analysed again
      updateTrack(id, r ? { beats: r.beats, bpm: r.bpm } : { beats: [], bpm: undefined })
      await persistTrack(id)
    }).catch(() => {})
    trackJob(key, job)
  }

  const wantsBeats = (t: MusicTrack): boolean => t.status !== 'error' && !t.beats

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
      schedule(
        result.filter((it) => it.status === 'pending').map((it) => it.id),
        result.filter(needsAnalysis).map((it) => it.id)
      )
      return result.sort((a, b) => a.captureTime - b.captureTime || a.name.localeCompare(b.name, undefined, { numeric: true }))
    },

    async restoreMedia(list) {
      const requeue: string[] = []
      const analyze: string[] = []
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
            if (needsAnalysis(it)) analyze.push(it.id)
            return { ...it }
          }
          let fresh = stripDerived(it)
          // An edited original invalidates what was derived from its content
          if (changed) fresh = clean({ ...fresh, faces: undefined, sharpness: undefined, hash: undefined })
          if (fresh.live && !existsSync(fresh.live.source)) delete fresh.live
          items.set(it.id, fresh)
          requeue.push(it.id)
          return { ...fresh }
        })
      )
      schedule(requeue, analyze)
      return result
    },

    async importMusic(paths) {
      const files = await scanPaths(paths, ['audio'])
      files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
      const result = await Promise.all(files.map((f) => metaLimit(() => prepareTrack(f))))
      scheduleMusic(
        result.filter((t) => t.status === 'pending').map((t) => t.id),
        result.filter(wantsBeats).map((t) => t.id)
      )
      return result.map((t) => ({ ...(tracks.get(t.id) ?? t) }))
    },

    async restoreMusic(list) {
      const requeue: string[] = []
      const beats: string[] = []
      const result = await Promise.all(
        list.map(async (t) => {
          const current = tracks.get(t.id)
          if (current && current.status !== 'error') return { ...current }
          if (!existsSync(t.path)) return { ...t, status: 'error' as const, error: 'missing' }
          if (t.status === 'ready' && t.playback && existsSync(t.playback)) {
            tracks.set(t.id, t)
            if (wantsBeats(t)) beats.push(t.id)
            return { ...t }
          }
          let fresh: MusicTrack = clean({ ...t, status: 'pending' as const, playback: undefined, error: undefined })
          // Cache gone or a packed project from another PC: formats Chromium plays need no transcode
          try {
            const m = analyzeMusic(t.path, await ff.probe(t.path, signal))
            if (m.native) fresh = { ...fresh, status: 'ready', playback: t.path, duration: fresh.duration || m.duration }
          } catch {
            // the transcode job reports what is wrong with the file
          }
          tracks.set(t.id, fresh)
          if (fresh.status === 'pending') requeue.push(t.id)
          if (wantsBeats(fresh)) beats.push(t.id)
          return { ...fresh }
        })
      )
      scheduleMusic(requeue, beats)
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

    async setFaces(id, faces) {
      if (!items.has(id)) {
        if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return
        const cached = await fromCache(id)
        if (!cached) return
        items.set(id, cached)
      }
      update(id, { faces: sanitizeFaces(faces) })
      await persist(id)
    },

    prepareHires,

    get(id) {
      const it = items.get(id)
      return it ? { ...it } : undefined
    },

    getTrack(id) {
      const t = tracks.get(id)
      return t ? { ...t } : undefined
    },

    async idle() {
      do {
        await new Promise((r) => setImmediate(r))
        await Promise.allSettled([...jobs.values(), ...preparing.values(), ...writes.values()])
      } while (jobs.size || preparing.size || writes.size)
    },

    async dispose() {
      if (disposed) return
      disposed = true
      abort.abort()
      raw.dispose()
      await Promise.allSettled([...jobs.values(), ...writes.values()])
      await endExiftool()
    }
  }
}
