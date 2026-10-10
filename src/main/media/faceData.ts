// Checks face data coming from the renderer before it is stored with a media item: descriptors
// (128 numbers per face, aligned with the faces) and the faces found in sampled video frames.
import type { Rect, VideoFaces } from '@shared/types'

export const DESC_LENGTH = 128
const MAX_FACES = 256
const MAX_SAMPLES = 400

/** Keeps well-formed rects, clamped into the unit square. */
export function sanitizeRects(faces: unknown): Rect[] {
  if (!Array.isArray(faces)) return []
  const out: Rect[] = []
  const unit = (v: number): number => Math.min(1, Math.max(0, v))
  for (const f of faces.slice(0, MAX_FACES)) {
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

/** One descriptor: 128 finite numbers (rounded to 4 decimals), else null. */
export function sanitizeDescriptor(d: unknown): number[] | null {
  if (!Array.isArray(d) || d.length !== DESC_LENGTH) return null
  const out = new Array<number>(DESC_LENGTH)
  for (let i = 0; i < DESC_LENGTH; i++) {
    const v = d[i]
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 10) return null
    out[i] = Math.round(v * 1e4) / 1e4
  }
  return out
}

/**
 * Descriptors aligned with `faces` (same length, each valid), or undefined: a list that doesn't fit
 * the faces is dropped as a whole rather than attached to the wrong face. A face without a
 * descriptor (too small, failed) may be an empty array.
 */
export function sanitizeDescriptors(desc: unknown, faceCount: number): number[][] | undefined {
  if (!Array.isArray(desc) || desc.length !== faceCount) return undefined
  const out: number[][] = []
  for (const d of desc) {
    if (Array.isArray(d) && d.length === 0) {
      out.push([])
      continue
    }
    const v = sanitizeDescriptor(d)
    if (!v) return undefined
    out.push(v)
  }
  return out
}

/** Sampled video frames: finite times >= 0 in ascending order, rects checked, descriptors aligned. */
export function sanitizeVideoFaces(samples: unknown): VideoFaces[] {
  if (!Array.isArray(samples)) return []
  const out: VideoFaces[] = []
  let last = -1
  for (const s of samples.slice(0, MAX_SAMPLES)) {
    if (!s || typeof s !== 'object') continue
    const { t, faces, desc } = s as Record<string, unknown>
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t <= last) continue
    // rects that were dropped would misalign the descriptors: then all are kept or none
    const rects = sanitizeRects(faces)
    const aligned = Array.isArray(faces) && rects.length === faces.length
    const d = aligned && desc !== undefined ? sanitizeDescriptors(desc, rects.length) : undefined
    last = t
    out.push(d ? { t: Math.round(t * 1000) / 1000, faces: rects, desc: d } : { t: Math.round(t * 1000) / 1000, faces: rects })
  }
  return out
}
