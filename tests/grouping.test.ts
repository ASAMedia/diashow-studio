import { beforeAll, describe, expect, it } from 'vitest'
import { buildTimeline } from '@shared/timeline'
import { buildAudioPlan, audibleClips } from '@shared/audioPlan'
import { DEFAULT_SETTINGS, type Entry, type MediaItem, type Project } from '@shared/types'
import { showsWhole } from '../src/renderer/src/engine/draw'
import { addMissingDayTitles, autoGroup, hasDateTitles, insertByTime, isFixed, sortByDate, splitSlide } from '../src/renderer/src/entryEdits'
import { insertEntries } from '../src/renderer/src/insertAt'
import { localeTag } from '../src/renderer/src/i18n'

// the store saves through window.api; a stub is enough here
;(globalThis as unknown as { window: unknown }).window = { api: { saveProject: async () => {} } }
let useStore: typeof import('../src/renderer/src/store').useStore
beforeAll(async () => {
  useStore = (await import('../src/renderer/src/store')).useStore
})

const photo = (id: string): MediaItem => ({
  id, path: `C:\\p\\${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: 4000, height: 3000,
  captureTime: 0, status: 'ready', display: `C:\\c\\${id}.jpg`
})
const video = (id: string, duration: number): MediaItem => ({
  id, path: `C:\\p\\${id}.mp4`, name: `${id}.mp4`, kind: 'video', format: 'H.264', width: 1920, height: 1080,
  duration, hasAudio: true, captureTime: 0, status: 'ready', playback: `C:\\p\\${id}.mp4`, audio: `C:\\c\\${id}.m4a`
})

function project(entries: Entry[], media: MediaItem[], patch: Partial<Project['settings']> = {}): Project {
  return { version: 1, id: 'p', name: 'Test', createdAt: 0, updatedAt: 0, entries, media, music: [], settings: { ...DEFAULT_SETTINGS, showTitle: false, ...patch } }
}
const sizes = (p: Project): number[] => buildTimeline(p).slides.map((s) => s.entries.length)

describe('videos in Magazine grids', () => {
  const media = [video('v1', 6), video('v2', 9), photo('a'), photo('b')]
  const entries: Entry[] = [
    { id: 'e1', type: 'video', mediaId: 'v1' },
    { id: 'e2', type: 'video', mediaId: 'v2', groupBreak: 'join' },
    { id: 'e3', type: 'photo', mediaId: 'a', groupBreak: 'join' },
    { id: 'e4', type: 'photo', mediaId: 'b', groupBreak: 'force' }
  ]
  it('puts several videos on one slide that lasts as long as the longest clip', () => {
    const tl = buildTimeline(project(entries, media, { theme: 'magazine' }))
    const grid = tl.slides[0]
    expect(grid.kind).toBe('photos')
    expect(grid.entries).toHaveLength(3)
    expect(grid.duration).toBeGreaterThanOrEqual(9)
    expect(grid.clips?.filter(Boolean)).toHaveLength(2)
    // other themes keep videos on their own slides
    expect(buildTimeline(project(entries, media, { theme: 'origami' })).slides[0].entries).toHaveLength(1)
  })

  it('plays the sound of the first video only, unless another one is switched on', () => {
    const p = project(entries, media, { theme: 'magazine' })
    const tl = buildTimeline(p)
    expect(audibleClips(tl.slides[0]).map((c) => c.entry.id)).toEqual([tl.slides[0].entries.find((e) => e.type === 'video')!.id])
    const both = entries.map((e) => (e.type === 'video' ? { ...e, muted: false } : e))
    const pb = project(both, media, { theme: 'magazine' })
    const plan = buildAudioPlan(pb, buildTimeline(pb))
    expect(plan.clips.filter((c) => c.kind === 'video')).toHaveLength(2)
  })
})

describe('uniform transitions', () => {
  it('keeps the same transition length on short slides', () => {
    const media = Array.from({ length: 12 }, (_, i) => photo(`p${i}`))
    const entries: Entry[] = media.map((m) => ({ id: m.id, type: 'photo', mediaId: m.id }))
    const tl = buildTimeline(project(entries, media, { timing: { mode: 'custom', customTotal: 10 } }))
    const t = tl.slides.slice(1).map((s) => s.transIn)
    expect(new Set(t.map((x) => x.toFixed(3))).size).toBe(1)
    expect(t[0]).toBeCloseTo(1.4, 6)
  })
})

describe('slide grouping actions', () => {
  const media = ['a', 'b', 'c', 'd', 'e', 'f'].map(photo)
  const base = (): Entry[] => media.map((m) => ({ id: m.id, type: 'photo', mediaId: m.id, groupBreak: 'force' as const }))
  const load = (entries: Entry[]): void => useStore.setState({ project: project(entries, media, { theme: 'magazine' }) })
  const p = (): Project => useStore.getState().project!

  it('combines chosen items into one slide', () => {
    load(base())
    useStore.getState().mergeEntries(['b', 'e'])
    expect(p().entries.map((e) => e.id)).toEqual(['a', 'b', 'e', 'c', 'd', 'f'])
    expect(sizes(p())).toEqual([1, 2, 1, 1, 1])
  })

  it('grows, shrinks and releases items', () => {
    load(base())
    useStore.getState().resizeSlide(['a'], 1)
    useStore.getState().resizeSlide(['a', 'b'], 1)
    expect(sizes(p())[0]).toBe(3)
    useStore.getState().resizeSlide(['a', 'b', 'c'], -1)
    expect(sizes(p())[0]).toBe(2)
    useStore.getState().mergeEntries(['a', 'b', 'c', 'd'])
    useStore.getState().releaseEntry(['a', 'b', 'c', 'd'], 'b')
    expect(p().entries.map((e) => e.id).slice(0, 4)).toEqual(['a', 'c', 'd', 'b'])
    expect(sizes(p()).slice(0, 2)).toEqual([3, 1])
    useStore.getState().splitSlide(['a', 'c', 'd'])
    expect(sizes(p()).slice(0, 3)).toEqual([1, 1, 1])
  })
})

describe('crop or whole picture', () => {
  const st = DEFAULT_SETTINGS
  it('follows the entry, then the show setting; videos decide by shape', () => {
    const photoE: Entry = { id: 'a', type: 'photo', mediaId: 'a' }
    expect(showsWhole(photoE, st, 0.75, 1.78)).toBe(false)
    expect(showsWhole(photoE, { ...st, scaleToFill: false }, 0.75, 1.78)).toBe(true)
    expect(showsWhole({ ...photoE, whole: true }, st, 0.75, 1.78)).toBe(true)
    expect(showsWhole({ ...photoE, whole: false }, { ...st, scaleToFill: false }, 0.75, 1.78)).toBe(false)
    const videoE: Entry = { id: 'v', type: 'video', mediaId: 'v' }
    expect(showsWhole(videoE, st, 1.78, 1.78)).toBe(false)
    expect(showsWhole(videoE, st, 0.56, 1.78)).toBe(true)
    expect(showsWhole({ ...videoE, whole: false }, st, 0.56, 1.78)).toBe(false)
  })
})

describe('undo, durations and day titles', () => {
  const day = (d: number, h = 10): number => new Date(2026, 1, d, h).getTime()
  const media = [
    { ...photo('a'), captureTime: day(14), path: 'D:/Ski/1_Samstag Lange Fahrt/a.jpg' },
    { ...photo('b'), captureTime: day(15), path: 'D:/Ski/2_Sonntag Unser erster Tag/b.jpg' },
    { ...photo('c'), captureTime: day(15, 14), path: 'D:/Ski/2_Sonntag Unser erster Tag/c.jpg' },
    // a messenger photo with a wrong date, and a loose file in the top folder
    { ...photo('d'), captureTime: day(13), path: 'D:/Ski/2_Sonntag Unser erster Tag/d.jpg' },
    { ...photo('e'), captureTime: day(12), path: 'D:/Ski/film.jpg' }
  ]
  const entries = (): Entry[] => media.map((m) => ({ id: m.id, type: 'photo', mediaId: m.id }))
  const load = (): void => useStore.setState({ project: project(entries(), media, { theme: 'magazine' }) })
  const p = (): Project => useStore.getState().project!

  it('undoes and redoes, with slider moves as one step', () => {
    load()
    const s = useStore.getState()
    s.setSettings({ look: 'warm' })
    s.setSettings({ timing: { mode: 'custom', customTotal: 30 } })
    s.setSettings({ timing: { mode: 'custom', customTotal: 31 } })
    s.setSettings({ timing: { mode: 'custom', customTotal: 32 } })
    useStore.getState().undo()
    expect(p().settings.timing.mode).toBe('fitToMusic')
    expect(p().settings.look).toBe('warm')
    useStore.getState().redo()
    expect(p().settings.timing.customTotal).toBe(32)
  })

  it('sets a slide time and inserts day titles from dates or folders', () => {
    load()
    useStore.getState().setSlideDuration(['a'], 7.04)
    expect(p().entries[0].duration).toBe(7)
    useStore.getState().insertDayTitles('folder')
    const titles = p().entries.filter((e) => e.type === 'text') as { title: string; subtitle?: string }[]
    expect(titles.map((t) => [t.title, t.subtitle])).toEqual([['Samstag', 'Lange Fahrt'], ['Sonntag', 'Unser erster Tag']])
    // grouped by folder: e (top folder, no chapter), a, then b c d
    expect(p().entries.filter((e) => e.type !== 'text').map((e) => e.id)).toEqual(['e', 'a', 'b', 'c', 'd'])
    useStore.getState().insertDayTitles('date')
    expect(p().entries.filter((e) => e.type === 'text')).toHaveLength(4)
    useStore.getState().removeAutoTitles()
    expect(p().entries.some((e) => e.type === 'text')).toBe(false)
  })

  it('sorts by capture date, text slides staying with the photo after them', () => {
    const text = (id: string): Entry => ({ id, type: 'text', title: id })
    const [a, b, c, d] = entries()
    useStore.setState({ project: project([text('t1'), a, b, c, text('t2'), d, text('end')], media) })
    useStore.getState().sortByDate()
    expect(p().entries.map((e) => e.id)).toEqual(['t2', 'd', 't1', 'a', 'b', 'c', 'end'])
  })
})

describe('uploads sorted into their day', () => {
  const at = (d: number, h: number): number => new Date(2026, 1, d, h).getTime()
  const media = new Map(
    [
      { ...photo('mo1'), captureTime: at(16, 9) },
      { ...photo('mo2'), captureTime: at(16, 18) },
      { ...photo('di1'), captureTime: at(17, 9) },
      { ...photo('new-mo'), captureTime: at(16, 20) },
      { ...photo('new-di'), captureTime: at(17, 7) },
      { ...photo('new-mi'), captureTime: at(18, 12) },
      { ...photo('undated'), captureTime: 0 }
    ].map((m) => [m.id, m])
  )
  const ph = (id: string): Entry => ({ id, type: 'photo', mediaId: id })
  const title = (id: string, d: number): Entry => ({
    id, type: 'text', auto: 'day',
    title: new Intl.DateTimeFormat(localeTag(), { weekday: 'long' }).format(at(d, 9)),
    subtitle: new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'long', year: 'numeric' }).format(at(d, 9))
  })
  const show: Entry[] = [title('tMo', 16), ph('mo1'), ph('mo2'), title('tDi', 17), ph('di1'), { id: 'credits', type: 'text', title: 'Danke', titleStyle: 'credits' }]

  it('puts each item in time order inside its own day, before closing credits', () => {
    const out = insertByTime(show, [ph('new-di'), ph('new-mo'), ph('undated'), ph('new-mi')], media)
    expect(out.map((e) => e.id)).toEqual(['tMo', 'mo1', 'mo2', 'new-mo', 'tDi', 'new-di', 'di1', 'new-mi', 'undated', 'credits'])
  })

  it('adds a date title for a new day when the show has date titles', () => {
    expect(hasDateTitles(show, media)).toBe(true)
    expect(hasDateTitles([{ id: 'x', type: 'text', auto: 'day', title: 'Sonntag', subtitle: 'Unser erster Tag' }, ph('mo1')], media)).toBe(false)
    const out = addMissingDayTitles(insertByTime(show, [ph('new-mi')], media), media)
    const ids = out.map((e) => e.id)
    expect(ids.slice(0, 5)).toEqual(['tMo', 'mo1', 'mo2', 'tDi', 'di1'])
    const added = out[5] as { type: string; auto?: string; subtitle?: string }
    expect(added).toMatchObject({ type: 'text', auto: 'day' })
    expect(added.subtitle).toBe(new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'long', year: 'numeric' }).format(at(18, 12)))
    expect(ids.slice(6)).toEqual(['new-mi', 'credits'])
  })
})

describe('grouping automatically again', () => {
  // twelve landscape photos, newest first, so sorting reverses them
  const media = Array.from({ length: 12 }, (_, i) => ({ ...photo(`m${i}`), captureTime: 1000 * (12 - i) }))
  const fresh = (): Entry[] => media.map((m, i) => ({ id: `e${i}`, type: 'photo', mediaId: m.id }))
  const ids = (p: Project): string[][] => buildTimeline(p).slides.map((s) => s.entries.map((e) => e.id))
  const allSingle = (): Project => {
    const p = project(fresh(), media, { theme: 'magazine' })
    splitSlide(p, p.entries.map((e) => e.id))
    expect(sizes(p)).toEqual(Array(12).fill(1))
    return p
  }

  it('the whole show: as if nothing had been fixed by hand', () => {
    const p = allSingle()
    autoGroup(p)
    expect(sizes(p)).toEqual(sizes(project(fresh(), media, { theme: 'magazine' })))
    expect(p.entries.some(isFixed)).toBe(false)
  })

  it('selected slides: they are grouped again among themselves, the slides around them stay', () => {
    const p = allSingle()
    autoGroup(p, ['e3', 'e4', 'e5', 'e6', 'e7', 'e8'])
    const slides = ids(p)
    expect(slides.slice(0, 3)).toEqual([['e0'], ['e1'], ['e2']])
    expect(slides.slice(-3)).toEqual([['e9'], ['e10'], ['e11']])
    const inner = slides.slice(3, -3)
    expect(inner.flat()).toEqual(['e3', 'e4', 'e5', 'e6', 'e7', 'e8'])
    expect(inner.length).toBeLessThan(6)
    // two separate runs keep their own edges too
    const q = allSingle()
    autoGroup(q, ['e1', 'e2', 'e6', 'e7', 'e8'])
    const runs = ids(q)
    expect(runs.find((s) => s.includes('e0'))).toEqual(['e0'])
    for (const k of ['e3', 'e4', 'e5', 'e9', 'e10', 'e11']) expect(runs.find((s) => s.includes(k))).toEqual([k])
    expect(runs.find((s) => s.includes('e1'))).toEqual(['e1', 'e2'])
  })

  it('photos inserted between slides keep the others fixed, until the show is grouped again', () => {
    const p = project(fresh(), media, { theme: 'magazine' })
    const before = ids(p)
    const added: Entry[] = [{ id: 'n1', type: 'photo', mediaId: 'm0' }]
    insertEntries(p, added, before[1][0], buildTimeline(p))
    expect(ids(p).filter((s) => !s.includes('n1'))).toEqual(before)
    autoGroup(p)
    expect(ids(p).filter((s) => !s.includes('n1'))).not.toEqual(before)
  })

  it('sorting by capture date groups the photos again', () => {
    const p = allSingle()
    sortByDate(p)
    expect(p.entries.map((e) => e.id)).toEqual(fresh().map((e) => e.id).reverse())
    expect(p.entries.some(isFixed)).toBe(false)
    expect(sizes(p)).toEqual(sizes(project(fresh(), media, { theme: 'magazine' })))
  })
})