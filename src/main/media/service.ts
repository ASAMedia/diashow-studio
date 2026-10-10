// Media import + background processing. Electron-free: the IPC layer injects directories and
// forwards onUpdate / onMusicUpdate to the renderer.
//
// Processing keeps big imports responsive (see processing.ts): every item first gets its
// thumbnail (photos straight from the original, videos one frame), in show order, with whatever the
// renderer focuses (prioritize) first. Then display JPEGs (CPU), video sound (disk) and proxies (GPU)
// run side by side; videos the renderer decodes need no proxy at all (playbackPlan). Hash and
// sharpness come last, once every item is usable.
// Each item emits few updates: thumbnail ready (status 'processing'), then 'ready' or 'error', then
// one with the analysis. Loudness of video sound is measured while it is extracted; music and older
// cache entries get it lazily with an extra update.
//
// The parts share one ServiceContext (serviceContext.ts): photoJobs.ts, videoJobs.ts and
// musicJobs.ts do the work per kind, analysisJobs.ts the last pass, restore.ts reopened projects and
// moved originals, cacheMeta.ts the cache folders.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CacheInfo, ExportProgress, MediaItem, MusicTrack, Rect, VideoFaces } from '@shared/types'
import { ID_FOLDER, type CleanTarget } from '../cache'
import type { Ffmpeg } from '../ffmpeg'
import { cacheInfo, cleanCache, fromCache, persist, stripFolder } from './cacheMeta'
import { endExiftool } from './exif'
import { sanitizeDescriptors, sanitizeRects, sanitizeVideoFaces } from './faceData'
import { MAX_EDGE as FRAMES_MAX_EDGE, MAX_FRAMES, videoFrames, videoInfoCached } from './frames'
import { importMusic, restoreMusic, waveform } from './musicJobs'
import { importPaths } from './processing'
import type { RawDecoding } from './raw'
import { relinkMedia, restoreMedia } from './restore'
import { createServiceContext } from './serviceContext'
import { stripFiles, videoStrip } from './video'
import { analyzeVideo, type DirectDecode } from './videoInfo'
import { prepareHires, stabilizeVideo } from './videoJobs'

export { pickRelinkCandidate } from './restore'
export { sanitizeRects as sanitizeFaces } from './faceData'

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
  /** Whether a path from a saved project may be opened (network shares the user hasn't trusted may not); default all. */
  allowPath?: (path: string) => boolean
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
  /**
   * Stores face rects (normalised, clamped to 0..1) on a known item, persists and emits it. `desc`:
   * one descriptor per face (128 numbers); without it, older descriptors are dropped.
   */
  setFaces(id: string, faces: Rect[], desc?: number[][]): Promise<void>
  /** Stores the faces found in sampled frames of a video, persists and emits the item. */
  setVideoFaces(id: string, samples: VideoFaces[]): Promise<void>
  /** JPEG frames of a video at source times (ascending), fitting maxEdge; empty where none could be read. */
  videoFrames(path: string, times: number[], maxEdge: number): Promise<Uint8Array[]>
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
  /**
   * Makes a stabilised copy of a ready video's playback file (stab.mp4 in its cache folder: same frames,
   * timestamps and size, slightly zoomed), one video at a time. Progress goes out as `stabilizing`
   * (0..1) through onUpdate, the result as `stabilized`. Resolves at once when it exists already.
   */
  stabilizeVideo(id: string): Promise<void>
  /** Resolves when no import/transcode/analysis job is queued or running. */
  idle(): Promise<void>
  dispose(): Promise<void>
}

export function createMediaService(config: MediaServiceConfig): MediaService {
  const ctx = createServiceContext(config)
  const { ff, items, tracks, jobs, preparing, writes, signal } = ctx

  /** An item the service doesn't hold (any more), loaded from its cache folder; false when there is none. */
  async function loadCached(id: string): Promise<boolean> {
    if (typeof id !== 'string' || !ID_FOLDER.test(id)) return false
    const cached = await fromCache(ctx, id)
    if (!cached) return false
    // restore or import may have taken the item over while the cache was read
    if (!items.has(id)) items.set(id, cached)
    return true
  }

  return {
    ffmpeg: ff,

    importPaths: (paths) => importPaths(ctx, paths),

    restoreMedia: (list) => restoreMedia(ctx, list),

    importMusic: (paths) => importMusic(ctx, paths),

    restoreMusic: (list) => restoreMusic(ctx, list),

    waveform: (path, buckets) => waveform(ctx, path, buckets),

    async setFaces(id, faces, desc) {
      if (!items.has(id) && !(await loadCached(id))) return
      const rects = sanitizeRects(faces)
      // descriptors only fit when no rect was dropped
      const aligned = Array.isArray(faces) && rects.length === faces.length
      ctx.update(id, { faces: rects, faceDesc: aligned ? sanitizeDescriptors(desc, rects.length) : undefined })
      await persist(ctx, id)
    },

    async setVideoFaces(id, samples) {
      if (!items.has(id) && !(await loadCached(id))) return
      if (items.get(id)?.kind !== 'video') return
      ctx.update(id, { videoFaces: sanitizeVideoFaces(samples) })
      await persist(ctx, id)
    },

    async videoFrames(path, times, maxEdge) {
      if (typeof path !== 'string' || !path) throw new Error('no video')
      const list = (Array.isArray(times) ? times : []).filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0).slice(0, MAX_FRAMES)
      list.sort((a, b) => a - b)
      const edge = Math.max(64, Math.min(FRAMES_MAX_EDGE, Math.round(Number(maxEdge)) || 1280))
      const info = await videoInfoCached(ff, path, signal)
      if (!info) throw new Error('no video stream')
      return videoFrames(ff, path, info, list, edge, signal)
    },

    prepareHires: (ids, maxEdge, opts) => prepareHires(ctx, ids, maxEdge, opts),

    async videoStrip(path, count, height) {
      if (typeof path !== 'string' || !path) throw new Error('no video')
      const n = Math.max(1, Math.min(120, Math.round(Number(count)) || 1))
      const h = Math.max(16, Math.min(720, Math.round(Number(height)) || 16))
      const dir = join(await stripFolder(ctx, path), `strip-${n}x${h}`)
      const files = stripFiles(dir, n)
      if (files.every((f) => existsSync(f))) return files
      let job = ctx.strips.get(dir)
      if (!job) {
        job = (async () => {
          const info = analyzeVideo(await ff.probe(path, signal))
          if (!info) throw new Error('no video stream')
          return videoStrip(ff, path, info, n, h, dir, signal)
        })().finally(() => ctx.strips.delete(dir))
        ctx.strips.set(dir, job)
      }
      return job
    },

    cacheInfo: (used) => cacheInfo(ctx, used),

    cleanCache: (what, used) => cleanCache(ctx, what, used),

    relinkMedia: (missing, dir) => relinkMedia(ctx, missing, dir),

    prioritize(ids) {
      ctx.order.prioritize((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string').slice(0, 2000))
    },

    stabilizeVideo: (id) => stabilizeVideo(ctx, id),

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
      if (ctx.disposed) return
      ctx.disposed = true
      ctx.abort.abort()
      ctx.raw.dispose()
      await Promise.allSettled([...jobs.values(), ...writes.values()])
      // A detection still running removes its test clips when it ends (at most ~60 s; usually 2-3 s)
      const detection = ctx.gpuDetection ? Promise.race([ctx.gpuDetection, new Promise((r) => setTimeout(r, 5000).unref())]) : null
      await Promise.all([endExiftool(), ctx.trace.close(), detection])
    }
  }
}
