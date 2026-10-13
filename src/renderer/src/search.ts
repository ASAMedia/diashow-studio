// Searching the filmstrip (Ctrl+F): which slides match a query and what matched. A query is split
// into terms that must all match (in any field): words in file names, titles, chapter and text slides,
// captions, text boxes and people's names; kinds ("Video", "Live", "Text"); and capture dates, in
// German or English ("12.5.", "12. Mai", "May 12", "Dienstag", "Mai 2026", "2026-05-12"). Pure, so
// the parsing and matching are unit tested (tests/filmstrip.test.ts).
import type { Timeline, TimelineSlide } from '@shared/timeline'
import type { MediaItem, Person, Project, TextEntry } from '@shared/types'
import { peopleKey, photoPersonFaces, videoPersonTracks } from '@shared/people'

export type MatchField = 'file' | 'title' | 'chapter' | 'text' | 'caption' | 'freeText' | 'person' | 'kind' | 'date'
export type MatchKind = 'video' | 'live' | 'text'

export interface SearchHit {
  /** Index of the slide in the timeline. */
  index: number
  field: MatchField
  /** The text that matched (file name, title, caption, person); empty for kinds and dates. */
  text: string
  /** 'date': the capture time that matched (ms). */
  time?: number
  /** 'kind': which kind. */
  kind?: MatchKind
}

/** Parts of a date to look for; missing parts match anything. Months 1..12, weekdays 0 (Sunday)..6. */
export interface DateQuery {
  day?: number
  month?: number
  year?: number
  weekday?: number
}

/** One part of a query: a word (also matched as a date when it is a month, weekday or year), or a date only. */
export interface SearchTerm {
  raw: string
  word?: string
  date?: DateQuery
}

/** Lower case without accents (ä → a, ß → ss), for comparing. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss')
}

// folded names, German and English (abbreviations as the date formats of both languages write them)
const MONTHS: readonly (readonly string[])[] = [
  ['januar', 'janner', 'jaenner', 'january', 'jan'],
  ['februar', 'feber', 'february', 'feb'],
  ['marz', 'maerz', 'march', 'mar', 'mrz'],
  ['april', 'apr'],
  ['mai', 'may'],
  ['juni', 'june', 'jun'],
  ['juli', 'july', 'jul'],
  ['august', 'aug'],
  ['september', 'sept', 'sep'],
  ['oktober', 'october', 'okt', 'oct'],
  ['november', 'nov'],
  ['dezember', 'december', 'dez', 'dec']
]
const WEEKDAYS: readonly (readonly string[])[] = [
  ['sonntag', 'sunday', 'sun'],
  ['montag', 'monday', 'mon'],
  ['dienstag', 'tuesday', 'tue', 'tues'],
  ['mittwoch', 'wednesday', 'wed'],
  ['donnerstag', 'thursday', 'thu', 'thur', 'thurs'],
  ['freitag', 'friday', 'fri'],
  ['samstag', 'saturday', 'sat']
]
// German short weekdays ("Di., 12. Mai") only with their dot: "so" or "do" alone are ordinary words
const WEEKDAYS_SHORT = ['so.', 'mo.', 'di.', 'mi.', 'do.', 'fr.', 'sa.']

/** Finds a name: the whole word, or the start of a name when at least three letters are typed. */
function nameIndex(names: readonly (readonly string[])[], word: string): number | null {
  const w = fold(word).replace(/\.$/, '')
  if (w.length < 3) return null
  for (const [i, list] of names.entries()) if (list.includes(w)) return i
  for (const [i, list] of names.entries()) if (list.some((n) => n.length > 3 && n.startsWith(w))) return i
  return null
}

/** 1..12 for a German or English month name ("Mai", "März", "Sept.", "oct"), else null. */
export function monthOf(word: string): number | null {
  const i = nameIndex(MONTHS, word)
  return i == null ? null : i + 1
}

/** 0 (Sunday)..6 for a German or English weekday ("Dienstag", "Di.", "tue"), else null. */
export function weekdayOf(word: string): number | null {
  const short = WEEKDAYS_SHORT.indexOf(fold(word))
  return short >= 0 ? short : nameIndex(WEEKDAYS, word)
}

const isYear = (s: string | undefined): boolean => !!s && /^(19|20)\d{2}$/.test(s)
const fullYear = (s: string): number => (s.length === 2 ? 2000 + Number(s) : Number(s))
const validDay = (d: number): boolean => d >= 1 && d <= 31
const validMonth = (m: number): boolean => m >= 1 && m <= 12
/** "12", "12.", "1st", "22nd": a day of the month, else null. */
function dayOf(s: string | undefined): number | null {
  const m = s ? /^(\d{1,2})(?:\.|st|nd|rd|th)?$/i.exec(s) : null
  return m && validDay(Number(m[1])) ? Number(m[1]) : null
}

/**
 * Splits a query into terms. Numeric dates: "12.5.", "12.5.2026", "12.05.26" (day first),
 * "2026-05-12" and "5/12" (month first in English, day first in German, as `locale` writes them).
 */
export function parseQuery(query: string, locale = 'de-DE'): SearchTerm[] {
  const tokens = query.trim().split(/[\s,;]+/).filter(Boolean)
  const monthFirst = !locale.toLowerCase().startsWith('de')
  const terms: SearchTerm[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const next = tokens[i + 1]
    const after = tokens[i + 2]
    let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(t)
    if (m && validMonth(Number(m[2])) && (!m[3] || validDay(Number(m[3])))) {
      terms.push({ raw: t, date: { year: Number(m[1]), month: Number(m[2]), ...(m[3] ? { day: Number(m[3]) } : {}) } })
      continue
    }
    m = /^(\d{1,2})\.(\d{1,2})\.?(\d{4}|\d{2})?$/.exec(t)
    if (m && validDay(Number(m[1])) && validMonth(Number(m[2]))) {
      terms.push({ raw: t, date: { day: Number(m[1]), month: Number(m[2]), ...(m[3] ? { year: fullYear(m[3]) } : {}) } })
      continue
    }
    m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?$/.exec(t)
    if (m) {
      const [day, month] = monthFirst ? [Number(m[2]), Number(m[1])] : [Number(m[1]), Number(m[2])]
      if (validDay(day) && validMonth(month)) {
        terms.push({ raw: t, date: { day, month, ...(m[3] ? { year: fullYear(m[3]) } : {}) } })
        continue
      }
    }
    // "12. Mai", "12 May", "1st June", optionally with a year
    const day = dayOf(t)
    const nextMonth = next ? monthOf(next) : null
    if (day != null && nextMonth != null) {
      const withYear = isYear(after)
      terms.push({ raw: [t, next, ...(withYear ? [after] : [])].join(' '), date: { day, month: nextMonth, ...(withYear ? { year: Number(after) } : {}) } })
      i += withYear ? 2 : 1
      continue
    }
    const month = monthOf(t)
    if (month != null) {
      // "May 12", "May 12 2026", "Mai 2026"
      const d = dayOf(next)
      if (d != null) {
        const withYear = isYear(after)
        terms.push({ raw: [t, next, ...(withYear ? [after] : [])].join(' '), date: { day: d, month, ...(withYear ? { year: Number(after) } : {}) } })
        i += withYear ? 2 : 1
      } else if (isYear(next)) {
        terms.push({ raw: `${t} ${next}`, date: { month, year: Number(next) } })
        i += 1
      } else {
        terms.push({ raw: t, word: fold(t).replace(/\.$/, ''), date: { month } })
      }
      continue
    }
    const weekday = weekdayOf(t)
    if (weekday != null) {
      terms.push({ raw: t, word: fold(t).replace(/\.$/, ''), date: { weekday } })
      continue
    }
    if (isYear(t)) {
      terms.push({ raw: t, word: t, date: { year: Number(t) } })
      continue
    }
    terms.push({ raw: t, word: fold(t) })
  }
  return terms
}

/** True when a capture time (ms, local time) has every part of the date query. 0 = unknown date. */
export function dateMatches(time: number, q: DateQuery): boolean {
  if (!time) return false
  const d = new Date(time)
  return (
    (q.day == null || d.getDate() === q.day) &&
    (q.month == null || d.getMonth() + 1 === q.month) &&
    (q.year == null || d.getFullYear() === q.year) &&
    (q.weekday == null || d.getDay() === q.weekday)
  )
}

const KIND_WORDS: Record<MatchKind, readonly string[]> = {
  video: ['video', 'videos', 'clip', 'clips'],
  live: ['live', 'livephoto', 'livephotos', 'motion'],
  text: ['text', 'texte', 'textfolie', 'textfolien']
}

/** The kind a word names ("Video", "Live", "Text"; three letters are enough), else null. */
export function kindOf(word: string): MatchKind | null {
  const w = fold(word)
  for (const [kind, words] of Object.entries(KIND_WORDS) as [MatchKind, readonly string[]][]) {
    if (words.includes(w) || (w.length >= 3 && words.some((x) => x.startsWith(w)))) return kind
  }
  return null
}

function hasKind(s: TimelineSlide, kind: MatchKind): boolean {
  if (kind === 'video') return s.kind === 'video' || s.entries.some((e) => e.type === 'video')
  if (kind === 'live') return s.media.some((m) => !!m.live)
  return s.kind === 'text' || s.kind === 'title'
}

// Whether a person is in a photo or video: face matching is costly for videos, so it is kept per
// media item (items are replaced, never changed, when their data changes) and person.
const personCache = new WeakMap<MediaItem, Map<string, boolean>>()
function shows(m: MediaItem, person: Person): boolean {
  let byPerson = personCache.get(m)
  if (!byPerson) personCache.set(m, (byPerson = new Map()))
  const key = peopleKey([person])
  let hit = byPerson.get(key)
  if (hit === undefined) {
    hit = m.kind === 'video' ? videoPersonTracks(m, [person]).length > 0 : photoPersonFaces(m, [person]).length > 0
    byPerson.set(key, hit)
  }
  return hit
}

interface TextField {
  field: MatchField
  text: string
}

/** The texts of a slide, in the order they are reported. */
function textsOf(s: TimelineSlide): TextField[] {
  const out: TextField[] = []
  const push = (field: MatchField, text: string | undefined): void => {
    if (text?.trim()) out.push({ field, text: text.trim() })
  }
  for (const m of s.media) push('file', m.name)
  if (s.kind === 'title') {
    push('title', s.title?.text)
    push('title', s.title?.subtitle)
  }
  if (s.kind === 'text') {
    const e = s.entries[0] as TextEntry
    const field = e.titleStyle === 'credits' ? 'text' : 'chapter'
    push(field, e.title)
    push(field, e.subtitle)
  }
  // a text slide shown as this slide's caption (Magazine) is a chapter
  if (s.captionEntryId) {
    push('chapter', s.caption?.text)
    push('chapter', s.caption?.subtitle)
  }
  if (s.titleOverlay) push('title', s.title?.text)
  for (const e of s.entries) push('caption', e.caption)
  for (const e of s.entries) for (const ft of e.texts ?? []) push('freeText', ft.text)
  return out
}

/** Capture times of a slide's photos and videos; a day title made from the capture date has its day's. */
function timesOf(tl: Timeline, s: TimelineSlide): number[] {
  const own = s.media.map((m) => m.captureTime).filter((x) => x > 0)
  if (own.length || s.kind !== 'text' || (s.entries[0] as TextEntry).auto !== 'day') return own
  for (let k = s.index + 1; k < tl.slides.length; k++) {
    const next = tl.slides[k].media.find((m) => m.captureTime > 0)
    if (next) return [next.captureTime]
    if (tl.slides[k].kind === 'text') break
  }
  return []
}

const ORDER: readonly MatchField[] = ['file', 'title', 'chapter', 'caption', 'text', 'freeText', 'person', 'kind', 'date']

function matchTerm(term: SearchTerm, s: TimelineSlide, texts: TextField[], times: () => number[], people: readonly Person[]): Omit<SearchHit, 'index'> | null {
  if (term.word) {
    const found = texts.find((f) => fold(f.text).includes(term.word!))
    if (found) return { field: found.field, text: found.text }
    if (term.word.length >= 2) {
      for (const p of people) {
        if (fold(p.name ?? '').includes(term.word) && s.media.some((m) => shows(m, p))) return { field: 'person', text: p.name! }
      }
    }
    const kind = kindOf(term.word)
    if (kind && hasKind(s, kind)) return { field: 'kind', text: '', kind }
  }
  if (term.date) {
    const time = times().find((x) => dateMatches(x, term.date!))
    if (time) return { field: 'date', text: '', time }
  }
  return null
}

/**
 * The slides matching every term of `query`, in show order, each with what matched (of all terms,
 * the most telling: a file name or title before a person, a kind or a date).
 */
export function searchSlides(tl: Timeline, project: Pick<Project, 'people'>, query: string, locale = 'de-DE'): SearchHit[] {
  const terms = parseQuery(query, locale)
  if (!terms.length) return []
  const people = (project.people ?? []).filter((p) => !!p.name?.trim())
  const out: SearchHit[] = []
  for (const s of tl.slides) {
    const texts = textsOf(s)
    let cached: number[] | null = null
    const times = (): number[] => (cached ??= timesOf(tl, s))
    let best: Omit<SearchHit, 'index'> | null = null
    for (const term of terms) {
      const hit = matchTerm(term, s, texts, times, people)
      if (!hit) {
        best = null
        break
      }
      if (!best || ORDER.indexOf(hit.field) < ORDER.indexOf(best.field)) best = hit
    }
    if (best) out.push({ index: s.index, ...best })
  }
  return out
}
