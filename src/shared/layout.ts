// Grouping of photos into multi-photo slides and choice of slot templates.
import type { Entry, MediaItem, ThemeId } from './types'
import { themeMeta } from './themes'

/** Slot in normalised frame coordinates (0..1 of the output frame). */
export interface Slot {
  x: number
  y: number
  w: number
  h: number
}

export interface Template {
  id: string
  slots: Slot[]
}

const T = (id: string, ...slots: [number, number, number, number][]): Template => ({
  id,
  slots: slots.map(([x, y, w, h]) => ({ x, y, w, h }))
})

export const TEMPLATES: Record<number, Template[]> = {
  1: [T('full', [0, 0, 1, 1])],
  2: [
    T('halves', [0, 0, 0.5, 1], [0.5, 0, 0.5, 1]),
    T('wide-left', [0, 0, 0.62, 1], [0.62, 0, 0.38, 1]),
    T('wide-right', [0, 0, 0.38, 1], [0.38, 0, 0.62, 1]),
    T('rows', [0, 0, 1, 0.5], [0, 0.5, 1, 0.5])
  ],
  3: [
    T('big-left', [0, 0, 0.6, 1], [0.6, 0, 0.4, 0.5], [0.6, 0.5, 0.4, 0.5]),
    T('big-right', [0, 0, 0.4, 0.5], [0, 0.5, 0.4, 0.5], [0.4, 0, 0.6, 1]),
    T('columns', [0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]),
    T('big-top', [0, 0, 1, 0.58], [0, 0.58, 0.5, 0.42], [0.5, 0.58, 0.5, 0.42])
  ],
  4: [
    T('grid', [0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]),
    T('big-left-3', [0, 0, 0.55, 1], [0.55, 0, 0.45, 1 / 3], [0.55, 1 / 3, 0.45, 1 / 3], [0.55, 2 / 3, 0.45, 1 / 3]),
    T('columns-4', [0, 0, 0.25, 1], [0.25, 0, 0.25, 1], [0.5, 0, 0.25, 1], [0.75, 0, 0.25, 1])
  ]
}

/** Fraction of a photo lost when it is cropped to fill a slot. */
function cropLoss(photoAspect: number, slotAspect: number): number {
  return 1 - Math.min(photoAspect / slotAspect, slotAspect / photoAspect)
}

export function pickTemplate(aspects: number[], frameAspect: number): Template {
  const options = TEMPLATES[aspects.length] ?? TEMPLATES[1]
  let best = options[0]
  let bestScore = Infinity
  for (const tpl of options) {
    const score = tpl.slots.reduce((sum, s, i) => sum + cropLoss(aspects[i], (s.w / s.h) * frameAspect), 0)
    if (score < bestScore - 1e-6) {
      best = tpl
      bestScore = score
    }
  }
  return best
}

export interface Group {
  entries: Entry[]
}

/**
 * Splits the flat entry list into slides. Videos, text and playing Live Photos are always
 * alone; consecutive photos are combined following the theme's pattern. `groupBreak`
 * lets the user force a new slide ('force') or attach a photo to the previous one ('join').
 */
export function groupEntries(
  entries: Entry[],
  theme: ThemeId,
  isSolo: (e: Entry) => boolean = () => false,
  aspect: (e: Entry) => number = () => 1.5
): Group[] {
  const meta = themeMeta(theme)
  const groups: Group[] = []
  let current: { entries: Entry[]; target: number } | null = null
  let k = 0
  for (const e of entries) {
    if (e.type !== 'photo' || meta.maxPerSlide === 1 || isSolo(e)) {
      current = null
      groups.push({ entries: [e] })
      continue
    }
    const join = e.groupBreak === 'join'
    const force = e.groupBreak === 'force'
    if (current && !force && current.entries.length < (join ? meta.maxPerSlide : current.target)) {
      current.entries.push(e)
      continue
    }
    let target = meta.pattern[k++ % meta.pattern.length]
    // a lone portrait photo would be cropped hard; pair it with the next photo instead
    if (target === 1 && aspect(e) < 0.9) target = 2
    current = { entries: [e], target }
    groups.push(current)
  }
  return groups
}

export function mediaAspect(m: MediaItem | undefined): number {
  return m && m.width > 0 && m.height > 0 ? m.width / m.height : 1.5
}
