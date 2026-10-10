// The editor's side of the vision workers: a small pool (one per six CPU threads, 1 to 3), each
// request goes to the least busy one. Detection costs about the same in a worker as on this thread,
// but it no longer freezes the editor, and several workers analyse pictures side by side.
// If no worker can start, detection runs on this thread (CPU, no descriptors) as before.
import { mediaUrl } from '@shared/api'
import type { Rect } from '@shared/types'
import type { Delegate, Levels } from './detect'
import type { AnalyzeRequest, AnalyzeResult, InitRequest, InitResult, VisionResponse } from './protocol'

export type { AnalyzeResult } from './protocol'

export interface AnalyzeOptions {
  levels?: Levels
  describe?: boolean
  /** Known face boxes: only keypoints and descriptors are computed for them. */
  known?: Rect[]
  /** With `known`: find each face again near its box (or in a wide area); result score 0 where it wasn't found. */
  locate?: 'near' | 'wide'
  /** Detect on this thread (CPU, no descriptors), as before the workers existed: for measurements. */
  here?: boolean
  /** Measurements: see detect.ts TILE_PX. */
  tilePx?: number
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

/** Folder with MediaPipe's wasm and the models, copied next to index.html by scripts/fetch-models.mjs. */
const visionBase = (): string => new URL('./vision/', document.baseURI).href

interface Slot {
  worker: Worker
  ready: Promise<InitResult>
  pending: Map<number, Pending>
  broken: boolean
}

let slots: Slot[] = []
let nextId = 1
// BlazeFace on the GPU measured slower than on the CPU (many small inputs); the CPU stays the default
let delegate: Delegate = 'CPU'
let poolSize = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 6)))
let failedStarts = false

/** Workers analysing side by side. */
export const visionWorkers = (): number => poolSize

function call<T>(slot: Slot, req: AnalyzeRequest | InitRequest, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    slot.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    slot.worker.postMessage({ ...req, id }, transfer)
  })
}

function spawn(): Slot {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'vision' })
  const slot: Slot = { worker, ready: Promise.resolve({ delegate }), pending: new Map(), broken: false }
  worker.addEventListener('message', (e: MessageEvent<VisionResponse>) => {
    const p = slot.pending.get(e.data.id)
    if (!p) return
    slot.pending.delete(e.data.id)
    if (e.data.ok) p.resolve(e.data.result)
    else p.reject(new Error(e.data.error))
  })
  worker.addEventListener('error', (e) => {
    console.warn('vision worker failed', e.message)
    slot.broken = true
    for (const p of slot.pending.values()) p.reject(new Error(e.message || 'vision worker failed'))
    slot.pending.clear()
  })
  slot.ready = call<InitResult>(slot, { type: 'init', base: visionBase(), delegate })
  slot.ready.catch(() => (slot.broken = true))
  return slot
}

/** The least busy working worker (started on first use), or null when none can run. */
async function slot(): Promise<Slot | null> {
  slots = slots.filter((s) => {
    if (s.broken) s.worker.terminate()
    return !s.broken
  })
  while (slots.length < poolSize && !failedStarts) {
    const s = spawn()
    slots.push(s)
    try {
      await s.ready
    } catch {
      failedStarts = true
      slots = slots.filter((x) => x !== s)
      s.worker.terminate()
    }
  }
  if (!slots.length) return null
  return slots.reduce((a, b) => (b.pending.size < a.pending.size ? b : a))
}

/** Restarts the workers with another detector delegate and pool size (tests and measurements). */
export async function setDelegate(d: Delegate, workers = poolSize): Promise<Delegate> {
  delegate = d
  poolSize = Math.max(1, Math.min(4, workers))
  for (const s of slots) s.worker.terminate()
  slots = []
  failedStarts = false
  const s = await slot()
  return s ? (await s.ready).delegate : 'CPU'
}

// ---------------------------------------------------------------- fallback on this thread

let local: Promise<import('./detect').DetectorHandle> | null = null

async function analyzeHere(bitmap: ImageBitmap, opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const det = await import('./detect')
  local ??= det.createDetector(visionBase(), 'CPU', false)
  const h = await local
  const levels = opts.levels ?? 'photo'
  const scale = Math.min(1, det.detectEdge(levels) / Math.max(bitmap.width, bitmap.height))
  const small = scale < 1 ? await createImageBitmap(bitmap, { resizeWidth: Math.round(bitmap.width * scale), resizeHeight: Math.round(bitmap.height * scale), resizeQuality: 'medium' }) : bitmap
  try {
    const t0 = performance.now()
    const dets = opts.known ? opts.known.map((r) => ({ r, kp: undefined, score: 1 })) : det.detectAll(h, small, levels, opts.tilePx)
    return { faces: dets.map((d) => d.r), kp: dets.map((d) => d.kp), ms: { detect: performance.now() - t0, describe: 0 }, delegate: 'CPU' }
  } finally {
    if (small !== bitmap) small.close()
    bitmap.close()
  }
}

// ---------------------------------------------------------------- API

/** Faces (and descriptors) in a picture; the bitmap is handed over (closed afterwards). */
export async function analyzeBitmap(bitmap: ImageBitmap, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const s = opts.here ? null : await slot()
  if (!s) return analyzeHere(bitmap, opts)
  return call<AnalyzeResult>(s, { type: 'analyze', bitmap, levels: opts.levels ?? 'photo', describe: !!opts.describe, known: opts.known, locate: opts.locate, tilePx: opts.tilePx }, [bitmap])
}

/** Decodes a file served by the media protocol (decoding happens off this thread). */
export async function loadBitmap(path: string): Promise<ImageBitmap> {
  const blob = await (await fetch(mediaUrl(path))).blob()
  return createImageBitmap(blob)
}

export async function analyzePath(path: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  return analyzeBitmap(await loadBitmap(path), opts)
}
