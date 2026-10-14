// Where photos and videos go that are inserted at a place in the show (dropped from Explorer between
// two filmstrip cards, pasted with Ctrl+V behind the selection, "Insert…" in a slide's menu). Pure;
// applied by insert.ts inside one undo step and unit tested in tests/filmstrip.test.ts.
//
// The rule for themes that group photos into slides (Magazine, Origami, …): an insertion between two
// slides changes no other slide. The new items never join the slide in front of the marker, and every
// slide behind it keeps exactly its photos and videos. Without that, the theme's automatic grouping,
// which counts its pattern (2, 3, 6, 4, …) from the start of the show, would regroup every slide after
// the insertion point, and their layouts, crops and captions would move to other slides.
import { aspectValue, type Timeline, type TimelineSlide } from '@shared/timeline'
import { panoramaOf } from '@shared/panorama'
import type { Entry, MediaItem, Project, ProjectSettings } from '@shared/types'
import { themeMeta } from '@shared/themes'
import { mergeEntries } from './entryEdits'

/** A slide's entries with the text slide shown as its caption (it comes right before them in the show). */
function idsOf(s: TimelineSlide): string[] {
  return s.captionEntryId ? [s.captionEntryId, ...s.entries.map((e) => e.id)] : s.entries.map((e) => e.id)
}

/**
 * The entry in front of which items dropped at slide boundary `at` go (0: before the first slide,
 * `tl.slides.length`: behind the last): the first entry, in show order, of the slide behind the
 * boundary (its caption text slide included). null: at the end of the show. The generated title slide
 * has no entries; items dropped in front of it go in front of the first real slide.
 */
export function anchorAt(tl: Timeline, entries: readonly Entry[], at: number): string | null {
  const index = new Map(entries.map((e, i) => [e.id, i]))
  for (let k = Math.max(0, at); k < tl.slides.length; k++) {
    const found = idsOf(tl.slides[k])
      .map((id) => index.get(id))
      .filter((i): i is number => i !== undefined)
    if (found.length) return entries[Math.min(...found)].id
  }
  return null
}

/** Entries the theme can put into a grid with others. */
function groupable(e: Entry, settings: ProjectSettings): boolean {
  return e.type === 'photo' || (e.type === 'video' && !!themeMeta(settings.theme).videoInGrid)
}

/**
 * Puts `fresh` in front of entry `before` (null or unknown: at the end). `tl` is the timeline before the
 * insertion. In themes with several photos per slide, the first new item starts a slide, and each slide
 * behind the insertion point is pinned to its current photos (its first entry starts a slide, the
 * others join it, as "Combine into one slide" does); the new items are grouped among themselves.
 */
export function insertEntries(p: Project, fresh: Entry[], before: string | null, tl: Timeline): void {
  let at = before == null ? -1 : p.entries.findIndex((e) => e.id === before)
  if (at < 0) at = p.entries.length
  if (themeMeta(p.settings.theme).maxPerSlide > 1 && fresh.length) {
    const index = new Map(p.entries.map((e, i) => [e.id, i]))
    for (const s of tl.slides) {
      if (s.kind !== 'photos' && s.kind !== 'video') continue
      const own = s.entries
        .map((e) => index.get(e.id))
        .filter((i): i is number => i !== undefined && i >= at)
        .sort((a, b) => a - b)
        .map((i) => p.entries[i])
        .filter((e) => groupable(e, p.settings))
      own.forEach((e, k) => (e.groupBreak = k === 0 ? 'force' : 'join'))
    }
    if (groupable(fresh[0], p.settings)) fresh[0].groupBreak = 'force'
  }
  p.entries.splice(at, 0, ...fresh)
}

/**
 * Whether new items can join a slide (dropped onto its card), like dragging one slide onto another:
 * a theme with several photos per slide, a photo or grid slide, room for all of them, and only items
 * the theme puts into a grid (no Live Photo that plays its motion, no panorama, videos only in Magazine).
 */
export function canJoin(
  slide: TimelineSlide,
  items: readonly (Pick<MediaItem, 'kind' | 'live'> & Partial<Pick<MediaItem, 'width' | 'height' | 'edit'>>)[],
  settings: ProjectSettings
): boolean {
  const meta = themeMeta(settings.theme)
  // a panorama is always alone on its slide (shared/panorama.ts)
  if (meta.maxPerSlide < 2 || !items.length || slide.live || slide.pano) return false
  if (slide.kind !== 'photos' && !(slide.kind === 'video' && meta.videoInGrid)) return false
  if (slide.entries.length + items.length > meta.maxPerSlide) return false
  const frame = aspectValue(settings.aspect)
  return items.every((m) =>
    m.kind === 'video' ? !!meta.videoInGrid : !(m.live && settings.playLivePhotos) && !(m.width && m.height && panoramaOf(m as MediaItem, frame))
  )
}

/** Adds `fresh` to the slide made of `slideIds` (behind its last entry) as one slide, like "Combine into one slide". */
export function insertInto(p: Project, fresh: Entry[], slideIds: string[]): void {
  const want = new Set(slideIds)
  let last = -1
  p.entries.forEach((e, i) => {
    if (want.has(e.id)) last = i
  })
  p.entries.splice(last + 1, 0, ...fresh)
  mergeEntries(p, [...slideIds, ...fresh.map((e) => e.id)])
}

/**
 * Moves the slide at index `from` to slide boundary `to` (in front of slide `to`; at the end for
 * `tl.slides.length`), as dragging its card or Alt+←/→ does. Its entries go in front of the first entry
 * of the slide behind the boundary in show order, its caption text included (anchorAt): a slide lists
 * its entries in the order of its layout's cells, so its first one may sit in the middle of the slide.
 */
export function moveSlide(p: Project, tl: Timeline, from: number, to: number): void {
  const src = tl.slides[from]
  if (!src || src.kind === 'title') return
  const ids = new Set(src.entries.map((e) => e.id))
  const target = tl.slides.slice(to).find((s) => s.kind !== 'title' && !s.entries.some((e) => ids.has(e.id)))
  const before = target ? anchorAt(tl, p.entries, target.index) : null
  const moving = p.entries.filter((e) => ids.has(e.id))
  p.entries = p.entries.filter((e) => !ids.has(e.id))
  const idx = before == null ? -1 : p.entries.findIndex((e) => e.id === before)
  p.entries.splice(idx < 0 ? p.entries.length : idx, 0, ...moving)
}
