// The filmstrip's zoom (time ↔ x, shared with the audio lane), its search (date words and matching)
// where inserted photos go (insertion index and grouping in multi-photo themes, and only into the show
// they were meant for) and where a moved slide goes.
import { beforeAll, describe, expect, it } from 'vitest'
import { buildTimeline, type Timeline } from '@shared/timeline'
import { DEFAULT_SETTINGS, type Entry, type MediaItem, type Project, type Rect } from '@shared/types'
import {
  addWidth, anchoredScroll, CARD, cardToSlider, clampCard, fitCard, MAX_CARD, MIN_CARD, MIN_STEP, minCard, numberEvery, sliderToCard, STEP, stripScale, stripWidth, timeToX,
  xToTime, zoomStep
} from '../src/renderer/src/components/stripScale'
import { dateMatches, fold, kindOf, monthBeforeDay, monthOf, parseQuery, searchSlides, weekdayOf } from '../src/renderer/src/search'
import { dateLocale, setLocale } from '../src/renderer/src/i18n'
import { anchorAt, canJoin, insertEntries, insertInto, moveSlide } from '../src/renderer/src/insertAt'
import { endOfShow, insertByTime } from '../src/renderer/src/entryEdits'

const photo = (id: string, extra: Partial<MediaItem> = {}): MediaItem => ({
  id, path: `C:\\p\\${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: 4000, height: 3000, captureTime: 0, status: 'ready', ...extra
})
const video = (id: string, extra: Partial<MediaItem> = {}): MediaItem => ({
  id, path: `C:\\p\\${id}.mp4`, name: `${id}.mp4`, kind: 'video', format: 'H.264', width: 1920, height: 1080, duration: 4, hasAudio: true,
  captureTime: 0, status: 'ready', playback: `C:\\p\\${id}.mp4`, ...extra
})
const entryOf = (m: MediaItem, extra: Partial<Entry> = {}): Entry => ({ id: `e-${m.id}`, type: m.kind, mediaId: m.id, ...extra }) as Entry

function project(entries: Entry[], media: MediaItem[], patch: Partial<Project['settings']> = {}, extra: Partial<Project> = {}): Project {
  return { version: 1, id: 'p', name: 'Test', createdAt: 0, updatedAt: 0, entries, media, music: [], settings: { ...DEFAULT_SETTINGS, showTitle: false, ...patch }, ...extra }
}
/** Each slide as the ids of its media, in show order. */
const slidesOf = (p: Project): string[][] => buildTimeline(p).slides.map((s) => s.entries.map((e) => (e.type === 'text' ? e.id : e.mediaId)).sort())

describe('filmstrip zoom: time ↔ x, shared with the audio lane', () => {
  const media = Array.from({ length: 6 }, (_, i) => (i === 2 ? video(`v${i}`, { duration: 7 }) : photo(`p${i}`)))
  const p = project(media.map((m) => entryOf(m)), media)
  const tl = buildTimeline(p)

  it('keeps the classic size and scales gaps, heights and detail with the card width', () => {
    expect(stripScale(CARD)).toEqual({ card: 96, gap: 6, step: STEP, height: 64, detail: 'full' })
    expect(stripScale(MIN_CARD)).toMatchObject({ card: MIN_CARD, gap: 1, step: MIN_CARD + 1, detail: 'tiny' })
    expect(stripScale(30).detail).toBe('compact')
    expect(stripScale(1000).card).toBe(MAX_CARD)
    expect(stripScale(MAX_CARD).height).toBeGreaterThan(64)
  })

  it('puts every slide start at its card at every zoom, so the lane and the cards line up', () => {
    for (const card of [MIN_STEP, 1.37, 4.8, MIN_CARD, 20, 57, CARD, MAX_CARD]) {
      const { step } = stripScale(card)
      for (const s of tl.slides) {
        expect(timeToX(tl, s.start, step)).toBeCloseTo(s.index * step, 6)
        // half way through a slide's own time is half way across its step
        const end = s.index + 1 < tl.slides.length ? tl.slides[s.index + 1].start : s.start + s.duration
        expect(timeToX(tl, (s.start + end) / 2, step)).toBeCloseTo((s.index + 0.5) * step, 6)
      }
      for (const time of [0, 0.7, 3.3, 9.9, tl.duration - 0.01]) {
        expect(xToTime(tl, timeToX(tl, time, step), step)).toBeCloseTo(time, 6)
        // the same time lands on the same fraction of a slide at any zoom
        expect(timeToX(tl, time, step) / step).toBeCloseTo(timeToX(tl, time) / STEP, 6)
      }
    }
  })

  it('keeps the anchored point in place while zooming', () => {
    for (const [scroll, anchorX, from, to] of [[0, 200, 102, 7], [5000, 640, 102, 145], [123, 16, 30, 31]]) {
      const before = (scroll + anchorX - 16) / from
      const next = anchoredScroll(scroll, anchorX, from, to)
      if (next > 0) expect((next + anchorX - 16) / to).toBeCloseTo(before, 6)
    }
    // the first card's left edge (behind the 16 px padding) stays at the left
    expect(anchoredScroll(0, 16, 102, 7)).toBe(0)
  })

  it('fits the whole show: with cards, or for a long show as an overview of thin bars', () => {
    const c = fitCard(200, 1800)
    expect(stripWidth(200, stripScale(c))).toBeLessThanOrEqual(1800)
    expect(stripWidth(200, stripScale(c + 1))).toBeGreaterThan(1800)
    expect(fitCard(5, 1800)).toBe(MAX_CARD)
    // too long for the smallest cards (about 250 slides here): the overview, every slide in the width
    for (const [n, width] of [[400, 1800], [500, 1000], [1000, 1400], [1000, 992], [2000, 1050]]) {
      const o = fitCard(n, width)
      expect(o, `${n} in ${width}`).toBeLessThan(MIN_CARD)
      expect(stripScale(o).detail).toBe('overview')
      expect(stripWidth(n, stripScale(o))).toBeLessThanOrEqual(width)
      expect(stripWidth(n, stripScale(o + 0.01))).toBeGreaterThan(width)
      expect(minCard(n, width)).toBe(o)
    }
    // the narrowest bar: half a pixel
    expect(fitCard(5000, 1000)).toBe(MIN_STEP)
    // a show that fits with cards can't be zoomed out into the overview
    expect(minCard(200, 1800)).toBe(MIN_CARD)
  })

  it('the overview: bars without gaps, fractional widths, zoom steps across the smallest card', () => {
    expect(stripScale(2.5)).toEqual({ card: 2.5, gap: 0, step: 2.5, height: 64, detail: 'overview' })
    expect(stripScale(MIN_STEP / 2).card).toBe(MIN_STEP)
    expect(clampCard(1.234, 1)).toBe(1.23)
    // cards keep whole pixels; without an overview to go to, the smallest card is the end
    expect(clampCard(5.999, 1)).toBe(MIN_CARD)
    expect(clampCard(2, MIN_CARD)).toBe(MIN_CARD)
    const lo = minCard(1000, 1400)
    expect(zoomStep(MIN_CARD, 1 / 1.25, lo)).toBe(4.8)
    expect(zoomStep(4.8, 1.25, lo)).toBe(MIN_CARD)
    expect(zoomStep(lo, 0.5, lo)).toBe(lo)
    expect(zoomStep(5.5, 1.25, lo)).toBe(7)
    // the slider starts at the overview of the whole show
    expect(cardToSlider(lo, lo)).toBe(0)
    expect(sliderToCard(0, lo)).toBe(lo)
    expect(sliderToCard(100, lo)).toBe(MAX_CARD)
    expect(cardToSlider(MIN_CARD, lo)).toBeGreaterThan(0)
    expect(addWidth(stripScale(2))).toBe(44)
    // numbers every 25 or 50 slides at a pixel or two
    expect(numberEvery(stripScale(1.4))).toBe(25)
    expect(numberEvery(stripScale(MIN_STEP))).toBe(100)
  })

  it('has a logarithmic slider, steps of at least a pixel and sparse numbers on small cards', () => {
    expect(cardToSlider(MIN_CARD)).toBe(0)
    expect(cardToSlider(MAX_CARD)).toBe(100)
    let last = 0
    for (let v = 0; v <= 100; v += 5) {
      const c = sliderToCard(v)
      expect(c).toBeGreaterThanOrEqual(last)
      expect(Math.abs(cardToSlider(c) - v)).toBeLessThanOrEqual(2)
      last = c
    }
    expect(zoomStep(MIN_CARD, 1.05)).toBe(MIN_CARD + 1)
    expect(zoomStep(MIN_CARD, 0.5)).toBe(MIN_CARD)
    expect(zoomStep(CARD, 1.25)).toBe(120)
    expect(numberEvery(stripScale(CARD))).toBe(1)
    for (const card of [MIN_CARD, 10, 25, 50]) {
      const s = stripScale(card)
      expect(numberEvery(s) * s.step).toBeGreaterThanOrEqual(30)
    }
  })
})

describe('filmstrip search: dates in German and English', () => {
  it('reads month and weekday names, short forms and umlauts', () => {
    for (const w of ['März', 'maerz', 'March', 'Mrz', 'mar.']) expect(monthOf(w)).toBe(3)
    expect(monthOf('Mai')).toBe(5)
    expect(monthOf('may')).toBe(5)
    expect(monthOf('Sept.')).toBe(9)
    expect(monthOf('Okt')).toBe(10)
    expect(monthOf('octo')).toBe(10)
    expect(monthOf('Dezember')).toBe(12)
    expect(monthOf('ma')).toBeNull()
    expect(monthOf('Strand')).toBeNull()
    expect(weekdayOf('Dienstag')).toBe(2)
    expect(weekdayOf('Di.')).toBe(2)
    expect(weekdayOf('tue')).toBe(2)
    expect(weekdayOf('Sonntag')).toBe(0)
    expect(weekdayOf('saturday')).toBe(6)
    // two letters without a dot are ordinary words ("so", "do")
    expect(weekdayOf('so')).toBeNull()
    expect(weekdayOf('do')).toBeNull()
    expect(fold('Größe Über')).toBe('grosse uber')
  })

  it('parses numeric dates, day-month phrases and years', () => {
    expect(parseQuery('12.5.')).toEqual([{ raw: '12.5.', date: { day: 12, month: 5 } }])
    expect(parseQuery('12.5.2026')[0].date).toEqual({ day: 12, month: 5, year: 2026 })
    expect(parseQuery('12.05.26')[0].date).toEqual({ day: 12, month: 5, year: 2026 })
    expect(parseQuery('2026-05-12')[0].date).toEqual({ year: 2026, month: 5, day: 12 })
    expect(parseQuery('2026-05')[0].date).toEqual({ year: 2026, month: 5 })
    // slashes: month first in English, day first in German
    expect(parseQuery('5/12', 'en-US')[0].date).toEqual({ day: 12, month: 5 })
    expect(parseQuery('5/12', 'de-DE')[0].date).toEqual({ day: 5, month: 12 })
    expect(parseQuery('12. Mai')).toEqual([{ raw: '12. Mai', date: { day: 12, month: 5 } }])
    expect(parseQuery('May 12, 2026')).toEqual([{ raw: 'May 12 2026', date: { day: 12, month: 5, year: 2026 } }])
    expect(parseQuery('1st June')[0].date).toEqual({ day: 1, month: 6 })
    expect(parseQuery('Mai 2026')[0].date).toEqual({ month: 5, year: 2026 })
    // a single month, weekday or year is a word too (a caption "Mai-Feier" matches as well)
    expect(parseQuery('Mai')).toEqual([{ raw: 'Mai', word: 'mai', date: { month: 5 } }])
    expect(parseQuery('Dienstag')).toEqual([{ raw: 'Dienstag', word: 'dienstag', date: { weekday: 2 } }])
    expect(parseQuery('2025')).toEqual([{ raw: '2025', word: '2025', date: { year: 2025 } }])
    expect(parseQuery('  Strand   12.5. ').map((x) => x.raw)).toEqual(['Strand', '12.5.'])
    // not dates
    expect(parseQuery('32.5.')[0]).toEqual({ raw: '32.5.', word: '32.5.' })
    expect(parseQuery('IMG_1234')[0]).toEqual({ raw: 'IMG_1234', word: 'img_1234' })
  })

  it('matches capture times in local time', () => {
    const tue = new Date(2025, 6, 15, 10, 0).getTime()
    expect(dateMatches(tue, { day: 15, month: 7 })).toBe(true)
    expect(dateMatches(tue, { weekday: 2 })).toBe(true)
    expect(dateMatches(tue, { month: 7, year: 2025 })).toBe(true)
    expect(dateMatches(tue, { month: 8 })).toBe(false)
    expect(dateMatches(0, { month: 1 })).toBe(false)
    expect(kindOf('Video')).toBe('video')
    expect(kindOf('vid')).toBe('video')
    expect(kindOf('Live')).toBe('live')
    expect(kindOf('Strand')).toBeNull()
  })
})

describe('filmstrip search: what matches', () => {
  const axis = (k: number): number[] => Array.from({ length: 128 }, (_, i) => (i === k ? 1 : 0))
  const FACE: Rect = { x: 0.4, y: 0.3, w: 0.1, h: 0.15 }
  const at = (m: number, d: number, h = 10): number => new Date(2025, m - 1, d, h).getTime()
  const media = [
    photo('a', { name: 'IMG_0001.JPG', captureTime: at(7, 14, 18) }), // Monday
    photo('b', { name: 'Strand.jpg', captureTime: at(7, 15) }), // Tuesday
    video('v', { name: 'clip.mp4', captureTime: at(7, 15, 11) }),
    photo('l', { name: 'IMG_0002.HEIC', captureTime: at(8, 1), live: { source: 'C:\\p\\IMG_0002.MOV', duration: 2 } }),
    photo('f', { name: 'gruppe.jpg', captureTime: at(8, 1, 12), faces: [FACE], faceDesc: [axis(3)] })
  ]
  const entries: Entry[] = [
    { id: 't1', type: 'text', title: 'Montag', subtitle: '14. Juli 2025', auto: 'day' },
    entryOf(media[0], { caption: 'Ankunft am Bahnhof' }),
    { id: 't2', type: 'text', title: 'Dienstag', subtitle: 'Am Meer', auto: 'day' },
    entryOf(media[1], { texts: [{ id: 'x', text: 'Sonnenuntergang', x: 0.5, y: 0.5, size: 0.1, font: 'theme', color: '#fff', bold: true, box: 'none', rotation: 0 }] }),
    entryOf(media[2]),
    entryOf(media[3], { caption: 'Über den Wolken' }),
    entryOf(media[4]),
    { id: 'cr', type: 'text', title: 'Abspann', subtitle: 'Danke an alle', titleStyle: 'credits' }
  ]
  const p = project(entries, media, { theme: 'kenburns' }, { people: [{ id: 'lena', name: 'Lena', desc: [axis(3)] }] })
  const tl: Timeline = buildTimeline(p)
  const find = (q: string, locale = 'de-DE'): string[] =>
    searchSlides(tl, p, q, locale).map((h) => `${tl.slides[h.index].entries[0].id}:${h.field}`)

  it('finds file names, chapters, captions, text boxes and text slides', () => {
    expect(find('img_0001')).toEqual(['e-a:file'])
    expect(find('ankunft')).toEqual(['e-a:caption'])
    expect(find('sonnenunter')).toEqual(['e-b:freeText'])
    expect(find('uber')).toEqual(['e-l:caption'])
    expect(find('Danke')).toEqual(['cr:text'])
    expect(find('Am Meer')).toEqual(['t2:chapter'])
  })

  it('finds capture dates by weekday, month and day; a day title has its day', () => {
    expect(find('Dienstag')).toEqual(['t2:chapter', 'e-b:date', 'e-v:date'])
    expect(find('Monday', 'en-US')).toEqual(['t1:date', 'e-a:date'])
    expect(find('14.7.')).toEqual(['t1:date', 'e-a:date'])
    expect(find('15. Juli 2025')).toEqual(['t2:date', 'e-b:date', 'e-v:date'])
    expect(find('August')).toEqual(['e-l:date', 'e-f:date'])
    expect(find('1.8.2025')).toEqual(['e-l:date', 'e-f:date'])
    // the day title's subtitle names the month: a text match comes first
    expect(find('Juli')[0]).toBe('t1:chapter')
  })

  it('finds people by name and kinds; every word must match', () => {
    expect(find('Lena')).toEqual(['e-f:person'])
    expect(find('video')).toEqual(['e-v:kind'])
    expect(find('Live')).toEqual(['e-l:kind'])
    expect(find('Strand Dienstag')).toEqual(['e-b:file'])
    expect(find('Strand August')).toEqual([])
    expect(find('   ')).toEqual([])
  })

  it('finds a person where the people list and the pixelation see them: each face goes to the closest person', () => {
    const mix = (a: number, b: number): number[] => axis(3).map((x, i) => x * a + (i === 5 ? b : 0))
    // Mia looks like Lena; the face in "mia.jpg" is within reach of both, but closer to Mia
    const people = [
      { id: 'lena', name: 'Lena', desc: [axis(3)] },
      { id: 'mia', name: 'Mia', desc: [mix(0.9, 0.436)] }
    ]
    const faces = [photo('lena', { faces: [FACE], faceDesc: [axis(3)] }), photo('mia', { faces: [FACE], faceDesc: [mix(0.97, 0.243)] })]
    const q = project(faces.map((m) => entryOf(m)), faces, { theme: 'kenburns' }, { people })
    const qtl = buildTimeline(q)
    const who = (word: string): string[] => searchSlides(qtl, q, word).map((h) => qtl.slides[h.index].entries[0].id)
    expect(who('Lena')).toEqual(['e-lena'])
    expect(who('Mia')).toEqual(['e-mia'])
  })
})

describe('filmstrip search: dates only where they are meant', () => {
  it('reads short forms from three letters (two with the dot) and starts of names from four', () => {
    expect(monthOf('Jan')).toBe(1)
    expect(monthOf('Jan.')).toBe(1)
    expect(monthOf('jän')).toBe(1)
    expect(monthOf('Mai')).toBe(5)
    expect(monthOf('Marc')).toBe(3)
    expect(weekdayOf('Mo.')).toBe(1)
    expect(weekdayOf('Sa.')).toBe(6)
    expect(weekdayOf('Sams')).toBe(6)
    expect(weekdayOf('frei')).toBe(5)
    // ordinary words: starts of names with three letters
    for (const w of ['die', 'mit', 'Sam', 'son', 'don', 'Mo', 'sa']) expect(weekdayOf(w), w).toBeNull()
    for (const w of ['jun.x', 'ma', 'okto2']) expect(monthOf(w), w).toBeNull()
  })

  it('parses dates with and without spaces; a number like 1.5 is a word too; names with a dot are dates only', () => {
    expect(parseQuery('Jan.')).toEqual([{ raw: 'Jan.', date: { month: 1 } }])
    expect(parseQuery('Mo.')).toEqual([{ raw: 'Mo.', date: { weekday: 1 } }])
    expect(parseQuery('Jan')).toEqual([{ raw: 'Jan', word: 'jan', date: { month: 1 } }])
    for (const w of ['die', 'mit', 'Sam']) expect(parseQuery(w)).toEqual([{ raw: w, word: w.toLowerCase() }])
    expect(parseQuery('12.Mai')).toEqual([{ raw: '12. Mai', date: { day: 12, month: 5 } }])
    expect(parseQuery('12.Mai 2026')[0].date).toEqual({ day: 12, month: 5, year: 2026 })
    expect(parseQuery('12.Mai2026')[0].date).toEqual({ day: 12, month: 5, year: 2026 })
    expect(parseQuery('12. Mai')[0].date).toEqual({ day: 12, month: 5 })
    expect(parseQuery('Mai 2026')[0].date).toEqual({ month: 5, year: 2026 })
    expect(parseQuery('12.5.')).toEqual([{ raw: '12.5.', date: { day: 12, month: 5 } }])
    expect(parseQuery('12.5.2026')).toEqual([{ raw: '12.5.2026', date: { day: 12, month: 5, year: 2026 } }])
    expect(parseQuery('2026-05-12')[0].date).toEqual({ year: 2026, month: 5, day: 12 })
    expect(parseQuery('1.5')).toEqual([{ raw: '1.5', word: '1.5', date: { day: 1, month: 5 } }])
    // a word that only looks like a glued date stays a word
    expect(parseQuery('12.Strand')).toEqual([{ raw: '12.Strand', word: '12.strand' }])
  })

  it('reads 12/5 in the order the Windows language writes it: day first in German and British English, month first in American', () => {
    expect(monthBeforeDay('de-DE')).toBe(false)
    expect(monthBeforeDay('en-GB')).toBe(false)
    expect(monthBeforeDay('fr-FR')).toBe(false)
    expect(monthBeforeDay('en-US')).toBe(true)
    expect(parseQuery('12/5', 'de-DE')[0].date).toEqual({ day: 12, month: 5 })
    expect(parseQuery('12/5', 'en-GB')[0].date).toEqual({ day: 12, month: 5 })
    expect(parseQuery('12/5', 'en-US')[0].date).toEqual({ day: 5, month: 12 })
    expect(parseQuery('12/5/2026', 'en-US')[0].date).toEqual({ day: 5, month: 12, year: 2026 })
    // the UI's date order: German with a German UI, else the Windows language itself
    try {
      setLocale('de-AT')
      expect(dateLocale()).toBe('de-DE')
      setLocale('en-GB')
      expect(dateLocale()).toBe('en-GB')
      setLocale('en-US')
      expect(dateLocale()).toBe('en-US')
    } finally {
      setLocale(navigator.language)
    }
  })

  const axis = (k: number): number[] => Array.from({ length: 128 }, (_, i) => (i === k ? 1 : 0))
  const FACE: Rect = { x: 0.4, y: 0.3, w: 0.1, h: 0.15 }
  const on = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 10).getTime()
  const media = [
    photo('a', { name: 'IMG_0001.JPG', captureTime: on(2026, 1, 10), faces: [FACE], faceDesc: [axis(3)] }), // Saturday, Jan
    photo('b', { name: 'IMG_0002.JPG', captureTime: on(2026, 1, 20) }), // Tuesday
    photo('c', { name: 'IMG_0003.JPG', captureTime: on(2026, 3, 3), faces: [FACE], faceDesc: [axis(5)] }), // Tuesday, Marc
    photo('j', { name: 'IMG_0010.JPG', captureTime: on(2026, 3, 14) }), // Saturday
    photo('k', { name: 'IMG_0011.JPG', captureTime: on(2026, 5, 1) }), // Friday
    photo('d', { name: 'IMG_0004.JPG', captureTime: on(2026, 5, 7) }), // Thursday
    photo('e', { name: 'IMG_0005.JPG', captureTime: on(2026, 5, 12) }), // Tuesday
    photo('f', { name: 'IMG_20250715_0900.jpg', captureTime: on(2025, 7, 15) }), // Tuesday
    photo('g', { name: 'Freibad.jpg', captureTime: on(2026, 6, 5) }), // Friday
    photo('h', { name: 'IMG_0008.JPG', captureTime: on(2026, 12, 5) }), // Saturday
    photo('i', { name: 'IMG_0009.JPG', captureTime: on(2026, 9, 4) }), // Friday
    photo('l', { name: 'IMG_0012.JPG', captureTime: on(2026, 9, 20) }), // Sunday
    photo('m', { name: 'IMG_0013.JPG', captureTime: on(2025, 12, 24) }) // Wednesday
  ]
  const byId = new Map(media.map((m) => [m.id, m]))
  const ent = (id: string, extra: Partial<Entry> = {}): Entry => entryOf(byId.get(id)!, extra)
  const box = (text: string): Partial<Entry> => ({ texts: [{ id: `t-${text}`, text, x: 0.5, y: 0.5, size: 0.1, font: 'theme', color: '#fff', bold: true, box: 'none', rotation: 0 }] })
  const showOf = (captions: { b?: string; d?: string } = {}): { tl: Timeline; p: Project } => {
    const entries: Entry[] = [
      ent('a'), ent('b', { caption: captions.b ?? 'Maike am Strand' }), ent('c'), ent('j'), ent('k'), ent('d', { caption: captions.d ?? 'Version 1.5' }),
      ent('e', { caption: 'Mai-Feier' }),
      { id: 't1', type: 'text', title: 'Dienstag', subtitle: '15. Juli 2025', auto: 'day' },
      ent('f'), ent('g'), ent('h', box('Sam und die anderen')), ent('i', { caption: 'Ausflug im September' }), ent('l'), ent('m')
    ]
    const p = project(entries, media, { theme: 'kenburns' }, { people: [{ id: 'jan', name: 'Jan', desc: [axis(3)] }, { id: 'marc', name: 'Marc', desc: [axis(5)] }] })
    return { tl: buildTimeline(p), p }
  }
  const show = showOf()
  const find = (q: string, locale = 'de-DE', s = show): string[] =>
    searchSlides(s.tl, s.p, q, locale).map((h) => `${s.tl.slides[h.index].entries[0].id}:${h.field}`)

  for (const locale of ['de-DE', 'en-US']) {
    it(`a name or a word found in the show is searched as text only, else as a date (${locale})`, () => {
      // a person's name: Jan's photo, not every January photo; with the dot or written out it is the month
      expect(find('Jan', locale)).toEqual(['e-a:person'])
      expect(find('Jan.', locale)).toEqual(['e-a:date', 'e-b:date'])
      expect(find('Januar', locale)).toEqual(['e-a:date', 'e-b:date'])
      expect(find('January', locale)).toEqual(['e-a:date', 'e-b:date'])
      expect(find('Januar 2026', locale)).toEqual(['e-a:date', 'e-b:date'])
      expect(find('Marc', locale)).toEqual(['e-c:person'])
      expect(find('Mar', locale)).toEqual(['e-c:person'])
      expect(find('März', locale)).toEqual(['e-c:date', 'e-j:date'])
      expect(find('Mar.', locale)).toEqual(['e-c:date', 'e-j:date'])
      // inside a word of a caption ("Maike"): the captions, not every May photo
      expect(find('Mai', locale)).toEqual(['e-b:caption', 'e-e:caption'])
      expect(find('Mai Strand', locale)).toEqual(['e-b:caption'])
      expect(find('Mai 2026', locale)).toEqual(['e-k:date', 'e-d:date', 'e-e:date'])
      expect(find('Mai.', locale)).toEqual(['e-k:date', 'e-d:date', 'e-e:date'])
      // "May" is in no text: the month, and "Mai-Feier" names the month, so without "Maike" it is a date too
      expect(find('May', locale)).toEqual(['e-k:date', 'e-d:date', 'e-e:date'])
      expect(find('Mai', locale, showOf({ b: 'Am Strand' }))).toEqual(['e-k:date', 'e-d:date', 'e-e:caption'])
      // a file name ("Freibad.jpg"): not every Friday
      expect(find('frei', locale)).toEqual(['e-g:file'])
      expect(find('Freitag', locale)).toEqual(['e-k:date', 'e-g:date', 'e-i:date'])
      expect(find('Friday', locale)).toEqual(['e-k:date', 'e-g:date', 'e-i:date'])
      // starts of names with three letters are words: no Tuesdays, Wednesdays or Saturdays
      expect(find('die', locale)).toEqual(['t1:chapter', 'e-h:freeText'])
      expect(find('mit', locale)).toEqual([])
      expect(find('Sam', locale)).toEqual(['e-h:freeText'])
      expect(find('Sams', locale)).toEqual(['e-a:date', 'e-j:date', 'e-h:date'])
      expect(find('Sa.', locale)).toEqual(['e-a:date', 'e-j:date', 'e-h:date'])
      expect(find('Mittwoch', locale)).toEqual(['e-m:date'])
      // a day title names its date: "Juli" there doesn't make it a word
      expect(find('Juli', locale)).toEqual(['t1:chapter', 'e-f:date'])
      expect(find('July', locale)).toEqual(['t1:date', 'e-f:date'])
      expect(find('Dienstag', locale)).toEqual(['e-b:date', 'e-c:date', 'e-e:date', 't1:chapter', 'e-f:date'])
      // "September" written out in a caption is the month: "Sept" stays a date
      expect(find('Sept', locale)).toEqual(['e-i:caption', 'e-l:date'])
      // a version number in a caption: the caption, not 1 May; with the date's dot, 1 May
      expect(find('1.5', locale)).toEqual(['e-d:caption'])
      expect(find('1.5.', locale)).toEqual(['e-k:date'])
      expect(find('1.5', locale, showOf({ d: 'Am See' }))).toEqual(['e-k:date'])
      // a year stays a date also where a file name has it
      expect(find('2025', locale)).toEqual(['t1:chapter', 'e-f:file', 'e-m:date'])
    })

    it(`keeps the date forms working (${locale})`, () => {
      for (const q of ['12.Mai', '12. Mai', '12.Mai 2026', '12. Mai 2026', 'Mai 12', 'May 12, 2026', '12.5.', '12.5.2026', '12.05.26', '2026-05-12', '12.5']) {
        expect(find(q, locale), q).toEqual(['e-e:date'])
      }
      // "12/5" follows the language: 12 May in German, 5 December in American English
      expect(find('12/5', locale)).toEqual([locale === 'de-DE' ? 'e-e:date' : 'e-h:date'])
      expect(find('12/5', 'en-GB')).toEqual(['e-e:date'])
    })
  }
})

describe('inserting at a place in the filmstrip', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => photo(`p${String(i).padStart(2, '0')}`))
  const fresh = (...ids: string[]): { media: MediaItem[]; entries: Entry[] } => {
    const media = ids.map((id) => photo(id))
    return { media, entries: media.map((m) => entryOf(m)) }
  }
  /** Inserts new photos at slide boundary `at` the way the filmstrip does. */
  const insert = (p: Project, at: number, ...ids: string[]): Project => {
    const tl = buildTimeline(p)
    const n = fresh(...ids)
    const next = structuredClone(p)
    next.media.push(...n.media)
    insertEntries(next, n.entries, anchorAt(tl, next.entries, at), tl)
    return next
  }

  it('finds the entry behind a boundary: start, between, end, title slide, caption text', () => {
    const p = project(twenty.map((m) => entryOf(m)), twenty, { theme: 'magazine' })
    const tl = buildTimeline(p)
    expect(anchorAt(tl, p.entries, 0)).toBe('e-p00')
    expect(anchorAt(tl, p.entries, 2)).toBe(tl.slides[2].entries.map((e) => e.id).sort()[0])
    expect(anchorAt(tl, p.entries, tl.slides.length)).toBeNull()
    // Origami has a title slide of its own: dropping in front of it goes in front of the first photo
    const kb = project(twenty.slice(0, 3).map((m) => entryOf(m)), twenty.slice(0, 3), { theme: 'origami', showTitle: true })
    const kbTl = buildTimeline(kb)
    expect(kbTl.slides[0].kind).toBe('title')
    expect(anchorAt(kbTl, kb.entries, 0)).toBe('e-p00')
    expect(anchorAt(kbTl, kb.entries, 1)).toBe('e-p00')
    // Magazine shows a text slide as the caption of the next slide: new photos go in front of the text
    const withText = project([entryOf(twenty[0]), { id: 'day', type: 'text', title: 'Dienstag' }, ...twenty.slice(1, 4).map((m) => entryOf(m))], twenty.slice(0, 4), { theme: 'magazine' })
    const wtTl = buildTimeline(withText)
    const captioned = wtTl.slides.findIndex((s) => s.captionEntryId === 'day')
    expect(captioned).toBeGreaterThan(0)
    expect(anchorAt(wtTl, withText.entries, captioned)).toBe('day')
  })

  it('Magazine: between two slides, the new photos get a slide of their own and no other slide changes', () => {
    const p = project(twenty.map((m) => entryOf(m)), twenty, { theme: 'magazine' })
    const before = slidesOf(p)
    expect(before.map((s) => s.length)).toEqual([2, 3, 6, 4, 3, 2])
    const after = slidesOf(insert(p, 2, 'n1'))
    expect(after).toEqual([...before.slice(0, 2), ['n1'], ...before.slice(2)])
    const three = slidesOf(insert(p, 3, 'n1', 'n2', 'n3'))
    expect(three.slice(0, 3)).toEqual(before.slice(0, 3))
    expect(three.slice(-3)).toEqual(before.slice(-3))
    expect(three.slice(3, -3).flat().sort()).toEqual(['n1', 'n2', 'n3'])
    // why the slides behind are pinned: a plain insert regroups everything after it
    const plain = structuredClone(p)
    plain.media.push(photo('n1'))
    plain.entries.splice(5, 0, entryOf(photo('n1')))
    expect(slidesOf(plain).slice(3)).not.toEqual(before.slice(2))
  })

  it('Magazine: at the start and at the end, nothing joins the neighbouring slide', () => {
    const p = project(twenty.map((m) => entryOf(m)), twenty, { theme: 'magazine' })
    const before = slidesOf(p)
    expect(slidesOf(insert(p, 0, 'n1'))).toEqual([['n1'], ...before])
    // the last slide has room for more (its pattern says 5), but the new photo starts its own
    expect(slidesOf(insert(p, before.length, 'n1'))).toEqual([...before, ['n1']])
  })

  it('Origami: videos stay alone, photo groups around the marker keep their photos', () => {
    const media = [...twenty.slice(0, 9), video('v1')]
    const entries = [...twenty.slice(0, 4).map((m) => entryOf(m)), entryOf(media[9]), ...twenty.slice(4, 9).map((m) => entryOf(m))]
    const p = project(entries, media, { theme: 'origami' })
    const before = slidesOf(p)
    for (let at = 0; at <= before.length; at++) {
      const after = slidesOf(insert(p, at, 'n1', 'n2'))
      expect(after.slice(0, at)).toEqual(before.slice(0, at))
      expect(after.slice(after.length - (before.length - at))).toEqual(before.slice(at))
    }
  })

  it('themes with one photo per slide get no grouping marks', () => {
    const p = project(twenty.slice(0, 5).map((m) => entryOf(m)), twenty.slice(0, 5), { theme: 'kenburns' })
    const next = insert(p, 2, 'n1')
    expect(next.entries.map((e) => e.id)).toEqual(['e-p00', 'e-p01', 'e-n1', 'e-p02', 'e-p03', 'e-p04'])
    expect(next.entries.every((e) => e.groupBreak === undefined)).toBe(true)
  })

  it('dropped onto a slide, photos join it when they fit (like dragging a slide onto another)', () => {
    const p = project(twenty.map((m) => entryOf(m)), twenty, { theme: 'magazine' })
    const tl = buildTimeline(p)
    const first = tl.slides[0] // 2 photos, room for 4 more
    expect(canJoin(first, [{ kind: 'photo' }, { kind: 'photo' }], p.settings)).toBe(true)
    expect(canJoin(first, Array.from({ length: 5 }, () => ({ kind: 'photo' as const })), p.settings)).toBe(false)
    expect(canJoin(first, [{ kind: 'video' }], p.settings)).toBe(true)
    expect(canJoin(first, [{ kind: 'photo', live: { source: 'x.mov', duration: 2 } }], { ...p.settings, playLivePhotos: true })).toBe(false)
    expect(canJoin(first, [{ kind: 'video' }], { ...p.settings, theme: 'origami' })).toBe(false)
    expect(canJoin(first, [{ kind: 'photo' }], { ...p.settings, theme: 'kenburns' })).toBe(false)
    // a panorama stays alone on its slide: none joins it, and a dropped one doesn't join another (it would
    // get a slide of its own behind it all the same, and the slides behind would be grouped anew)
    expect(canJoin({ ...first, pano: { axis: 'x', mode: 'pan', reverse: false } }, [{ kind: 'photo' }], p.settings)).toBe(false)
    expect(canJoin(first, [{ kind: 'photo', width: 8000, height: 2000 }], p.settings)).toBe(false)
    expect(canJoin(first, [{ kind: 'photo', width: 2000, height: 8000, edit: { rotate: 90, straighten: 0 } }], p.settings)).toBe(false)
    expect(canJoin(first, [{ kind: 'photo', width: 8000, height: 2000, edit: { rotate: 0, straighten: 0, crop: { x: 0, y: 0, w: 0.25, h: 1 } } }], p.settings)).toBe(true)
    const before = slidesOf(p)
    const next = structuredClone(p)
    const n = fresh('n1', 'n2')
    next.media.push(...n.media)
    insertInto(next, n.entries, first.entries.map((e) => e.id))
    const after = slidesOf(next)
    expect(after[0]).toEqual([...before[0], 'n1', 'n2'].sort())
    // the number of slides stays, so the theme's pattern doesn't shift for the slides behind
    expect(after.slice(1)).toEqual(before.slice(1))
  })
})

describe('moving a slide in the filmstrip', () => {
  it('goes in front of the whole slide behind the place, though a slide lists its photos in the order of its cells', () => {
    // a portrait among landscapes: Magazine's layout puts it into the first cell
    const media = [4000, 4000, 4000, 4000, 3000, 4000].map((w, i) => photo(`m${i}`, { width: w, height: 7000 - w }))
    const p = project(media.map((m) => entryOf(m)), media, { theme: 'magazine' })
    const tl = buildTimeline(p)
    expect(tl.slides.map((s) => s.entries.map((e) => e.id))).toEqual([['e-m0', 'e-m1'], ['e-m4', 'e-m3', 'e-m2'], ['e-m5']])
    // the last slide in front of the middle one (Alt+←, or its card dragged there)
    const moved = structuredClone(p)
    moveSlide(moved, tl, 2, 1)
    expect(moved.entries.map((e) => e.id)).toEqual(['e-m0', 'e-m1', 'e-m5', 'e-m2', 'e-m3', 'e-m4'])
    // to the end
    const last = structuredClone(p)
    moveSlide(last, tl, 0, tl.slides.length)
    expect(last.entries.map((e) => e.id)).toEqual(['e-m2', 'e-m3', 'e-m4', 'e-m5', 'e-m0', 'e-m1'])
    // a text slide shown as the caption of the slide behind the place stays with it
    const withText = project([...media.slice(0, 2).map((m) => entryOf(m)), { id: 'day', type: 'text', title: 'Dienstag' }, ...media.slice(2).map((m) => entryOf(m))], media, { theme: 'magazine' })
    const wtTl = buildTimeline(withText)
    const captioned = wtTl.slides.findIndex((s) => s.captionEntryId === 'day')
    expect(captioned).toBe(1)
    moveSlide(withText, wtTl, wtTl.slides.length - 1, captioned)
    expect(withText.entries.map((e) => e.id)).toEqual(['e-m0', 'e-m1', 'e-m5', 'day', 'e-m2', 'e-m3', 'e-m4'])
  })
})

describe('inserting: the import queue', () => {
  // the renderer's store and insert.ts with a stub of the main process: each import waits until released
  const imports: { paths: string[]; done: (r: { items: MediaItem[]; repeats: Record<string, string> }) => void }[] = []
  const api = {
    saveProject: async () => undefined,
    importNew: (paths: string[]) => new Promise((done) => imports.push({ paths, done })),
    importPaths: async () => []
  }
  let store: typeof import('../src/renderer/src/store')
  let insert: typeof import('../src/renderer/src/insert')
  beforeAll(async () => {
    ;(globalThis as unknown as { window: unknown }).window = { api }
    store = await import('../src/renderer/src/store')
    insert = await import('../src/renderer/src/insert')
  })

  const item = (id: string): MediaItem => ({ id, path: `C:\\Fotos\\${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: 4000, height: 3000, captureTime: 0, status: 'pending' })
  const showOf = (id: string): Project => ({ version: 1, id, name: id, createdAt: 0, updatedAt: 0, entries: [{ id: `${id}-e`, type: 'photo', mediaId: `${id}-m` }], media: [item(`${id}-m`)], music: [], settings: structuredClone(DEFAULT_SETTINGS) })
  const next = async (): Promise<(typeof imports)[number]> => {
    await expect.poll(() => imports.length).toBeGreaterThan(0)
    return imports.shift()!
  }

  it('files imported for one show never land in another one opened meanwhile', async () => {
    const { useStore } = store
    // "Add photos" in show A; A is closed and B opened while the files are read
    useStore.setState({ project: showOf('A'), selection: [] })
    const added = useStore.getState().importMedia(['C:\\Fotos\\neu.jpg'])
    const first = await next()
    useStore.setState({ project: showOf('B'), selection: [] })
    first.done({ items: [item('neu')], repeats: {} })
    expect(await added).toEqual({ added: [], skipped: [] })
    expect(useStore.getState().project!.media.map((m) => m.id)).toEqual(['B-m'])

    // a drop on A's filmstrip waiting behind another import: by its turn B is open, nothing is read for A
    useStore.setState({ project: showOf('A'), selection: [] })
    const before = useStore.getState().importMedia(['C:\\Fotos\\x.jpg'])
    const inserted = insert.insertFiles(['C:\\Fotos\\y.jpg'], { before: null })
    const running = await next()
    useStore.setState({ project: showOf('B'), selection: [] })
    running.done({ items: [item('x')], repeats: {} })
    await before
    expect(await inserted).toEqual([])
    expect(imports).toHaveLength(0)
    expect(useStore.getState().project!.entries.map((e) => e.id)).toEqual(['B-e'])

    // the show still open gets its files
    const own = useStore.getState().importMedia(['C:\\Fotos\\z.jpg'])
    ;(await next()).done({ items: [item('z')], repeats: {} })
    expect((await own).added.map((m) => m.id)).toEqual(['z'])
    expect(useStore.getState().project!.media.map((m) => m.id)).toEqual(['B-m', 'z'])
  })

  it('the notice counts the skipped files that repeat a left-out photo', async () => {
    const { leftOutTargets, noticeRepeats, noticeText, useRepeatNotice } = await import('../src/renderer/src/repeats')
    // a photo and a byte-identical copy of it come in; the show has it, left out
    const p: Project = { ...showOf('A'), entries: [{ id: 'A-e', type: 'photo', mediaId: 'A-m', excluded: true }] }
    noticeRepeats(p, { fresh: [], skipped: [item('x1'), item('x2')], repeatOf: { x1: 'A-m', x2: 'A-m' } }, async () => [])
    const notice = useRepeatNotice.getState().notice!
    expect(leftOutTargets(p, notice.targets)).toBe(2)
    // the text in both languages, whatever the machine's language is (GitHub's runner is English)
    const { setLocale } = await import('../src/renderer/src/i18n')
    try {
      setLocale('de-DE')
      expect(noticeText(p, notice)).toMatch(/^Alle 2 Fotos .* 2 davon sind herausgenommen/)
      setLocale('en-US')
      expect(noticeText(p, notice)).toMatch(/^All 2 photos .* 2 of them are left out/)
    } finally {
      setLocale(navigator.language)
    }
  })
})

describe('new photos go in front of the end credits', () => {
  const ph = (id: string, extra: Partial<Entry> = {}): Entry => ({ id, type: 'photo', mediaId: id, ...extra }) as Entry
  const tx = (id: string, extra: Partial<Entry> = {}): Entry => ({ id, type: 'text', title: id, ...extra }) as Entry
  const cr = (id: string): Entry => tx(id, { titleStyle: 'credits' } as Partial<Entry>)

  it('the end of the show is in front of closing end credits', () => {
    expect(endOfShow([])).toBe(0)
    expect(endOfShow([ph('a'), ph('b')])).toBe(2)
    // a text slide at the end without credits: behind it, as before
    expect(endOfShow([ph('a'), tx('ende')])).toBe(2)
    expect(endOfShow([ph('a'), cr('c')])).toBe(1)
    // credits not at the very end: a last text slide, or a left-out photo, behind them
    expect(endOfShow([ph('a'), cr('c'), tx('ende')])).toBe(1)
    expect(endOfShow([ph('a'), cr('c'), ph('x', { excluded: true })])).toBe(1)
    // several text slides at the end: those in front of the credits stay in front of the new photos
    expect(endOfShow([ph('a'), tx('tag3'), cr('c')])).toBe(2)
    expect(endOfShow([ph('a'), cr('c1'), tx('note'), cr('c2')])).toBe(1)
    // a left-out photo in front of the credits doesn't end them
    expect(endOfShow([ph('a'), ph('x', { excluded: true }), cr('c')])).toBe(2)
    // credits in the middle of the show are no end credits
    expect(endOfShow([ph('a'), cr('c'), ph('b')])).toBe(3)
  })

  it('by capture time: newer and undated photos go in front of the credits, also with something behind them', () => {
    const at = (d: number): number => new Date(2025, 6, d, 10).getTime()
    const media = new Map<string, MediaItem>(
      [photo('a', { captureTime: at(14) }), photo('b', { captureTime: at(15) }), photo('late', { captureTime: at(30) }), photo('new', { captureTime: at(20) }), photo('undated')].map((m) => [m.id, m])
    )
    const order = (es: Entry[]): string[] => es.map((e) => e.id)
    const show = [ph('a'), ph('b'), cr('c'), tx('ende'), ph('late', { excluded: true })]
    expect(order(insertByTime(show, [ph('new'), ph('undated')], media))).toEqual(['a', 'b', 'new', 'undated', 'c', 'ende', 'late'])
    // an older photo still goes where its time belongs
    expect(order(insertByTime([ph('b'), cr('c')], [ph('a')], media))).toEqual(['a', 'b', 'c'])
    // without credits: at the end, as before
    expect(order(insertByTime([ph('a'), tx('ende')], [ph('new')], media))).toEqual(['a', 'ende', 'new'])
  })
})

describe('new photos go in front of the end credits: every way in', () => {
  // the renderer's store and insert.ts with a stub of the main process that imports at once
  const item = (id: string): MediaItem => ({ id, path: `C:/Neu/${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: 4000, height: 3000, captureTime: 0, status: 'pending' })
  const idOf = (path: string): string => path.split('/').pop()!.replace(/\.jpg$/, '')
  let clip: string[] = []
  const api = {
    saveProject: async () => undefined,
    importNew: async (paths: string[]) => ({ items: paths.map((p) => item(idOf(p))), repeats: {} }),
    importPaths: async () => [],
    clipboardMedia: async () => clip
  }
  let store: typeof import('../src/renderer/src/store')
  let insert: typeof import('../src/renderer/src/insert')
  beforeAll(async () => {
    ;(globalThis as unknown as { window: unknown }).window = { api }
    store = await import('../src/renderer/src/store')
    insert = await import('../src/renderer/src/insert')
  })

  const ph = (id: string): Entry => ({ id: `e-${id}`, type: 'photo', mediaId: id })
  const tx = (id: string, credits = false): Entry => ({ id, type: 'text', title: id, ...(credits ? { titleStyle: 'credits' as const } : {}) })
  const show = (entries: Entry[], theme: Project['settings']['theme'] = 'kenburns'): Project => ({
    version: 1, id: `show-${theme}`, name: 'Show', createdAt: 0, updatedAt: 0, entries,
    media: entries.flatMap((e) => (e.type === 'text' ? [] : [{ ...item(e.mediaId), status: 'ready' as const }])),
    music: [], settings: { ...structuredClone(DEFAULT_SETTINGS), theme }
  })
  /** The show in order: media ids for photos, ids for text slides. */
  const order = (): string[] => store.useStore.getState().project!.entries.map((e) => (e.type === 'text' ? e.id : e.mediaId))
  /** "Add photos", a drop on the window, the assistant, pupils' uploads "after the selection". */
  const add = async (entries: Entry[], selection: string[], placement?: 'selection' | 'byTime'): Promise<string[]> => {
    store.useStore.setState({ project: show(entries), selection })
    await store.useStore.getState().importMedia(['C:/Neu/n1.jpg', 'C:/Neu/n2.jpg'], placement)
    return order()
  }
  /** Ctrl+V of copied files. */
  const paste = async (entries: Entry[], selection: string[], theme?: Project['settings']['theme']): Promise<string[]> => {
    store.useStore.setState({ project: show(entries, theme), selection })
    clip = ['C:/Neu/v1.jpg', 'C:/Neu/v2.jpg']
    await insert.pasteMedia()
    return order()
  }

  it('without a selection: in front of the credits; without credits at the end', async () => {
    expect(await add([ph('a'), ph('b')], [])).toEqual(['a', 'b', 'n1', 'n2'])
    expect(await add([ph('a'), ph('b'), tx('c', true)], [])).toEqual(['a', 'b', 'n1', 'n2', 'c'])
    // credits not at the very end, and several text slides at the end
    expect(await add([ph('a'), tx('c', true), tx('ende')], [])).toEqual(['a', 'n1', 'n2', 'c', 'ende'])
    expect(await add([ph('a'), tx('tag3'), tx('c', true)], [])).toEqual(['a', 'tag3', 'n1', 'n2', 'c'])
    // by capture time (a drop onto the show's card on the home screen, uploads "into their day")
    expect(await add([ph('a'), tx('c', true), tx('ende')], [], 'byTime')).toEqual(['a', 'n1', 'n2', 'c', 'ende'])
    // Ctrl+V
    expect(await paste([ph('a'), ph('b')], [])).toEqual(['a', 'b', 'v1', 'v2'])
    expect(await paste([ph('a'), tx('c', true), tx('ende')], [])).toEqual(['a', 'v1', 'v2', 'c', 'ende'])
    expect(await paste([ph('a'), ph('b'), ph('d'), tx('c', true)], [], 'magazine')).toEqual(['a', 'b', 'd', 'v1', 'v2', 'c'])
    // the new slides are selected
    expect(store.useStore.getState().selection).toHaveLength(2)
  })

  it('with a selection: behind it, as before, also inside the credits', async () => {
    expect(await add([ph('a'), ph('b'), tx('c', true)], ['e-a'])).toEqual(['a', 'n1', 'n2', 'b', 'c'])
    expect(await add([ph('a'), tx('c1', true), tx('c2', true)], ['c1'])).toEqual(['a', 'c1', 'n1', 'n2', 'c2'])
    expect(await paste([ph('a'), ph('b'), tx('c', true)], ['e-a'])).toEqual(['a', 'v1', 'v2', 'b', 'c'])
    expect(await paste([ph('a'), tx('c1', true), tx('c2', true)], ['c1'])).toEqual(['a', 'c1', 'v1', 'v2', 'c2'])
    expect(await paste([ph('a'), tx('c', true)], ['c'])).toEqual(['a', 'c', 'v1', 'v2'])
  })
})
