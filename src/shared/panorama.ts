// Panoramas: photos much wider (or taller) than the slide. As in the slideshows of macOS Photos they
// get a slide of their own, fill its height (width) and the view travels from one end to the other,
// instead of being cropped hard or shown as a thin strip. The timeline (own slide, longer time), the
// engine (the pan, in every theme) and the editor (Slide tab, filmstrip mark) share these rules.
import type { Entry, MediaItem, Rect } from './types'
import { shownAspect } from './mediaEdit'

/**
 * A photo is a panorama when its shape as shown (after rotate, straighten and crop) is at least 2:1
 * and at least 1.4 times as wide as the output; tall ones the same way round (at most 1:2, and at
 * most the output's shape / 1.4), panning top to bottom. The first bound keeps ordinary photos
 * ordinary in narrow shows (a 3:2 photo in 9:16); the second keeps a mildly wide photo in a wide show
 * (2.2:1 in 16:9: a fifth cropped on each side) a normal photo. So in 16:9 a panorama starts at about
 * 2.5:1, in 4:3, 1:1 and 9:16 at 2:1; tall ones at 1:2, and in 9:16 at about 1:2.5.
 */
export const PANO_MIN = 2
export const PANO_REL = 1.4

/** 'x': wide, pans left/right; 'y': tall, pans up/down. */
export type PanAxis = 'x' | 'y'

/** How a panorama is shown: panning (the default), the whole picture, or cropped to fill. */
export type PanoMode = 'pan' | 'whole' | 'crop'

/** A panorama alone on its slide (TimelineSlide.pano). `reverse`: right to left (bottom to top). */
export interface PanoSlide {
  axis: PanAxis
  mode: PanoMode
  reverse: boolean
}

/** The axis a picture of this shape pans along in an output of `frameAspect`, null when it is no panorama. */
export function panoramaAxis(aspect: number, frameAspect: number): PanAxis | null {
  if (!(aspect > 0) || !(frameAspect > 0)) return null
  if (aspect >= PANO_MIN && aspect >= PANO_REL * frameAspect) return 'x'
  if (aspect <= 1 / PANO_MIN && aspect <= frameAspect / PANO_REL) return 'y'
  return null
}

/** The panorama axis of a media item as shown in a show of `frameAspect`; videos never pan. */
export function panoramaOf(m: MediaItem | undefined, frameAspect: number): PanAxis | null {
  return m?.kind === 'photo' ? panoramaAxis(shownAspect(m), frameAspect) : null
}

/** The entry's own choice; the existing crop / whole-picture setting doubles as it ('pan' when unset). */
export function panoMode(e: Entry | undefined): PanoMode {
  if (!e || e.type === 'text' || e.whole == null) return 'pan'
  return e.whole ? 'whole' : 'crop'
}

/** What the Slide tab stores for a mode: the crop / whole setting (none for panning). */
export const panoModePatch = (mode: PanoMode): { whole: boolean | undefined } => ({ whole: mode === 'pan' ? undefined : mode === 'whole' })

/** How many frames the panorama spans when it fills the frame's height (width). */
export function panSpan(aspect: number, frameAspect: number, axis: PanAxis): number {
  return Math.max(1, axis === 'x' ? aspect / frameAspect : frameAspect / aspect)
}

/** Longest a panning slide lasts by default, in normal photo times. */
export const PANO_MAX_TIME = 2.5

/**
 * Default time of a panning slide in normal photo times: longer the further it travels (60 % of a
 * photo time per extra frame), at most 2.5×. A 4:1 iPhone panorama in 16:9 travels 1.25 frames and
 * gets 1.75×; from about 6:1 on the cap applies.
 */
export function panTimeFactor(aspect: number, frameAspect: number, axis: PanAxis): number {
  return Math.min(PANO_MAX_TIME, 1 + 0.6 * (panSpan(aspect, frameAspect, axis) - 1))
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/**
 * Where the pan is (0..1) at time t (0..1): constant speed in the middle, and over `ramp` (a share of
 * the time) at each end the speed rises from 0 and falls back to 0 along a smoothstep, so the view
 * starts and stops softly and never jerks. The position is the speed's integral (u³ - u⁴/2 on a ramp).
 */
export function panEase(t: number, ramp = 0.2): number {
  const r = Math.min(0.5, Math.max(1e-3, ramp))
  const x = clamp01(t)
  // speed in the middle: the ramps cover only half their length
  const v = 1 / (1 - r)
  const rise = (u: number): number => u * u * u - (u * u * u * u) / 2
  if (x < r) return v * r * rise(x / r)
  if (x > 1 - r) return 1 - v * r * rise((1 - x) / r)
  return v * (x - r / 2)
}

/** Seconds of the soft start and of the soft stop (shorter on short slides, at most 30 % each). */
export const PAN_RAMP_SECONDS = 1.2
export const panRamp = (seconds: number): number => Math.min(0.3, PAN_RAMP_SECONDS / Math.max(1e-3, seconds))

/** The part of a picture (normalised) that fills a box of `boxAspect`, at the start (q 0) or end (q 1) of the pan. */
export function panUv(aspect: number, boxAspect: number, axis: PanAxis, reverse: boolean, q: number): Rect {
  const k = reverse ? 1 - clamp01(q) : clamp01(q)
  if (aspect > boxAspect) {
    const w = boxAspect / aspect
    return axis === 'x' ? { x: (1 - w) * k, y: 0, w, h: 1 } : { x: (1 - w) / 2, y: 0, w, h: 1 }
  }
  const h = aspect / boxAspect
  return axis === 'y' ? { x: 0, y: (1 - h) * k, w: 1, h } : { x: 0, y: (1 - h) / 2, w: 1, h }
}

/** Start and end of the pan across the full frame: the panorama's default Ken Burns framing. */
export function panFrames(aspect: number, frameAspect: number, axis: PanAxis, reverse: boolean): { start: Rect; end: Rect } {
  return { start: panUv(aspect, frameAspect, axis, reverse, 0), end: panUv(aspect, frameAspect, axis, reverse, 1) }
}

/**
 * Shape of a print, card or cell that holds a panorama in a theme that doesn't fill the frame with
 * it (Vintage Prints, Scrapbook, Snapshots, Reflections): the shape of the theme's `area`, but at
 * least 2:1 (1:2 for a tall one), and never wider (taller) than the panorama itself.
 */
export function panoWindow(aspect: number, areaAspect: number, axis: PanAxis): number {
  return axis === 'x' ? Math.min(aspect, Math.max(PANO_MIN, areaAspect)) : Math.max(aspect, Math.min(1 / PANO_MIN, areaAspect))
}
