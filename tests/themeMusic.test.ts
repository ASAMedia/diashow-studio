// Theme music: which songs play (own songs or the theme's song), how the theme song is timed and
// looped, the bundled catalog (resources/theme-music) and how export jobs carry the song.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildAudioPlan, gainAt, loudnessGain } from '@shared/audioPlan'
import { buildTimeline, musicBeatTimes } from '@shared/timeline'
import { themeMeta, THEMES } from '@shared/themes'
import { chosenTheme, effectiveMusic, placementAudio, THEME_LOOP_CROSSFADE, themeSongId, type ThemeTrack } from '@shared/themeMusic'
import { DEFAULT_SETTINGS, type AudioPlan, type Entry, type MediaItem, type MusicTrack, type Project, type ThemeId } from '@shared/types'
import { loadThemeMusic, parseThemeCatalog, rebaseThemeMusic, resolveThemeMusicDir, themeOfFile } from '../src/main/themeMusic'
import { validateNewJob, validateThemeSong } from '../src/main/export/validate'
import { projectSummary } from '../src/main/diagnostics/package'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-theme-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

const photo = (id: string): MediaItem => ({
  id, path: `C:\\p\\${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: 4000, height: 3000, captureTime: 0, status: 'ready', display: `C:\\c\\${id}.jpg`
})
const video = (id: string, duration: number): MediaItem => ({
  id, path: `C:\\p\\${id}.mp4`, name: `${id}.mp4`, kind: 'video', format: 'H.264', width: 1920, height: 1080, duration, hasAudio: true,
  captureTime: 0, status: 'ready', playback: `C:\\p\\${id}.mp4`, audio: `C:\\c\\${id}.m4a`
})
const own = (id: string, duration: number): MusicTrack => ({ id, path: `C:\\m\\${id}.mp3`, title: id, duration, status: 'ready', playback: `C:\\m\\${id}.mp3` })
/** A theme song with a beat every 60/bpm seconds from 0.2 s on. */
const song = (theme: ThemeId, duration: number, bpm: number): ThemeTrack => {
  const path = `C:\\app\\resources\\theme-music\\${theme}.m4a`
  const beats = Array.from({ length: Math.floor(((duration - 0.2) * bpm) / 60) + 1 }, (_, i) => Math.round((0.2 + (i * 60) / bpm) * 1000) / 1000)
  return { id: `theme-${theme}`, theme, path, playback: path, title: `${theme} song`, artist: 'Someone', duration, status: 'ready', beats, bpm, loudness: -20, licence: 'CC0 1.0', source: 'https://example.org' }
}
const CATALOG = [song('kenburns', 60, 120), song('origami', 40, 100), song('vintage', 50, 90)]

const { themeMusic: _on, themeSong: _song, ...OLD_SETTINGS } = DEFAULT_SETTINGS

function project(photos: number, music: MusicTrack[] = [], patch: Partial<Project['settings']> = {}, extra: Entry[] = [], extraMedia: MediaItem[] = []): Project {
  const media = Array.from({ length: photos }, (_, i) => photo(`p${i}`))
  const entries: Entry[] = media.map((m) => ({ id: `e-${m.id}`, type: 'photo', mediaId: m.id }))
  return {
    version: 1, id: 'p', name: 'Show', createdAt: 0, updatedAt: 0,
    entries: [...entries, ...extra], media: [...media, ...extraMedia], music,
    settings: { ...DEFAULT_SETTINGS, showTitle: false, ...patch }
  }
}
const musicClips = (plan: AudioPlan) => plan.clips.filter((c) => c.kind === 'music')

describe('which songs play', () => {
  it('a new show plays its theme song, following the theme', () => {
    expect(DEFAULT_SETTINGS.themeMusic).toBe(true)
    expect(DEFAULT_SETTINGS.themeSong).toBe('auto')
    const p = project(3)
    expect(effectiveMusic(p, CATALOG)).toEqual({ tracks: [CATALOG[0]], theme: CATALOG[0] })
    const q = project(3, [], { theme: 'origami' })
    expect(effectiveMusic(q, CATALOG).theme?.theme).toBe('origami')
    expect(themeSongId(q.settings)).toBe('origami')
  })

  it('plays another theme song when one is chosen', () => {
    const p = project(3, [], { theme: 'kenburns', themeSong: 'vintage' })
    expect(chosenTheme(p.settings)).toBe('vintage')
    expect(effectiveMusic(p, CATALOG).theme?.id).toBe('theme-vintage')
  })

  it('songs of the show replace the theme song', () => {
    const p = project(3, [own('s1', 30)])
    expect(effectiveMusic(p, CATALOG)).toEqual({ tracks: p.music })
    // removing them brings it back
    expect(effectiveMusic({ ...p, music: [] }, CATALOG).theme?.theme).toBe('kenburns')
  })

  it('is silent when switched off, for older projects without the fields, and without the song', () => {
    expect(effectiveMusic(project(3, [], { themeMusic: false }), CATALOG)).toEqual({ tracks: [] })
    const old: Project = { ...project(3), settings: { ...OLD_SETTINGS, showTitle: false } }
    expect(themeSongId(old.settings)).toBeNull()
    expect(effectiveMusic(old, CATALOG)).toEqual({ tracks: [] })
    expect(effectiveMusic(project(3, [], { theme: 'retro' }), CATALOG)).toEqual({ tracks: [] })
    expect(effectiveMusic(project(3), [])).toEqual({ tracks: [] })
  })

  it('loops the theme song with at least the loop crossfade, and leaves own songs as set', () => {
    const a = { ...DEFAULT_SETTINGS.audio, repeatMusic: false, crossfade: 0 }
    expect(placementAudio(a, true)).toMatchObject({ repeatMusic: true, crossfade: THEME_LOOP_CROSSFADE })
    expect(placementAudio({ ...a, crossfade: 6 }, true).crossfade).toBe(6)
    expect(placementAudio(a, false)).toBe(a)
  })
})

describe('timing with the theme song', () => {
  it('"Fit to music" ignores a lone theme song: nominal durations, a long show is not squeezed', () => {
    const p = project(30)
    const tl = buildTimeline(p, 'de-DE', CATALOG)
    const silent = buildTimeline(p)
    expect(tl.themeSong?.theme).toBe('kenburns')
    expect(tl.music).toEqual([CATALOG[0]])
    expect(tl.musicDuration).toBe(0)
    expect(tl.photoSeconds).toBe(themeMeta('kenburns').photoSeconds)
    expect(tl.duration).toBeCloseTo(silent.duration, 6)
    expect(tl.duration).toBeGreaterThan(60)
  })

  it('keeps a custom total, and own music still sets the length', () => {
    expect(buildTimeline(project(10, [], { timing: { mode: 'custom', customTotal: 45 } }), 'de-DE', CATALOG).duration).toBeCloseTo(45, 1)
    const withOwn = buildTimeline(project(10, [own('s1', 40)]), 'de-DE', CATALOG)
    expect(withOwn.themeSong).toBeUndefined()
    expect(withOwn.duration).toBeCloseTo(40, 1)
  })

  it('puts slide changes on the theme song’s beats, also after the loop point', () => {
    const p = project(30, [], { timing: { mode: 'fitToMusic', customTotal: 120, beatSync: true } })
    const tl = buildTimeline(p, 'de-DE', CATALOG)
    const beats = musicBeatTimes(p, tl.duration, tl)
    // the second play starts THEME_LOOP_CROSSFADE seconds before the first one ends
    expect(beats).toContain(Math.round((60 - THEME_LOOP_CROSSFADE + 0.2) * 1000) / 1000)
    for (const s of tl.slides.slice(1)) {
      const cut = s.start + s.transIn / 2
      expect(Math.min(...beats.map((b) => Math.abs(b - cut)))).toBeLessThan(1e-6)
    }
    expect(tl.slides.some((s) => s.start > 60)).toBe(true)
  })

  it('plays the theme song in the whole show: chapter music is for own songs only', () => {
    const chapter: Entry = { id: 'day2', type: 'text', title: 'Montag', music: ['gone'] }
    const tl = buildTimeline(project(6, [], {}, [chapter, { id: 'e-x', type: 'photo', mediaId: 'p0' }]), 'de-DE', CATALOG)
    expect(tl.musicSegments).toEqual([{ start: 0, end: tl.duration, tracks: ['theme-kenburns'], chapterId: undefined }])
  })
})

describe('the audio plan with the theme song', () => {
  it('loops it through the whole show with a crossfade at the loop point and fades out at the end', () => {
    // crossfade 0 and no repeat for own songs: the theme song still loops smoothly
    const p = project(40, [], { audio: { ...DEFAULT_SETTINGS.audio, repeatMusic: false, crossfade: 0 } })
    const tl = buildTimeline(p, 'de-DE', CATALOG)
    const clips = musicClips(buildAudioPlan(p, tl))
    expect(tl.duration).toBeGreaterThan(120)
    expect(clips.length).toBe(Math.ceil((tl.duration - THEME_LOOP_CROSSFADE) / (60 - THEME_LOOP_CROSSFADE)))
    expect(clips.every((c) => c.src === CATALOG[0].playback && c.offset === 0)).toBe(true)
    expect(clips[0].start).toBe(0)
    for (let i = 1; i < clips.length; i++) {
      const prev = clips[i - 1]
      expect(prev.duration).toBeCloseTo(60, 6)
      expect(clips[i].start).toBeCloseTo(prev.start + 60 - THEME_LOOP_CROSSFADE, 6)
      // one fades out while the next fades in
      expect(gainAt(prev.gain, prev.start + prev.duration)).toBe(0)
      expect(gainAt(clips[i].gain, clips[i].start)).toBe(0)
      expect(gainAt(clips[i].gain, clips[i].start + THEME_LOOP_CROSSFADE)).toBeGreaterThan(0.5)
    }
    const last = clips[clips.length - 1]
    expect(last.start + last.duration).toBeCloseTo(tl.duration, 6)
    expect(gainAt(last.gain, tl.duration)).toBe(0)
  })

  it('a short show ends with a fade-out of the song, at the theme song’s level', () => {
    const p = project(3)
    const tl = buildTimeline(p, 'de-DE', CATALOG)
    const [clip, ...more] = musicClips(buildAudioPlan(p, tl))
    expect(more).toEqual([])
    expect(clip.duration).toBeCloseTo(tl.duration, 6)
    const level = DEFAULT_SETTINGS.audio.musicVolume * loudnessGain(-20, true)
    expect(gainAt(clip.gain, tl.duration - DEFAULT_SETTINGS.audio.fadeOut)).toBeCloseTo(level, 6)
    expect(gainAt(clip.gain, tl.duration)).toBe(0)
  })

  it('never gives a negative gain (fades that round below 0 are refused by the export)', () => {
    const negative: number[] = []
    for (let total = 10; total < 40; total += 0.137) {
      const p = project(4, [], { timing: { mode: 'custom', customTotal: total }, audio: { ...DEFAULT_SETTINGS.audio, normalize: false } })
      const plan = buildAudioPlan(p, buildTimeline(p, 'de-DE', CATALOG))
      for (const c of plan.clips) for (const g of c.gain) if (g.g < 0) negative.push(g.g)
    }
    expect(negative).toEqual([])
  })

  it('ducks under video sound like own music', () => {
    const p = project(4, [], {}, [{ id: 'e-v', type: 'video', mediaId: 'v' }], [video('v', 8)])
    const tl = buildTimeline(p, 'de-DE', CATALOG)
    const plan = buildAudioPlan(p, tl)
    const v = tl.slides.find((s) => s.id === 'e-v')!
    const [clip] = musicClips(plan)
    const level = DEFAULT_SETTINGS.audio.musicVolume * loudnessGain(-20, true)
    expect(gainAt(clip.gain, v.start + v.duration / 2)).toBeCloseTo(level * DEFAULT_SETTINGS.audio.duckLevel, 6)
    expect(plan.clips.some((c) => c.kind === 'video')).toBe(true)
  })
})

describe('the bundled catalog', () => {
  const dir = join(tmp, 'theme-music')
  mkdirSync(dir, { recursive: true })

  it('turns theme-music.json into playable tracks and leaves out what is wrong', () => {
    const raw = {
      version: 1,
      songs: {
        kenburns: { file: 'kenburns.m4a', title: ' Morning ', artist: 'A', licence: 'CC0 1.0', source: 'https://x', duration: 70, bpm: 96, beats: [0.5, 1.1], loudness: -16 },
        origami: { file: '..\\..\\secret.m4a', title: 'x', duration: 10 },
        panels: { file: 'sub/panels.m4a', title: 'x', duration: 10 },
        vintage: { file: 'vintage.wma', title: 'x', duration: 10 },
        classic: { file: 'classic.m4a', title: 'x', duration: 0 },
        retro: { file: 'retro.mp3', title: 'R', duration: 30, beats: [1, 'x'], placeholder: true },
        hologram: { file: 'hologram.m4a', title: 'x', duration: 10 }
      }
    }
    const tracks = parseThemeCatalog(raw, dir)
    expect(tracks.map((t) => t.theme)).toEqual(['kenburns', 'retro'])
    expect(tracks[0]).toEqual({
      id: 'theme-kenburns', theme: 'kenburns', path: join(dir, 'kenburns.m4a'), playback: join(dir, 'kenburns.m4a'), title: 'Morning', artist: 'A',
      duration: 70, status: 'ready', beats: [0.5, 1.1], bpm: 96, loudness: -16, licence: 'CC0 1.0', source: 'https://x'
    })
    expect(tracks[1]).toMatchObject({ placeholder: true })
    expect(tracks[1].beats).toBeUndefined()
    expect(parseThemeCatalog(null, dir)).toEqual([])
  })

  it('reads only songs whose file is there', async () => {
    writeFileSync(join(dir, 'theme-music.json'), JSON.stringify({ version: 1, songs: { kenburns: { file: 'kenburns.m4a', title: 'K', duration: 5 }, origami: { file: 'origami.m4a', title: 'O', duration: 5 } } }))
    writeFileSync(join(dir, 'kenburns.m4a'), 'x')
    expect((await loadThemeMusic(dir)).map((t) => t.theme)).toEqual(['kenburns'])
    expect(await loadThemeMusic(join(tmp, 'nowhere'))).toEqual([])
    expect(await loadThemeMusic('')).toEqual([])
    expect(resolveThemeMusicDir({ resourcesPath: tmp, packaged: true })).toBe(dir)
    expect(resolveThemeMusicDir({ resourcesPath: join(tmp, 'nowhere'), packaged: true })).toBe('')
  })

  it('ships a song with its loudness (and the beats, where it has a beat) for every theme', async () => {
    const repo = resolveThemeMusicDir({ appPath: join(__dirname, '..') })
    expect(repo).toBe(join(__dirname, '..', 'resources', 'theme-music'))
    const songs = await loadThemeMusic(repo)
    expect(songs.map((s) => s.theme)).toEqual(THEMES.map((t) => t.id))
    for (const s of songs) {
      expect(s.duration).toBeGreaterThan(30)
      // a calm song may have no beat to find; the generated stand-ins all have one
      if (s.placeholder) expect(s.beats!.length).toBeGreaterThan(20)
      expect(Math.abs(s.loudness! + 16)).toBeLessThan(1.5)
      expect(s.licence).toMatch(/^(CC0|public domain)/i)
      expect(existsSync(s.path)).toBe(true)
    }
  })

  it('finds the song of a resumed export in today’s folder', () => {
    const plan: AudioPlan = {
      duration: 10,
      clips: [
        { id: 'music-0', kind: 'music', src: 'C:\\Temp\\old-unpack\\resources\\theme-music\\kenburns.m4a', start: 0, offset: 0, duration: 10, gain: [] },
        { id: 'music-1', kind: 'music', src: 'C:\\Musik\\gone.mp3', start: 0, offset: 0, duration: 10, gain: [] }
      ]
    }
    expect(themeOfFile(plan.clips[0].src)).toBe('kenburns')
    expect(themeOfFile(plan.clips[1].src)).toBeNull()
    const moved = rebaseThemeMusic(plan, dir)
    expect(moved.clips.map((c) => c.src)).toEqual([join(dir, 'kenburns.m4a'), 'C:\\Musik\\gone.mp3'])
    expect(rebaseThemeMusic(plan, '')).toBe(plan)
  })
})

describe('export jobs and diagnostics', () => {
  it('keeps the theme song of a job as a clean copy', () => {
    const s = validateThemeSong({ ...CATALOG[0], extra: 'dropped' })!
    expect(s).toMatchObject({ id: 'theme-kenburns', theme: 'kenburns', path: CATALOG[0].path, duration: 60, beats: CATALOG[0].beats })
    expect((s as unknown as Record<string, unknown>).extra).toBeUndefined()
    expect(validateThemeSong(undefined)).toBeUndefined()
    for (const bad of [{ ...CATALOG[0], theme: 'hologram' }, { ...CATALOG[0], path: 'http://x/a.m4a' }, { ...CATALOG[0], duration: 0 }, { ...CATALOG[0], beats: ['x'] }, 'song']) {
      expect(() => validateThemeSong(bad)).toThrow(/theme song/)
    }
    const out = join(tmp, 'show.mp4')
    const job = validateNewJob({
      name: 'Show',
      project: project(3),
      request: { outPath: out, width: 640, height: 360, fps: 30, codec: 'h264', quality: 'standard', hardware: false, locale: 'de-DE' },
      audio: { duration: 10, clips: [] },
      themeSong: CATALOG[0]
    })
    expect(job.themeSong?.theme).toBe('kenburns')
  })

  it('tells in the project summary which music plays', () => {
    const summary = (p: Project) => (projectSummary(p, undefined, CATALOG) as { music: Record<string, unknown> }).music
    expect(summary(project(3))).toMatchObject({ plays: 'theme', themeMusic: 'auto', themeSong: 'kenburns' })
    expect(summary(project(3, [own('s1', 30)]))).toMatchObject({ plays: 'own', themeMusic: 'auto', tracks: 1 })
    expect(summary({ ...project(3), settings: { ...OLD_SETTINGS } })).toMatchObject({ plays: 'none', themeMusic: 'off' })
  })
})
