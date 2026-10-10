// The vision worker: face detection and descriptors off the editor's thread, so the editor never
// stutters while photos and video frames are analysed. Requests run one after another.
import './noTelemetry'
import { createDetector, detectAll, detectEdge, keypointsFor, locate, type Delegate, type Det, type DetectorHandle } from './detect'
import { describe, tfBackend } from './describe'
import type { AnalyzeRequest, AnalyzeResult, InitResult, VisionRequest, VisionResponse } from './protocol'

const scope = self as unknown as {
  postMessage(msg: VisionResponse): void
  importScripts(...urls: string[]): void
  addEventListener(type: 'message', fn: (e: MessageEvent<VisionRequest>) => void): void
}

// MediaPipe loads its wasm glue with importScripts, which module workers (dev server) don't have
const moduleWorker = ((): boolean => {
  try {
    scope.importScripts()
    return false
  } catch {
    return true
  }
})()

let base = ''
let wanted: Delegate = 'GPU'
let handle: Promise<DetectorHandle> | null = null

/** The GPU delegate when it initialises, else the CPU. */
function detector(want: Delegate): Promise<DetectorHandle> {
  handle ??= (async () => {
    if (want === 'GPU') {
      try {
        return await createDetector(base, 'GPU', moduleWorker)
      } catch (e) {
        console.warn('vision: GPU delegate unavailable, using the CPU', e)
      }
    }
    return createDetector(base, 'CPU', moduleWorker)
  })()
  handle.catch(() => (handle = null))
  return handle
}

async function analyze(req: AnalyzeRequest): Promise<AnalyzeResult> {
  const h = await detector(wanted)
  const full = req.bitmap
  const scale = Math.min(1, detectEdge(req.levels) / Math.max(full.width, full.height))
  const small = scale < 1 ? await createImageBitmap(full, { resizeWidth: Math.round(full.width * scale), resizeHeight: Math.round(full.height * scale), resizeQuality: 'medium' }) : full
  try {
    const t0 = performance.now()
    let dets: Det[]
    if (req.known && req.locate) {
      // following a face: its box now (score 0 where it was not found)
      const found = locate(h, small, req.known, req.locate === 'wide')
      dets = req.known.map((r, i) => ({ r: found[i].box ?? r, kp: found[i].kp, score: found[i].score }))
    } else if (req.known) {
      const found = keypointsFor(h, small, req.known)
      dets = req.known.map((r, i) => ({ r, kp: found[i].kp, score: found[i].score }))
    } else dets = detectAll(h, small, req.levels, req.tilePx)
    const t1 = performance.now()
    const desc = req.describe ? await describe(base, full, dets) : undefined
    const t2 = performance.now()
    return { faces: dets.map((d) => d.r), kp: dets.map((d) => d.kp), score: dets.map((d) => +d.score.toFixed(3)), size: [full.width, full.height], desc, ms: { detect: t1 - t0, describe: t2 - t1 }, delegate: h.delegate, backend: tfBackend }
  } finally {
    if (small !== full) small.close()
    full.close()
  }
}

let chain: Promise<unknown> = Promise.resolve()

scope.addEventListener('message', (e) => {
  const req = e.data
  chain = chain.then(async () => {
    try {
      let result: AnalyzeResult | InitResult
      if (req.type === 'init') {
        base = req.base
        wanted = req.delegate
        handle = null
        result = { delegate: (await detector(wanted)).delegate }
      } else result = await analyze(req)
      scope.postMessage({ id: req.id, ok: true, result })
    } catch (err) {
      if (req.type === 'analyze') req.bitmap.close()
      scope.postMessage({ id: req.id, ok: false, error: (err as Error)?.message ?? String(err) })
    }
  })
})
