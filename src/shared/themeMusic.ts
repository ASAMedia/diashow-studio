// Theme music, like the theme songs of macOS Photos: every theme has a bundled royalty-free (CC0)
// song in resources/theme-music (scripts/theme-music.mjs writes it). A show plays its theme's song
// while it has no songs of its own; its own songs always replace it. Pure: the timeline, the audio
// plan, the editor and the export all ask effectiveMusic() which songs play.
import type { AudioSettings, MusicTrack, Project, ProjectSettings, ThemeId } from './types'

/** One song of resources/theme-music/theme-music.json. */
export interface ThemeSongInfo {
  /** File name inside the theme-music folder, e.g. "kenburns.m4a". */
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
  /** Generated stand-in until the real song is chosen. */
  placeholder?: boolean
}

export interface ThemeMusicCatalog {
  version: 1
  songs: Partial<Record<ThemeId, ThemeSongInfo>>
}

/** A theme song as a playable track (absolute path), with where it comes from. */
export interface ThemeTrack extends MusicTrack {
  /** The theme whose song this is. */
  theme: ThemeId
  licence: string
  source: string
  placeholder?: boolean
}

/** Crossfade at the theme song's loop point, at least (a longer crossfade setting is kept). */
export const THEME_LOOP_CROSSFADE = 3

/** Whose song theme music plays: the one picked, or ('auto') the show's own theme. */
export function chosenTheme(settings: ProjectSettings): ThemeId {
  return settings.themeSong && settings.themeSong !== 'auto' ? settings.themeSong : settings.theme
}

/** The theme song a show asks for, or null when theme music is off (also when the setting is missing). */
export function themeSongId(settings: ProjectSettings): ThemeId | null {
  return settings.themeMusic === true ? chosenTheme(settings) : null
}

export interface EffectiveMusic {
  /** The songs that play, in order: the show's own, or the theme song. */
  tracks: MusicTrack[]
  /** Set when the theme song plays. */
  theme?: ThemeTrack
}

/**
 * Which songs play: the show's own songs whenever it has any; otherwise its theme song, when theme
 * music is on and the song is bundled; otherwise none.
 */
export function effectiveMusic(project: Project, themeTracks: readonly ThemeTrack[] = []): EffectiveMusic {
  if (project.music.length) return { tracks: project.music }
  const id = themeSongId(project.settings)
  const theme = id ? themeTracks.find((t) => t.theme === id) : undefined
  return theme ? { tracks: [theme], theme } : { tracks: [] }
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
