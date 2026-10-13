// The filmstrip's zoom (time ↔ x, shared with the audio lane), its search (date words and matching)
// and where inserted photos go (insertion index and grouping in multi-photo themes).
import { describe, expect, it } from 'vitest'
import { buildTimeline, type Timeline } from '@shared/timeline'
import { DEFAULT_SETTINGS, type Entry, type MediaItem, type Project, type Rect } from '@shared/types'
import {
  anchoredScroll, CARD, cardToSlider, fitCard, MAX_CARD, MIN_CARD, numberEvery, sliderToCard, STEP, stripScale, stripWidth, timeToX, xToTime, zoomStep
} from '../src/renderer/src/components/stripScale'
import { dateMatches, fold, kindOf, monthOf, parseQuery, searchSlides, weekdayOf } from '../src/renderer/src/search'
import { anchorAt, canJoin, insertEntries, insertInto } from '../src/renderer/src/insertAt'

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
    for (const card of [MIN_CARD, 20, 57, CARD, MAX_CARD]) {
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

  it('fits the whole show, or as close as the smallest cards allow', () => {
    const c = fitCard(200, 1800)
    expect(stripWidth(200, stripScale(c))).toBeLessThanOrEqual(1800)
    expect(stripWidth(200, stripScale(c + 1))).toBeGreaterThan(1800)
    expect(fitCard(400, 1800)).toBe(MIN_CARD)
    expect(fitCard(5, 1800)).toBe(MAX_CARD)
    expect(fitCard(5000, 1000)).toBe(MIN_CARD)
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
    // a panorama stays alone on its slide
    expect(canJoin({ ...first, pano: { axis: 'x', mode: 'pan', reverse: false } }, [{ kind: 'photo' }], p.settings)).toBe(false)
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
