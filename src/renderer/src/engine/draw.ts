import type { Entry, MediaItem, PhotoEntry, ProjectSettings, Rect, TextPosition, TextStyle } from '@shared/types'
import { DEFAULT_TEXT_STYLE } from '@shared/types'
import type { TimelineSlide } from '@shared/timeline'
import type { QuadSpec, Tex, UvRect } from './gl'
import type { Ctx, SlideState } from './types'
import type { TextSpec } from './media'

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
export const easeOut = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3)
export const easeIn = (t: number): number => Math.pow(clamp01(t), 3)
export const smooth = (t: number): number => {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

/** Deterministic pseudo random generator seeded by a string. */
export function rng(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h += 0x6d2b79f5
    let x = h
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Largest centred crop of a media item with the given aspect, as a normalised rect. */
export function coverRect(mediaAspect: number, boxAspect: number): Rect {
  if (mediaAspect > boxAspect) {
    const w = boxAspect / mediaAspect
    return { x: (1 - w) / 2, y: 0, w, h: 1 }
  }
  const h = mediaAspect / boxAspect
  return { x: 0, y: (1 - h) / 2, w: 1, h }
}

export function containBox(mediaAspect: number, box: Box): Box {
  const ba = box.w / box.h
  if (mediaAspect > ba) {
    const h = box.w / mediaAspect
    return { x: box.x, y: box.y + (box.h - h) / 2, w: box.w, h }
  }
  const w = box.h * mediaAspect
  return { x: box.x + (box.w - w) / 2, y: box.y, w, h: box.h }
}

export function aspectOf(m: MediaItem | undefined, tex?: Tex | null): number {
  if (m && m.width > 0 && m.height > 0) return m.width / m.height
  return tex ? tex.w / tex.h : 1.5
}

/** Default Ken Burns motion: zoom in or out and drift in a direction picked from the seed. */
export function defaultKenBurns(mediaAspect: number, frameAspect: number, seed: string, faces?: Rect[]): { start: Rect; end: Rect } {
  const full = coverRect(mediaAspect, frameAspect)
  const r = rng(seed)
  if (faces?.length) {
    // move towards (or away from) the faces instead of a random spot
    const f = facesFocus({ faces } as MediaItem)
    const wide = { ...full, x: Math.min(1 - full.w, Math.max(0, f.x - full.w / 2)), y: Math.min(1 - full.h, Math.max(0, f.y - full.h / 2)) }
    const zoom = 0.78 + r() * 0.06
    const w = full.w * zoom
    const h = full.h * zoom
    const close = { x: Math.min(1 - w, Math.max(0, f.x - w / 2)), y: Math.min(1 - h, Math.max(0, f.y - h / 2)), w, h }
    return r() < 0.65 ? { start: wide, end: close } : { start: close, end: wide }
  }
  const zoom = 0.82 + r() * 0.06
  const small = { w: full.w * zoom, h: full.h * zoom }
  const portraitInWide = mediaAspect < frameAspect * 0.8
  let sx: number, sy: number
  if (portraitInWide) {
    // pan from top to bottom (or the reverse) through a tall photo
    sx = full.x + (full.w - small.w) / 2
    sy = r() < 0.5 ? full.y : full.y + full.h - small.h
  } else {
    sx = full.x + (full.w - small.w) * r()
    sy = full.y + (full.h - small.h) * r()
  }
  const inner = { x: sx, y: sy, ...small }
  return r() < 0.5 ? { start: full, end: inner } : { start: inner, end: full }
}

/** Default vertical focus: slightly above the middle, where heads usually are. */
export const DEFAULT_FOCUS_Y = 0.42

/** Centre of the detected faces (weighted by size), or the default focus. */
export function facesFocus(m: MediaItem | undefined): { x: number; y: number } {
  const faces = m?.faces
  if (!faces?.length) return { x: 0.5, y: DEFAULT_FOCUS_Y }
  let sum = 0
  let x = 0
  let y = 0
  for (const f of faces) {
    const a = f.w * f.h
    sum += a
    x += (f.x + f.w / 2) * a
    y += (f.y + f.h / 2) * a
  }
  return { x: x / sum, y: y / sum }
}

/** Crop of a photo filling a cell, honouring the user's framing (focus point and zoom). */
export function photoUv(entry: Entry | undefined, m: MediaItem | undefined, boxAspect: number, tex?: Tex | null): UvRect {
  const base = coverRect(aspectOf(m, tex), boxAspect)
  const crop = entry?.type === 'photo' || entry?.type === 'video' ? entry.crop : undefined
  const z = Math.min(4, Math.max(1, crop?.zoom ?? 1))
  const w = base.w / z
  const h = base.h / z
  const focus = crop ? null : facesFocus(m)
  const fx = crop?.x ?? focus!.x
  const fy = crop?.y ?? focus!.y
  return { x: Math.min(1 - w, Math.max(0, fx - w / 2)), y: Math.min(1 - h, Math.max(0, fy - h / 2)), w, h }
}

export function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) }
}

export function kenBurnsUv(entry: PhotoEntry, m: MediaItem, frameAspect: number, t: number): UvRect {
  const kb = entry.kenBurns ?? defaultKenBurns(aspectOf(m), frameAspect, entry.id, m.faces)
  return lerpRect(kb.start, kb.end, easeInOut(clamp01(t)))
}

/** Texture for entry i of a slide: video frame, live photo motion, or still image. */
export function slideTexture(ctx: Ctx, s: SlideState, i = 0): Tex | null {
  const sl = s.slide
  if (sl.kind === 'video') return ctx.video(sl, s.local)
  if (sl.entries[i]?.type === 'video') return ctx.video(sl, s.local, i) ?? ctx.image(sl.media[i])
  if (i === 0 && sl.live && s.local < sl.live.duration) {
    const v = ctx.video(sl, s.local)
    if (v) return v
  }
  return ctx.image(sl.media[i])
}

export interface MediaDrawOpts extends Omit<QuadSpec, 'x' | 'y' | 'w' | 'h' | 'tex' | 'uv'> {
  fit?: 'cover' | 'contain'
  uv?: UvRect
  /** Extra zoom factor applied around the centre of the crop (1 = none). */
  zoom?: number
}

/** Draws media into a box. Returns the box actually covered (smaller for 'contain'). */
export function drawMedia(ctx: Ctx, tex: Tex | null, aspect: number, box: Box, o: MediaDrawOpts = {}): Box {
  const fit = o.fit ?? 'cover'
  const target = fit === 'contain' ? containBox(aspect, box) : box
  if (!tex) {
    ctx.c.quad({ ...o, color: [0.16, 0.16, 0.17, 1], x: target.x, y: target.y, w: target.w, h: target.h })
    return target
  }
  let uv: UvRect = o.uv ?? (fit === 'cover' ? coverRect(aspect, box.w / box.h) : { x: 0, y: 0, w: 1, h: 1 })
  if (o.zoom && o.zoom !== 1) {
    const w = uv.w / o.zoom
    const h = uv.h / o.zoom
    uv = { x: uv.x + (uv.w - w) / 2, y: uv.y + (uv.h - h) / 2, w, h }
  }
  ctx.c.quad({ look: true, ...o, tex, uv, x: target.x, y: target.y, w: target.w, h: target.h })
  return target
}

/**
 * Whether an entry is shown whole (fitted into its cell) instead of cropped. Photos follow
 * their own choice or the project's "crop to fill"; videos without a choice are cropped only
 * when their shape is close to the cell's.
 */
export function showsWhole(e: Entry | undefined, settings: ProjectSettings, mediaAspect: number, boxAspect: number, tolerance = 0.22): boolean {
  if (!e || e.type === 'text') return false
  if (e.whole != null) return e.whole
  if (e.type === 'video') return Math.abs(Math.log(mediaAspect / boxAspect)) >= tolerance
  return !settings.scaleToFill
}

/** Whole picture inside a box, on a blurred copy of itself ('blur') or on the background ('none'). */
export function drawWhole(ctx: Ctx, tex: Tex | null, aspect: number, box: Box, o: MediaDrawOpts = {}, fill: 'blur' | 'none' = 'blur', scale = 1): Box {
  if (fill === 'blur' && tex) drawMedia(ctx, tex, aspect, box, { ...o, fit: 'cover', blur: 5, shade: Math.max(o.shade ?? 0, 0.68), zoom: 1.12 })
  const c = containBox(aspect, box)
  const inner = { x: c.x + (c.w * (1 - scale)) / 2, y: c.y + (c.h * (1 - scale)) / 2, w: c.w * scale, h: c.h * scale }
  const pv = o.pivot ?? [0.5, 0.5]
  const pivot: [number, number] = [(box.x + pv[0] * box.w - inner.x) / inner.w, (box.y + pv[1] * box.h - inner.y) / inner.h]
  return drawMedia(ctx, tex, aspect, inner, { ...o, zoom: 1, fit: 'cover', pivot })
}

/** Entry i of a slide in a cell: cropped with the user's framing, or whole. */
export function drawCell(ctx: Ctx, s: SlideState, i: number, box: Box, o: MediaDrawOpts = {}, fill: 'blur' | 'none' = 'blur', tolerance = 0.22): Box {
  const sl = s.slide
  const e = sl.entries[i]
  const m = sl.media[i]
  const tex = slideTexture(ctx, s, i)
  const a = aspectOf(m, tex)
  if (tex && showsWhole(e, ctx.settings, a, box.w / box.h, tolerance)) return drawWhole(ctx, tex, a, box, o, fill)
  return drawMedia(ctx, tex, a, box, { ...o, uv: photoUv(e, m, box.w / box.h, tex) })
}

/** The show's text overrides (font, size, colour, capitals) applied to a theme's text. */
export function applyTextStyle(spec: TextSpec, style: TextStyle | undefined): TextSpec {
  const ts = { ...DEFAULT_TEXT_STYLE, ...style }
  return {
    ...spec,
    font: ts.font === 'theme' ? spec.font : ts.font,
    weight: ts.font === 'theme' ? spec.weight : undefined,
    size: spec.size * ts.scale,
    color: ts.color || spec.color,
    uppercase: ts.uppercase === 'theme' ? spec.uppercase : ts.uppercase === 'on'
  }
}

/** Position chosen for titles and captions on photos, or 'theme'. */
export function textPosition(ctx: Ctx): TextPosition {
  return ctx.settings.text?.position ?? 'theme'
}

/** Lines of text stacked into one block at a position inside an area. */
export function drawTextBlock(ctx: Ctx, specs: TextSpec[], pos: Exclude<TextPosition, 'theme'>, area: Box, opacity: number): Box | null {
  const align = pos === 'bottom-right' ? 'right' : pos === 'bottom-center' || pos === 'center' ? 'center' : 'left'
  const texs = specs.map((sp) => ctx.text({ ...sp, align, maxWidth: Math.min(sp.maxWidth ?? Infinity, area.w * 0.8) })).filter((x): x is Tex => !!x)
  if (!texs.length || opacity <= 0.001) return null
  const w = Math.max(...texs.map((x) => x.w))
  const h = texs.reduce((sum, x) => sum + x.h, 0)
  const pad = ctx.H * 0.03
  const x = pos === 'bottom-left' || pos === 'top-left' ? area.x + pad : pos === 'bottom-right' ? area.x + area.w - pad - w : area.x + (area.w - w) / 2
  const y = pos === 'top-left' ? area.y + pad : pos === 'center' ? area.y + (area.h - h) / 2 : area.y + area.h - pad - h
  let yy = y
  for (const tex of texs) {
    const xx = align === 'left' ? x : align === 'right' ? x + w - tex.w : x + (w - tex.w) / 2
    ctx.c.quad({ tex, x: xx, y: yy, w: tex.w, h: tex.h, opacity })
    yy += tex.h
  }
  return { x, y, w, h }
}

/** Draws a text texture with its centre (or left edge) at x,y. */
export function drawText(
  ctx: Ctx,
  spec: TextSpec,
  x: number,
  y: number,
  o: Omit<QuadSpec, 'x' | 'y' | 'w' | 'h' | 'tex'> & { anchor?: 'center' | 'left' | 'right' } = {}
): Box | null {
  const tex = ctx.text(spec)
  if (!tex) return null
  const ax = o.anchor === 'left' ? 0 : o.anchor === 'right' ? 1 : 0.5
  const box = { x: x - tex.w * ax, y: y - tex.h / 2, w: tex.w, h: tex.h }
  ctx.c.quad({ ...o, tex, ...box })
  return box
}

export function slotBoxes(slide: TimelineSlide, frame: Box, gutter: number): Box[] {
  const slots = slide.template?.slots ?? [{ x: 0, y: 0, w: 1, h: 1 }]
  return slots.map((s) => {
    const x0 = frame.x + s.x * frame.w + (s.x > 0 ? gutter / 2 : 0)
    const y0 = frame.y + s.y * frame.h + (s.y > 0 ? gutter / 2 : 0)
    const x1 = frame.x + (s.x + s.w) * frame.w - (s.x + s.w < 0.999 ? gutter / 2 : 0)
    const y1 = frame.y + (s.y + s.h) * frame.h - (s.y + s.h < 0.999 ? gutter / 2 : 0)
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  })
}

/** Opacity of a title overlay on the first slide: fades in, holds, fades out. */
export function titleOpacity(local: number): number {
  return smooth(local / 0.8) * (1 - smooth((local - 3.2) / 0.8))
}

export function dirVector(d: string): [number, number] {
  switch (d) {
    case 'right':
      return [-1, 0]
    case 'up':
      return [0, -1]
    case 'down':
      return [0, 1]
    default:
      return [1, 0]
  }
}
