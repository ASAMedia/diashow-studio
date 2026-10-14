// State shared by the parts of one media service (service.ts): its items and songs, the pools and
// gates that order their processing, and how changes reach the renderer.
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import type { MediaItem, MusicTrack } from '@shared/types'
import { abortError, isAbort } from '../abort'
import { Ffmpeg, type ProbeResult } from '../ffmpeg'
import type { Tags } from './exif'
import { detectGpuTonemap, type GpuTonemap } from './hdr'
import { measureLoudness } from './loudness'
import { createGate, createLimiter, createPriorityLimiter, MediaOrder, type Gate, type PriorityLimiter } from './queue'
import { RawDecoderPool, type RawDecoding } from './raw'
import type { MediaServiceConfig } from './service'
import { createTracer, type Tracer } from './trace'
import { gpuEligible } from './video'
import type { DirectDecode, VideoInfo } from './videoInfo'

/** Work classes (MediaOrder.key): thumbnails, then display images / sound / playback, then analysis. */
export const PRI_THUMB = 0
export const PRI_DISPLAY = 1
export const PRI_ANALYSIS = 2

/** An id that can be a folder name as it is (media ids are 16 hex digits, scan.ts; songs of the library "theme-…"). */
const PLAIN_ID = /^(?!(?:con|prn|aux|nul|com\d|lpt\d)$)[A-Za-z0-9_-]{1,128}$/i

/**
 * The cache folder name of a media or music id. Ids come back from project files, and one made
 * elsewhere can hold any string ("..\..\Startup"): such an id gets a folder named by its hash, inside
 * the cache like every other, never a path of its own.
 */
export function cacheFolderName(id: string): string {
  return PLAIN_ID.test(id) ? id : createHash('sha1').update(`id:${String(id)}`).digest('hex').slice(0, 16)
}

/** What the import read about a file, reused by its processing job. */
export interface ImportContext {
  tags?: Tags
  probe?: ProbeResult
  liveProbe?: ProbeResult
  /** JPEG & co. read with quickPhotoMeta: the XMP announces an embedded video. */
  motionXmp?: boolean
}

/** Stages of one processing job that other items wait for (processing.ts). */
export interface Stages {
  /** Thumbnail done (or failed): later stages of other items may start. */
  leaveThumb: () => void
  /** Display image done (or failed). */
  leaveDisplay: () => void
}

type Limiter = ReturnType<typeof createLimiter>

export interface ServiceContext {
  readonly config: MediaServiceConfig
  readonly ff: Ffmpeg
  readonly raw: RawDecoding
  /** Aborted by dispose(). */
  readonly abort: AbortController
  readonly signal: AbortSignal
  /** Set by dispose(): jobs stop at their next check, and nothing is emitted any more. */
  disposed: boolean
  readonly items: Map<string, MediaItem>
  readonly tracks: Map<string, MusicTrack>
  readonly contexts: Map<string, ImportContext>
  /** Metadata reads of the import, per media id. */
  readonly preparing: Map<string, Promise<MediaItem[]>>
  /** Running jobs by key: the media id (processing), or a prefix and the id ('analysis:…', 'music:…', …). */
  readonly jobs: Map<string, Promise<void>>
  /** Cache JSON writes per file (cacheMeta.ts). */
  readonly writes: Map<string, Promise<void>>
  readonly waveforms: Map<string, Promise<number[]>>
  /** Video strips being made, per strip folder. */
  readonly strips: Map<string, Promise<string[]>>
  /** Stabilisation runs per media id; one at a time (both passes keep the CPU busy). */
  readonly stabilizing: Map<string, Promise<void>>
  /** Import time of freshly imported ids (the cache cleanup counts them as used). */
  readonly recent: Map<string, number>
  /** Media / track ids whose loudness was measured this session (silent ones stay undefined). */
  readonly loudnessTried: Set<string>
  /** Show order and the renderer's focus, shared by every queue and gate below. */
  readonly order: MediaOrder
  /** CPU: thumbnails, display images, analysis. */
  readonly work: PriorityLimiter
  /** Hardware encoder sessions: proxies (Live Photo motion parts included). */
  readonly encodeWork: PriorityLimiter
  /** Disk-bound FFmpeg runs: video sound (+ loudness), remuxes. */
  readonly audioWork: PriorityLimiter
  /** Items still without a thumbnail; heavier work of other items waits for them. */
  readonly thumbGate: Gate
  /** Photos still without a display image; CPU-decoded proxies wait for them. */
  readonly displayGate: Gate
  /** Items (and music transcodes) still being processed; hash / sharpness / lazy loudness wait for them. */
  readonly essentialGate: Gate
  readonly metaLimit: Limiter
  readonly musicLimit: Limiter
  readonly beatLimit: Limiter
  readonly stabilizeLimit: Limiter
  readonly trace: Tracer
  readonly shaderCache: string
  /** The one-off GPU path detection, once started (dispose waits for it: it cleans up temp files). */
  gpuDetection: Promise<unknown> | null
  /** Cache folder of a media or music id. */
  folder(id: string): string
  emit(item: MediaItem): void
  /** Changes an item without telling the renderer (intermediate state inside a phase). */
  set(id: string, patch: Partial<MediaItem>): MediaItem
  update(id: string, patch: Partial<MediaItem>): MediaItem
  updateTrack(id: string, patch: Partial<MusicTrack>): MusicTrack
  trackJob(key: string, job: Promise<void>): void
  /** The GPU path for this source (HDR tone mapping, or an SDR stream the GPU decodes), else null. */
  gpuFor(vi: VideoInfo): Promise<GpuTonemap | null>
  /** Loudness or undefined (silent, undecodable); only cancellation is thrown. */
  loudnessOf(path: string): Promise<number | undefined>
  /** What the renderer decodes besides H.264/VP9/AV1 (asked per video; the answer is cached by the caller). */
  directDecode(): Promise<DirectDecode>
}

export function clean<T extends object>(obj: T): T {
  const out = { ...obj }
  for (const k of Object.keys(out) as Array<keyof T>) if (out[k] === undefined) delete out[k]
  return out
}

export function shortError(context: string, err: unknown): string {
  if (isAbort(err)) return 'cancelled'
  const msg = err instanceof Error ? err.message : String(err)
  const text = msg ? `${context}: ${msg}` : context
  return text.length > 180 ? text.slice(0, 180) + '…' : text
}

/** leave() of a gate that may be called more than once for the same entry. */
export function once(gate: Gate): () => void {
  gate.enter()
  let left = false
  return () => {
    if (left) return
    left = true
    gate.leave()
  }
}

export function createServiceContext(config: MediaServiceConfig): ServiceContext {
  const ff = new Ffmpeg(config.ffmpegDir)
  const abort = new AbortController()
  const threads = availableParallelism()
  const workers = config.photoConcurrency ?? Math.max(2, Math.min(12, Math.floor(threads * 0.6)))
  const order = new MediaOrder()
  // Many images in parallel with few libvips threads each beats few images with many threads
  // (measured on 50 MP JPEGs: -35 % per photo; 12 x 2 threads beat 8 x 3 by ~15 % on 20 threads);
  // needs UV_THREADPOOL_SIZE >= workers (see threadpool.ts)
  sharp.concurrency(Math.max(1, Math.round(threads / workers)))

  const ctx: ServiceContext = {
    config,
    ff,
    raw: config.rawDecoder ?? new RawDecoderPool(2),
    abort,
    signal: abort.signal,
    disposed: false,
    items: new Map(),
    tracks: new Map(),
    contexts: new Map(),
    preparing: new Map(),
    jobs: new Map(),
    writes: new Map(),
    waveforms: new Map(),
    strips: new Map(),
    stabilizing: new Map(),
    recent: new Map(),
    loudnessTried: new Set(),
    order,
    work: createPriorityLimiter(workers, order),
    encodeWork: createPriorityLimiter(config.videoConcurrency ?? 4, order),
    audioWork: createPriorityLimiter(config.audioConcurrency ?? 3, order),
    thumbGate: createGate(order),
    displayGate: createGate(order),
    essentialGate: createGate(order),
    metaLimit: createLimiter(16),
    musicLimit: createLimiter(2),
    beatLimit: createLimiter(1),
    stabilizeLimit: createLimiter(1),
    trace: createTracer(),
    shaderCache: join(config.cacheDir, 'gpu'),
    gpuDetection: null,

    folder: (id) => join(config.cacheDir, cacheFolderName(id)),

    emit(item) {
      if (!ctx.disposed) config.onUpdate?.({ ...item })
    },

    set(id, patch) {
      const next = clean({ ...ctx.items.get(id)!, ...patch })
      ctx.items.set(id, next)
      return next
    },

    update(id, patch) {
      const next = ctx.set(id, patch)
      ctx.emit(next)
      return next
    },

    updateTrack(id, patch) {
      const next = clean({ ...ctx.tracks.get(id)!, ...patch })
      ctx.tracks.set(id, next)
      if (!ctx.disposed) config.onMusicUpdate?.({ ...next })
      return next
    },

    trackJob(key, job) {
      const tracked = job.finally(() => {
        if (ctx.jobs.get(key) === tracked) ctx.jobs.delete(key)
      })
      ctx.jobs.set(key, tracked)
    },

    async gpuFor(vi) {
      if (config.hdrGpu === false) return null
      const detecting = detectGpuTonemap(ff)
      ctx.gpuDetection ??= detecting
      const gpu = await detecting
      if (!gpu || !gpuEligible(vi, gpu)) return null
      await mkdir(ctx.shaderCache, { recursive: true }).catch(() => {})
      return gpu
    },

    async loudnessOf(path) {
      try {
        return await measureLoudness(ff, path, ctx.signal)
      } catch (err) {
        if (isAbort(err) || ctx.signal.aborted) throw abortError()
        return undefined
      }
    },

    async directDecode() {
      try {
        return (await config.directDecode?.()) ?? {}
      } catch {
        return {}
      }
    }
  }
  return ctx
}
