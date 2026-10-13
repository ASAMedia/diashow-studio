// Edits of a project's entry list, applied by the store inside one undo step: new entries, chapter
// titles (per day or per folder), sorting by date, and which entries form a slide (groupBreak).
import type { Entry, MediaItem, Project, TextEntry } from '@shared/types'
import { localeTag } from './i18n'

export const uid = (): string => crypto.randomUUID()

export function entriesFor(items: MediaItem[]): Entry[] {
  return items.map((m) => (m.kind === 'video' ? { id: uid(), type: 'video', mediaId: m.id } : { id: uid(), type: 'photo', mediaId: m.id }))
}

const dayKey = (time: number): string => {
  const d = new Date(time)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** "2_Sonntag Unser erster Tag" -> title "Sonntag", subtitle "Unser erster Tag". */
function titleFromFolder(name: string): { title: string; subtitle?: string } {
  const clean = name.replace(/^[\d\s._-]+/, '').trim() || name
  const [first, ...rest] = clean.split(/\s+/)
  return rest.length ? { title: first, subtitle: rest.join(' ') } : { title: first }
}

/** Folder of a file with forward slashes, e.g. "D:/Ski/2_Sonntag". */
const folderPath = (path: string): string => {
  const parts = path.split(/[\\/]/)
  return parts.slice(0, -1).join('/')
}

/** Each photo / video with the text slides before it, and the text slides after the last one. */
function textBlocks(entries: Entry[]): { blocks: Entry[][]; rest: Entry[] } {
  const blocks: Entry[][] = []
  let pending: Entry[] = []
  for (const e of entries) {
    if (e.type === 'text') pending.push(e)
    else {
      blocks.push([...pending, e])
      pending = []
    }
  }
  return { blocks, rest: pending }
}

/** Text slides at every new day ('date') or every new subfolder ('folder'). */
export function insertDayTitles(p: Project, mode: 'date' | 'folder'): void {
  const fmtDay = new Intl.DateTimeFormat(localeTag(), { weekday: 'long' })
  const fmtDate = new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'long', year: 'numeric' })
  const media = new Map(p.media.map((m) => [m.id, m]))
  const kept = p.entries.filter((e) => !(e.type === 'text' && e.auto === 'day'))
  let entries = kept
  let skip = new Set<string>()
  if (mode === 'folder') {
    // Chapters follow the folders, not the capture times (those can disagree, e.g. for
    // files from messengers). Text slides stay with the photo after them.
    const { blocks, rest } = textBlocks(kept)
    const folder = (b: Entry[]): string => {
      const e = b[b.length - 1]
      return e.type === 'text' ? '' : folderPath(media.get(e.mediaId)?.path ?? '')
    }
    const order = new Map(blocks.map((b, i) => [b, i]))
    blocks.sort((a, b) => folder(a).localeCompare(folder(b), undefined, { numeric: true }) || order.get(a)! - order.get(b)!)
    entries = [...blocks.flat(), ...rest]
    // the imported top folder (it holds other folders) gets no chapter of its own
    const folders = new Set(blocks.map(folder))
    skip = new Set([...folders].filter((f) => [...folders].some((g) => g !== f && g.startsWith(`${f}/`))))
  }
  const out: Entry[] = []
  let last = ''
  for (const e of entries) {
    if (e.type !== 'text') {
      const m = media.get(e.mediaId)
      const key = m ? (mode === 'date' ? dayKey(m.captureTime) : folderPath(m.path)) : ''
      if (m && key && key !== last) {
        last = key
        if (!skip.has(key)) {
          const text = mode === 'date' ? { title: fmtDay.format(m.captureTime), subtitle: fmtDate.format(m.captureTime) } : titleFromFolder(key.split('/').pop()!)
          out.push({ id: uid(), type: 'text', auto: 'day', ...text } as TextEntry)
        }
      }
    }
    out.push(e)
  }
  p.entries = out
}

export function sortByDate(p: Project): void {
  const media = new Map(p.media.map((m) => [m.id, m]))
  const time = (e: Entry): number => (e.type === 'text' ? Number.NaN : (media.get(e.mediaId)?.captureTime ?? 0))
  // text slides keep their place relative to the following photo
  const { blocks, rest } = textBlocks(p.entries)
  blocks.sort((a, b) => time(a[a.length - 1]) - time(b[b.length - 1]))
  p.entries = [...blocks.flat(), ...rest]
  // fixed slides would now hold photos that came apart: the theme groups them again
  autoGroup(p)
}

/** Whether an entry's slide was fixed by hand (combined, split, or kept as it was when photos were inserted). */
export const isFixed = (e: Entry): boolean => e.groupBreak === 'force' || e.groupBreak === 'join'

/**
 * The theme groups the photos into slides again, following its pattern: of the given entries (their
 * slides, in a selection), or of the whole show. A selection keeps its edges, so the slides around it
 * stay as they are.
 */
export function autoGroup(p: Project, ids?: string[]): void {
  if (!ids) {
    for (const e of p.entries) delete e.groupBreak
    return
  }
  const want = new Set(ids)
  const list = p.entries
  list.forEach((e, i) => {
    if (!want.has(e.id)) return
    delete e.groupBreak
    // each run of selected slides starts a slide, and so does the slide behind it
    const prev = list[i - 1]
    if (prev && !want.has(prev.id) && prev.type !== 'text') e.groupBreak = 'force'
    const next = list[i + 1]
    if (next && !want.has(next.id) && next.type !== 'text') next.groupBreak = 'force'
  })
}

/** The given entries become one slide at the position of the first of them. */
export function mergeEntries(p: Project, ids: string[]): void {
  const want = new Set(ids)
  const block = p.entries.filter((e) => want.has(e.id) && e.type !== 'text')
  if (block.length < 2) return
  const firstIdx = p.entries.indexOf(block[0])
  const moving = new Set(block)
  const rest = p.entries.filter((e) => !moving.has(e))
  const at = p.entries.slice(0, firstIdx).filter((e) => !moving.has(e)).length
  rest.splice(at, 0, ...block)
  block.forEach((e, i) => (e.groupBreak = i === 0 ? 'force' : 'join'))
  const after = rest[at + block.length]
  if (after) after.groupBreak = 'force'
  p.entries = rest
}

/** Every entry of a slide becomes a slide of its own. */
export function splitSlide(p: Project, ids: string[]): void {
  const want = new Set(ids)
  p.entries.forEach((e) => want.has(e.id) && (e.groupBreak = 'force'))
}

/** Takes one entry out of a slide; it follows the slide as a slide of its own. */
export function releaseEntry(p: Project, slideIds: string[], id: string): void {
  const want = new Set(slideIds)
  const slide = p.entries.filter((e) => want.has(e.id))
  const e = p.entries.find((x) => x.id === id)
  const keep = slide.filter((x) => x.id !== id)
  if (!e || keep.length === 0) return
  p.entries = p.entries.filter((x) => x !== e)
  const at = p.entries.indexOf(keep[keep.length - 1]) + 1
  p.entries.splice(at, 0, e)
  e.groupBreak = 'force'
  if (keep[0].groupBreak === 'join') keep[0].groupBreak = 'force'
  const next = p.entries[at + 1]
  if (next) next.groupBreak = 'force'
}

/** Pulls the next entry of the show into the slide, or hands the last one on. */
export function resizeSlide(p: Project, slideIds: string[], delta: 1 | -1): void {
  const want = new Set(slideIds)
  const slide = p.entries.filter((e) => want.has(e.id))
  if (!slide.length) return
  const last = slide[slide.length - 1]
  if (delta < 0) {
    if (slide.length > 1) last.groupBreak = 'force'
    return
  }
  const next = p.entries[p.entries.indexOf(last) + 1]
  if (!next || next.type === 'text') return
  next.groupBreak = 'join'
  const after = p.entries[p.entries.indexOf(next) + 1]
  if (after && after.groupBreak !== 'join') after.groupBreak = 'force'
}

/**
 * New entries go where their capture time belongs: among the show's photos and videos in time
 * order, inside their day's chapter (behind its title slide), or in front of the next day's title.
 * Undated items, and items newer than everything, go to the end (before closing credits).
 */
export function insertByTime(entries: Entry[], fresh: Entry[], media: Map<string, MediaItem>): Entry[] {
  const time = (e: Entry): number => (e.type === 'text' ? 0 : (media.get(e.mediaId)?.captureTime ?? 0))
  const out = [...entries]
  // undated ones last, behind everything that has a date
  for (const e of [...fresh].sort((a, b) => (time(a) || Infinity) - (time(b) || Infinity))) {
    const t = time(e)
    let at = t ? out.findIndex((x) => x.type !== 'text' && time(x) > t) : -1
    if (at < 0) {
      at = out.length
      while (at > 0 && out[at - 1].type === 'text' && (out[at - 1] as TextEntry).titleStyle === 'credits') at--
    } else {
      // text slides right before the later item open its chapter: that is this item's chapter only on the same day
      let k = at
      while (k > 0 && out[k - 1].type === 'text') k--
      if (k < at && dayKey(time(out[at])) !== dayKey(t)) at = k
    }
    out.splice(at, 0, e)
  }
  return out
}

/** True when the show's day titles were made from capture dates ("Day titles from capture date"). */
export function hasDateTitles(entries: Entry[], media: Map<string, MediaItem>): boolean {
  const fmtDate = new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'long', year: 'numeric' })
  return entries.some((e, i) => {
    if (e.type !== 'text' || e.auto !== 'day') return false
    const next = entries.slice(i + 1).find((x) => x.type !== 'text')
    const m = next ? media.get(next.mediaId) : undefined
    return !!m?.captureTime && fmtDate.format(m.captureTime) === e.subtitle
  })
}

/** Adds a date title in front of every day that starts without one. */
export function addMissingDayTitles(entries: Entry[], media: Map<string, MediaItem>): Entry[] {
  const fmtDay = new Intl.DateTimeFormat(localeTag(), { weekday: 'long' })
  const fmtDate = new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'long', year: 'numeric' })
  const out: Entry[] = []
  let last = ''
  let titled = false
  for (const e of entries) {
    if (e.type === 'text') {
      if (e.auto === 'day') titled = true
      out.push(e)
      continue
    }
    const m = media.get(e.mediaId)
    const key = m?.captureTime ? dayKey(m.captureTime) : last
    if (m?.captureTime && key !== last && !titled) {
      // in front of the text slides that already lead into this item
      let at = out.length
      while (at > 0 && out[at - 1].type === 'text') at--
      out.splice(at, 0, { id: uid(), type: 'text', auto: 'day', title: fmtDay.format(m.captureTime), subtitle: fmtDate.format(m.captureTime) })
    }
    last = key
    titled = false
    out.push(e)
  }
  return out
}
