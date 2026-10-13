// Live Photos as Loop and Bounce: which motion frame shows at a slide time (the Loop's seam crossfade,
// the Bounce's turns, export frame times), how long their slides last (fit to music, a total, beat
// sync), and the new field in project files.
import { describe, expect, it } from 'vitest'
import { cycleSeconds, liveEffectOf, liveMinSeconds, LOOP_FADE, loopFadeFrames, motionFrame, type MotionFrame } from '@shared/livePhoto'
import { buildTimeline } from '@shared/timeline'
import { DEFAULT_SETTINGS, type Entry, type LiveEffect, type MediaItem, type MusicTrack, type PhotoEntry, type Project } from '@shared/types'
import { validateProject } from '../src/main/projectSchema'

const FPS = 30
/** A 3 s motion part at 30 fps, like the iPhone's. */
const N = 90

/** Frames shown at slots 0..count-1 (one per frame time of the clip). */
const slots = (effect: LiveEffect, count: number, n = N): MotionFrame[] => Array.from({ length: count }, (_, k) => motionFrame(effect, k / FPS, n, FPS))

describe('Loop', () => {
  const fade = loopFadeFrames(N, FPS)
  const period = N - fade

  it('crossfades about 0.4 s, at most a third of a short clip', () => {
    expect(fade).toBe(Math.round(LOOP_FADE * FPS))
    expect(loopFadeFrames(9, FPS)).toBe(3)
    expect(loopFadeFrames(2, FPS)).toBe(0)
    expect(cycleSeconds('loop', N, FPS)).toBeCloseTo(period / FPS, 9)
  })

  it('plays the first pass from the start, then every pass from the seam', () => {
    const f = slots('loop', 4 * N)
    // first pass: 0 … period-1, nothing blended
    for (let k = 0; k < period; k++) expect(f[k]).toEqual({ a: k })
    // the seam: the last frames run on, the first ones fade in over them, a frame each
    for (let j = 0; j < fade; j++) {
      const s = f[period + j]
      expect(s.a).toBe(period + j)
      expect(s.b).toBe(j)
      expect(s.w).toBeCloseTo((j + 1) / (fade + 1), 9)
    }
    // and carries on where the faded-in frames leave off
    expect(f[period + fade]).toEqual({ a: fade })
    // it repeats with the period
    for (let k = period; k < 3 * period; k++) expect(f[k + period]).toEqual(f[k])
  })

  it('shows every frame once per cycle and never jumps at the seam', () => {
    const f = slots('loop', 3 * period)
    const seen = new Map<number, number>()
    for (const s of f.slice(period, 2 * period)) for (const i of s.b != null ? [s.a, s.b] : [s.a]) seen.set(i, (seen.get(i) ?? 0) + 1)
    expect([...seen.keys()].sort((x, y) => x - y)).toEqual(Array.from({ length: N }, (_, i) => i))
    expect([...seen.values()].every((c) => c === 1)).toBe(true)
    // the frame underneath and the one fading in each advance by exactly one frame per slot,
    // and the weight rises in even steps strictly between 0 and 1
    for (let k = period + 1; k < 2 * period + fade; k++) {
      const [p, s] = [f[k - 1], f[k]]
      if (s.b != null && p.b != null) {
        expect(s.a - p.a).toBe(1)
        expect(s.b - p.b).toBe(1)
        expect(s.w! - p.w!).toBeCloseTo(1 / (fade + 1), 9)
      } else if (s.b != null) expect(s.a - p.a).toBe(1) // into the seam: the tail continues
      else if (p.b != null) expect(s.a - p.b).toBe(1) // out of it: the start continues
      else expect(s.a - p.a).toBe(1)
    }
    expect(f.every((s) => s.w == null || (s.w > 0 && s.w < 1))).toBe(true)
  })

  it('handles tiny clips', () => {
    expect(motionFrame('loop', 5, 1, FPS)).toEqual({ a: 0 })
    expect(slots('loop', 5, 2).map((s) => s.a)).toEqual([0, 1, 0, 1, 0])
    expect(motionFrame('loop', 1, 0, FPS)).toEqual({ a: 0 })
  })
})

describe('Bounce', () => {
  it('goes forward and backward, showing each end once per turn', () => {
    expect(slots('bounce', 13, 5).map((s) => s.a)).toEqual([0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4])
    const f = slots('bounce', 5 * N).map((s) => s.a)
    // no stutter: every slot moves exactly one frame
    for (let k = 1; k < f.length; k++) expect(Math.abs(f[k] - f[k - 1])).toBe(1)
    expect(Math.max(...f)).toBe(N - 1)
    expect(Math.min(...f)).toBe(0)
    expect(cycleSeconds('bounce', N, FPS)).toBeCloseTo((2 * (N - 1)) / FPS, 9)
    expect(slots('bounce', 4, 2).map((s) => s.a)).toEqual([0, 1, 0, 1])
  })
})

describe('export frame times', () => {
  // an export renders frame j at j / fps; the slide starts anywhere (and its start carries float noise)
  for (const start of [4, 4.0123, 0.1 + 0.2, 7 / 3, 1e3 / 3]) {
    it(`gives the slide's j-th exported frame the j-th frame slot (slide at ${start.toFixed(4)} s)`, () => {
      const first = Math.ceil(start * FPS - 1e-9)
      for (const effect of ['loop', 'bounce'] as const) {
        const shown = Array.from({ length: 3 * N }, (_, j) => motionFrame(effect, (first + j) / FPS - start, N, FPS))
        // no frame repeated or skipped, whatever the rounding of the frame times
        expect(shown).toEqual(slots(effect, 3 * N))
      }
    })
  }
  it('shows a 30 fps clip at 60 fps twice per frame, in the same order', () => {
    const at60 = Array.from({ length: 2 * N }, (_, j) => motionFrame('bounce', j / 60, N, FPS).a)
    const at30 = Array.from({ length: N }, (_, j) => motionFrame('bounce', j / 30, N, FPS).a)
    expect(at60.filter((_, j) => j % 2 === 0)).toEqual(at30)
    expect(at60.filter((_, j) => j % 2 === 1)).toEqual(at30)
  })
})

// ---------------------------------------------------------------- slides

const photo = (id: string): MediaItem => ({ id, path: `C:\\p\\${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: 4000, height: 3000, captureTime: 0, status: 'ready', display: `C:\\c\\${id}.jpg` })
const livePhoto = (id: string, duration = 3): MediaItem => ({ ...photo(id), format: 'HEIC', live: { source: `C:\\p\\${id}.mov`, duration }, liveVideo: `C:\\c\\${id}\\live.mp4` })
const track = (id: string, duration: number): MusicTrack => ({ id, path: `C:\\m\\${id}.mp3`, title: id, duration, status: 'ready', playback: `C:\\m\\${id}.mp3` })

function show(live: Partial<PhotoEntry>, patch: Partial<Project['settings']> = {}, music: MusicTrack[] = [], motion = 3): Project {
  const media = [photo('a'), livePhoto('l', motion), photo('b'), photo('c')]
  const entries: Entry[] = [
    { id: 'ea', type: 'photo', mediaId: 'a' },
    { id: 'el', type: 'photo', mediaId: 'l', ...live },
    { id: 'eb', type: 'photo', mediaId: 'b' },
    { id: 'ec', type: 'photo', mediaId: 'c' }
  ]
  return { version: 1, id: 'p', name: 'Live', createdAt: 0, updatedAt: 0, entries, media, music, settings: { ...DEFAULT_SETTINGS, showTitle: false, ...patch } }
}
const liveSlide = (p: Project) => buildTimeline(p).slides.find((s) => s.entries.some((e) => e.id === 'el'))!

describe('Loop and Bounce slides', () => {
  it('carry the effect only while the motion plays', () => {
    expect(liveSlide(show({ playLive: true, liveEffect: 'loop' })).live).toEqual({ duration: 3, effect: 'loop' })
    expect(liveSlide(show({ playLive: true, liveEffect: 'bounce' })).live).toEqual({ duration: 3, effect: 'bounce' })
    expect(liveSlide(show({ playLive: true })).live).toEqual({ duration: 3 })
    expect(liveSlide(show({ playLive: false, liveEffect: 'loop' })).live).toBeUndefined()
    // the show's default plays the motion: the photo's effect applies
    expect(liveSlide(show({ liveEffect: 'loop' }, { playLivePhotos: true })).live?.effect).toBe('loop')
    // an effect of a newer version plays once
    expect(liveSlide(show({ playLive: true, liveEffect: 'longExposure' as LiveEffect })).live).toEqual({ duration: 3 })
    expect(liveEffectOf({ id: 'x', type: 'photo', mediaId: 'l', liveEffect: 'longExposure' as LiveEffect })).toBeUndefined()
  })

  it('last like a photo, but at least one cycle; a time of their own wins', () => {
    const normal = buildTimeline(show({})).photoSeconds
    expect(liveMinSeconds(3, 'loop')).toBe(3)
    expect(liveMinSeconds(3, 'bounce')).toBe(6)
    expect(liveMinSeconds(3)).toBeCloseTo(3.8, 9)
    expect(liveSlide(show({ playLive: true, liveEffect: 'loop' })).duration).toBeCloseTo(normal, 6)
    expect(liveSlide(show({ playLive: true, liveEffect: 'bounce' })).duration).toBeCloseTo(Math.max(normal, 6), 6)
    expect(liveSlide(show({ playLive: true, liveEffect: 'loop' }, {}, [], 6)).duration).toBeCloseTo(6, 6)
    expect(liveSlide(show({ playLive: true, liveEffect: 'bounce', duration: 2 })).duration).toBe(2)
  })

  it('stay alone on their slide in grid themes', () => {
    for (const liveEffect of ['loop', 'bounce'] as const) {
      const tl = buildTimeline(show({ playLive: true, liveEffect }, { theme: 'magazine' }))
      expect(liveSlide(show({ playLive: true, liveEffect }, { theme: 'magazine' })).entries).toHaveLength(1)
      expect(tl.slides.some((s) => s.entries.length > 1)).toBe(true)
    }
  })

  it('keep "fit to music", a total and beat sync exact', () => {
    for (const liveEffect of ['loop', 'bounce'] as const) {
      const fit = buildTimeline(show({ playLive: true, liveEffect }, { timing: { mode: 'fitToMusic', customTotal: 60 } }, [track('s', 40)]))
      expect(fit.duration).toBeCloseTo(40, 2)
      const total = buildTimeline(show({ playLive: true, liveEffect }, { timing: { mode: 'custom', customTotal: 13 } }))
      expect(total.duration).toBeCloseTo(13, 2)
      // a short total: the bounce keeps its cycle, the photos give way
      const short = buildTimeline(show({ playLive: true, liveEffect: 'bounce' }, { timing: { mode: 'custom', customTotal: 10 } }))
      expect(short.slides.find((s) => s.live)!.duration).toBeGreaterThanOrEqual(6 - 1e-9)
      const beats = { ...track('b', 60), beats: Array.from({ length: 120 }, (_, i) => 0.25 + i * 0.5), bpm: 120 }
      const synced = buildTimeline(show({ playLive: true, liveEffect }, { timing: { mode: 'fitToMusic', customTotal: 60, beatSync: true } }, [beats]))
      for (const s of synced.slides.slice(1)) {
        const off = Math.abs(((s.start + s.transIn / 2 - 0.25) / 0.5) % 1)
        expect(Math.min(off, 1 - off)).toBeLessThan(1e-6)
      }
    }
  })
})

// ---------------------------------------------------------------- project files

describe('project files', () => {
  const file = (liveEffect?: unknown): Project => {
    const p = show({ playLive: true })
    if (liveEffect !== undefined) (p.entries[1] as unknown as Record<string, unknown>).liveEffect = liveEffect
    return p
  }

  it('keeps Loop and Bounce, and opens older files unchanged', () => {
    for (const v of ['loop', 'bounce']) {
      const { project, report } = validateProject(file(v))
      expect(report.changes).toEqual([])
      expect((project.entries[1] as PhotoEntry).liveEffect).toBe(v)
    }
    const old = file()
    const { project, report } = validateProject(old)
    expect(report.changes).toEqual([])
    expect(project.entries).toEqual(old.entries)
  })

  it('keeps an effect of a newer version (it plays once here) and drops nonsense', () => {
    const newer = validateProject(file('longExposure'))
    expect(newer.report.changes).toEqual([])
    expect((newer.project.entries[1] as PhotoEntry).liveEffect).toBe('longExposure')
    expect(liveSlide(newer.project).live).toEqual({ duration: 3 })
    for (const bad of [5, true, '', { loop: 1 }]) {
      const { project, report } = validateProject(file(bad))
      expect(report.changes).toEqual([{ code: 'entriesRepaired', count: 1 }])
      expect('liveEffect' in project.entries[1]).toBe(false)
      expect((project.entries[1] as PhotoEntry).playLive).toBe(true)
    }
  })
})
