// Where a time sits on the filmstrip: every slide gets one card width, however long it plays. The
// filmstrip zooms (card widths MIN_CARD..MAX_CARD); the audio lane under it and the playhead use the
// same mapping with the same step, so they stay aligned at every zoom.
import type { Timeline } from '@shared/timeline'

export const CARD = 96
export const GAP = 6
export const STEP = CARD + GAP
/** Smallest and largest card width (px). */
export const MIN_CARD = 6
export const MAX_CARD = 144
/** Left padding of the scrolling part (.strip-scroll): x = 0 of the cards sits this far in. */
export const STRIP_PAD = 16

/** How much a card shows: 'full' badges, numbers and text; 'compact' pictures and chapter marks; 'tiny' slivers. */
export type StripDetail = 'full' | 'compact' | 'tiny'

export interface StripScale {
  card: number
  gap: number
  /** card + gap: one slide on the time axis. */
  step: number
  height: number
  detail: StripDetail
}

export function clampCard(card: number): number {
  return Math.round(Math.min(MAX_CARD, Math.max(MIN_CARD, Number.isFinite(card) ? card : CARD)))
}

/** Sizes for a card width; 96 px is the classic filmstrip (96 × 64, gaps of 6). */
export function stripScale(card: number = CARD): StripScale {
  const c = clampCard(card)
  const gap = Math.round(Math.min(6, Math.max(1, c / 16)))
  const height = Math.round(Math.min(84, Math.max(64, (c * 2) / 3)))
  const detail: StripDetail = c >= 56 ? 'full' : c >= 20 ? 'compact' : 'tiny'
  return { card: c, gap, step: c + gap, height, detail }
}

/** The zoom slider (0..100) is logarithmic: each step changes the card width by the same factor. */
export function cardToSlider(card: number): number {
  return Math.round((Math.log(clampCard(card) / MIN_CARD) / Math.log(MAX_CARD / MIN_CARD)) * 100)
}

export function sliderToCard(value: number): number {
  return clampCard(MIN_CARD * Math.pow(MAX_CARD / MIN_CARD, Math.min(100, Math.max(0, value)) / 100))
}

/** One zoom step (buttons, Ctrl+wheel): at least one pixel, so small cards change too. */
export function zoomStep(card: number, factor: number): number {
  const next = clampCard(card * factor)
  if (next !== card || factor === 1) return next
  return clampCard(card + (factor > 1 ? 1 : -1))
}

/** Width of the "+" card at the end (it stays clickable when the cards get tiny). */
export const addWidth = (s: StripScale): number => Math.max(s.card, 40)

/** Width of the cards row: every slide plus the "+" card. */
export const stripWidth = (slides: number, s: StripScale): number => slides * s.step + addWidth(s)

/**
 * "Fit all": the largest card width at which `slides` cards and the "+" card fit into `width`
 * pixels, or the smallest card width when even that is too wide.
 */
export function fitCard(slides: number, width: number): number {
  for (let c = MAX_CARD; c > MIN_CARD; c--) if (stripWidth(slides, stripScale(c)) <= width) return c
  return MIN_CARD
}

/**
 * Keeps a point of the filmstrip where it is on screen while the zoom changes: `anchorX` is its
 * distance from the scrolling part's left edge, `scrollLeft` the scroll position before. Returns the
 * scroll position for the new step. Slides map linearly to x, so the anchor is exact.
 */
export function anchoredScroll(scrollLeft: number, anchorX: number, oldStep: number, newStep: number): number {
  const units = (scrollLeft + anchorX - STRIP_PAD) / oldStep
  return Math.max(0, units * newStep + STRIP_PAD - anchorX)
}

export function timeToX(tl: Timeline, time: number, step: number = STEP): number {
  const s = tl.slides
  for (let i = 0; i < s.length; i++) {
    const end = i + 1 < s.length ? s[i + 1].start : s[i].start + s[i].duration
    if (time < end || i === s.length - 1) {
      const span = Math.max(0.001, end - s[i].start)
      return i * step + Math.min(1, Math.max(0, (time - s[i].start) / span)) * step
    }
  }
  return 0
}

export function xToTime(tl: Timeline, x: number, step: number = STEP): number {
  const i = Math.min(tl.slides.length - 1, Math.max(0, Math.floor(x / step)))
  const s = tl.slides[i]
  if (!s) return 0
  const end = i + 1 < tl.slides.length ? tl.slides[i + 1].start : s.start + s.duration
  return s.start + ((x - i * step) / step) * (end - s.start)
}

/** Slide numbers shown on small cards: every n-th, so they don't run into each other. */
export function numberEvery(s: StripScale): number {
  if (s.detail === 'full') return 1
  return [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find((n) => n * s.step >= 30) ?? 1000
}

const ZOOM_KEY = 'diashow.filmstripZoom'

/** The card width the user chose last (per user, in this browser profile); the classic size by default. */
export function loadZoom(): number {
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY))
    return v ? clampCard(v) : CARD
  } catch {
    return CARD
  }
}

export function saveZoom(card: number): void {
  try {
    localStorage.setItem(ZOOM_KEY, String(clampCard(card)))
  } catch {
    // storage blocked: the zoom lasts for this session only
  }
}
