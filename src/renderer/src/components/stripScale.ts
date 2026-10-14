// Where a time sits on the filmstrip: every slide gets one card width, however long it plays. The
// filmstrip zooms (card widths MIN_CARD..MAX_CARD); a show too long to fit even with the smallest cards
// zooms out further into the overview, where every slide is a thin bar (StripOverview.tsx) down to
// MIN_STEP, as far as it takes to show the whole show. The audio lane under it and the playhead use the
// same mapping with the same step, so they stay aligned at every zoom.
import type { Timeline } from '@shared/timeline'

export const CARD = 96
export const GAP = 6
export const STEP = CARD + GAP
/** Smallest and largest card width (px). */
export const MIN_CARD = 6
export const MAX_CARD = 144
/** The overview's narrowest slide (px): 2000 slides fit into 1000 px. */
export const MIN_STEP = 0.5
/** Left padding of the scrolling part (.strip-scroll): x = 0 of the cards sits this far in. */
export const STRIP_PAD = 16

/**
 * How much a card shows: 'full' badges, numbers and text; 'compact' pictures and chapter marks; 'tiny'
 * slivers; 'overview' no cards, a bar per slide in the colour of its picture.
 */
export type StripDetail = 'full' | 'compact' | 'tiny' | 'overview'

export interface StripScale {
  card: number
  gap: number
  /** card + gap: one slide on the time axis. */
  step: number
  height: number
  detail: StripDetail
}

/**
 * A card width between `min` (MIN_CARD unless the show needs the overview, minCard) and MAX_CARD.
 * Cards have whole pixels; the overview's bars share pixels (two decimals).
 */
export function clampCard(card: number, min: number = MIN_CARD): number {
  const lo = Math.min(MIN_CARD, Math.max(MIN_STEP, min))
  const c = Math.min(MAX_CARD, Math.max(lo, Number.isFinite(card) ? card : CARD))
  return c > MIN_CARD - 0.005 ? Math.max(MIN_CARD, Math.round(c)) : Math.max(lo, Math.round(c * 100) / 100)
}

/** Sizes for a card width; 96 px is the classic filmstrip (96 × 64, gaps of 6). Below MIN_CARD: the overview. */
export function stripScale(card: number = CARD): StripScale {
  const c = clampCard(card, MIN_STEP)
  if (c < MIN_CARD) return { card: c, gap: 0, step: c, height: 64, detail: 'overview' }
  const gap = Math.round(Math.min(6, Math.max(1, c / 16)))
  const height = Math.round(Math.min(84, Math.max(64, (c * 2) / 3)))
  const detail: StripDetail = c >= 56 ? 'full' : c >= 20 ? 'compact' : 'tiny'
  return { card: c, gap, step: c + gap, height, detail }
}

/** The narrowest zoom for `slides` slides in `width` px: the smallest card, or the overview at which they all fit. */
export function minCard(slides: number, width: number): number {
  return Math.min(MIN_CARD, fitCard(slides, width))
}

/** The zoom slider (0..100, from `min` up) is logarithmic: each step changes the card width by the same factor. */
export function cardToSlider(card: number, min: number = MIN_CARD): number {
  const lo = clampCard(min, MIN_STEP)
  if (lo >= MAX_CARD) return 100
  return Math.round((Math.log(clampCard(card, lo) / lo) / Math.log(MAX_CARD / lo)) * 100)
}

export function sliderToCard(value: number, min: number = MIN_CARD): number {
  const lo = clampCard(min, MIN_STEP)
  return clampCard(lo * Math.pow(MAX_CARD / lo, Math.min(100, Math.max(0, value)) / 100), lo)
}

/** One zoom step (buttons, Ctrl+wheel) down to `min`: at least one pixel, so small cards change too. */
export function zoomStep(card: number, factor: number, min: number = MIN_CARD): number {
  const next = clampCard(card * factor, min)
  if (next !== card || factor === 1) return next
  return clampCard(card + (factor > 1 ? 1 : -1), min)
}

/** Width of the "+" card at the end (it stays clickable when the cards get tiny); in the overview 40 px behind a gap of 4. */
export const addWidth = (s: StripScale): number => (s.detail === 'overview' ? 44 : Math.max(s.card, 40))

/** Width of the cards row: every slide plus the "+" card. */
export const stripWidth = (slides: number, s: StripScale): number => slides * s.step + addWidth(s)

/**
 * "Fit all": the largest card width at which `slides` cards and the "+" card fit into `width`
 * pixels; for a show too long for the smallest cards, the overview where they fit (MIN_STEP at least).
 */
export function fitCard(slides: number, width: number): number {
  for (let c = MAX_CARD; c >= MIN_CARD; c--) if (stripWidth(slides, stripScale(c)) <= width) return c
  const share = Math.floor(((width - addWidth(stripScale(MIN_STEP))) / Math.max(1, slides)) * 100 + 1e-6) / 100
  return Math.min(MIN_CARD - 0.01, Math.max(MIN_STEP, share))
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

/** The slide playing at `time`: the last one starting at or before it (slides are in time order). */
function slideAt(tl: Timeline, time: number): number {
  const s = tl.slides
  let lo = 0
  let hi = s.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (s[mid].start <= time) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function timeToX(tl: Timeline, time: number, step: number = STEP): number {
  const s = tl.slides
  if (!s.length) return 0
  const i = slideAt(tl, time)
  const end = i + 1 < s.length ? s[i + 1].start : s[i].start + s[i].duration
  const span = Math.max(0.001, end - s[i].start)
  return i * step + Math.min(1, Math.max(0, (time - s[i].start) / span)) * step
}

export function xToTime(tl: Timeline, x: number, step: number = STEP): number {
  const i = Math.min(tl.slides.length - 1, Math.max(0, Math.floor(x / step)))
  const s = tl.slides[i]
  if (!s) return 0
  const end = i + 1 < tl.slides.length ? tl.slides[i + 1].start : s.start + s.duration
  return s.start + ((x - i * step) / step) * (end - s.start)
}

/** Slide numbers shown on small cards and in the overview: every n-th, so they don't run into each other. */
export function numberEvery(s: StripScale): number {
  if (s.detail === 'full') return 1
  return [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find((n) => n * s.step >= 30) ?? 1000
}

const ZOOM_KEY = 'diashow.filmstripZoom'

/** The card width the user chose last (per user, in this browser profile; an overview too); the classic size by default. */
export function loadZoom(): number {
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY))
    return v ? clampCard(v, MIN_STEP) : CARD
  } catch {
    return CARD
  }
}

export function saveZoom(card: number): void {
  try {
    localStorage.setItem(ZOOM_KEY, String(clampCard(card, MIN_STEP)))
  } catch {
    // storage blocked: the zoom lasts for this session only
  }
}
