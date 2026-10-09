import { describe, expect, it } from 'vitest'
import { buildTimeline, slidesAt } from '@shared/timeline'
import { buildAudioPlan, duckIntervals, gainAt } from '@shared/audioPlan'
import { groupEntries, pickTemplate } from '@shared/layout'
import { DEFAULT_SETTINGS, type Entry, type MediaItem, type MusicTrack, type Project } from '@shared/types'

const photo = (id: string, w = 4000, h = 3000): MediaItem => ({
  id, path: `C:\\p\\${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: w, height: h,
  captureTime: Date.UTC(2026, 6, 12), status: 'ready', display: `C:\\c\\${id}.jpg`
})
const video = (id: string, duration: number, hasAudio = true): MediaItem => ({
  id, path: `C:\\p\\${id}.mp4`, name: `${id}.mp4`, kind: 'video', format: 'H.264', width: 1920, height: 1080,
  duration, hasAudio, captureTime: Date.UTC(2026, 6, 13), status: 'ready', playback: `C:\\p\\${id}.mp4`, audio: `C:\\c\\${id}.m4a`
})
const track = (id: string, duration: number): MusicTrack => ({ id, path: `C:\\m\\${id}.mp3`, title: id, duration, status: 'ready', playback: `C:\\m\\${id}.mp3` })

function project(entries: Entry[], media: MediaItem[], music: MusicTrack[] = [], patch: Partial<Project['settings']> = {}): Project {
  return {
    version: 1, id: 'p', name: 'Kroatien', createdAt: 0, updatedAt: 0, entries, media, music,
    settings: { ...DEFAULT_SETTINGS, showTitle: false, ...patch }
  }
}

describe('timeline', () => {
  const media = [photo('a'), photo('b'), photo('c'), video('v', 8)]
  const entries: Entry[] = [
    { id: 'e1', type: 'photo', mediaId: 'a' },
    { id: 'e2', type: 'photo', mediaId: 'b' },
    { id: 'e3', type: 'video', mediaId: 'v' },
    { id: 'e4', type: 'photo', mediaId: 'c' }
  ]

  it('fits the show to the music length', () => {
    const tl = buildTimeline(project(entries, media, [track('s1', 40)]))
    expect(tl.slides).toHaveLength(4)
    expect(tl.duration).toBeCloseTo(40, 1)
    expect(tl.slides[2].duration).toBe(8) // full video clip
    // consecutive slides overlap by the transition
    expect(tl.slides[1].start).toBeCloseTo(tl.slides[0].start + tl.slides[0].duration - tl.slides[0].transOut, 6)
  })

  it('honours a custom total and per-slide durations', () => {
    const custom: Entry[] = entries.map((e) => (e.id === 'e1' ? { ...e, duration: 6 } : e))
    const tl = buildTimeline(project(custom, media, [], { timing: { mode: 'custom', customTotal: 30 } }))
    expect(tl.slides[0].duration).toBe(6)
    expect(tl.duration).toBeCloseTo(30, 1)
  })

  it('uses the theme default without music', () => {
    const tl = buildTimeline(project(entries, media))
    expect(tl.photoSeconds).toBe(4.5)
  })

  it('returns two slides during a transition', () => {
    const tl = buildTimeline(project(entries, media))
    const s1 = tl.slides[1]
    expect(slidesAt(tl, s1.start + 0.01).map((s) => s.id)).toEqual(['e1', 'e2'])
  })

  it('adds a title slide or overlay depending on the theme', () => {
    const kb = buildTimeline(project(entries, media, [], { showTitle: true }))
    expect(kb.slides[0].titleOverlay).toBe(true)
    expect(kb.slides[0].title?.text).toBe('Kroatien')
    const origami = buildTimeline(project(entries, media, [], { showTitle: true, theme: 'origami' }))
    expect(origami.slides[0].kind).toBe('title')
  })
})

describe('grouping', () => {
  const es: Entry[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((m) => ({ id: m, type: 'photo', mediaId: m }))
  it('follows the theme pattern and respects breaks', () => {
    expect(groupEntries(es, 'origami').map((g) => g.entries.length)).toEqual([1, 2, 3, 1])
    const forced = es.map((e) => (e.id === 'c' ? { ...e, groupBreak: 'force' as const } : e))
    expect(groupEntries(forced, 'origami').map((g) => g.entries.length)).toEqual([1, 1, 3, 1, 1])
    expect(groupEntries(es, 'kenburns')).toHaveLength(7)
  })
  it('puts two portrait photos side by side', () => {
    expect(pickTemplate([0.75, 0.75], 16 / 9).template.id).toBe('halves')
    expect(pickTemplate([1.5, 1.5], 9 / 16).template.id).toBe('rows')
  })
})

describe('magazine', () => {
  const portrait = (id: string): MediaItem => photo(id, 3000, 4000)
  it('turns a text slide into a caption on the next slide', () => {
    const media = [photo('a'), photo('b'), photo('c')]
    const entries: Entry[] = [
      { id: 'e1', type: 'photo', mediaId: 'a' },
      { id: 't1', type: 'text', title: 'Sonntag', subtitle: 'Unser erster Tag' },
      { id: 'e2', type: 'photo', mediaId: 'b' },
      { id: 'e3', type: 'photo', mediaId: 'c' }
    ]
    const tl = buildTimeline(project(entries, media, [], { theme: 'magazine' }))
    expect(tl.slides.every((s) => s.kind === 'photos')).toBe(true)
    const withCaption = tl.slides.find((s) => s.caption)!
    expect(withCaption.caption).toEqual({ text: 'Sonntag', subtitle: 'Unser erster Tag' })
    expect(withCaption.captionEntryId).toBe('t1')
    // other themes keep it as a slide of its own
    expect(buildTimeline(project(entries, media)).slides.some((s) => s.kind === 'text')).toBe(true)
  })

  it('pairs a lone portrait and fills every slide with a template', () => {
    const media = [portrait('a'), photo('b'), photo('c')]
    const entries: Entry[] = media.map((m, i) => ({ id: `e${i}`, type: 'photo', mediaId: m.id }))
    const tl = buildTimeline(project(entries, media, [], { theme: 'magazine', showTitle: false }))
    expect(tl.slides[0].entries).toHaveLength(2)
    expect(tl.slides.every((s) => s.template && s.template.slots.length === s.entries.length)).toBe(true)
  })

  it('moves photos into the cells that fit them and honours a chosen layout', () => {
    const media = [photo('w1'), portrait('p1'), photo('w2')]
    const entries: Entry[] = media.map((m, i) => ({ id: `e${i}`, type: 'photo', mediaId: m.id, groupBreak: i ? 'join' : undefined }))
    const auto = buildTimeline(project(entries, media, [], { theme: 'magazine' })).slides[0]
    expect(auto.entries).toHaveLength(3)
    const forced = entries.map((e, i) => (i === 0 ? { ...e, layout: 'm3-cols' } : e))
    expect(buildTimeline(project(forced, media, [], { theme: 'magazine' })).slides[0].template?.id).toBe('m3-cols')
  })
})

describe('audio plan', () => {
  const media = [photo('a'), video('v', 10), photo('b')]
  const entries: Entry[] = [
    { id: 'e1', type: 'photo', mediaId: 'a' },
    { id: 'e2', type: 'video', mediaId: 'v' },
    { id: 'e3', type: 'photo', mediaId: 'b' }
  ]
  it('ducks the music while a video with sound plays', () => {
    const p = project(entries, media, [track('s1', 60)], { timing: { mode: 'custom', customTotal: 30 } })
    const tl = buildTimeline(p)
    const plan = buildAudioPlan(p, tl)
    const music = plan.clips.find((c) => c.kind === 'music')!
    const v = tl.slides[1]
    const mid = v.start + v.duration / 2
    expect(gainAt(music.gain, mid)).toBeCloseTo(0.8 * 0.2, 3)
    expect(gainAt(music.gain, tl.slides[0].start + 2)).toBeCloseTo(0.8, 3)
    const clip = plan.clips.find((c) => c.kind === 'video')!
    expect(clip.offset).toBe(0)
    expect(gainAt(clip.gain, mid)).toBe(1)
    // fade out at the end of the show
    expect(gainAt(music.gain, tl.duration)).toBeCloseTo(0, 6)
  })

  it('skips ducking for muted clips and when disabled', () => {
    const muted = entries.map((e) => (e.type === 'video' ? { ...e, muted: true } : e))
    const p1 = project(muted, media, [track('s1', 60)])
    expect(duckIntervals(p1, buildTimeline(p1))).toHaveLength(0)
    const p2 = project(entries, media, [track('s1', 60)], { audio: { ...DEFAULT_SETTINGS.audio, duck: false } })
    expect(duckIntervals(p2, buildTimeline(p2))).toHaveLength(0)
    expect(buildAudioPlan(p2, buildTimeline(p2)).clips.some((c) => c.kind === 'video')).toBe(true)
  })

  it('repeats the playlist with crossfades when the show is longer', () => {
    const p = project(entries, media, [track('s1', 12)], { timing: { mode: 'custom', customTotal: 30 } })
    const plan = buildAudioPlan(p, buildTimeline(p))
    const music = plan.clips.filter((c) => c.kind === 'music')
    expect(music.length).toBeGreaterThanOrEqual(3)
    expect(music[1].start).toBeCloseTo(12 - 2, 6)
    const last = music[music.length - 1]
    expect(last.start + last.duration).toBeCloseTo(plan.duration, 6)
  })
})

describe('beat sync and big shows', () => {
  it('puts slide changes on beats', () => {
    const media = Array.from({ length: 10 }, (_, i) => photo(`p${i}`))
    const entries: Entry[] = media.map((m) => ({ id: m.id, type: 'photo', mediaId: m.id }))
    const beatTrack = { ...track('s1', 60), beats: Array.from({ length: 120 }, (_, i) => 0.25 + i * 0.5), bpm: 120 }
    const p = project(entries, media, [beatTrack], { timing: { mode: 'fitToMusic', customTotal: 60, beatSync: true } })
    const tl = buildTimeline(p)
    for (const s of tl.slides.slice(1)) {
      const cut = s.start + s.transIn / 2
      const offBeat = Math.abs(((cut - 0.25) / 0.5) % 1)
      expect(Math.min(offBeat, 1 - offBeat)).toBeLessThan(1e-6)
    }
    expect(tl.duration).toBeGreaterThan(55)
    expect(tl.duration).toBeLessThan(65)
  })

  it('builds the timeline of 1500 items quickly', () => {
    const media = Array.from({ length: 1500 }, (_, i) => photo(`p${i}`, i % 3 ? 4000 : 3000, i % 3 ? 3000 : 4000))
    const entries: Entry[] = media.map((m) => ({ id: m.id, type: 'photo', mediaId: m.id }))
    const p = project(entries, media, [], { theme: 'magazine' })
    buildTimeline(p)
    const t0 = performance.now()
    const tl = buildTimeline({ ...p, entries: [...p.entries] })
    const ms = performance.now() - t0
    expect(tl.slides.length).toBeGreaterThan(300)
    expect(ms).toBeLessThan(150)
  })
})
