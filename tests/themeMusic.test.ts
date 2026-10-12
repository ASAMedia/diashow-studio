// Theme music: which songs play (own songs or the chosen bundled song), how the theme song is timed
// and looped, the bundled catalogue (resources/theme-music: songs per theme and a library by mood),
// how export jobs carry the song, and own songs taken from the library (export, pack, restore).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildAudioPlan, gainAt, loudnessGain } from '@shared/audioPlan'
import { buildTimeline, musicBeatTimes } from '@shared/timeline'
import { themeMeta, THEMES } from '@shared/themes'
import { chosenSong, effectiveMusic, isSongId, MOODS, moodsIn, placementAudio, songGroups, songsOfTheme, THEME_LOOP_CROSSFADE, themeMusicOn, type Mood, type ThemeTrack } from '@shared/themeMusic'
import { DEFAULT_SETTINGS, type AudioPlan, type Entry, type MediaItem, type MusicTrack, type Project, type ThemeId } from '@shared/types'
import { bundledFileName, loadThemeMusic, parseThemeCatalog, rebaseBundledPath, rebaseThemeMusic, resolveThemeMusicDir } from '../src/main/themeMusic'
import { validateNewJob, validateThemeSong } from '../src/main/export/validate'
import { projectSummary } from '../src/main/diagnostics/package'
import { packProject } from '../src/main/projectFile'
import { createMediaService } from '../src/main/media/service'
import { FFMPEG_DIR } from './helpers/media'

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
/** A bundled song with a beat every 60/bpm seconds from 0.2 s on; its id is the theme's unless given. */
const song = (theme: ThemeId | null, duration: number, bpm: number, id: string = theme!, moods: Mood[] = ['calm']): ThemeTrack => {
  const path = `C:\\app\\resources\\theme-music\\${id}.m4a`
  const beats = Array.from({ length: Math.floor(((duration - 0.2) * bpm) / 60) + 1 }, (_, i) => Math.round((0.2 + (i * 60) / bpm) * 1000) / 1000)
  return {
    id: `theme-${id}`, song: id, themes: theme ? [theme] : [], moods, path, playback: path, title: `${id} song`, artist: 'Someone',
    duration, status: 'ready', beats, bpm, loudness: -20, licence: 'CC0 1.0', source: 'https://example.org'
  }
}
const CATALOG = [song('kenburns', 60, 120), song('origami', 40, 100), song('vintage', 50, 90)]
/** Two more songs of Ken Burns and one of the music library only. */
const LIBRARY = [
  ...CATALOG.slice(0, 1),
  song('kenburns', 45, 80, 'kenburns-2', ['emotional']),
  song('kenburns', 45, 80, 'kenburns-3', ['upbeat', 'cheerful']),
  ...CATALOG.slice(1),
  song(null, 70, 110, 'festive-1', ['festive'])
]

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
    expect(effectiveMusic(q, CATALOG).theme?.song).toBe('origami')
    expect(chosenSong(q.settings, CATALOG)?.song).toBe('origami')
  })

  it('plays another theme song when one is chosen', () => {
    const p = project(3, [], { theme: 'kenburns', themeSong: 'vintage' })
    expect(chosenSong(p.settings, CATALOG)?.song).toBe('vintage')
    expect(effectiveMusic(p, CATALOG).theme?.id).toBe('theme-vintage')
  })

  it('songs of the show replace the theme song', () => {
    const p = project(3, [own('s1', 30)])
    expect(effectiveMusic(p, CATALOG)).toEqual({ tracks: p.music })
    // removing them brings it back
    expect(effectiveMusic({ ...p, music: [] }, CATALOG).theme?.song).toBe('kenburns')
  })

  it('is silent when switched off, for older projects without the fields, and without the song', () => {
    expect(effectiveMusic(project(3, [], { themeMusic: false }), CATALOG)).toEqual({ tracks: [] })
    const old: Project = { ...project(3), settings: { ...OLD_SETTINGS, showTitle: false } }
    expect(themeMusicOn(old.settings)).toBe(false)
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

describe('songs per theme and the music library', () => {
  it('a theme’s songs are those listing it, in order; the first is its default', () => {
    expect(songsOfTheme('kenburns', LIBRARY).map((s) => s.song)).toEqual(['kenburns', 'kenburns-2', 'kenburns-3'])
    expect(songsOfTheme('retro', LIBRARY)).toEqual([])
    expect(chosenSong(project(3).settings, LIBRARY)?.song).toBe('kenburns')
    // a song can belong to several themes
    const shared = { ...LIBRARY[1], themes: ['origami', 'kenburns'] as ThemeId[] }
    expect(songsOfTheme('origami', [shared, ...CATALOG]).map((s) => s.song)).toEqual(['kenburns-2', 'origami'])
  })

  it('plays another song of the theme or a song of the library by its id', () => {
    const p = project(3, [], { themeSong: 'kenburns-3' })
    expect(effectiveMusic(p, LIBRARY).theme?.song).toBe('kenburns-3')
    // a song of no theme plays with any theme
    const q = project(3, [], { theme: 'origami', themeSong: 'festive-1' })
    expect(effectiveMusic(q, LIBRARY)).toMatchObject({ theme: { song: 'festive-1', themes: [] } })
    // with the setting 'auto' the theme decides again
    expect(effectiveMusic({ ...q, settings: { ...q.settings, themeSong: 'auto' } }, LIBRARY).theme?.song).toBe('origami')
  })

  it('reads 1.2 values: a theme id is the song with that id, or else that theme’s default', () => {
    // 1.2 stored the theme whose song was picked; that song keeps the theme's id
    const reordered = [LIBRARY[1], LIBRARY[0], ...LIBRARY.slice(2)]
    expect(songsOfTheme('kenburns', reordered)[0].song).toBe('kenburns-2')
    expect(chosenSong(project(3, [], { theme: 'origami', themeSong: 'kenburns' }).settings, reordered)?.song).toBe('kenburns')
    // a theme without a song of its id: its first song
    const renamed = LIBRARY.map((s) => (s.song === 'vintage' ? { ...s, song: 'vintage-a', id: 'theme-vintage-a' } : s))
    expect(chosenSong(project(3, [], { themeSong: 'vintage' }).settings, renamed)?.song).toBe('vintage-a')
  })

  it('an unknown song id (a newer catalogue) plays the show’s theme’s default', () => {
    for (const themeSong of ['christmas-7', 'hologram']) {
      expect(chosenSong(project(3, [], { theme: 'origami', themeSong }).settings, LIBRARY)?.song).toBe('origami')
    }
    expect(chosenSong(project(3, [], { theme: 'retro', themeSong: 'christmas-7' }).settings, LIBRARY)).toBeUndefined()
  })

  it('groups the chooser: the theme’s songs, the other themes’ songs, the library; filtered by mood', () => {
    const ids = (g: ThemeTrack[]): string[] => g.map((s) => s.song)
    const all = songGroups('kenburns', LIBRARY)
    expect([ids(all.theme), ids(all.other), ids(all.library)]).toEqual([['kenburns', 'kenburns-2', 'kenburns-3'], ['origami', 'vintage'], ['festive-1']])
    const calm = songGroups('origami', LIBRARY, 'calm')
    expect([ids(calm.theme), ids(calm.other), ids(calm.library)]).toEqual([['origami'], ['kenburns', 'vintage'], []])
    const festive = songGroups('kenburns', LIBRARY, 'festive')
    expect([ids(festive.theme), ids(festive.other), ids(festive.library)]).toEqual([[], [], ['festive-1']])
    expect(songGroups('kenburns', LIBRARY, 'christmas')).toEqual({ theme: [], other: [], library: [] })
    // only the moods that songs have, in a fixed order
    expect(moodsIn(LIBRARY)).toEqual(['calm', 'cheerful', 'festive', 'emotional', 'upbeat'])
    expect(MOODS.map((m) => m.id)).toEqual(['calm', 'cheerful', 'festive', 'emotional', 'upbeat', 'nostalgic', 'christmas'])
  })

  it('song ids are plain file names', () => {
    for (const ok of ['kenburns', 'kenburns-2', 'festive-1', 'a', 'x9']) expect(isSongId(ok)).toBe(true)
    for (const bad of ['', 'Kenburns', '-a', 'a-', 'a b', 'a/b', '..', 'a.m4a', 'x'.repeat(65), 7, null]) expect(isSongId(bad)).toBe(false)
  })
})

describe('timing with the theme song', () => {
  it('"Fit to music" ignores a lone theme song: nominal durations, a long show is not squeezed', () => {
    const p = project(30)
    const tl = buildTimeline(p, 'de-DE', CATALOG)
    const silent = buildTimeline(p)
    expect(tl.themeSong?.song).toBe('kenburns')
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

  it('turns theme-music.json into playable tracks in catalogue order and leaves out what is wrong', () => {
    const raw = {
      version: 2,
      songs: [
        { id: 'kenburns', file: 'kenburns.m4a', title: ' Morning ', artist: 'A', licence: 'CC0 1.0', source: 'https://x', duration: 70, bpm: 96, beats: [0.5, 1.1], loudness: -16, themes: ['kenburns'], moods: ['calm', 'emotional'] },
        { id: 'festive-1', file: 'festive-1.m4a', title: 'March', artist: 'B', licence: 'Public domain', source: 'https://y', duration: 90, themes: [], moods: ['festive', 'loud', 'festive'], placeholder: true },
        { id: 'kenburns-2', file: 'kenburns-2.mp3', title: 'Second', duration: 50, themes: ['hologram', 'kenburns', 'kenburns', 'origami'], moods: ['calm'] },
        // the same id again, bad ids, files outside the folder or of other formats, no length
        { id: 'kenburns', file: 'kenburns-b.m4a', title: 'Again', duration: 70, themes: ['kenburns'], moods: [] },
        { id: 'Kenburns-3', file: 'kenburns-3.m4a', title: 'x', duration: 10, themes: ['kenburns'] },
        { id: '../x', file: 'x.m4a', title: 'x', duration: 10 },
        { id: 'secret', file: '..\\..\\secret.m4a', title: 'x', duration: 10 },
        { id: 'sub', file: 'sub/a.m4a', title: 'x', duration: 10 },
        { id: 'wma', file: 'a.wma', title: 'x', duration: 10 },
        { id: 'short', file: 'short.m4a', title: 'x', duration: 0 },
        'nonsense'
      ]
    }
    const tracks = parseThemeCatalog(raw, dir)
    expect(tracks.map((t) => t.song)).toEqual(['kenburns', 'festive-1', 'kenburns-2'])
    expect(tracks[0]).toEqual({
      id: 'theme-kenburns', song: 'kenburns', themes: ['kenburns'], moods: ['calm', 'emotional'], path: join(dir, 'kenburns.m4a'), playback: join(dir, 'kenburns.m4a'),
      title: 'Morning', artist: 'A', duration: 70, status: 'ready', beats: [0.5, 1.1], bpm: 96, loudness: -16, licence: 'CC0 1.0', source: 'https://x'
    })
    // unknown themes and moods are dropped, each once
    expect(tracks[1]).toMatchObject({ id: 'theme-festive-1', themes: [], moods: ['festive'], placeholder: true })
    expect(tracks[2]).toMatchObject({ themes: ['kenburns', 'origami'], path: join(dir, 'kenburns-2.mp3') })
    expect(songsOfTheme('kenburns', tracks).map((t) => t.song)).toEqual(['kenburns', 'kenburns-2'])
    expect(parseThemeCatalog({ version: 2, songs: 'x' }, dir)).toEqual([])
  })

  it('reads the 1.2 catalogue: one song per theme, with the theme’s id', () => {
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
    expect(tracks.map((t) => t.song)).toEqual(['kenburns', 'retro'])
    expect(tracks[0]).toEqual({
      id: 'theme-kenburns', song: 'kenburns', themes: ['kenburns'], moods: [], path: join(dir, 'kenburns.m4a'), playback: join(dir, 'kenburns.m4a'), title: 'Morning', artist: 'A',
      duration: 70, status: 'ready', beats: [0.5, 1.1], bpm: 96, loudness: -16, licence: 'CC0 1.0', source: 'https://x'
    })
    // a 1.2 project's choice means the same song
    expect(chosenSong(project(3, [], { theme: 'origami', themeSong: 'retro' }).settings, tracks)?.title).toBe('R')
    expect(tracks[1]).toMatchObject({ placeholder: true })
    expect(tracks[1].beats).toBeUndefined()
    expect(parseThemeCatalog(null, dir)).toEqual([])
  })

  it('reads only songs whose file is there', async () => {
    writeFileSync(join(dir, 'theme-music.json'), JSON.stringify({ version: 1, songs: { kenburns: { file: 'kenburns.m4a', title: 'K', duration: 5 }, origami: { file: 'origami.m4a', title: 'O', duration: 5 } } }))
    writeFileSync(join(dir, 'kenburns.m4a'), 'x')
    expect((await loadThemeMusic(dir)).map((t) => t.song)).toEqual(['kenburns'])
    expect(await loadThemeMusic(join(tmp, 'nowhere'))).toEqual([])
    expect(await loadThemeMusic('')).toEqual([])
    expect(resolveThemeMusicDir({ resourcesPath: tmp, packaged: true })).toBe(dir)
    expect(resolveThemeMusicDir({ resourcesPath: join(tmp, 'nowhere'), packaged: true })).toBe('')
  })

  it('ships 2–3 songs for every theme and a library by mood, each with its loudness, moods and file', async () => {
    const repo = resolveThemeMusicDir({ appPath: join(__dirname, '..') })
    expect(repo).toBe(join(__dirname, '..', 'resources', 'theme-music'))
    const raw = JSON.parse(readFileSync(join(repo, 'theme-music.json'), 'utf8'))
    expect(raw.version).toBe(2)
    const songs = await loadThemeMusic(repo)
    // every entry is valid and its file is there
    expect(songs.length).toBe(raw.songs.length)
    expect(new Set(songs.map((s) => s.song)).size).toBe(songs.length)
    for (const th of THEMES) {
      const own = songsOfTheme(th.id, songs)
      expect(own.length, th.id).toBeGreaterThanOrEqual(2)
      expect(own.length, th.id).toBeLessThanOrEqual(3)
      // the 1.2 song stays the theme's default, under the theme's id (projects store it)
      expect(own[0].song).toBe(th.id)
      expect(own[0].placeholder).toBeUndefined()
    }
    expect(songs.filter((s) => !s.themes.length).length).toBeGreaterThanOrEqual(4)
    expect(moodsIn(songs.filter((s) => !s.themes.length))).toEqual(expect.arrayContaining(['festive', 'christmas']))
    for (const s of songs) {
      expect(basename(s.path)).toBe(`${s.song}.m4a`)
      expect(s.moods.length, s.song).toBeGreaterThan(0)
      // a song with a theme's id belongs to that theme
      if (THEMES.some((t) => t.id === s.song)) expect(s.themes).toContain(s.song)
      expect(s.duration).toBeGreaterThan(30)
      // a calm song may have no beat to find; the generated stand-ins all have one
      if (s.placeholder) expect(s.beats!.length).toBeGreaterThan(20)
      expect(Math.abs(s.loudness! + 16)).toBeLessThan(1.5)
      expect(s.licence).toMatch(/^(CC0|public domain)/i)
      expect(existsSync(s.path)).toBe(true)
    }
    // no stray audio files next to the catalogue
    expect(readdirSync(repo).filter((n) => n.endsWith('.m4a')).sort()).toEqual(songs.map((s) => `${s.song}.m4a`).sort())
  })

  it('finds the song of a resumed export in today’s folder', () => {
    const plan: AudioPlan = {
      duration: 10,
      clips: [
        { id: 'music-0', kind: 'music', src: 'C:\\Temp\\old-unpack\\resources\\theme-music\\kenburns.m4a', start: 0, offset: 0, duration: 10, gain: [] },
        { id: 'music-1', kind: 'music', src: 'C:\\Musik\\gone.mp3', start: 0, offset: 0, duration: 10, gain: [] }
      ]
    }
    expect(bundledFileName(plan.clips[0].src)).toBe('kenburns.m4a')
    expect(bundledFileName(plan.clips[1].src)).toBeNull()
    const moved = rebaseThemeMusic(plan, dir)
    expect(moved.clips.map((c) => c.src)).toEqual([join(dir, 'kenburns.m4a'), 'C:\\Musik\\gone.mp3'])
    expect(rebaseThemeMusic(plan, '')).toBe(plan)
  })
})

describe('own songs from the music library', () => {
  const today = join(tmp, 'today', 'resources', 'theme-music')
  const before = join(tmp, 'old-unpack', 'resources', 'theme-music')
  mkdirSync(today, { recursive: true })
  // a real bundled song, so the media service can read it
  copyFileSync(join(__dirname, '..', 'resources', 'theme-music', 'origami.m4a'), join(today, 'festive-1.m4a'))
  const stale = join(before, 'festive-1.m4a')

  it('recognises files of a theme-music folder only', () => {
    expect(bundledFileName(stale)).toBe('festive-1.m4a')
    expect(bundledFileName('C:\\x\\Theme-Music\\kenburns-2.M4A')).toBe('kenburns-2.M4A')
    for (const no of ['C:\\Musik\\festive-1.m4a', 'C:\\theme-music\\sub\\a.m4a', 'C:\\theme-music\\.hidden.m4a', 'C:\\theme-music\\a b.m4a', 'C:\\theme-music\\a.wma', 'C:\\theme-music\\theme-music.json']) {
      expect(bundledFileName(no), no).toBeNull()
    }
    expect(rebaseBundledPath(stale, today)).toBe(join(today, 'festive-1.m4a'))
    // only missing files move, and only to a file that is there
    expect(rebaseBundledPath(join(today, 'festive-1.m4a'), join(tmp, 'elsewhere'))).toBe(join(today, 'festive-1.m4a'))
    expect(rebaseBundledPath(join(before, 'christmas-9.m4a'), today)).toBe(join(before, 'christmas-9.m4a'))
    expect(rebaseBundledPath('C:\\Musik\\festive-1.m4a', today)).toBe('C:\\Musik\\festive-1.m4a')
    expect(rebaseBundledPath(stale, '')).toBe(stale)
    // a share the user hasn't trusted is not opened: today's file is taken
    const share = '\\\\nas01\\apps\\Diashow\\resources\\theme-music\\festive-1.m4a'
    expect(rebaseBundledPath(share, today, () => false)).toBe(join(today, 'festive-1.m4a'))
    expect(rebaseBundledPath(share.replace('festive-1', 'christmas-9'), today, () => false)).toBe(share.replace('festive-1', 'christmas-9'))
  })

  it('an own song pointing at a bundled file is resolved for the export', () => {
    // the audio plan of a job queued before a restart of the portable exe
    const p = project(3, [{ ...own('lib', 60), path: stale, playback: stale }])
    const plan = buildAudioPlan(p, buildTimeline(p, 'de-DE', CATALOG))
    expect(musicClips(plan).map((c) => c.src)).toEqual([stale])
    expect(musicClips(rebaseThemeMusic(plan, today)).map((c) => c.src)).toEqual([join(today, 'festive-1.m4a')])
  })

  it('is found again when the project opens, and packed like any other song', async () => {
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: join(tmp, 'cache'), themeMusicDir: today })
    try {
      const track: MusicTrack = { ...own('lib', 60), path: stale, playback: stale, beats: [], loudness: -16 }
      const [r] = await svc.restoreMusic([track])
      expect(r).toMatchObject({ id: 'lib', status: 'ready', path: join(today, 'festive-1.m4a'), playback: join(today, 'festive-1.m4a') })
    } finally {
      await svc.dispose()
    }
    const out = join(tmp, 'pack')
    mkdirSync(out, { recursive: true })
    const dshow = await packProject(project(0, [{ ...own('lib', 60), path: stale, playback: stale }]), out, { themeMusicDir: today })
    const packed = JSON.parse(readFileSync(dshow, 'utf8'))
    expect(packed.music[0].path).toBe('music/festive-1.m4a')
    expect(existsSync(join(dshow, '..', 'music', 'festive-1.m4a'))).toBe(true)
  })
})

describe('export jobs and diagnostics', () => {
  it('keeps the theme song of a job as a clean copy', () => {
    const s = validateThemeSong({ ...CATALOG[0], extra: 'dropped' })!
    expect(s).toMatchObject({ id: 'theme-kenburns', song: 'kenburns', themes: ['kenburns'], moods: ['calm'], path: CATALOG[0].path, duration: 60, beats: CATALOG[0].beats })
    expect((s as unknown as Record<string, unknown>).extra).toBeUndefined()
    expect(validateThemeSong(undefined)).toBeUndefined()
    // a song of the library only
    expect(validateThemeSong(LIBRARY[LIBRARY.length - 1])).toMatchObject({ song: 'festive-1', themes: [], moods: ['festive'] })
    // a job queued by 1.2 named the theme: its song has the theme's id
    const { song: _s, themes: _t, moods: _m, ...older } = CATALOG[2]
    expect(validateThemeSong({ ...older, theme: 'vintage' })).toMatchObject({ song: 'vintage', themes: ['vintage'], moods: [] })
    for (const bad of [
      { ...CATALOG[0], themes: ['hologram'] },
      { ...CATALOG[0], song: '../x' },
      { ...CATALOG[0], moods: ['loud'] },
      { ...older, theme: 'hologram' },
      { ...CATALOG[0], path: 'http://x/a.m4a' },
      { ...CATALOG[0], duration: 0 },
      { ...CATALOG[0], beats: ['x'] },
      'song'
    ]) {
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
    expect(job.themeSong?.song).toBe('kenburns')
  })

  it('tells in the project summary which music plays', () => {
    const summary = (p: Project) => (projectSummary(p, undefined, CATALOG) as { music: Record<string, unknown> }).music
    expect(summary(project(3))).toMatchObject({ plays: 'theme', themeMusic: 'auto', themeSong: 'kenburns' })
    expect(summary(project(3, [own('s1', 30)]))).toMatchObject({ plays: 'own', themeMusic: 'auto', tracks: 1 })
    expect(summary({ ...project(3), settings: { ...OLD_SETTINGS } })).toMatchObject({ plays: 'none', themeMusic: 'off' })
    // a song this catalogue doesn't have: the theme's own plays
    expect(summary(project(3, [], { themeSong: 'kenburns-2' }))).toMatchObject({ plays: 'theme', themeMusic: 'kenburns-2', themeSong: 'kenburns' })
    const library = (projectSummary(project(3, [own('s1', 30), { ...LIBRARY[1], id: 's2' }], { themeSong: 'kenburns-2' }), undefined, LIBRARY) as { music: Record<string, unknown> }).music
    expect(library).toMatchObject({ plays: 'own', tracks: 2, fromLibrary: 1 })
  })
})
