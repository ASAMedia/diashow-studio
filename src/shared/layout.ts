// Grouping of photos into multi-photo slides and choice of slot templates.
import type { Entry, MediaItem, ThemeId } from './types'
import { themeMeta } from './themes'
import { shownAspect } from './mediaEdit'

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

/**
 * Magazine grids measured from a slideshow exported by macOS Photos (1920x1080): equal outer
 * margin and gutter, cells listed in reading order (the order they fade in).
 */
export const MAGAZINE_TEMPLATES: Record<number, Template[]> = {
  1: [T('m1', [0, 0, 1, 1])],
  2: [
    T('m2-left', [0, 0, 0.375, 1], [0.375, 0, 0.625, 1]),
    T('m2-right', [0, 0, 0.625, 1], [0.625, 0, 0.375, 1]),
    T('m2-half', [0, 0, 0.5, 1], [0.5, 0, 0.5, 1]),
    T('m2-wide', [0, 0, 0.727, 1], [0.727, 0, 0.273, 1]),
    T('m2-rows', [0, 0, 1, 0.5], [0, 0.5, 1, 0.5])
  ],
  3: [
    T('m3-big-left', [0, 0, 0.62, 1], [0.62, 0, 0.38, 0.5], [0.62, 0.5, 0.38, 0.5]),
    T('m3-big-right', [0, 0, 0.38, 0.5], [0.38, 0, 0.62, 1], [0, 0.5, 0.38, 0.5]),
    T('m3-cols', [0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]),
    T('m3-mid', [0, 0, 0.28, 1], [0.28, 0, 0.44, 1], [0.72, 0, 0.28, 1]),
    T('m3-top', [0, 0, 1, 0.6], [0, 0.6, 0.5, 0.4], [0.5, 0.6, 0.5, 0.4])
  ],
  4: [
    T('m4-big-left', [0, 0, 0.727, 1], [0.727, 0, 0.273, 1 / 3], [0.727, 1 / 3, 0.273, 1 / 3], [0.727, 2 / 3, 0.273, 1 / 3]),
    T('m4-grid', [0, 0, 0.58, 0.5], [0.58, 0, 0.42, 0.5], [0, 0.5, 0.42, 0.5], [0.42, 0.5, 0.58, 0.5]),
    T('m4-top3', [0, 0, 1 / 3, 0.42], [1 / 3, 0, 1 / 3, 0.42], [2 / 3, 0, 1 / 3, 0.42], [0, 0.42, 1, 0.58]),
    T('m4-half', [0, 0, 0.5, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.25, 0.5], [0.75, 0.5, 0.25, 0.5]),
    T('m4-cols', [0, 0, 0.25, 1], [0.25, 0, 0.25, 1], [0.5, 0, 0.25, 1], [0.75, 0, 0.25, 1])
  ],
  5: [
    T('m5-big-left', [0, 0, 0.5, 1], [0.5, 0, 0.25, 0.5], [0.75, 0, 0.25, 0.5], [0.5, 0.5, 0.25, 0.5], [0.75, 0.5, 0.25, 0.5]),
    T('m5-rows', [0, 0, 1 / 3, 0.42], [1 / 3, 0, 1 / 3, 0.42], [2 / 3, 0, 1 / 3, 0.42], [0, 0.42, 0.6, 0.58], [0.6, 0.42, 0.4, 0.58]),
    T('m5-center', [0, 0, 0.28, 0.5], [0.28, 0, 0.44, 1], [0.72, 0, 0.28, 0.5], [0, 0.5, 0.28, 0.5], [0.72, 0.5, 0.28, 0.5])
  ],
  6: [
    T('m6-mixed', [0, 0, 1 / 3, 0.4], [1 / 3, 0, 1 / 3, 0.4], [2 / 3, 0, 1 / 3, 0.4], [0, 0.4, 0.255, 0.6], [0.255, 0.4, 0.49, 0.6], [0.745, 0.4, 0.255, 0.6]),
    T('m6-grid', [0, 0, 1 / 3, 0.5], [1 / 3, 0, 1 / 3, 0.5], [2 / 3, 0, 1 / 3, 0.5], [0, 0.5, 1 / 3, 0.5], [1 / 3, 0.5, 1 / 3, 0.5], [2 / 3, 0.5, 1 / 3, 0.5]),
    T('m6-top4', [0, 0, 0.25, 0.45], [0.25, 0, 0.25, 0.45], [0.5, 0, 0.25, 0.45], [0.75, 0, 0.25, 0.45], [0, 0.45, 0.5, 0.55], [0.5, 0.45, 0.5, 0.55])
  ]
}

export function templatesFor(theme: ThemeId, n: number): Template[] {
  const lib = theme === 'magazine' ? MAGAZINE_TEMPLATES : TEMPLATES
  return lib[n] ?? lib[Math.min(n, 4)] ?? TEMPLATES[1]
}

/** Fraction of a photo lost when it is cropped to fill a slot. */
function cropLoss(photoAspect: number, slotAspect: number): number {
  return 1 - Math.min(photoAspect / slotAspect, slotAspect / photoAspect)
}

const PERMS = new Map<number, number[][]>()
function permutations(n: number): number[][] {
  let p = PERMS.get(n)
  if (p) return p
  const out: number[][] = []
  const rec = (cur: number[], rest: number[]): void => {
    if (!rest.length) out.push(cur)
    rest.forEach((x, i) => rec([...cur, x], [...rest.slice(0, i), ...rest.slice(i + 1)]))
  }
  rec([], [...Array(n).keys()])
  PERMS.set(n, (p = out))
  return p
}

export interface Placement {
  template: Template
  /** order[slot] = index of the photo shown in that slot. */
  order: number[]
}

/**
 * Picks the template and photo-to-cell assignment that crops least. Photos may move to
 * another cell (a portrait into a tall cell), with a small cost so the filmstrip order wins
 * ties; repeating the previous slide's template costs a little to keep the show varied.
 */
const placementCache = new Map<string, Placement>()

export function pickTemplate(
  aspects: number[],
  frameAspect: number,
  options: Template[] = TEMPLATES[aspects.length] ?? TEMPLATES[1],
  prev?: string,
  override?: string
): Placement {
  // the search tries every assignment (720 for six photos); big shows rebuild the timeline on
  // every edit, so results are memoised
  const key = `${aspects.map((a) => a.toFixed(2)).join(',')}|${frameAspect.toFixed(3)}|${options.map((o) => o.id).join(',')}|${prev ?? ''}|${override ?? ''}`
  const hit = placementCache.get(key)
  if (hit) return hit
  const result = searchPlacement(aspects, frameAspect, options, prev, override)
  if (placementCache.size > 20000) placementCache.clear()
  placementCache.set(key, result)
  return result
}

function searchPlacement(aspects: number[], frameAspect: number, options: Template[], prev?: string, override?: string): Placement {
  const forced = override ? options.find((t) => t.id === override) : undefined
  let best: Placement = { template: forced ?? options[0], order: aspects.map((_, i) => i) }
  let bestScore = Infinity
  for (const tpl of forced ? [forced] : options) {
    const slotAspects = tpl.slots.map((s) => (s.w / s.h) * frameAspect)
    for (const perm of permutations(aspects.length)) {
      let score = tpl.id === prev ? 0.12 : 0
      perm.forEach((photo, slot) => {
        score += cropLoss(aspects[photo], slotAspects[slot]) + (photo === slot ? 0 : 0.03)
      })
      if (score < bestScore - 1e-6) {
        bestScore = score
        best = { template: tpl, order: perm }
      }
    }
  }
  return best
}

export interface Group {
  entries: Entry[]
}

/**
 * Splits the flat entry list into slides. Text and playing Live Photos are always alone, and
 * so are videos unless the theme puts them into grids (Magazine). Consecutive photos (and
 * videos) are combined following the theme's pattern. `groupBreak` lets the user force a new
 * slide ('force') or attach an entry to the previous slide ('join').
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
    const groupable = e.type === 'photo' || (e.type === 'video' && !!meta.videoInGrid)
    if (!groupable || meta.maxPerSlide === 1 || isSolo(e)) {
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

/** Width / height of a photo or video as it is shown (turned, straightened, cropped): grids, pairing, portrait or landscape. */
export function mediaAspect(m: MediaItem | undefined): number {
  return shownAspect(m)
}
