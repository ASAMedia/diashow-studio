// Alignment of a face for the recognition model (src/renderer/src/vision): a similarity transform
// (scale, rotation, shift) that puts the eyes and the mouth where the model expects them.
//
// The model is dlib's face recognition ResNet (via face-api.js). It was trained on 150 x 150 "face
// chips" made by dlib's get_face_chip_details(shape, 150, 0.25): the face's landmarks are mapped onto
// dlib's mean face shape, padded by 25 % on each side. The targets below are that mean shape's eye
// centres, nose tip and mouth centre in chip pixels; BlazeFace gives the same four points.
import type { Rect } from './types'

export const CHIP_SIZE = 150

export type Pt = [number, number]

/** Image-left eye, image-right eye, nose tip, mouth centre, in chip pixels. */
export const CHIP_TARGETS: Pt[] = [
  [47.55, 46.6],
  [100.48, 46.6],
  [74.01, 76.56],
  [74.01, 105.42]
]

/** Where those points sit inside a BlazeFace box (fractions of the box): medians of 265 faces in class-trip photos, made symmetric. */
export const BOX_KEYPOINTS: Pt[] = [
  [0.285, 0.31],
  [0.685, 0.31],
  [0.485, 0.555],
  [0.485, 0.745]
]

/** x' = a x - b y + tx, y' = b x + a y + ty (canvas setTransform(a, b, -b, a, tx, ty)). */
export interface Similarity {
  a: number
  b: number
  tx: number
  ty: number
}

/**
 * Least-squares similarity transform mapping `src` points onto `dst` (same length, >= 2 points,
 * optional weights). Closed form (Umeyama without reflection).
 */
export function fitSimilarity(src: Pt[], dst: Pt[], weights?: number[]): Similarity {
  const n = Math.min(src.length, dst.length)
  let sw = 0
  let sx = 0, sy = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const w = weights?.[i] ?? 1
    sw += w
    sx += w * src[i][0]
    sy += w * src[i][1]
    dx += w * dst[i][0]
    dy += w * dst[i][1]
  }
  sx /= sw
  sy /= sw
  dx /= sw
  dy /= sw
  let num1 = 0, num2 = 0, den = 0
  for (let i = 0; i < n; i++) {
    const w = weights?.[i] ?? 1
    const px = src[i][0] - sx
    const py = src[i][1] - sy
    const qx = dst[i][0] - dx
    const qy = dst[i][1] - dy
    num1 += w * (px * qx + py * qy)
    num2 += w * (px * qy - py * qx)
    den += w * (px * px + py * py)
  }
  const a = den > 0 ? num1 / den : 1
  const b = den > 0 ? num2 / den : 0
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) }
}

export function applySimilarity(t: Similarity, p: Pt): Pt {
  return [t.a * p[0] - t.b * p[1] + t.tx, t.b * p[0] + t.a * p[1] + t.ty]
}

/**
 * Transform from image pixels to chip pixels for a face. `kp` are BlazeFace's keypoints in image
 * pixels (image-left eye, image-right eye, nose tip, mouth centre, ...); without them (or with
 * implausible ones) the average keypoint positions inside the box are used.
 */
export function chipTransform(box: Rect, kp?: Pt[]): Similarity {
  const fromBox = BOX_KEYPOINTS.map(([fx, fy]): Pt => [box.x + fx * box.w, box.y + fy * box.h])
  let pts = fromBox
  if (kp && kp.length >= 4) {
    const eyes = Math.hypot(kp[1][0] - kp[0][0], kp[1][1] - kp[0][1])
    // keypoints far off the box (a mis-detection) would give a wild crop
    const inside = kp.slice(0, 4).every(([x, y]) => x > box.x - box.w * 0.3 && x < box.x + box.w * 1.3 && y > box.y - box.h * 0.3 && y < box.y + box.h * 1.3)
    if (inside && eyes > box.w * 0.15) pts = kp.slice(0, 4)
  }
  // eyes count most: the nose tip moves with the head turning
  return fitSimilarity(pts, CHIP_TARGETS, [2, 2, 0.5, 1])
}

// ---------------------------------------------------------------- which faces can be recognised

/** Detector confidence below which a "face" is too often something else (a helmet, a glove). */
export const DESC_MIN_SCORE = 0.65
/** Eye distance (pixels of the analysed picture) below which a face is too small to recognise. */
export const DESC_MIN_EYE_PX = 12
/** Share of the eye band that must look like the cheeks: goggles and sunglasses hide the eyes. */
export const DESC_MIN_VISIBLE = 0.3

/**
 * How much of the eye band of an aligned chip (RGBA, CHIP_SIZE square) has the colour of the
 * cheeks below it, 0..1. Ski goggles and sunglasses cover that band and give values near 0; eyes,
 * brows and the nose bridge leave most of it skin. Faces with covered eyes give descriptors that
 * are all alike (different children in goggles came out as "the same person"), so they get none.
 * 0 as well when the cheeks don't look like skin.
 */
export function eyeVisibility(rgba: ArrayLike<number>, size = CHIP_SIZE): number {
  const k = size / CHIP_SIZE
  const at = (x: number, y: number): number => (Math.round(y * k) * size + Math.round(x * k)) * 4
  const chroma = (i: number): [number, number, number] => {
    const s = rgba[i] + rgba[i + 1] + rgba[i + 2] + 1
    return [rgba[i] / s, rgba[i + 1] / s, s / 3]
  }
  // reference skin: the cheeks beside the nose, below the eyes
  const ref: [number, number, number][] = []
  for (let y = 68; y < 90; y++) for (const [x0, x1] of [[38, 58], [90, 110]]) for (let x = x0; x < x1; x++) ref.push(chroma(at(x, y)))
  const med = [0, 1, 2].map((c) => ref.map((p) => p[c]).sort((a, b) => a - b)[ref.length >> 1])
  // cheeks that aren't skin-coloured (reddish, not too dark): a glove, a black helmet, goggles and
  // a face mask taken for a face; on 400 class-trip faces this kept every clear face but a few in
  // very cold light
  if (med[0] < 0.31 || med[2] < 30) return 0
  let close = 0
  let n = 0
  for (let y = 34; y < 60; y++)
    for (let x = 30; x < 120; x++) {
      const c = chroma(at(x, y))
      const d = Math.hypot((c[0] - med[0]) * 6, (c[1] - med[1]) * 6, ((c[2] - med[2]) / 255) * 1.5)
      if (d < 0.25) close++
      n++
    }
  return close / n
}

/** Is a face good enough for a descriptor? */
export function recognisable(score: number, eyePx: number, visible: number): boolean {
  return score >= DESC_MIN_SCORE && eyePx >= DESC_MIN_EYE_PX && visible >= DESC_MIN_VISIBLE
}
