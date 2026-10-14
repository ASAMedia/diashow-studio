// Rotate, straighten and crop of a photo or video (MediaItem.edit), as in the edit view of macOS Photos.
// Everything that refers to the original picture (detected faces, pixelated areas, followed faces)
// stays in original-image coordinates. The maps here take points from the edited picture to the
// original and back; the engine samples the original texture through the same affine map (part of the
// texture/UV transform, no extra decode), so the preview, the export and the editing layers agree.
//
// The edit, in order: quarter turns clockwise (`rotate`), then `straighten` degrees clockwise around
// the centre with the zoom that keeps the turned frame free of empty corners, then `crop` (normalised
// to that straightened frame). `adjust` (light and colour, adjust.ts) changes no geometry: isEdited
// and the maps here ignore it; editKey, normalizeEdit and sanitizeEdit carry it along.
import type { MediaEdit, MediaItem, Rect } from './types'
import { adjustKey, isAdjusted, normalizeAdjust, sanitizeAdjust } from './adjust'

/** Straightening goes from -45° to +45°. */
export const MAX_STRAIGHTEN = 45
/** Smallest side of a crop, as a fraction of the straightened picture. */
export const MIN_CROP = 0.05

/** Affine map [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (the order of canvas setTransform and CSS matrix()). */
export type Affine = [number, number, number, number, number, number]

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 }

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))
const isFull = (r: Rect): boolean => Math.abs(r.x) < 1e-6 && Math.abs(r.y) < 1e-6 && Math.abs(r.w - 1) < 1e-6 && Math.abs(r.h - 1) < 1e-6

/** True when the edit changes the geometry (a turn, a tilt or a crop smaller than the picture). */
export function isEdited(e: MediaEdit | undefined | null): e is MediaEdit {
  return !!e && (e.rotate !== 0 || Math.abs(e.straighten) > 1e-6 || (!!e.crop && !isFull(e.crop)))
}

/** True when the edit changes the picture in any way: its geometry or its light and colour. */
export const isChanged = (e: MediaEdit | undefined | null): e is MediaEdit => isAdjusted(e?.adjust) || isEdited(e)

/** Short key of an edit for caches, with its light and colour ('' when the picture is as shot). */
export function editKey(e: MediaEdit | undefined): string {
  const adjust = adjustKey(e?.adjust)
  if (!isEdited(e)) return adjust && `||${adjust}`
  const c = e.crop ?? FULL
  const geometry = `${e.rotate}|${e.straighten.toFixed(2)}|${[c.x, c.y, c.w, c.h].map((v) => v.toFixed(4)).join(',')}`
  return adjust ? `${geometry}|${adjust}` : geometry
}

const quarter = (rotate: number): boolean => rotate === 90 || rotate === 270

/** Size after the quarter turns. */
export function turnedSize(w: number, h: number, rotate: number): { w: number; h: number } {
  return quarter(rotate) ? { w: h, h: w } : { w, h }
}

/** Zoom of a picture (aspect w/h) straightened by `deg`, so its own frame shows no empty corners. */
export function straightenZoom(aspect: number, deg: number): number {
  const t = (Math.min(MAX_STRAIGHTEN, Math.abs(deg)) * Math.PI) / 180
  return Math.cos(t) + Math.max(aspect, 1 / aspect) * Math.sin(t)
}

/** The straightened picture before the crop (in the units of w, h): the turned size shrunk by the zoom. */
export function frameSize(w: number, h: number, e: MediaEdit | undefined): { w: number; h: number } {
  const r = turnedSize(w, h, e?.rotate ?? 0)
  const s = straightenZoom(r.w / r.h, e?.straighten ?? 0)
  return { w: r.w / s, h: r.h / s }
}

/** Size of the edited picture, in the units of w and h (e.g. pixels of the original). */
export function editedSize(w: number, h: number, e: MediaEdit | undefined): { w: number; h: number } {
  if (!isEdited(e)) return { w, h }
  const f = frameSize(w, h, e)
  const c = e.crop ?? FULL
  return { w: f.w * c.w, h: f.h * c.h }
}

/** Width / height of the edited picture of an original with aspect `aspect`. */
export function editedAspect(aspect: number, e: MediaEdit | undefined): number {
  const s = editedSize(aspect, 1, e)
  return s.w / s.h
}

/** Original width / height of a media item (display orientation), 1.5 when unknown. */
export const sourceAspect = (m: Pick<MediaItem, 'width' | 'height'> | undefined): number => (m && m.width > 0 && m.height > 0 ? m.width / m.height : 1.5)

/** Width / height of a media item as it is shown (with its edit). */
export const shownAspect = (m: Pick<MediaItem, 'width' | 'height' | 'edit'> | undefined): number => editedAspect(sourceAspect(m), m?.edit)

export const apply = (m: Affine, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

export function invert(m: Affine): Affine {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

/** `first`, then `second`. */
export function compose(second: Affine, first: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = first
  const [a2, b2, c2, d2, e2, f2] = second
  return [a2 * a1 + c2 * b1, b2 * a1 + d2 * b1, a2 * c1 + c2 * d1, b2 * c1 + d2 * d1, a2 * e1 + c2 * f1 + e2, b2 * e1 + d2 * f1 + f2]
}

/**
 * Map from the edited picture (0..1, top-left origin) to the original picture (0..1); `aspect` is
 * the original's width / height. `withCrop` false maps the straightened frame instead (the editor
 * shows it whole, with the crop on top).
 */
export function editToSource(e: MediaEdit | undefined, aspect: number, withCrop = true): Affine {
  if (!isEdited(e)) return IDENTITY
  // units: the original is `aspect` wide and 1 high
  const turned = quarter(e.rotate)
  const W1 = turned ? 1 : aspect
  const H1 = turned ? aspect : 1
  const s = straightenZoom(W1 / H1, e.straighten)
  const c = withCrop && e.crop ? e.crop : FULL
  const th = (Math.max(-MAX_STRAIGHTEN, Math.min(MAX_STRAIGHTEN, e.straighten)) * Math.PI) / 180
  const cos = Math.cos(th)
  const sin = Math.sin(th)
  const f = (u: number, v: number): [number, number] => {
    // centred point of the frame, then back through the clockwise tilt (y points down)
    const X = ((c.x + u * c.w - 0.5) * W1) / s
    const Y = ((c.y + v * c.h - 0.5) * H1) / s
    const a = (cos * X + sin * Y) / W1 + 0.5
    const b = (-sin * X + cos * Y) / H1 + 0.5
    // back through the quarter turns: a clockwise turn takes (x, y) to (1 - y, x)
    if (e.rotate === 90) return [b, 1 - a]
    if (e.rotate === 180) return [1 - a, 1 - b]
    if (e.rotate === 270) return [1 - b, a]
    return [a, b]
  }
  const [x0, y0] = f(0, 0)
  const [x1, y1] = f(1, 0)
  const [x2, y2] = f(0, 1)
  return [x1 - x0, y1 - y0, x2 - x0, y2 - y0, x0, y0]
}

/** Map from the original picture to the edited one (points outside 0..1 are cut away). */
export const sourceToEdit = (e: MediaEdit | undefined, aspect: number, withCrop = true): Affine => invert(editToSource(e, aspect, withCrop))

/** Bounding box of a rect taken through a map (its four corners). */
export function mapRect(m: Affine, r: Rect): Rect {
  const pts = [apply(m, r.x, r.y), apply(m, r.x + r.w, r.y), apply(m, r.x, r.y + r.h), apply(m, r.x + r.w, r.y + r.h)]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** A rect of the original as it sits on the edited picture (bounding box; may reach outside 0..1). */
export function rectToEdit(r: Rect, e: MediaEdit | undefined, aspect: number): Rect {
  return isEdited(e) ? mapRect(sourceToEdit(e, aspect), r) : r
}

const clip = (r: Rect): Rect => {
  const x = Math.max(0, r.x)
  const y = Math.max(0, r.y)
  return { x, y, w: Math.max(0, Math.min(1, r.x + r.w) - x), h: Math.max(0, Math.min(1, r.y + r.h) - y) }
}

/**
 * Faces (or any boxes) of the original on the edited picture: clipped to it, and left out when less
 * than `visible` of the box is still in the picture (cropped away).
 */
export function facesInEdit(faces: readonly Rect[] | undefined, e: MediaEdit | undefined, aspect: number, visible = 0.25): Rect[] {
  if (!faces?.length) return []
  if (!isEdited(e)) return [...faces]
  const m = sourceToEdit(e, aspect)
  const out: Rect[] = []
  for (const f of faces) {
    const r = mapRect(m, f)
    const c = clip(r)
    if (c.w * c.h >= visible * r.w * r.h && c.w * c.h > 0) out.push(c)
  }
  return out
}

/** A point of the original on the edited picture, kept inside it (e.g. a focus point that was cropped away). */
export function pointToEdit(p: { x: number; y: number }, e: MediaEdit | undefined, aspect: number): { x: number; y: number } {
  if (!isEdited(e)) return p
  const [x, y] = apply(sourceToEdit(e, aspect), p.x, p.y)
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }
}

/**
 * An area drawn on the edited picture as an area of the original, for pixelating: the ellipse inside
 * `r` goes through the map (a turned ellipse when straightened), and the result is the smallest
 * upright ellipse with the same centre and shape as its bounding box that still covers all of it.
 */
export function areaToSource(r: Rect, e: MediaEdit | undefined, aspect: number): Rect {
  if (!isEdited(e)) return r
  const m = editToSource(e, aspect)
  // centre and the two half-axes of the ellipse after the (linear part of the) map
  const [cx, cy] = apply(m, r.x + r.w / 2, r.y + r.h / 2)
  const a1 = (m[0] * r.w) / 2
  const a2 = (m[1] * r.w) / 2
  const b1 = (m[2] * r.h) / 2
  const b2 = (m[3] * r.h) / 2
  const hx = Math.hypot(a1, b1)
  const hy = Math.hypot(a2, b2)
  // largest (dx/hx)² + (dy/hy)² on the mapped ellipse: the top eigenvalue of MᵀM
  const p = a1 / hx
  const q = b1 / hx
  const s = a2 / hy
  const t = b2 / hy
  const tr = p * p + q * q + s * s + t * t
  const det = (p * t - q * s) ** 2
  const k = Math.sqrt((tr + Math.sqrt(Math.max(0, tr * tr - 4 * det))) / 2) * (1 + 1e-6)
  return { x: cx - hx * k, y: cy - hy * k, w: 2 * hx * k, h: 2 * hy * k }
}

/** The edit turned a quarter to the left (-1) or to the right (+1): the crop and the tilt turn with the picture. */
export function rotateEdit(e: MediaEdit | undefined, dir: -1 | 1): MediaEdit {
  const cur = e ?? { rotate: 0, straighten: 0 }
  const rotate = (((cur.rotate + dir * 90) % 360) + 360) % 360 as MediaEdit['rotate']
  const c = cur.crop
  // right: a point (x, y) of the picture goes to (1 - y, x); left: to (y, 1 - x)
  const crop = c ? (dir > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w }) : undefined
  return crop ? { ...cur, rotate, crop } : { ...cur, rotate }
}

/** The edit as it is stored: undefined when it changes nothing, numbers rounded (and still inside, as sanitizeEdit wants them). */
export function normalizeEdit(e: MediaEdit | undefined): MediaEdit | undefined {
  if (!e) return undefined
  const adjust = normalizeAdjust(e.adjust)
  const r4 = (v: number): number => Math.round(v * 1e4) / 1e4
  // (|| 0: a tilt rounded away is +0, as it reads back from the file)
  const straighten = (Number.isFinite(e.straighten) ? Math.round(clamp(e.straighten, -MAX_STRAIGHTEN, MAX_STRAIGHTEN) * 10) / 10 : 0) || 0
  const out: MediaEdit = { ...e, straighten }
  if (e.crop && !isFull(e.crop)) {
    const w = clamp(r4(e.crop.w), MIN_CROP, 1)
    const h = clamp(r4(e.crop.h), MIN_CROP, 1)
    out.crop = { x: clamp(r4(e.crop.x), 0, 1 - w), y: clamp(r4(e.crop.y), 0, 1 - h), w, h }
  } else delete out.crop
  if (adjust) out.adjust = adjust
  else delete out.adjust
  return isEdited(out) || adjust ? out : undefined
}

// ---------------------------------------------------------------- crop presets and handles

export type CropPreset = 'free' | 'original' | '1:1' | '4:3' | '3:2' | '16:9' | '9:16'
export const CROP_PRESETS: CropPreset[] = ['free', 'original', '1:1', '4:3', '3:2', '16:9', '9:16']

/**
 * Width / height in pixels of a preset, null for 'free'. `turnedAspect`: the picture's aspect after the
 * quarter turns ('original' keeps it); `swap` turns portrait into landscape and back.
 */
export function presetRatio(p: CropPreset, turnedAspect: number, swap = false): number | null {
  if (p === 'free') return null
  const r = p === 'original' ? turnedAspect : (([w, h]) => w / h)(p.split(':').map(Number))
  return swap ? 1 / r : r
}

/** The preset a crop matches (for the editor when it opens again), else 'free'. */
export function presetOf(crop: Rect | undefined, frameAspect: number, turnedAspect: number): { preset: CropPreset; swap: boolean } {
  if (!crop) return { preset: 'free', swap: false }
  const r = (crop.w / crop.h) * frameAspect
  // a preset as it is (9:16) before a swapped one (16:9 turned)
  for (const swap of [false, true]) {
    for (const p of CROP_PRESETS) {
      if (p === 'free') continue
      if (Math.abs(Math.log(r / presetRatio(p, turnedAspect, swap)!)) < 0.01) return { preset: p, swap }
    }
  }
  return { preset: 'free', swap: false }
}

/**
 * The largest crop with pixel aspect `ratio`, centred where the current crop is centred (moved to stay
 * inside). `frameAspect`: width / height of the straightened picture.
 */
export function cropToRatio(crop: Rect | undefined, ratio: number, frameAspect: number): Rect {
  const c = crop ?? FULL
  const k = ratio / frameAspect // w / h in frame units
  let w = 1
  let h = 1 / k
  if (h > 1) {
    h = 1
    w = k
  }
  const cx = c.x + c.w / 2
  const cy = c.y + c.h / 2
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h }
}

export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * The crop after dragging a handle by (dx, dy) (fractions of the frame). With `ratio` (pixel w/h) the
 * shape is kept: corners scale from the opposite corner, edges from the middle of the opposite edge.
 */
export function dragCrop(start: Rect, handle: CropHandle, dx: number, dy: number, ratio: number | null, frameAspect: number, min = MIN_CROP): Rect {
  const x0 = start.x
  const y0 = start.y
  const x1 = start.x + start.w
  const y1 = start.y + start.h
  if (handle === 'move') return { x: clamp(x0 + dx, 0, 1 - start.w), y: clamp(y0 + dy, 0, 1 - start.h), w: start.w, h: start.h }
  const west = handle.includes('w')
  const east = handle.includes('e')
  const north = handle.includes('n')
  const south = handle.includes('s')
  if (ratio == null) {
    const l = west ? clamp(x0 + dx, 0, x1 - min) : x0
    const r = east ? clamp(x1 + dx, x0 + min, 1) : x1
    const t = north ? clamp(y0 + dy, 0, y1 - min) : y0
    const b = south ? clamp(y1 + dy, y0 + min, 1) : y1
    return { x: l, y: t, w: r - l, h: b - t }
  }
  const k = ratio / frameAspect // w / h in frame units
  const minW = Math.max(min, min * k)
  // the width the drag asks for (from the moved edges) and the room there is
  let w: number
  let maxW: number
  if ((west || east) && (north || south)) {
    const ww = east ? start.w + dx : start.w - dx
    const hh = south ? start.h + dy : start.h - dy
    w = Math.max(ww, hh * k)
    maxW = Math.min(east ? 1 - x0 : x1, (south ? 1 - y0 : y1) * k)
  } else if (west || east) {
    w = east ? start.w + dx : start.w - dx
    const cy = y0 + start.h / 2
    maxW = Math.min(east ? 1 - x0 : x1, 2 * Math.min(cy, 1 - cy) * k)
  } else {
    w = (south ? start.h + dy : start.h - dy) * k
    const cx = x0 + start.w / 2
    maxW = Math.min(2 * Math.min(cx, 1 - cx), (south ? 1 - y0 : y1) * k)
  }
  w = clamp(w, Math.min(minW, maxW), maxW)
  const h = w / k
  let x = west ? x1 - w : x0
  let y = north ? y1 - h : y0
  if (!west && !east) x = x0 + start.w / 2 - w / 2
  if (!north && !south) y = y0 + start.h / 2 - h / 2
  return { x, y, w, h }
}

// ---------------------------------------------------------------- stored data

/**
 * A media item as the cache knows it (the main process: restore, relink, processing updates) with the
 * fields that belong to the project, not to the file: the user's edit (always the project's) and the
 * faces' centre the clean-up kept (the project's, else the cache's).
 */
export function withProjectFields(item: MediaItem, project: MediaItem | undefined): MediaItem {
  if (!project) return item
  const edit = project.edit
  const faceFocus = project.faceFocus ?? item.faceFocus
  if (item.edit === edit && item.faceFocus === faceFocus) return item
  const { edit: _e, faceFocus: _f, ...rest } = item
  return { ...rest, ...(edit ? { edit } : {}), ...(faceFocus ? { faceFocus } : {}) }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * A usable edit from stored data (project files): quarter turns (other angles rounded to the nearest),
 * straightening clamped to ±45°, a crop moved and shrunk into the picture, light and colour clamped
 * to ±100 (adjust.ts). `fixed` tells whether anything had to change; `edit` is undefined when
 * nothing usable was left.
 */
export function sanitizeEdit(raw: unknown): { edit: MediaEdit | undefined; fixed: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { edit: undefined, fixed: true }
  const o = { ...(raw as Record<string, unknown>) }
  let fixed = false
  let rotate = 0
  if (finite(o.rotate)) {
    rotate = ((Math.round(o.rotate / 90) * 90) % 360 + 360) % 360
    if (rotate !== o.rotate) fixed = true
  } else if (o.rotate !== undefined) fixed = true
  let straighten = 0
  if (finite(o.straighten)) {
    straighten = clamp(o.straighten, -MAX_STRAIGHTEN, MAX_STRAIGHTEN)
    if (straighten !== o.straighten) fixed = true
  } else if (o.straighten !== undefined) fixed = true
  const edit = { ...o, rotate, straighten } as unknown as MediaEdit
  delete (edit as { crop?: Rect }).crop
  if (o.crop !== undefined) {
    const c = o.crop as Record<string, unknown> | null
    if (typeof c === 'object' && c && finite(c.x) && finite(c.y) && finite(c.w) && finite(c.h) && c.w > 0 && c.h > 0) {
      const w = clamp(c.w, MIN_CROP, 1)
      const h = clamp(c.h, MIN_CROP, 1)
      const crop = { x: clamp(c.x, 0, 1 - w), y: clamp(c.y, 0, 1 - h), w, h }
      if (crop.x !== c.x || crop.y !== c.y || crop.w !== c.w || crop.h !== c.h) fixed = true
      edit.crop = crop
    } else fixed = true
  }
  delete (edit as { adjust?: unknown }).adjust
  if (o.adjust !== undefined) {
    const a = sanitizeAdjust(o.adjust)
    if (a.adjust) edit.adjust = a.adjust
    if (a.fixed) fixed = true
  }
  return { edit: edit.adjust || isEdited(edit) ? edit : undefined, fixed }
}
