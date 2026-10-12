// Theme music, like the theme songs of macOS Photos: bundled royalty-free (CC0 / public domain) songs
// in resources/theme-music (scripts/theme-music.mjs writes them). Every theme has two or three songs,
// its first is its default; a small library adds songs by mood (some belong to no theme). A show plays
// the chosen song while it has no songs of its own; its own songs always replace it. Pure: the
// timeline, the audio plan, the editor and the export all ask effectiveMusic() which songs play.
import type { AudioSettings, MusicTrack, Project, ProjectSettings, ThemeId } from './types'

/** Moods of the music library ("Stimmung"); every bundled song has one or more. */
export type Mood = 'calm' | 'cheerful' | 'festive' | 'emotional' | 'upbeat' | 'nostalgic' | 'christmas'

export const MOODS: { id: Mood; name: { de: string; en: string } }[] = [
  { id: 'calm', name: { de: 'Ruhig', en: 'Calm' } },
  { id: 'cheerful', name: { de: 'Fröhlich', en: 'Cheerful' } },
  // graduations, ceremonies
  { id: 'festive', name: { de: 'Feierlich', en: 'Festive' } },
  { id: 'emotional', name: { de: 'Gefühlvoll', en: 'Emotional' } },
  { id: 'upbeat', name: { de: 'Schwungvoll', en: 'Upbeat' } },
  { id: 'nostalgic', name: { de: 'Nostalgisch', en: 'Nostalgic' } },
  // school Christmas events
  { id: 'christmas', name: { de: 'Weihnachtlich', en: 'Christmas' } }
]

export const isMood = (v: unknown): v is Mood => MOODS.some((m) => m.id === v)

/**
 * A song id: lower-case letters, digits and hyphens, also the song's file name ("<id>.m4a"). Ids are
 * stable, projects store them (settings.themeSong). The first song of every theme (1.2 had one per
 * theme) has the theme's id, so a 1.2 project's `themeSong: 'vintage'` still means the same song.
 */
export const SONG_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
export const isSongId = (v: unknown): v is string => typeof v === 'string' && SONG_ID_RE.test(v)

/** One song of resources/theme-music/theme-music.json (version 2: a list of songs). */
export interface ThemeSongInfo {
  id: string
  /** File name inside the theme-music folder, "<id>.m4a". */
  file: string
  title: string
  artist: string
  /** e.g. "CC0 1.0". */
  licence: string
  /** Where the song comes from (URL). */
  source: string
  /** Seconds. */
  duration: number
  bpm?: number
  /** Beat times in seconds, found by the app's own beat tracking (media/beats.ts). */
  beats?: number[]
  /** Integrated loudness in LUFS. */
  loudness?: number
  /** The themes the song belongs to; a theme's songs are those listing it, in catalogue order. [] = mood library only. */
  themes: ThemeId[]
  moods: Mood[]
  /** Generated stand-in until the real song is chosen. */
  placeholder?: boolean
}

export interface ThemeMusicCatalog {
  version: 2
  songs: ThemeSongInfo[]
}

/** A bundled song as a playable track (absolute path), with where it comes from. */
export interface ThemeTrack extends MusicTrack {
  /** The song id (ThemeSongInfo.id); `id` is "theme-<song id>". */
  song: string
  /** The themes it belongs to, as in the catalogue; [] for a song of the mood library only. */
  themes: ThemeId[]
  moods: Mood[]
  licence: string
  source: string
  placeholder?: boolean
}

/** Crossfade at the theme song's loop point, at least (a longer crossfade setting is kept). */
export const THEME_LOOP_CROSSFADE = 3

/** A theme's songs in catalogue order; the first is its default ("Matches the theme"). */
export function songsOfTheme(theme: string, tracks: readonly ThemeTrack[]): ThemeTrack[] {
  return tracks.filter((t) => (t.themes as string[]).includes(theme))
}

/**
 * The song theme music plays, also while it is switched off (the Music tab shows it):
 * - 'auto' (or missing): the first song of the show's theme;
 * - a song id: that song (the first 11 have their theme's id, as 1.2 stored them);
 * - a theme id without a song of that id: that theme's first song;
 * - an id this catalogue doesn't know (a project from a newer version): the show's theme's first song.
 */
export function chosenSong(settings: ProjectSettings, tracks: readonly ThemeTrack[]): ThemeTrack | undefined {
  const want = settings.themeSong
  if (want && want !== 'auto') {
    const hit = tracks.find((t) => t.song === want) ?? songsOfTheme(want, tracks)[0]
    if (hit) return hit
  }
  return songsOfTheme(settings.theme, tracks)[0]
}

/** Theme music is on (missing in an older project means off). */
export const themeMusicOn = (settings: ProjectSettings): boolean => settings.themeMusic === true

export interface EffectiveMusic {
  /** The songs that play, in order: the show's own, or the theme song. */
  tracks: MusicTrack[]
  /** Set when the theme song plays. */
  theme?: ThemeTrack
}

/**
 * Which songs play: the show's own songs whenever it has any; otherwise the chosen theme song, when
 * theme music is on and the song is bundled; otherwise none.
 */
export function effectiveMusic(project: Project, themeTracks: readonly ThemeTrack[] = []): EffectiveMusic {
  if (project.music.length) return { tracks: project.music }
  const theme = themeMusicOn(project.settings) ? chosenSong(project.settings, themeTracks) : undefined
  return theme ? { tracks: [theme], theme } : { tracks: [] }
}

/** The song chooser of the Music tab: the show's theme's songs, the other themes' songs, the songs of no theme. */
export interface SongGroups {
  theme: ThemeTrack[]
  other: ThemeTrack[]
  library: ThemeTrack[]
}

/** The songs in the chooser's groups, each in catalogue order; with a mood only the songs of that mood. */
export function songGroups(theme: ThemeId, tracks: readonly ThemeTrack[], mood: Mood | null = null): SongGroups {
  const shown = mood ? tracks.filter((t) => t.moods.includes(mood)) : tracks
  return {
    theme: shown.filter((t) => t.themes.includes(theme)),
    other: shown.filter((t) => t.themes.length > 0 && !t.themes.includes(theme)),
    library: shown.filter((t) => t.themes.length === 0)
  }
}

/** The moods that songs of the catalogue have, in MOODS order (the chooser offers only those). */
export function moodsIn(tracks: readonly ThemeTrack[]): Mood[] {
  return MOODS.map((m) => m.id).filter((id) => tracks.some((t) => t.moods.includes(id)))
}

/**
 * How songs follow each other: the theme song always loops through the whole show, with a smooth
 * crossfade at the loop point. The timeline (beats) and the audio plan both place songs with this.
 */
export function placementAudio(audio: AudioSettings, theme: boolean): AudioSettings {
  return theme ? { ...audio, repeatMusic: true, crossfade: Math.max(audio.crossfade, THEME_LOOP_CROSSFADE) } : audio
}

/** A free licence (CC0, public domain): the song may be used anywhere, also in shared videos. */
export const freeLicence = (licence: string): boolean => /^\s*(cc0|cc-0|public domain|pd\b)/i.test(licence)
