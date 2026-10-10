// Face detection, offline: MediaPipe BlazeFace (Apache-2.0) on the whole picture and on overlapping
// tiles, with the GPU delegate when it works, else on the CPU (WebAssembly). Runs inside the vision
// worker (worker.ts); the editor falls back to running it itself when the worker can't start.
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'
import type { Pt } from '@shared/faceAlign'
import type { Rect } from '@shared/types'

/** A face: box and keypoints normalised to the image (keypoints: image-left eye, image-right eye, nose, mouth). */
export interface Det {
  r: Rect
  kp?: Pt[]
  score: number
}

export type Delegate = 'GPU' | 'CPU'

/** 'photo': whole + two tile grids; 'thorough' adds a fine grid (pixelation editor); 'frame' / 'frameQuick': video frames (at most 1280 px) with / without the fine grid. */
export type Levels = 'photo' | 'thorough' | 'frame' | 'frameQuick'

export interface DetectorHandle {
  det: FaceDetector
  delegate: Delegate
}

/** `base`: absolute URL of the folder with MediaPipe's wasm and the models (public/vision). */
export async function createDetector(base: string, delegate: Delegate, moduleWorker: boolean): Promise<DetectorHandle> {
  const fileset = await FilesetResolver.forVisionTasks(base, moduleWorker)
  const det = await FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${base}blaze_face_short_range.tflite`, delegate },
    ...(delegate === 'GPU' ? { canvas: new OffscreenCanvas(1, 1) } : {}),
    runningMode: 'IMAGE',
    minDetectionConfidence: 0.6
  })
  return { det, delegate }
}

const iou = (a: Rect, b: Rect): number => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = x * y
  return inter / (a.w * a.h + b.w * b.h - inter)
}

/** Overlap relative to the smaller box (a face found again in a neighbouring tile). */
const overlap = (a: Rect, b: Rect): number => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return (x * y) / Math.min(a.w * a.h, b.w * b.h)
}

const LEVELS: Record<Levels, { n: number; size: number; minScore: number }[]> = {
  photo: [
    { n: 3, size: 0.45, minScore: 0.6 },
    { n: 5, size: 0.24, minScore: 0.7 }
  ],
  thorough: [
    { n: 3, size: 0.45, minScore: 0.6 },
    { n: 5, size: 0.24, minScore: 0.7 },
    { n: 9, size: 0.13, minScore: 0.75 }
  ],
  // video frames (about 720p) get the fine grid too: the pixelation editor searches its still the
  // same way, and a face clicked there must be found in the sampled frames to be followed
  frame: [
    { n: 3, size: 0.45, minScore: 0.6 },
    { n: 5, size: 0.24, minScore: 0.7 },
    { n: 9, size: 0.13, minScore: 0.75 }
  ],
  // every other sampled frame: without the fine grid (it costs three times as much)
  frameQuick: [
    { n: 3, size: 0.45, minScore: 0.6 },
    { n: 5, size: 0.24, minScore: 0.7 }
  ]
}

/** Long edge of the copies handed to the model per pass (0: the tile at full size). */
export const TILE_PX = 0

/** Longest edge the detector looks at. */
export function detectEdge(levels: Levels): number {
  return levels === 'thorough' ? 2400 : levels === 'frame' || levels === 'frameQuick' ? 1280 : 1600
}

/**
 * Faces in `bmp` (already scaled to detectEdge). BlazeFace (short range) only finds faces that fill
 * a fair part of its 128 px input, so besides the whole picture it looks at overlapping tiles of
 * shrinking size; smaller tiles need more confidence, as there is more background that might look
 * like a face. A face found again in a neighbouring tile is kept once.
 */
export function detectAll(handle: DetectorHandle, bmp: ImageBitmap, levels: Levels, tilePx = TILE_PX): Det[] {
  const { det } = handle
  const W = bmp.width
  const H = bmp.height
  const found: Det[] = []
  const collect = (src: ImageBitmap | OffscreenCanvas, ox: number, oy: number, sw: number, sh: number, minScore: number): void => {
    for (const d of det.detect(src).detections) {
      const b = d.boundingBox
      const score = d.categories[0]?.score ?? 0
      if (!b || score < minScore) continue
      const r = {
        x: (ox + (b.originX / src.width) * sw) / W,
        y: (oy + (b.originY / src.height) * sh) / H,
        w: ((b.width / src.width) * sw) / W,
        h: ((b.height / src.height) * sh) / H
      }
      if (r.w <= 0.004 || r.h <= 0.004 || found.some((f) => iou(f.r, r) > 0.3 || overlap(f.r, r) > 0.5)) continue
      const kp = d.keypoints?.length >= 4 ? d.keypoints.slice(0, 4).map((k): Pt => [(ox + k.x * sw) / W, (oy + k.y * sh) / H]) : undefined
      found.push({ r, kp, score })
    }
  }
  // The model sees 128 px: handing it smaller copies saves converting big pictures on every call
  const fit = (w: number, h: number): [number, number] => {
    const k = tilePx > 0 ? Math.min(1, tilePx / Math.max(w, h)) : 1
    return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))]
  }
  const [ww, wh] = fit(W, H)
  if (ww === W && wh === H) collect(bmp, 0, 0, W, H, 0.6)
  else {
    const whole = new OffscreenCanvas(ww, wh)
    const g = whole.getContext('2d')!
    g.imageSmoothingQuality = 'medium'
    g.drawImage(bmp, 0, 0, ww, wh)
    collect(whole, 0, 0, W, H, 0.6)
  }
  for (const { n, size, minScore } of LEVELS[levels]) {
    const tw = W * size
    const th = H * size
    const canvas = new OffscreenCanvas(...fit(tw, th))
    const g = canvas.getContext('2d')!
    g.imageSmoothingQuality = 'medium'
    const step = (1 - size) / (n - 1)
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        g.drawImage(bmp, ix * step * W, iy * step * H, tw, th, 0, 0, canvas.width, canvas.height)
        collect(canvas, ix * step * W, iy * step * H, tw, th, minScore)
      }
    }
  }
  return found.map((f) => ({ ...f, r: { x: +f.r.x.toFixed(4), y: +f.r.y.toFixed(4), w: +f.r.w.toFixed(4), h: +f.r.h.toFixed(4) } }))
}

/**
 * Keypoints for faces known only by their box (stored before descriptors existed): the detector
 * looks again at a crop around each box and the best overlapping detection gives its keypoints
 * and confidence.
 */
export function keypointsFor(handle: DetectorHandle, bmp: ImageBitmap, boxes: Rect[]): { kp?: Pt[]; score: number }[] {
  const W = bmp.width
  const H = bmp.height
  return boxes.map((r) => {
    const side = Math.max(r.w * W, r.h * H) * 2.2
    const cx = (r.x + r.w / 2) * W
    const cy = (r.y + r.h / 2) * H
    const sx = Math.max(0, cx - side / 2)
    const sy = Math.max(0, cy - side / 2)
    const sw = Math.min(W - sx, side)
    const sh = Math.min(H - sy, side)
    if (sw < 4 || sh < 4) return { score: 0 }
    const canvas = new OffscreenCanvas(Math.max(8, Math.round(Math.min(sw, 512))), Math.max(8, Math.round((Math.min(sw, 512) * sh) / sw)))
    canvas.getContext('2d')!.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    let best: { fit: number; score: number; kp: Pt[] } | undefined
    for (const d of handle.det.detect(canvas).detections) {
      const b = d.boundingBox
      if (!b || !d.keypoints || d.keypoints.length < 4) continue
      const box = { x: (sx + (b.originX / canvas.width) * sw) / W, y: (sy + (b.originY / canvas.height) * sh) / H, w: ((b.width / canvas.width) * sw) / W, h: ((b.height / canvas.height) * sh) / H }
      const fit = iou(box, r)
      if (fit > 0.3 && (!best || fit > best.fit)) best = { fit, score: d.categories[0]?.score ?? 0, kp: d.keypoints.slice(0, 4).map((k): Pt => [(sx + k.x * sw) / W, (sy + k.y * sh) / H]) }
    }
    // not found again: keep the box (it was a face when it was detected), keypoints from the box
    return best ? { kp: best.kp, score: best.score } : { score: 1 }
  })
}

/**
 * Where a face is now, given where it was a moment ago (following a face through a clip): the
 * detector looks at a crop around the old box; the detection nearest to it, of similar size, wins.
 * `wide`: a much larger crop, after a quick pan (the caller then checks it is the same person).
 */
export function locate(handle: DetectorHandle, bmp: ImageBitmap, boxes: Rect[], wide = false): { box?: Rect; kp?: Pt[]; score: number }[] {
  const W = bmp.width
  const H = bmp.height
  const search = (r: Rect, crop: number, maxMove: number): { box?: Rect; kp?: Pt[]; score: number } => {
    const size = Math.max(r.w * W, r.h * H)
    const side = size * crop
    const cx = (r.x + r.w / 2) * W
    const cy = (r.y + r.h / 2) * H
    const sx = Math.max(0, cx - side / 2)
    const sy = Math.max(0, cy - side / 2)
    const sw = Math.min(W - sx, side)
    const sh = Math.min(H - sy, side)
    if (sw < 4 || sh < 4) return { score: 0 }
    const k = Math.min(1, 384 / Math.max(sw, sh))
    const canvas = new OffscreenCanvas(Math.max(8, Math.round(sw * k)), Math.max(8, Math.round(sh * k)))
    canvas.getContext('2d')!.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    let best: { cost: number; box: Rect; kp?: Pt[]; score: number } | undefined
    for (const d of handle.det.detect(canvas).detections) {
      const b = d.boundingBox
      const score = d.categories[0]?.score ?? 0
      if (!b || score < 0.6) continue
      const box = { x: (sx + (b.originX / canvas.width) * sw) / W, y: (sy + (b.originY / canvas.height) * sh) / H, w: ((b.width / canvas.width) * sw) / W, h: ((b.height / canvas.height) * sh) / H }
      const move = Math.hypot((box.x + box.w / 2) * W - cx, (box.y + box.h / 2) * H - cy) / size
      const ratio = Math.max(box.w * W, box.h * H) / size
      if (move > maxMove || ratio < 0.6 || ratio > 1.7) continue
      const cost = move + Math.abs(Math.log(ratio))
      const kp = d.keypoints?.length >= 4 ? d.keypoints.slice(0, 4).map((p): Pt => [(sx + p.x * sw) / W, (sy + p.y * sh) / H]) : undefined
      if (!best || cost < best.cost) best = { cost, box, kp, score }
    }
    return best ? { box: best.box, kp: best.kp, score: best.score } : { score: 0 }
  }
  return boxes.map((r) => (wide ? search(r, 6, 2.5) : search(r, 2.6, 0.8)))
}
