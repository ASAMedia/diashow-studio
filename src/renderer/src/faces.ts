// Face detection for face-aware crops and Ken Burns. MediaPipe's BlazeFace runs offline in
// WebAssembly; results are stored with the media item through the main process.
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'
import { mediaUrl } from '@shared/api'
import type { Rect } from '@shared/types'
import { useStore } from './store'

let detector: Promise<FaceDetector> | null = null

// MediaPipe reports usage statistics to Google. The page's CSP blocks that anyway; answering
// the request locally keeps it from even trying (and from logging errors).
const TELEMETRY = 'odml.pa.googleapis.com'
const realFetch = window.fetch.bind(window)
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return url.includes(TELEMETRY) ? Promise.resolve(new Response(null, { status: 204 })) : realFetch(input, init)
}

function getDetector(): Promise<FaceDetector> {
  detector ??= (async () => {
    // copied next to index.html by scripts/fetch-models.mjs
    const base = new URL('./vision/', document.baseURI).href
    const fileset = await FilesetResolver.forVisionTasks(base)
    return FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${base}blaze_face_short_range.tflite`, delegate: 'CPU' },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.6
    })
  })()
  return detector
}

const iou = (a: Rect, b: Rect): number => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = x * y
  return inter / (a.w * a.h + b.w * b.h - inter)
}

/**
 * Faces as rects normalised to the image. BlazeFace (short range) finds faces that fill a fair
 * part of its input, so besides the whole picture it also looks at 3x3 overlapping tiles to
 * catch the small faces of group photos.
 */
export async function detectFaces(path: string): Promise<Rect[]> {
  const det = await getDetector()
  const blob = await (await fetch(mediaUrl(path))).blob()
  let bmp = await createImageBitmap(blob)
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
  if (scale < 1) {
    const small = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * scale), resizeHeight: Math.round(bmp.height * scale), resizeQuality: 'medium' })
    bmp.close()
    bmp = small
  }
  const W = bmp.width
  const H = bmp.height
  const found: Rect[] = []
  const collect = (src: TexImageSource & { width: number; height: number }, ox: number, oy: number, sw: number, sh: number): void => {
    for (const d of det.detect(src).detections) {
      const b = d.boundingBox
      if (!b) continue
      const r = {
        x: (ox + (b.originX / src.width) * sw) / W,
        y: (oy + (b.originY / src.height) * sh) / H,
        w: ((b.width / src.width) * sw) / W,
        h: ((b.height / src.height) * sh) / H
      }
      if (r.w > 0.004 && r.h > 0.004 && !found.some((f) => iou(f, r) > 0.3)) found.push(r)
    }
  }
  collect(bmp, 0, 0, W, H)
  const tw = W * 0.45
  const th = H * 0.45
  const canvas = new OffscreenCanvas(Math.round(tw), Math.round(th))
  const g = canvas.getContext('2d')!
  for (const fy of [0, 0.275, 0.55]) {
    for (const fx of [0, 0.275, 0.55]) {
      g.drawImage(bmp, fx * W, fy * H, tw, th, 0, 0, canvas.width, canvas.height)
      collect(canvas, fx * W, fy * H, tw, th)
    }
  }
  bmp.close()
  return found.map((r) => ({ x: +r.x.toFixed(4), y: +r.y.toFixed(4), w: +r.w.toFixed(4), h: +r.h.toFixed(4) }))
}

/**
 * Works through the open project's photos in the background, one at a time, and pauses while
 * the show plays or exports so it never costs frames.
 */
export function startFaceQueue(): () => void {
  const tried = new Set<string>()
  let running = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async (): Promise<void> => {
    if (running || stopped) return
    const s = useStore.getState()
    if (s.playing || s.exportOpen || s.fullscreen || s.presenting) {
      clearTimeout(timer)
      timer = setTimeout(() => void tick(), 1500)
      return
    }
    const next = s.project?.media.find((m) => m.kind === 'photo' && m.status === 'ready' && m.display && m.faces === undefined && !tried.has(m.id))
    if (!next) return
    running = true
    tried.add(next.id)
    try {
      const faces = await detectFaces(next.display!)
      const p = useStore.getState().project
      if (p?.media.some((m) => m.id === next.id)) {
        useStore.setState({ project: { ...p, media: p.media.map((m) => (m.id === next.id ? { ...m, faces } : m)) } })
      }
      await window.api.setFaces(next.id, faces).catch(() => {})
    } catch (e) {
      console.warn('face detection failed', next.name, e)
    } finally {
      running = false
    }
    clearTimeout(timer)
    timer = setTimeout(() => void tick(), 20)
  }
  const unsubscribe = useStore.subscribe(() => void tick())
  void tick()
  return () => {
    stopped = true
    clearTimeout(timer)
    unsubscribe()
  }
}
