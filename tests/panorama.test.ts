// Panoramas pan across their slide (shared/panorama.ts): which photos count, the pan's path and
// speed, the longer default time, and that a panorama always keeps a slide of its own. (Their
// default Ken Burns framing is tested with the engine's framing in editFraming.test.ts.)
import { describe, expect, it } from 'vitest'
import { buildTimeline } from '@shared/timeline'
import { panEase, panFrames, panoMode, panoramaAxis, panoramaOf, panoWindow, panRamp, panTimeFactor, panUv, PANO_MAX_TIME } from '@shared/panorama'
import { DEFAULT_SETTINGS, type Entry, type MediaItem, type MusicTrack, type Project, type ThemeId } from '@shared/types'

const photo = (id: string, w = 4000, h = 3000): MediaItem => ({
  id, path: `C:\\p\\${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: w, height: h,
  captureTime: Date.UTC(2026, 6, 12), status: 'ready', display: `C:\\c\\${id}.jpg`
})
const track = (id: string, duration: number): MusicTrack => ({ id, path: `C:\\m\\${id}.mp3`, title: id, duration, status: 'ready', playback: `C:\\m\\${id}.mp3` })

function project(entries: Entry[], media: MediaItem[], music: MusicTrack[] = [], patch: Partial<Project['settings']> = {}): Project {
  return { version: 1, id: 'p', name: 'Alpen', createdAt: 0, updatedAt: 0, entries, media, music, settings: { ...DEFAULT_SETTINGS, showTitle: false, ...patch } }
}

const R169 = 16 / 9
const R43 = 4 / 3
const R916 = 9 / 16

describe('which photos are panoramas', () => {
  it('needs 2:1 and 1.4× the output shape (16:9, 4:3, 1:1, 9:16)', () => {
    // 16:9: from about 2.49:1 on
    expect(panoramaAxis(2.2, R169)).toBeNull()
    expect(panoramaAxis(2.45, R169)).toBeNull()
    expect(panoramaAxis(2.5, R169)).toBe('x')
    expect(panoramaAxis(4, R169)).toBe('x')
    expect(panoramaAxis(8, R169)).toBe('x')
    // 4:3 and 1:1: 2:1 is enough
    expect(panoramaAxis(1.9, R43)).toBeNull()
    expect(panoramaAxis(2, R43)).toBe('x')
    expect(panoramaAxis(1.9, 1)).toBeNull()
    expect(panoramaAxis(2, 1)).toBe('x')
    // 9:16: a 3:2 photo is no panorama, 2:1 is
    expect(panoramaAxis(1.5, R916)).toBeNull()
    expect(panoramaAxis(2, R916)).toBe('x')
    // ordinary shapes never are
    for (const frame of [R169, R43, 1, R916]) for (const a of [1, 4 / 3, 3 / 2, 16 / 9, 3 / 4, 2 / 3]) expect(panoramaAxis(a, frame)).toBeNull()
  })

  it('counts tall panoramas the same way round', () => {
    expect(panoramaAxis(0.56, R169)).toBeNull()
    expect(panoramaAxis(0.5, R169)).toBe('y')
    expect(panoramaAxis(0.25, R169)).toBe('y')
    expect(panoramaAxis(0.5, R43)).toBe('y')
    expect(panoramaAxis(0.5, 1)).toBe('y')
    // a phone screenshot in a 9:16 show is no panorama; 1:2 isn't either (only an eighth cropped), 1:2.5 is
    expect(panoramaAxis(9 / 16, R916)).toBeNull()
    expect(panoramaAxis(0.5, R916)).toBeNull()
    expect(panoramaAxis(0.4, R916)).toBe('y')
  })

  it('looks at photos as shown, never at videos', () => {
    const pano = photo('p', 8000, 2000)
    expect(panoramaOf(pano, R169)).toBe('x')
    // turned a quarter it is a tall one
    expect(panoramaOf({ ...pano, edit: { rotate: 90, straighten: 0 } }, R169)).toBe('y')
    // cropped to 16:9 it is a normal photo
    expect(panoramaOf({ ...pano, edit: { rotate: 0, straighten: 0, crop: { x: 0.3, y: 0, w: (16 / 9) * 0.25, h: 1 } } }, R169)).toBeNull()
    // a wide photo cropped to a strip becomes one
    expect(panoramaOf({ ...photo('q'), edit: { rotate: 0, straighten: 0, crop: { x: 0, y: 0.3, w: 1, h: 0.25 } } }, R169)).toBe('x')
    expect(panoramaOf({ ...pano, kind: 'video' }, R169)).toBeNull()
    expect(panoramaOf(undefined, R169)).toBeNull()
  })

  it('reuses the crop / whole-picture choice: unset pans', () => {
    expect(panoMode({ id: 'a', type: 'photo', mediaId: 'p' })).toBe('pan')
    expect(panoMode({ id: 'a', type: 'photo', mediaId: 'p', whole: true })).toBe('whole')
    expect(panoMode({ id: 'a', type: 'photo', mediaId: 'p', whole: false })).toBe('crop')
  })
})

describe('the pan', () => {
  it('runs at constant speed in the middle and starts and stops softly', () => {
    const ramp = 0.2
    const v = (t: number, h = 1e-4): number => (panEase(t + h, ramp) - panEase(t - h, ramp)) / (2 * h)
    expect(panEase(0, ramp)).toBe(0)
    expect(panEase(1, ramp)).toBeCloseTo(1, 12)
    expect(panEase(0.5, ramp)).toBeCloseTo(0.5, 12)
    // the middle: one speed, 1 / (1 - ramp)
    const mid = [0.21, 0.3, 0.4, 0.5, 0.6, 0.7, 0.79].map((t) => v(t))
    for (const x of mid) expect(x).toBeCloseTo(1 / (1 - ramp), 6)
    // at both ends the speed comes from and goes back to 0, without a jump anywhere
    expect(v(1e-3, 1e-4)).toBeLessThan(0.01)
    expect(v(1 - 1e-3, 1e-4)).toBeLessThan(0.01)
    let prev = 0
    for (let i = 0; i <= 1000; i++) {
      const t = i / 1000
      const p = panEase(t, ramp)
      expect(p).toBeGreaterThanOrEqual(prev - 1e-12)
      if (i > 0) expect(Math.abs(v(t, 5e-5) - v(Math.max(0, t - 1e-3), 5e-5))).toBeLessThan(0.05)
      prev = p
    }
    // the speed rises smoothly: half of the full speed half way through the ramp
    expect(v(ramp / 2)).toBeCloseTo(0.5 / (1 - ramp), 3)
    // outside 0..1 it rests at the ends
    expect(panEase(-0.5)).toBe(0)
    expect(panEase(1.5)).toBeCloseTo(1, 12)
  })

  it('ramps about 1.2 s at each end, at most 30 % of the pan each', () => {
    expect(panRamp(8)).toBeCloseTo(0.15, 6)
    expect(panRamp(2)).toBe(0.3)
  })

  it('fills the height and travels from one end to the other', () => {
    // 5:1 in 16:9: a window of 16:9 at full height
    const a = 5
    const { start, end } = panFrames(a, R169, 'x', false)
    expect(start).toEqual({ x: 0, y: 0, w: R169 / a, h: 1 })
    expect(end.x).toBeCloseTo(1 - R169 / a, 12)
    expect(end.h).toBe(1)
    const back = panFrames(a, R169, 'x', true)
    expect(back.start.x).toBeCloseTo(end.x, 12)
    expect(back.end.x).toBe(0)
    // a tall one, top to bottom at full width
    const tall = panFrames(0.25, R169, 'y', false)
    expect(tall.start).toEqual({ x: 0, y: 0, w: 1, h: 0.25 / R169 })
    expect(tall.end.y).toBeCloseTo(1 - 0.25 / R169, 12)
    // half way along the pan, half way along the picture
    expect(panUv(a, R169, 'x', false, 0.5).x).toBeCloseTo((1 - R169 / a) / 2, 12)
  })

  it('gives prints a wide (tall) window, never wider than the panorama', () => {
    expect(panoWindow(5, 2.4, 'x')).toBe(2.4)
    expect(panoWindow(5, 1.2, 'x')).toBe(2)
    expect(panoWindow(2.2, 3, 'x')).toBe(2.2)
    expect(panoWindow(0.25, 2, 'y')).toBe(0.5)
    expect(panoWindow(0.25, 0.4, 'y')).toBe(0.4)
    expect(panoWindow(0.45, 0.3, 'y')).toBe(0.45)
  })
})

describe('panorama slides', () => {
  const media = [photo('a'), photo('pano', 8000, 2000), photo('b'), photo('c'), photo('d'), photo('tall', 1000, 4000)]
  const entries: Entry[] = media.map((m) => ({ id: m.id, type: 'photo', mediaId: m.id }))

  it('last longer by default, scaled by how wide they are and capped', () => {
    const tl = buildTimeline(project(entries, media))
    const pano = tl.slides.find((s) => s.id === 'pano')!
    const normal = tl.slides.find((s) => s.id === 'b')!
    expect(pano.pano).toEqual({ axis: 'x', mode: 'pan', reverse: false })
    expect(normal.pano).toBeUndefined()
    // 4:1 in 16:9 spans 2.25 frames: 1 + 0.6 × 1.25 = 1.75 photo times
    expect(panTimeFactor(4, R169, 'x')).toBeCloseTo(1.75, 6)
    expect(pano.duration).toBeCloseTo(normal.duration * 1.75, 6)
    expect(panTimeFactor(12, R169, 'x')).toBe(PANO_MAX_TIME)
    const tall = tl.slides.find((s) => s.id === 'tall')!
    expect(tall.pano?.axis).toBe('y')
    expect(tall.duration).toBeCloseTo(normal.duration * Math.min(2.5, 1 + 0.6 * (R169 / 0.25 - 1)), 6)
  })

  it('keep the time the user set, and the normal time when not panning', () => {
    const custom = entries.map((e) => (e.id === 'pano' ? { ...e, duration: 3 } : e))
    expect(buildTimeline(project(custom, media)).slides.find((s) => s.id === 'pano')!.duration).toBe(3)
    for (const whole of [true, false]) {
      const tl = buildTimeline(project(entries.map((e) => (e.id === 'pano' ? { ...e, whole } : e)), media))
      const pano = tl.slides.find((s) => s.id === 'pano')!
      expect(pano.pano?.mode).toBe(whole ? 'whole' : 'crop')
      expect(pano.duration).toBeCloseTo(tl.slides.find((s) => s.id === 'b')!.duration, 6)
    }
    const back = buildTimeline(project(entries.map((e) => (e.id === 'pano' ? { ...e, panReverse: true } : e)), media))
    expect(back.slides.find((s) => s.id === 'pano')!.pano?.reverse).toBe(true)
  })

  it('keep "Fit to music", a custom total and beat sync exact', () => {
    const fit = buildTimeline(project(entries, media, [track('s1', 50)]))
    expect(fit.duration).toBeCloseTo(50, 1)
    const custom = buildTimeline(project(entries, media, [], { timing: { mode: 'custom', customTotal: 40 } }))
    expect(custom.duration).toBeCloseTo(40, 1)
    const p = (id: string): number => custom.slides.find((s) => s.id === id)!.duration
    expect(p('pano') / p('b')).toBeCloseTo(1.75, 3)
    const beatTrack = { ...track('s1', 60), beats: Array.from({ length: 120 }, (_, i) => 0.25 + i * 0.5), bpm: 120 }
    const synced = buildTimeline(project(entries, media, [beatTrack], { timing: { mode: 'fitToMusic', customTotal: 60, beatSync: true } }))
    for (const s of synced.slides.slice(1)) {
      const off = Math.abs(((s.start + s.transIn / 2 - 0.25) / 0.5) % 1)
      expect(Math.min(off, 1 - off)).toBeLessThan(1e-6)
    }
    const sp = synced.slides.find((s) => s.id === 'pano')!
    const sb = synced.slides.find((s) => s.id === 'b')!
    expect(sp.duration).toBeGreaterThan(sb.duration * 1.4)
  })

  it('are never grouped with other photos, in any theme', () => {
    const themes: ThemeId[] = ['magazine', 'origami', 'panels', 'reflections', 'scrapbook', 'kenburns', 'classic', 'vintage', 'snapshots', 'retro', 'shatter']
    // joined by hand onto the previous slide, and a slide that would take the next photos in
    const joined = entries.map((e) => (e.id === 'pano' || e.id === 'c' ? { ...e, groupBreak: 'join' as const } : e))
    for (const theme of themes) {
      for (const list of [entries, joined]) {
        const tl = buildTimeline(project(list, media, [], { theme }))
        for (const id of ['pano', 'tall']) {
          const s = tl.slides.find((x) => x.entries.some((e) => e.id === id))!
          expect(s.entries.map((e) => e.id), `${theme}: ${id}`).toEqual([id])
          expect(s.pano?.mode).toBe('pan')
        }
      }
    }
    // the photos around it still form grids
    const mag = buildTimeline(project(entries, media, [], { theme: 'magazine' }))
    expect(mag.slides.some((s) => s.entries.length > 1)).toBe(true)
    expect(mag.slides.find((s) => s.id === 'pano')!.template?.id).toBe('m1')
    // whole or cropped it keeps its own slide too
    const whole = buildTimeline(project(joined.map((e) => (e.id === 'pano' ? { ...e, whole: true } : e)), media, [], { theme: 'magazine' }))
    expect(whole.slides.find((s) => s.entries.some((e) => e.id === 'pano'))!.entries).toHaveLength(1)
  })

  it('depend on the output shape', () => {
    // 2.2:1 is a panorama in 4:3, not in 16:9
    const m = [photo('w', 2200, 1000), photo('b')]
    const es: Entry[] = m.map((x) => ({ id: x.id, type: 'photo', mediaId: x.id }))
    expect(buildTimeline(project(es, m)).slides[0].pano).toBeUndefined()
    expect(buildTimeline(project(es, m, [], { aspect: '4:3' })).slides[0].pano?.axis).toBe('x')
  })
})
