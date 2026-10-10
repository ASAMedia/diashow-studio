// Where a time sits on the filmstrip: every slide gets one card width, however long it plays.
import type { Timeline } from '@shared/timeline'

export const CARD = 96
export const GAP = 6
export const STEP = CARD + GAP

export function timeToX(tl: Timeline, time: number): number {
  const s = tl.slides
  for (let i = 0; i < s.length; i++) {
    const end = i + 1 < s.length ? s[i + 1].start : s[i].start + s[i].duration
    if (time < end || i === s.length - 1) {
      const span = Math.max(0.001, end - s[i].start)
      return i * STEP + Math.min(1, Math.max(0, (time - s[i].start) / span)) * STEP
    }
  }
  return 0
}

export function xToTime(tl: Timeline, x: number): number {
  const i = Math.min(tl.slides.length - 1, Math.max(0, Math.floor(x / STEP)))
  const s = tl.slides[i]
  if (!s) return 0
  const end = i + 1 < tl.slides.length ? tl.slides[i + 1].start : s.start + s.duration
  return s.start + ((x - i * STEP) / STEP) * (end - s.start)
}
