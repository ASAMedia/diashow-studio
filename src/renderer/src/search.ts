// Searching the filmstrip (Ctrl+F): which slides match a query and what matched. A query is split
// into terms that must all match (in any field): words in file names, titles, chapter and text slides,
// captions, text boxes and people's names; kinds ("Video", "Live", "Text"); and capture dates, in
// German or English ("12.5.", "12. Mai", "12.Mai", "May 12", "Dienstag", "Mai 2026", "2026-05-12").
//
// A month or weekday name is a date only when it is written out or abbreviated ("Mai", "Jan", "Jan.",
// "Mo.", "Sept") or is the start of a name from four letters on ("Dien", "Octo"); shorter starts are
// ordinary words ("die", "mit", "Sam"). Such a word, and a number like "1.5" (a date without the dot,
// or a version), is searched as text only when the show has it as something other than a date: in a
// person's name, or inside a name, file name, caption, chapter or text ("Jan", "Maike", "Freibad",
// "Version 1.5"). A day title like "14. Juli 2025" doesn't count, it names the date. The date can still
// be asked for unmistakably: "Jan.", "Januar 2026", "12. Jan", "1.5.". Pure, so the parsing and matching
// are unit tested (tests/filmstrip.test.ts).
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

/**
 * One part of a query: a word, a date, or both (a month or weekday name, a year, "1.5"). With both,
 * the date counts only while the show doesn't have the word as text (searchSlides); a year always counts.
 */
export interface SearchTerm {
  raw: string
  word?: string
  date?: DateQuery
}

/** Lower case without accents (ä → a, ß → ss), for comparing. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss')
}

/** Folded names of a month or weekday, German and English. */
interface DateName {
  full: readonly string[]
  /** Abbreviations as the date formats of both languages write them; those of two letters only with their dot ("Di."). */
  short: readonly string[]
}
const MONTHS: readonly DateName[] = [
  { full: ['januar', 'janner', 'jaenner', 'january'], short: ['jan'] },
  { full: ['februar', 'feber', 'february'], short: ['feb'] },
  { full: ['marz', 'maerz', 'march'], short: ['mar', 'mrz'] },
  { full: ['april'], short: ['apr'] },
  { full: ['mai', 'may'], short: [] },
  { full: ['juni', 'june'], short: ['jun'] },
  { full: ['juli', 'july'], short: ['jul'] },
  { full: ['august'], short: ['aug'] },
  { full: ['september'], short: ['sept', 'sep'] },
  { full: ['oktober', 'october'], short: ['okt', 'oct'] },
  { full: ['november'], short: ['nov'] },
  { full: ['dezember', 'december'], short: ['dez', 'dec'] }
]
const WEEKDAYS: readonly DateName[] = [
  { full: ['sonntag', 'sunday'], short: ['so', 'sun'] },
  { full: ['montag', 'monday'], short: ['mo', 'mon'] },
  { full: ['dienstag', 'tuesday'], short: ['di', 'tue', 'tues'] },
  { full: ['mittwoch', 'wednesday'], short: ['mi', 'wed'] },
  { full: ['donnerstag', 'thursday'], short: ['do', 'thu', 'thur', 'thurs'] },
  { full: ['freitag', 'friday'], short: ['fr', 'fri'] },
  { full: ['samstag', 'saturday'], short: ['sa', 'sat'] }
]

/**
 * Finds a name: written out or abbreviated (at least three letters, two with the dot: "Mai", "Jan",
 * "Di."), or the start of a written-out name from four letters on ("Sept", "Dien"). Shorter starts are
 * ordinary words ("die", "mit", "Sam").
 */
function nameIndex(names: readonly DateName[], word: string): number | null {
  const dotted = word.endsWith('.')
  const w = fold(word).replace(/\.$/, '')
  if (w.length < (dotted ? 2 : 3)) return null
  for (const [i, n] of names.entries()) if (n.full.includes(w) || n.short.includes(w)) return i
  if (w.length < 4) return null
  for (const [i, n] of names.entries()) if (n.full.some((x) => x.length > w.length && x.startsWith(w))) return i
  return null
}

/** 1..12 for a German or English month name ("Mai", "März", "Sept.", "oct"), else null. */
export function monthOf(word: string): number | null {
  const i = nameIndex(MONTHS, word)
  return i == null ? null : i + 1
}

/** 0 (Sunday)..6 for a German or English weekday ("Dienstag", "Di.", "tue"), else null. */
export function weekdayOf(word: string): number | null {
  return nameIndex(WEEKDAYS, word)
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

const monthFirstCache = new Map<string, boolean>()
/**
 * Whether `locale` writes the month in front of the day in numeric dates: "5/12/2026" in en-US,
 * "12/05/2026" in en-GB and German. Asked from Intl, so every Windows language gets its own order.
 */
export function monthBeforeDay(locale: string): boolean {
  let first = monthFirstCache.get(locale)
  if (first === undefined) {
    try {
      const parts = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric' }).formatToParts(new Date(2026, 4, 12)).map((p) => p.type)
      first = parts.indexOf('month') < parts.indexOf('day')
    } catch {
      first = false
    }
    monthFirstCache.set(locale, first)
  }
  return first
}

/** "12.Mai" and "12.Mai2026" written without spaces: day, month (and year) as tokens of their own. */
function splitGlued(token: string): string[] {
  const m = /^(\d{1,2}\.)(\p{L}+\.?)(\d{4})?$/u.exec(token)
  return m && monthOf(m[2]) != null ? [m[1], m[2], ...(m[3] ? [m[3]] : [])] : [token]
}

/**
 * Splits a query into terms. Numeric dates: "12.5.", "12.5.2026", "12.05.26" (day first),
 * "2026-05-12" and "5/12" (in the order `locale` writes them: month first in en-US, day first in
 * German and British English). "1.5" without the date's dot is a word too.
 */
export function parseQuery(query: string, locale = 'de-DE'): SearchTerm[] {
  const tokens = query.trim().split(/[\s,;]+/).filter(Boolean).flatMap(splitGlued)
  const monthFirst = monthBeforeDay(locale)
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
    m = /^(\d{1,2})\.(\d{1,2})(\.(\d{4}|\d{2})?)?$/.exec(t)
    if (m && validDay(Number(m[1])) && validMonth(Number(m[2]))) {
      const date = { day: Number(m[1]), month: Number(m[2]), ...(m[4] ? { year: fullYear(m[4]) } : {}) }
      // without the date's last dot it may be a number as well ("Version 1.5")
      terms.push(m[3] ? { raw: t, date } : { raw: t, word: fold(t), date })
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
    // a name with its dot ("Jan.", "Mo.") is a date only; written out or without the dot, a word too
    const named = (date: DateQuery): SearchTerm => (t.endsWith('.') ? { raw: t, date } : { raw: t, word: fold(t), date })
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
        terms.push(named({ month }))
      }
      continue
    }
    const weekday = weekdayOf(t)
    if (weekday != null) {
      terms.push(named({ weekday }))
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

// Dates written in a text (folded): numeric ones, a day with a month, a month with a year, a month or
// weekday written out, an abbreviation with its dot. They name a date, so a date word found in them
// stays a date (withoutDates).
const alternatives = (names: readonly string[]): string => [...new Set(names)].sort((a, b) => b.length - a.length).join('|')
const MONTH_WORD = `(?:${alternatives(MONTHS.flatMap((n) => [...n.full, ...n.short]))})\\.?`
const DAY_WORD = '\\d{1,2}(?:\\.|st|nd|rd|th)?'
const DATE_IN_TEXT = new RegExp(
  '(?<![\\p{L}\\d])(?:' +
    ['\\d{1,2}\\.\\d{1,2}\\.(?:\\d{4}|\\d{2})?', '\\d{4}-\\d{1,2}(?:-\\d{1,2})?', '\\d{1,2}/\\d{1,2}(?:/(?:\\d{4}|\\d{2}))?',
      `${DAY_WORD}\\s*${MONTH_WORD}(?:,?\\s*\\d{4})?`, `${MONTH_WORD}\\s*${DAY_WORD}(?:,?\\s*\\d{4})?`, `${MONTH_WORD}\\s*\\d{4}`,
      `(?:${alternatives([...MONTHS, ...WEEKDAYS].flatMap((n) => n.full))})`, `(?:${alternatives([...MONTHS, ...WEEKDAYS].flatMap((n) => n.short))})\\.`].join('|') +
    ')(?![\\p{L}\\d])',
  'gu'
)

const undated = new Map<string, string>()
/** A text folded and without the dates written in it. */
function withoutDates(text: string): string {
  let s = undated.get(text)
  if (s === undefined) {
    if (undated.size > 5000) undated.clear()
    undated.set(text, (s = fold(text).replace(DATE_IN_TEXT, ' ')))
  }
  return s
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
// media item (items are replaced, never changed, when their data changes) and person. Each face goes
// to the closest of all the marked people, as in the people list and the pixelation.
const personCache = new WeakMap<MediaItem, Map<string, boolean>>()
function shows(m: MediaItem, person: Person, all: readonly Person[]): boolean {
  let byPerson = personCache.get(m)
  if (!byPerson) personCache.set(m, (byPerson = new Map()))
  const key = `${person.id}/${peopleKey(all)}`
  let hit = byPerson.get(key)
  if (hit === undefined) {
    hit = m.kind === 'video' ? videoPersonTracks(m, all).some((x) => x.person.id === person.id) : photoPersonFaces(m, all).some((x) => x.person.id === person.id)
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

function matchTerm(term: SearchTerm, s: TimelineSlide, texts: TextField[], times: () => number[], people: readonly Person[], all: readonly Person[]): Omit<SearchHit, 'index'> | null {
  if (term.word) {
    const found = texts.find((f) => fold(f.text).includes(term.word!))
    if (found) return { field: found.field, text: found.text }
    if (term.word.length >= 2) {
      for (const p of people) {
        if (fold(p.name ?? '').includes(term.word) && s.media.some((m) => shows(m, p, all))) return { field: 'person', text: p.name! }
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
 * Whether the show has `word` as something other than a date: in the name of a person who is in a
 * photo or video, or in a text where it is not part of a date ("Jan" in "Jan am Strand", "mai" in
 * "Maike", "frei" in "Freibad", "1.5" in "Version 1.5"; not "Juli" in a day title "14. Juli 2025").
 */
function foundAsText(word: string, tl: Timeline, textsAt: (s: TimelineSlide) => TextField[], people: readonly Person[], all: readonly Person[]): boolean {
  const named = word.length >= 2 ? people.filter((p) => fold(p.name ?? '').includes(word)) : []
  return tl.slides.some((s) => textsAt(s).some((f) => withoutDates(f.text).includes(word)) || named.some((p) => s.media.some((m) => shows(m, p, all))))
}

/** A year alone stays a date also when it is in a text: phones put it into file names ("IMG_20250714"). */
const yearOnly = (q: DateQuery): boolean => q.year != null && q.month == null && q.day == null && q.weekday == null

/**
 * The slides matching every term of `query`, in show order, each with what matched (of all terms,
 * the most telling: a file name or title before a person, a kind or a date). `locale`: the Windows
 * language the UI follows (the order of day and month in "12/5").
 */
export function searchSlides(tl: Timeline, project: Pick<Project, 'people'>, query: string, locale = 'de-DE'): SearchHit[] {
  const all = project.people ?? []
  const people = all.filter((p) => !!p.name?.trim())
  const textCache: (TextField[] | undefined)[] = []
  const textsAt = (s: TimelineSlide): TextField[] => (textCache[s.index] ??= textsOf(s))
  // a word that may be a date or something else ("Jan", "Mai", "1.5") is text only where the show has it as text
  const terms = parseQuery(query, locale).map((term) =>
    term.word && term.date && !yearOnly(term.date) && foundAsText(term.word, tl, textsAt, people, all) ? { raw: term.raw, word: term.word } : term
  )
  if (!terms.length) return []
  const out: SearchHit[] = []
  for (const s of tl.slides) {
    const texts = textsAt(s)
    let cached: number[] | null = null
    const times = (): number[] => (cached ??= timesOf(tl, s))
    let best: Omit<SearchHit, 'index'> | null = null
    for (const term of terms) {
      const hit = matchTerm(term, s, texts, times, people, all)
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
