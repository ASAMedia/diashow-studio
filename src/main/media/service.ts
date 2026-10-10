// Media import + background processing. Electron-free: the IPC layer injects directories and
// forwards onUpdate / onMusicUpdate to the renderer.
//
// Processing keeps big imports responsive (see "processing" below): every item first gets its
// thumbnail (photos straight from the original, videos one frame), in show order, with whatever the
// renderer focuses (prioritize) first. Then display JPEGs (CPU), video sound (disk) and proxies (GPU)
// run side by side; videos the renderer decodes need no proxy at all (playbackPlan). Hash and
// sharpness come last, once every item is usable.
// Each item emits few updates: thumbnail ready (status 'processing'), then 'ready' or 'error', then
// one with the analysis. Loudness of video sound is measured while it is extracted; music and older
// cache entries get it lazily with an extra update.
import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { availableParallelism, constants } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { extOf, SHARP_IMAGE_EXT } from '@shared/formats'
import type { CacheInfo, ExportProgress, MediaItem, MusicTrack, Rect } from '@shared/types'
import { cacheInfo as scanCacheInfo, cleanCache as cleanCacheDir, ID_FOLDER, type CleanTarget } from '../cache'
import { Ffmpeg, FfmpegError, type ProbeResult } from '../ffmpeg'
import { analyzeImage, imageHash } from './analysis'
import { analyzeMusic, computeWaveform, transcodeMusic } from './audio'
import { detectBeatsInFile } from './beats'
import { captureTimeOf, deviceOf, endExiftool, makeOf, orientationOf, readTags, type Tags } from './exif'
import { detectGpuTonemap, type GpuTonemap } from './hdr'
import { measureLoudness } from './loudness'
import { endsAtJpegEoi, extractMotionVideo, isMotionPhoto } from './motion'
import { photoFormatLabel, renderPhoto, renderThumb } from './photo'
import { createGate, createLimiter, createPriorityLimiter, MediaOrder, type Gate } from './queue'
import { quickPhotoMeta } from './quickMeta'
import { RawDecoderPool, type RawDecoding } from './raw'
import { mediaId, pairFiles, scanPaths, type ImportGroup, type ScannedFile } from './scan'
import { createTracer } from './trace'
import { extractAudioWithLoudness, gpuEligible, PROXY_MAX, remuxVideo, stripFiles, transcodeProxy, videoStrip, videoThumb } from './video'
import { analyzeVideo, canCopyAudio, playbackPlan, streamProxyReason, videoFormatLabel, type DirectDecode, type VideoInfo } from './videoInfo'

export interface MediaServiceConfig {
  ffmpegDir: string
  cacheDir: string
  onUpdate?: (item: MediaItem) => void
  onMusicUpdate?: (track: MusicTrack) => void
  /** Parallel thumbnail / display image / analysis tasks; default 60 % of the CPU threads, 2..12. */
  photoConcurrency?: number
  /** Parallel proxy transcodes (hardware encoder sessions); default 4 (short clips spend ~1 s starting up). */
  videoConcurrency?: number
  /** Parallel audio extractions and remuxes (disk, little CPU); default 3. */
  audioConcurrency?: number
  /**
   * Decoders the renderer has besides H.264/VP9/AV1 (src/main/codecSupport.ts), asked when a video's
   * playback is decided. Without it, HEVC originals get proxies.
   */
  directDecode?: () => Promise<DirectDecode>
  /** Injected for tests; defaults to two libraw-wasm worker threads. */
  rawDecoder?: RawDecoding
  /** Make proxies on the GPU when available: HDR tone mapping, and SDR sources the GPU decodes (default true). */
  hdrGpu?: boolean
}

/** What saved projects use (ProjectStore.references()). */
export interface CacheUsage {
  ids: Set<string>
  paths: string[]
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
  /**
   * `count` JPEG frames `height` px high spread evenly over a video (original or proxy), cached in the
   * media's cache folder per count/height.
   */
  videoStrip(path: string, count: number, height: number): Promise<string[]>
  /** Cache size by kind; media folders neither used by saved projects nor in work count as unused. */
  cacheInfo(used: CacheUsage): Promise<CacheInfo>
  /** Deletes unused folders / hi-res proxies / all proxies; affected items are rebuilt on restore. */
  cleanCache(what: CleanTarget, used: CacheUsage): Promise<CacheInfo>
  /**
   * Finds moved originals (same file name; same size and time preferred) in `folder` and imports them
   * like importPaths. Resolves with old id → new item for the ones found.
   */
  relinkMedia(missing: MediaItem[], folder: string): Promise<Record<string, MediaItem>>
  /**
   * The renderer shows these media / music ids (most urgent first): all their pending work goes ahead
   * of everything else, and they skip the waits for other items. Each call replaces the previous one;
   * [] returns to show order. Unknown ids are ignored; running work is never interrupted.
   */
  prioritize(ids: string[]): void
  /** Resolves when no import/transcode/analysis job is queued or running. */
  idle(): Promise<void>
  dispose(): Promise<void>
}

/** A Live Photo's motion part is ~3 s; a longer same-named MOV is treated as a separate video. */
const LIVE_MAX_SECONDS = 10
const META = 'meta.json'
const MUSIC_META = 'music.json'
/** Size and modification time of the original a media folder was made from (relink). */
const SOURCE = 'source.json'
/** Freshly imported items count as used by the cache cleanup until the renderer saved its project. */
const RECENT_MS = 5 * 60_000
/** GPU proxies run above normal priority (see ProxyOptions.gpuPriority). */
const GPU_PRIORITY = constants.priority.PRIORITY_ABOVE_NORMAL
/** Stills that may carry a Motion Photo video after their image data. */
const JPEG_EXT = ['jpg', 'jpeg', 'jpe', 'jfif']
/** Work classes (MediaOrder.key): thumbnails, then display images / sound / playback, then analysis. */
const PRI_THUMB = 0
const PRI_DISPLAY = 1
const PRI_ANALYSIS = 2

interface Context {
  tags?: Tags
  probe?: ProbeResult
  liveProbe?: ProbeResult
  /** JPEG & co. read with quickPhotoMeta: the XMP announces an embedded video. */
  motionXmp?: boolean
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

const isInside = (file: string, dir: string): boolean => resolve(file).toLowerCase().startsWith(resolve(dir).toLowerCase() + sep)

/**
 * A ready item whose only missing cache file is its transcoded proxy (e.g. after a cache cleanup):
 * 'video' (playback proxy) or 'live' (Live Photo motion proxy); null when anything else is missing.
 */
function missingProxyOnly(item: MediaItem, cacheDir: string): 'video' | 'live' | null {
  if (item.status !== 'ready' || (item.live && !existsSync(item.live.source))) return null
  for (const key of ['thumb', 'display', 'audio'] as const) {
    const v = item[key]
    if (typeof v === 'string' && !existsSync(v)) return null
  }
  if (item.kind === 'video') {
    // A proxy or a remux (proxied false): any playback copy in the cache can be made again
    if (!item.thumb || !item.playback || existsSync(item.playback) || !isInside(item.playback, cacheDir)) return null
    return 'video'
  }
  if (!item.display || !item.live || !item.liveVideo || existsSync(item.liveVideo) || !isInside(item.liveVideo, cacheDir)) return null
  return 'live'
}

/**
 * Best match for a missing item among same-named files: same size and modification time (the media
 * id proves it) first, then the known size (a known, different size never matches), then the longest
 * run of matching parent folder names. Ties without a size match return null rather than a guess.
 */
export function pickRelinkCandidate(
  item: MediaItem,
  candidates: ScannedFile[],
  knownSize?: number
): { file: ScannedFile; exact: boolean } | null {
  if (!candidates.length) return null
  const folders = (p: string): string[] => dirname(p).split(/[\\/]/).reverse().map((s) => s.toLowerCase())
  const old = folders(item.path)
  const ranked = candidates
    .map((file) => {
      const f = folders(file.path)
      let tail = 0
      while (tail < old.length && tail < f.length && old[tail] === f[tail]) tail++
      const exact = mediaId(item.path, file.size, file.mtimeMs) === item.id
      return { file, exact, size: exact || file.size === knownSize, tail }
    })
    .sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.size) - Number(a.size) || b.tail - a.tail)
  const [best, second] = ranked
  if (best.exact) return { file: best.file, exact: true }
  if (knownSize !== undefined && !best.size) return null
  if (best.size || !second || best.tail > second.tail) return { file: best.file, exact: false }
  return null
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
  const workers = config.photoConcurrency ?? Math.max(2, Math.min(12, Math.floor(threads * 0.6)))
  /** Show order and the renderer's focus, shared by every queue and gate below. */
  const order = new MediaOrder()
  /** CPU: thumbnails, display images, analysis. */
  const work = createPriorityLimiter(workers, order)
  // Many images in parallel with few libvips threads each beats few images with many threads
  // (measured on 50 MP JPEGs: -35 % per photo; 12 x 2 threads beat 8 x 3 by ~15 % on 20 threads);
  // needs UV_THREADPOOL_SIZE >= workers (see threadpool.ts)
  sharp.concurrency(Math.max(1, Math.round(threads / workers)))
  /** Hardware encoder sessions: proxies (Live Photo motion parts included). */
  const encodeWork = createPriorityLimiter(config.videoConcurrency ?? 4, order)
  /** Disk-bound FFmpeg runs: video sound (+ loudness), remuxes. */
  const audioWork = createPriorityLimiter(config.audioConcurrency ?? 3, order)
  /** Items still without a thumbnail; heavier work of other items waits for them. */
  const thumbGate = createGate(order)
  /** Photos still without a display image; CPU-decoded proxies wait for them. */
  const displayGate = createGate(order)
  /** Items (and music transcodes) still being processed; hash / sharpness / lazy loudness wait for them. */
  const essentialGate = createGate(order)
  const musicLimit = createLimiter(2)
  const beatLimit = createLimiter(1)
  /** Media / track ids whose loudness was measured this session (silent ones stay undefined). */
  const loudnessTried = new Set<string>()
  const strips = new Map<string, Promise<string[]>>()
  const recent = new Map<string, number>()
  const trace = createTracer()
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

  const shaderCache = join(config.cacheDir, 'gpu')
  /** The GPU path for this source (HDR tone mapping, or an SDR stream the GPU decodes), else null. */
  /** The one-off GPU path detection, once started (dispose waits for it: it cleans up temp files). */
  let gpuDetection: Promise<unknown> | null = null
  const gpuFor = async (vi: VideoInfo): Promise<GpuTonemap | null> => {
    if (config.hdrGpu === false) return null
    const detecting = detectGpuTonemap(ff)
    gpuDetection ??= detecting
    const gpu = await detecting
    if (!gpu || !gpuEligible(vi, gpu)) return null
    await mkdir(shaderCache, { recursive: true }).catch(() => {})
    return gpu
  }

  /** Loudness or undefined (silent, undecodable); only cancellation is thrown. */
  async function loudnessOf(path: string): Promise<number | undefined> {
    try {
      return await measureLoudness(ff, path, signal)
    } catch (err) {
      if (isAbort(err) || signal.aborted) throw abortError()
      return undefined
    }
  }

  const wantsLoudness = (it: MediaItem): boolean =>
    it.status === 'ready' && it.kind === 'video' && !!it.audio && it.loudness === undefined && !loudnessTried.has(it.id)
  const wantsAnalysis = (it: MediaItem): boolean => needsAnalysis(it) || wantsLoudness(it)

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
    // GPU path detection runs while the thumbnails are made, before the first proxy (whether HEVC
    // plays directly is only known later: assume it does)
    if (streamProxyReason(info, { hevc: true })) void gpuFor(info)
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
    // JPEG & co. with a zoned EXIF date: header-only read; exiftool runs later in the background, and
    // only when the file may hold a Motion Photo
    const quick = SHARP_IMAGE_EXT.includes(file.ext) ? await quickPhotoMeta(file.path) : null
    if (quick?.captureTime !== undefined) {
      ctx.motionXmp = !!quick.motionXmp
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
      const result = await trace.span('prepare', id, async () => (f.kind === 'video' ? [await prepareVideo(f, id)] : await preparePhoto(group, id)), { kind: f.kind })
      for (const it of result) items.set(it.id, it)
      return result
    }).finally(() => preparing.delete(id))
    preparing.set(id, task)
    return task
  }

  // -------------------------------------------------------------- processing
  //
  // Order of work (MediaOrder): what the renderer looks at (prioritize) first, then the show order.
  // Every item gets its thumbnail before any heavier work starts (thumbGate). Then, in parallel and
  // each on its own resource: display images (CPU pool), the videos' sound and remuxes (audio pool)
  // and proxies (encoder pool: those on the GPU path start at once, CPU-decoded ones once the display
  // images are done, displayGate). Hash, sharpness and lazily filled loudness come last, once every
  // item has its thumbnail, display image / playable video and sound (essentialGate); music beats and
  // loudness only wait for the thumbnails and display images (afterCpuWork).
  // Measured on 625 phone files (17 GB): everything ready after 130 s instead of 558 s; the hardware
  // encoder (NVENC, ~300 fps at 1080p) is then the limit.

  /**
   * Called once an API call has its complete result: jobs start on the next macrotask, so the IPC
   * reply carrying the 'pending' items reaches the renderer before the first media:update for them.
   */
  function schedule(ids: string[], analyze: string[] = [], reproxy: string[] = []): void {
    if (ids.length || analyze.length || reproxy.length) {
      setImmediate(() => {
        ids.forEach(startJob)
        analyze.forEach(startAnalysis)
        reproxy.forEach(startReproxy)
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

  /** leave() of a gate that may be called more than once for the same entry. */
  function once(gate: Gate): () => void {
    gate.enter()
    let left = false
    return () => {
      if (left) return
      left = true
      gate.leave()
    }
  }

  async function runJob(id: string): Promise<void> {
    if (disposed) return
    const item = items.get(id)!
    // Entered synchronously, so every item of a schedule() is counted before any of them waits
    const leaveEssential = once(essentialGate)
    const leaveThumb = once(thumbGate)
    const leaveDisplay = item.kind === 'photo' ? once(displayGate) : () => {}
    let ready = false
    try {
      await mkdir(folder(id), { recursive: true })
      const stages = { leaveThumb, leaveDisplay }
      await trace.span('job', id, () => (item.kind === 'photo' ? processPhoto(id, stages) : processVideo(id, stages)), { kind: item.kind })
      if (disposed) return
      update(id, { status: 'ready', progress: undefined, error: undefined })
      ready = true
      await persist(id)
      await rememberSource(id)
    } catch (err) {
      if (disposed) return
      const context = item.kind === 'photo' ? 'Photo could not be read' : 'Video could not be converted'
      update(id, { status: 'error', progress: undefined, error: shortError(context, err) })
    } finally {
      contexts.delete(id)
      leaveThumb()
      leaveDisplay()
      leaveEssential()
    }
    if (ready && wantsAnalysis(items.get(id)!)) startAnalysis(id)
  }

  /** Size + time of the original next to the cache, so relinking can recognise a moved file. */
  async function rememberSource(id: string): Promise<void> {
    const it = items.get(id)
    if (!it) return
    try {
      const st = await stat(it.path)
      await writeJson(join(folder(id), SOURCE), { size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      // only relinking gets less precise
    }
  }

  interface Stages {
    /** Thumbnail done (or failed): later stages of other items may start. */
    leaveThumb: () => void
    /** Display image done (or failed). */
    leaveDisplay: () => void
  }

  async function processPhoto(id: string, stages: Stages): Promise<void> {
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
          await trace.span('photo.thumb', id, () => renderThumb(item.path, thumb))
          return true
        } catch {
          return false // the display pass below reports the real problem
        }
      }, PRI_THUMB, id)
      if (quickThumb) update(id, { status: 'processing', thumb, error: undefined })
    }
    // Formats without a quick thumbnail (HEIC, RAW, …) get theirs with the display image, which
    // then counts as their thumbnail stage
    if (quickThumb) stages.leaveThumb()
    // Full tags (motion photo markers, RAW previews). Read after the thumbnail pass so exiftool's
    // ~120 ms per photo doesn't compete with it, and before the display slot is taken.
    // A plain JPEG (nothing after its image data, no video in its XMP) needs nothing else from them:
    // sharp reads its orientation and colour profile itself. That saves exiftool's ~150 ms of CPU
    // per photo while the thumbnails are made.
    const plainJpeg = ctx.motionXmp === false && JPEG_EXT.includes(extOf(item.path)) && (await endsAtJpegEoi(item.path))
    const tags = ctx.tags ?? (plainJpeg ? ({} as Tags) : await trace.span('photo.tags', id, () => readTags(item.path, false)))
    await work(async () => {
      if (disposed) throw abortError()
      if (!quickThumb) update(id, { status: 'processing', error: undefined })
      const out = await trace.span('photo.display', id, () => renderPhoto({ ff, raw }, item.path, tags, { display, thumb: quickThumb ? undefined : thumb }, signal), { ext: extOf(item.path) })
      set(id, { width: out.width, height: out.height, display, thumb })
    }, quickThumb ? PRI_DISPLAY : PRI_THUMB, id)
    stages.leaveThumb()
    stages.leaveDisplay()

    let live = item.live && existsSync(item.live.source) ? item.live : undefined
    let liveProbe = live ? ctx.liveProbe : undefined
    if (!live && isMotionPhoto(tags)) {
      try {
        const motion = join(dir, 'motion.mp4')
        await trace.span('photo.motion', id, () => extractMotionVideo(item.path, tags, motion))
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
      set(id, { live, liveVideo: await makeLiveVideo(id, live.source, liveProbe) })
    } catch (err) {
      if (isAbort(err)) throw err
      // The still is fine; only the motion part is unusable
      set(id, { live: undefined, liveVideo: undefined })
    }
  }

  /** What the renderer decodes besides H.264/VP9/AV1 (asked per video; the answer is cached by the caller). */
  async function directDecode(): Promise<DirectDecode> {
    try {
      return (await config.directDecode?.()) ?? {}
    } catch {
      return {}
    }
  }

  /** Playable motion part of a Live/Motion photo: the source itself, a remux or an H.264 proxy (live.mp4). */
  async function makeLiveVideo(id: string, source: string, probe?: ProbeResult): Promise<string> {
    probe ??= await ff.probe(source, signal)
    const info = analyzeVideo(probe)
    if (!info) throw new Error('no video stream')
    const plan = playbackPlan(source, probe, info, await directDecode())
    if (plan.kind === 'direct') return source
    const target = join(folder(id), 'live.mp4')
    if (plan.kind === 'remux') {
      await audioWork(() => trace.span('live.remux', id, () => remuxVideo(ff, source, info, target, { signal }), { reason: plan.reason }), PRI_DISPLAY, id)
      return target
    }
    const [encoders, gpu] = await Promise.all([ff.encoders(), gpuFor(info)])
    await encodeWork(
      () => trace.span('live.proxy', id, () => transcodeProxy(ff, source, info, target, { signal, encoders, gpu, shaderCache, gpuPriority: GPU_PRIORITY }), { reason: plan.reason, duration: info.duration }),
      PRI_DISPLAY,
      id
    )
    return target
  }

  /**
   * Sets playback: the original when the renderer plays it, else a remux or an H.264 proxy (progress
   * updates). Remuxes and GPU proxies start once all thumbnails exist; proxies decoded on the CPU
   * also wait for the display images, which they would slow down.
   */
  async function makeVideoPlayback(id: string, probe: ProbeResult, vi: VideoInfo): Promise<void> {
    const item = items.get(id)!
    const plan = playbackPlan(item.path, probe, vi, await directDecode())
    if (plan.kind === 'direct') {
      trace.mark('video.direct', id, { codec: vi.stream.codec_name })
      set(id, { playback: item.path, proxied: false })
      return
    }
    // Remux and proxy share the file name: both are rebuildable playback copies (cache cleanup)
    const out = join(folder(id), 'proxy.mp4')
    let last = 0
    let lastAt = 0
    const onProgress = (p: number): void => {
      const now = Date.now()
      if (p - last >= 0.02 && now - lastAt >= 500) {
        last = p
        lastAt = now
        update(id, { progress: Math.round(p * 1000) / 1000 })
      }
    }
    await thumbGate.wait(id)
    if (plan.kind === 'remux') {
      await audioWork(async () => {
        if (disposed) throw abortError()
        await trace.span('video.remux', id, () => remuxVideo(ff, item.path, vi, out, { signal, onProgress }), { reason: plan.reason, duration: vi.duration })
      }, PRI_DISPLAY, id)
      set(id, { playback: out, proxied: false })
      return
    }
    const [encoders, gpu] = await Promise.all([ff.encoders(), gpuFor(vi)])
    const onGpu = !!gpu
    if (!onGpu) await trace.span('video.waitDisplays', id, () => displayGate.wait(id))
    const traceInfo = { reason: plan.reason, duration: vi.duration, codec: vi.stream.codec_name, edge: Math.max(vi.width, vi.height), fps: vi.fps, gpu: onGpu ? gpu!.decode : null }
    await encodeWork(async () => {
      if (disposed) throw abortError()
      await trace.span('video.proxy', id, () => transcodeProxy(ff, item.path, vi, out, { signal, encoders, gpu, shaderCache, onProgress, gpuPriority: GPU_PRIORITY }), traceInfo)
    }, PRI_DISPLAY, id)
    set(id, { playback: out, proxied: true })
  }

  /** The video's sound (audio.m4a) and its loudness, read in one pass; no sound when that fails. */
  async function makeVideoSound(id: string, probe: ProbeResult, vi: VideoInfo): Promise<void> {
    const item = items.get(id)!
    const audio = join(folder(id), 'audio.m4a')
    await thumbGate.wait(id)
    try {
      const loudness = await audioWork(async () => {
        if (disposed) throw abortError()
        const extract = (copy: boolean): Promise<number | undefined> =>
          trace.span('video.audio', id, () => extractAudioWithLoudness(ff, item.path, vi, audio, { signal, copy }), { duration: vi.duration, copy })
        const copy = canCopyAudio(probe, vi)
        try {
          return await extract(copy)
        } catch (err) {
          // An odd stream the MP4 muxer refuses as is: encode it instead
          if (!copy || isAbort(err) || signal.aborted) throw err
          return await extract(false)
        }
      }, PRI_DISPLAY, id)
      set(id, { audio, hasAudio: true, loudness })
    } catch (err) {
      if (isAbort(err) || signal.aborted) throw abortError()
      set(id, { audio: undefined, hasAudio: false, loudness: undefined })
    }
    loudnessTried.add(id)
  }

  async function processVideo(id: string, stages: Stages): Promise<void> {
    const item = items.get(id)!
    const ctx = contexts.get(id) ?? {}
    const thumb = join(folder(id), 'thumb.jpg')
    let probe: ProbeResult
    let vi: VideoInfo
    try {
      ;({ probe, info: vi } = await work(async () => {
        if (disposed) throw abortError()
        const probe = ctx.probe ?? (await ff.probe(item.path, signal))
        const info = analyzeVideo(probe)
        if (!info) throw new Error('no video stream')
        await trace.span('video.thumb', id, () => videoThumb(ff, item.path, info, thumb, signal), { codec: info.stream.codec_name, hdr: info.hdr })
        update(id, { status: 'processing', thumb, error: undefined })
        return { probe, info }
      }, PRI_THUMB, id))
    } finally {
      stages.leaveThumb()
    }
    // Sound and picture on their own resources at the same time; the item is ready when both are
    const results = await Promise.allSettled([vi.hasAudio ? makeVideoSound(id, probe, vi) : Promise.resolve(), makeVideoPlayback(id, probe, vi)])
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) throw failed.reason
  }

  /** Restored item whose proxy was deleted: only the proxy is made again. */
  function startReproxy(id: string): void {
    if (jobs.has(id) || disposed || !items.has(id)) return
    trackJob(id, runReproxy(id))
  }

  async function runReproxy(id: string): Promise<void> {
    const item = items.get(id)!
    const leaveEssential = once(essentialGate)
    try {
      await mkdir(folder(id), { recursive: true })
      if (item.kind === 'video') {
        const probe = await ff.probe(item.path, signal)
        const vi = analyzeVideo(probe)
        if (!vi) throw new Error('no video stream')
        await makeVideoPlayback(id, probe, vi)
        if (disposed) return
        update(id, { status: 'ready', progress: undefined, error: undefined })
      } else {
        const liveVideo = await makeLiveVideo(id, item.live!.source)
        if (disposed) return
        update(id, { liveVideo })
      }
      await persist(id)
    } catch (err) {
      if (disposed) return
      if (item.kind === 'video') update(id, { status: 'error', progress: undefined, error: shortError('Video could not be converted', err) })
      else {
        update(id, { live: undefined, liveVideo: undefined })
        await persist(id)
      }
    } finally {
      leaveEssential()
    }
    const it = items.get(id)
    if (it && wantsAnalysis(it)) startAnalysis(id)
  }

  /**
   * Hash / sharpness (photos), hash (videos) and loudness of older cache entries. Waits until every
   * item has its essential files (thumbnail, display image, playable video, sound), unless the
   * renderer focuses this item; runs at the lowest priority of the CPU pool.
   */
  function startAnalysis(id: string): void {
    const key = `analysis:${id}`
    if (jobs.has(key) || disposed) return
    const job = (async () => {
      await essentialGate.wait(id)
      await work(async () => {
        const it = items.get(id)
        if (!it || disposed || !wantsAnalysis(it)) return
        const patch: Partial<MediaItem> = {}
        if (needsAnalysis(it)) {
          try {
            Object.assign(patch, await trace.span('analysis', id, async () => (it.kind === 'photo' ? await analyzeImage(it.display!) : { hash: await imageHash(it.thumb!) }), { kind: it.kind }))
          } catch {
            // retried on the next restore
          }
        }
        if (wantsLoudness(it)) {
          loudnessTried.add(id)
          const loudness = await trace.span('loudness', id, () => loudnessOf(it.audio!))
          if (loudness !== undefined) patch.loudness = loudness
        }
        if (disposed || !Object.keys(patch).length || items.get(id)?.status !== 'ready') return
        update(id, patch)
        await persist(id)
      }, PRI_ANALYSIS, id)
    })().catch(() => {})
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
          gpu: await gpuFor(t.info),
          shaderCache,
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

  function scheduleMusic(transcode: string[], beats: string[], loudness: string[] = []): void {
    if (transcode.length || beats.length || loudness.length) {
      setImmediate(() => {
        transcode.forEach(startMusicJob)
        beats.forEach(startBeatJob)
        loudness.forEach(startTrackLoudness)
      })
    }
  }

  const trackWantsLoudness = (t: MusicTrack): boolean =>
    t.status === 'ready' && !!t.playback && t.loudness === undefined && !loudnessTried.has(t.id)

  /** Loudness of the playable file of a ready track; emits music:update when there is a value. */
  function startTrackLoudness(id: string): void {
    const key = `loudness:${id}`
    if (jobs.has(key) || disposed) return
    const job = afterCpuWork(id).then(() => musicLimit(async () => {
      const t = tracks.get(id)
      if (!t || disposed || !trackWantsLoudness(t)) return
      loudnessTried.add(id)
      const loudness = await loudnessOf(t.playback!)
      if (loudness === undefined || disposed || tracks.get(id)?.playback !== t.playback) return
      updateTrack(id, { loudness })
      await mkdir(folder(id), { recursive: true })
      await persistTrack(id)
    })).catch(() => {})
    trackJob(key, job)
  }

  function startMusicJob(id: string): void {
    if (jobs.has(`music:${id}`) || disposed) return
    const leaveEssential = once(essentialGate)
    const job = musicLimit(async () => {
      if (disposed) return
      const track = updateTrack(id, { status: 'processing', error: undefined })
      try {
        await mkdir(folder(id), { recursive: true })
        const out = join(folder(id), 'music.m4a')
        await transcodeMusic(ff, track.path, out, signal)
        updateTrack(id, { status: 'ready', playback: out, loudness: undefined })
        await persistTrack(id)
        startTrackLoudness(id)
      } catch (err) {
        if (!disposed) updateTrack(id, { status: 'error', error: shortError('Audio could not be converted', err) })
      }
    }).finally(leaveEssential)
    trackJob(`music:${id}`, job)
  }

  /** Beats are added to a track that is already usable; failures leave `beats` unset (retried on restore). */
  function startBeatJob(id: string): void {
    const key = `beats:${id}`
    if (jobs.has(key) || disposed) return
    const job = afterCpuWork(id).then(() => beatLimit(async () => {
      const t = tracks.get(id)
      if (!t || t.beats || t.status === 'error' || disposed) return
      await mkdir(folder(id), { recursive: true })
      const r = await detectBeatsInFile(ff, t.path, signal)
      if (disposed || !tracks.has(id)) return
      // No pulse found: an empty list, so it is not analysed again
      updateTrack(id, r ? { beats: r.beats, bpm: r.bpm } : { beats: [], bpm: undefined })
      await persistTrack(id)
    })).catch(() => {})
    trackJob(key, job)
  }

  /**
   * Music analysis (beats, loudness) waits for the CPU-heavy part of media processing (thumbnails,
   * display images), not for proxies: it is cheap, and beat sync and the beat lane should not wait
   * minutes for the graphics card.
   */
  async function afterCpuWork(id: string): Promise<void> {
    await thumbGate.wait(id)
    await displayGate.wait(id)
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

  // ------------------------------------------------------------- video strip

  /** Media cache folder a video path belongs to: its cache folder, the item using it, or by its id. */
  async function stripFolder(path: string): Promise<string> {
    const full = resolve(path)
    if (isInside(full, config.cacheDir)) {
      const first = relative(resolve(config.cacheDir), full).split(sep)[0]
      if (ID_FOLDER.test(first)) return folder(first)
    }
    for (const it of items.values()) if (it.path === path || it.playback === path) return folder(it.id)
    const st = await stat(full)
    return folder(mediaId(full, st.size, st.mtimeMs))
  }

  // ------------------------------------------------------------------ cache

  function busyIds(): Set<string> {
    const busy = new Set<string>()
    const now = Date.now()
    for (const it of items.values()) if (it.status === 'pending' || it.status === 'processing') busy.add(it.id)
    for (const t of tracks.values()) if (t.status === 'pending' || t.status === 'processing') busy.add(t.id)
    for (const key of [...jobs.keys(), ...preparing.keys()]) busy.add(key.split(':').pop()!)
    for (const path of writes.keys()) busy.add(basename(dirname(path)))
    for (const dir of strips.keys()) busy.add(basename(dirname(dir)))
    for (const [id, at] of recent) {
      if (now - at < RECENT_MS) busy.add(id)
      else recent.delete(id)
    }
    return busy
  }

  /** Items whose cache files were deleted: the next restore validates them against the disk again. */
  function forget(ids: string[]): void {
    for (const id of ids) {
      if (jobs.has(id)) continue
      items.delete(id)
      tracks.delete(id)
      contexts.delete(id)
    }
  }

  // ----------------------------------------------------------------- relink

  /**
   * Gives a moved original (proven identical: same size and time) the cache of its old id, so it
   * needs no processing. Hard links where possible: the pipeline replaces cache files by rename,
   * never in place, so the two folders cannot affect each other.
   */
  async function migrateCache(oldId: string, file: ScannedFile, live?: ScannedFile): Promise<void> {
    const newId = mediaId(file.path, file.size, file.mtimeMs)
    const from = folder(oldId)
    const to = folder(newId)
    if (oldId === newId || existsSync(join(to, META))) return
    const cached = await readJson<MediaItem>(join(from, META))
    if (!cached || cached.id !== oldId || cached.status !== 'ready') return
    await mkdir(to, { recursive: true })
    for (const e of await readdir(from, { withFileTypes: true })) {
      if (!e.isFile() || e.name === META || /\.(tmp|part)/i.test(e.name)) continue
      const src = join(from, e.name)
      const dst = join(to, e.name)
      await link(src, dst).catch(() => copyFile(src, dst))
    }
    const moved = (p: string | undefined): string | undefined => {
      if (!p) return p
      if (isInside(p, from)) return join(to, relative(from, p))
      if (p === cached.path) return file.path
      if (live && cached.live && p === cached.live.source) return live.path
      return p
    }
    const next: MediaItem = clean({
      ...cached,
      id: newId,
      path: file.path,
      name: file.name,
      thumb: moved(cached.thumb),
      display: moved(cached.display),
      playback: moved(cached.playback),
      audio: moved(cached.audio),
      liveVideo: moved(cached.liveVideo),
      live: cached.live ? { ...cached.live, source: moved(cached.live.source)! } : undefined
    })
    await writeJson(join(to, META), next)
  }

  async function knownSize(id: string): Promise<number | undefined> {
    const src = await readJson<{ size?: unknown }>(join(folder(id), SOURCE))
    return typeof src?.size === 'number' ? src.size : undefined
  }

  // -------------------------------------------------------------------- API

  async function importPaths(paths: string[]): Promise<MediaItem[]> {
    const files = await trace.span('scan', undefined, () => scanPaths(paths))
    const groups = pairFiles(files)
    const lists = await trace.span('prepareAll', undefined, () => Promise.all(groups.map((g) => prepare(g))), { groups: groups.length })
    const seen = new Set<string>()
    const result: MediaItem[] = []
    const now = Date.now()
    for (const it of lists.flat()) {
      if (seen.has(it.id)) continue
      seen.add(it.id)
      recent.set(it.id, now)
      result.push({ ...(items.get(it.id) ?? it) })
    }
    result.sort((a, b) => a.captureTime - b.captureTime || a.name.localeCompare(b.name, undefined, { numeric: true }))
    order.add(result.map((it) => it.id))
    schedule(
      result.filter((it) => it.status === 'pending').map((it) => it.id),
      result.filter(wantsAnalysis).map((it) => it.id)
    )
    return result
  }

  return {
    ffmpeg: ff,

    importPaths,

    async restoreMedia(list) {
      order.add(list.map((it) => it?.id).filter((id): id is string => typeof id === 'string'))
      const requeue: string[] = []
      const analyze: string[] = []
      const reproxy: string[] = []
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
            if (wantsAnalysis(it)) analyze.push(it.id)
            return { ...it }
          }
          const proxyGone = changed ? null : missingProxyOnly(it, config.cacheDir)
          if (proxyGone) {
            // Thumbnail, display image and audio are still there: only the proxy is rebuilt
            const fresh: MediaItem =
              proxyGone === 'video'
                ? clean({ ...it, playback: undefined, proxied: undefined, status: 'processing' as const, progress: 0, error: undefined })
                : clean({ ...it, liveVideo: undefined })
            items.set(it.id, fresh)
            reproxy.push(it.id)
            if (wantsAnalysis(fresh)) analyze.push(it.id)
            return { ...fresh }
          }
          let fresh = stripDerived(it)
          // An edited original invalidates what was derived from its content
          if (changed) fresh = clean({ ...fresh, faces: undefined, sharpness: undefined, hash: undefined, loudness: undefined })
          if (fresh.live && !existsSync(fresh.live.source)) delete fresh.live
          items.set(it.id, fresh)
          requeue.push(it.id)
          return { ...fresh }
        })
      )
      schedule(requeue, analyze, reproxy)
      return result
    },

    async importMusic(paths) {
      const files = await scanPaths(paths, ['audio'])
      files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
      const result = await Promise.all(files.map((f) => metaLimit(() => prepareTrack(f))))
      const now = Date.now()
      for (const t of result) recent.set(t.id, now)
      scheduleMusic(
        result.filter((t) => t.status === 'pending').map((t) => t.id),
        result.filter(wantsBeats).map((t) => t.id),
        result.filter(trackWantsLoudness).map((t) => t.id)
      )
      return result.map((t) => ({ ...(tracks.get(t.id) ?? t) }))
    },

    async restoreMusic(list) {
      const requeue: string[] = []
      const beats: string[] = []
      const loudness: string[] = []
      const result = await Promise.all(
        list.map(async (t) => {
          const current = tracks.get(t.id)
          if (current && current.status !== 'error') return { ...current }
          if (!existsSync(t.path)) return { ...t, status: 'error' as const, error: 'missing' }
          if (t.status === 'ready' && t.playback && existsSync(t.playback)) {
            tracks.set(t.id, t)
            if (wantsBeats(t)) beats.push(t.id)
            if (trackWantsLoudness(t)) loudness.push(t.id)
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
          if (trackWantsLoudness(fresh)) loudness.push(t.id)
          return { ...fresh }
        })
      )
      scheduleMusic(requeue, beats, loudness)
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

    async videoStrip(path, count, height) {
      if (typeof path !== 'string' || !path) throw new Error('no video')
      const n = Math.max(1, Math.min(120, Math.round(Number(count)) || 1))
      const h = Math.max(16, Math.min(720, Math.round(Number(height)) || 16))
      const dir = join(await stripFolder(path), `strip-${n}x${h}`)
      const files = stripFiles(dir, n)
      if (files.every((f) => existsSync(f))) return files
      let job = strips.get(dir)
      if (!job) {
        job = (async () => {
          const info = analyzeVideo(await ff.probe(path, signal))
          if (!info) throw new Error('no video stream')
          return videoStrip(ff, path, info, n, h, dir, signal)
        })().finally(() => strips.delete(dir))
        strips.set(dir, job)
      }
      return job
    },

    cacheInfo(used) {
      return scanCacheInfo(config.cacheDir, { ids: used.ids, paths: used.paths, busy: busyIds() })
    },

    async cleanCache(what, used) {
      if (what !== 'unused' && what !== 'hires' && what !== 'proxies') throw new Error(`unknown cache part: ${String(what)}`)
      forget(await cleanCacheDir(config.cacheDir, what, { ids: used.ids, paths: used.paths, busy: busyIds() }))
      return scanCacheInfo(config.cacheDir, { ids: used.ids, paths: used.paths, busy: busyIds() })
    },

    async relinkMedia(missing, dir) {
      const wanted = (Array.isArray(missing) ? missing : []).filter(
        (m): m is MediaItem => !!m && typeof m.id === 'string' && typeof m.path === 'string' && !!m.path
      )
      if (!wanted.length || typeof dir !== 'string' || !dir) return {}
      const files = await scanPaths([dir])
      const byName = new Map<string, ScannedFile[]>()
      for (const f of files) {
        const key = f.name.toLowerCase()
        const list = byName.get(key)
        if (list) list.push(f)
        else byName.set(key, [f])
      }
      const found = new Map<string, { file: ScannedFile; exact: boolean; live?: ScannedFile }>()
      for (const m of wanted) {
        const match = pickRelinkCandidate(m, byName.get(basename(m.path).toLowerCase()) ?? [], await knownSize(m.id))
        if (!match) continue
        let live: ScannedFile | undefined
        // A Live Photo's MOV sits next to the photo with the same base name
        if (m.live && dirname(m.live.source).toLowerCase() === dirname(m.path).toLowerCase()) {
          const movName = basename(m.live.source).toLowerCase()
          live = files.find((f) => f.dir.toLowerCase() === match.file.dir.toLowerCase() && f.name.toLowerCase() === movName)
        }
        found.set(m.id, { ...match, live })
      }
      for (const [oldId, f] of found) {
        if (f.exact) await migrateCache(oldId, f.file, f.live).catch(() => {})
      }
      const paths = [...new Set([...found.values()].flatMap((f) => (f.live ? [f.file.path, f.live.path] : [f.file.path])))]
      if (!paths.length) return {}
      const imported = await importPaths(paths)
      const byPath = new Map(imported.map((it) => [it.path.toLowerCase(), it]))
      const result: Record<string, MediaItem> = {}
      for (const [oldId, f] of found) {
        const it = byPath.get(f.file.path.toLowerCase())
        if (it) result[oldId] = it
      }
      return result
    },

    prioritize(ids) {
      order.prioritize((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string').slice(0, 2000))
    },

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
      // A detection still running removes its test clips when it ends (at most ~60 s; usually 2-3 s)
      const detection = gpuDetection ? Promise.race([gpuDetection, new Promise((r) => setTimeout(r, 5000).unref())]) : null
      await Promise.all([endExiftool(), trace.close(), detection])
    }
  }
}
