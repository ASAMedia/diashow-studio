import { beforeAll, describe, expect, it } from 'vitest'
import { buildTimeline } from '@shared/timeline'
import { buildAudioPlan, audibleClips } from '@shared/audioPlan'
import { DEFAULT_SETTINGS, type Entry, type MediaItem, type Project } from '@shared/types'
import { showsWhole } from '../src/renderer/src/engine/draw'

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
    { ...photo('c'), captureTime: day(15, 14), path: 'D:/Ski/2_Sonntag Unser erster Tag/c.jpg' }
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
    useStore.getState().insertDayTitles('date')
    expect(p().entries.filter((e) => e.type === 'text')).toHaveLength(2)
    useStore.getState().removeAutoTitles()
    expect(p().entries.some((e) => e.type === 'text')).toBe(false)
  })
})
