// Chapter marks of an exported video: the show title at 0:00, then every chapter text slide (also
// one shown as a caption, Magazine), so players can jump to "Dienstag". Pure: the export queue
// writes them into the MP4, the export dialog and the queue copy them as text for YouTube.
import type { Project, TextEntry } from './types'
import type { Timeline } from './timeline'

export interface Chapter {
  /** Seconds on the show timeline: where the slide starts to appear. */
  start: number
  title: string
}

/** Chapters closer than this to the one before replace it (keeping its start). */
const MIN_GAP = 1
/** A subtitle up to this length goes into the chapter title ("Sonntag – Unser erster Tag"). */
const MAX_SUBTITLE = 60
export const MAX_CHAPTER_TITLE = 200

/** One line of text: control characters and line breaks become spaces. */
export function oneLine(s: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function chapterTitle(title: string | undefined, subtitle: string | undefined, withSubtitle: boolean): string {
  const main = oneLine(title)
  const sub = withSubtitle && subtitle && !/[\r\n]/.test(subtitle.trim()) ? oneLine(subtitle) : ''
  const text = main && sub && sub.length <= MAX_SUBTITLE && sub.toLowerCase() !== main.toLowerCase() ? `${main} – ${sub}` : main || sub
  return text.slice(0, MAX_CHAPTER_TITLE)
}

/**
 * Chapters of a show: the show title at 0, then each text slide on the timeline (its title, plus a
 * short one-line subtitle such as the date of a day title) and each text slide shown as the caption
 * of the next slide, at that slide's start. End credits count with their title only. A chapter at the
 * very start replaces the show title. Starts are ascending and at least a second apart.
 */
export function buildChapters(project: Project, tl: Timeline): Chapter[] {
  const found: Chapter[] = []
  for (const s of tl.slides) {
    let title = ''
    if (s.kind === 'text') {
      const e = s.entries[0] as TextEntry | undefined
      if (e) title = chapterTitle(e.title, e.subtitle, e.titleStyle !== 'credits')
    } else if (s.captionEntryId && s.caption) {
      title = chapterTitle(s.caption.text, s.caption.subtitle, true)
    }
    if (title && s.start < tl.duration) found.push({ start: Math.max(0, Math.round(s.start * 1000) / 1000), title })
  }
  const showTitle =
    oneLine(tl.slides.find((s) => s.kind === 'title' || s.titleOverlay)?.title?.text) || oneLine(project.settings.titleText) || oneLine(project.name)
  const out: Chapter[] = []
  if (!found.length || found[0].start >= MIN_GAP) out.push({ start: 0, title: showTitle.slice(0, MAX_CHAPTER_TITLE) || '–' })
  for (const c of found) {
    const prev = out[out.length - 1]
    if (prev && c.start - prev.start < MIN_GAP) prev.title = c.title
    else out.push(out.length ? c : { ...c, start: 0 })
  }
  return out
}

/** "0:42", or "1:02:03" from an hour on: whole seconds, rounded down so a jump lands before the slide. */
export function chapterStamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** The chapter list for a YouTube description: one "0:00 Title" per line. */
export function chapterText(chapters: Chapter[]): string {
  return chapters.map((c) => `${chapterStamp(c.start)} ${c.title}`).join('\n')
}

/** Escapes a value for FFmpeg's ffmetadata format. */
const metaValue = (s: string): string => oneLine(s).replace(/[\\=;#]/g, (ch) => `\\${ch}`)

/**
 * An FFmpeg ffmetadata file with one [CHAPTER] per chapter (milliseconds); each ends where the next
 * starts, the last one at `duration` seconds. Chapters at or after the end are left out.
 */
export function chapterMetadata(chapters: Chapter[], duration: number): string {
  const end = Math.round(duration * 1000)
  const list = chapters.map((c) => ({ start: Math.round(c.start * 1000), title: c.title })).filter((c) => c.start < end)
  const lines = [';FFMETADATA1']
  list.forEach((c, i) => {
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${c.start}`, `END=${i + 1 < list.length ? list[i + 1].start : end}`, `title=${metaValue(c.title)}`)
  })
  return `${lines.join('\n')}\n`
}
