// The theme song of an archived show ("Diashow als ZIP archivieren", archive.ts). A show that plays a
// bundled theme song gets a copy of the song file in its archive and a note about it in its .dshow
// (ARCHIVED_THEME_SONG). Opening the extracted .dshow (projectFile.ts importProjectFile) keeps theme
// music as it is while this app plays the very same song. When it plays another one (a later version
// with other songs) or has none, the copy becomes the show's own music, looped like the theme song and
// with the show's length kept, so the show still sounds as it did. Electron-free.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { effectiveMusic, themeMusicOn, THEME_LOOP_CROSSFADE, type ThemeTrack } from '@shared/themeMusic'
import type { MusicTrack, Project } from '@shared/types'

/** Top-level field of an archived .dshow; the project opened from it no longer has it. */
export const ARCHIVED_THEME_SONG = 'archivedThemeSong'

export interface ArchivedThemeSong {
  /** The copy, relative to the .dshow, forward slashes ("music/kenburns.m4a"). */
  path: string
  /** Its id in the catalogue it came from. */
  song: string
  title: string
  artist?: string
  /** Seconds. */
  duration: number
  bpm?: number
  beats?: number[]
  loudness?: number
  licence?: string
  source?: string
  /** Length of the show when it was archived, seconds: kept when "Fit to music" would fit the show to the copy. */
  showSeconds?: number
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

/** The note for the copy of a theme song at `path` (relative to the .dshow). */
export function archivedThemeSong(track: ThemeTrack, path: string, showSeconds?: number): ArchivedThemeSong {
  return {
    path,
    song: track.song,
    title: track.title,
    ...(track.artist ? { artist: track.artist } : {}),
    duration: track.duration,
    ...(num(track.bpm) ? { bpm: track.bpm } : {}),
    ...(track.beats?.length ? { beats: track.beats } : {}),
    ...(num(track.loudness) ? { loudness: track.loudness } : {}),
    ...(track.licence ? { licence: track.licence } : {}),
    ...(track.source ? { source: track.source } : {}),
    ...(num(showSeconds) && showSeconds > 0 ? { showSeconds } : {})
  }
}

/** The note of a .dshow, checked; null when it is missing or broken (a relative path inside the folder, a length). */
export function readArchivedThemeSong(raw: unknown): ArchivedThemeSong | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const path = text(o.path, 500)
  if (!path || isAbsolute(path) || /^[A-Za-z]:|\\/.test(path) || path.split('/').some((p) => !p || p === '.' || p === '..')) return null
  if (!(num(o.duration) && o.duration > 0)) return null
  const beats = Array.isArray(o.beats) && o.beats.every(num) ? (o.beats as number[]).slice(0, 20_000) : undefined
  return {
    path,
    song: text(o.song, 64) ?? '',
    title: text(o.title, 300) ?? path.split('/').pop()!,
    ...(text(o.artist, 300) ? { artist: text(o.artist, 300) } : {}),
    duration: o.duration,
    ...(num(o.bpm) ? { bpm: o.bpm } : {}),
    ...(beats ? { beats } : {}),
    ...(num(o.loudness) ? { loudness: o.loudness } : {}),
    ...(text(o.licence, 100) ? { licence: text(o.licence, 100) } : {}),
    ...(text(o.source, 500) ? { source: text(o.source, 500) } : {}),
    ...(num(o.showSeconds) && o.showSeconds > 0 ? { showSeconds: o.showSeconds } : {})
  }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const st = await stat(path)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

function sha256(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')))
  })
}

/** Two files with the same bytes. */
export async function sameContent(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([sizeOf(a), sizeOf(b)])
  if (sa === null || sa !== sb) return false
  try {
    const [ha, hb] = await Promise.all([sha256(a), sha256(b)])
    return ha === hb
  } catch {
    return false
  }
}

/**
 * The project of an opened .dshow without the note; with the archived copy as its own music when the
 * show plays a theme song and this app's song for it is another one (or there is none). `base`: the
 * .dshow's folder (the project's paths are still relative to it). Without `themeTracks` the note just goes.
 */
export async function withArchivedThemeSong(p: Project, base: string, themeTracks?: readonly ThemeTrack[]): Promise<Project> {
  if (!(ARCHIVED_THEME_SONG in p)) return p
  const { [ARCHIVED_THEME_SONG]: raw, ...rest } = p as unknown as Record<string, unknown>
  const project = rest as unknown as Project
  const note = readArchivedThemeSong(raw)
  if (!note || !themeTracks || project.music?.length || !project.settings || !themeMusicOn(project.settings)) return project
  const root = resolve(base)
  const file = resolve(root, ...note.path.split('/'))
  const rel = relative(root, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || (await sizeOf(file)) === null) return project
  const playing = effectiveMusic(project, themeTracks).theme
  if (playing && (await sameContent(playing.path, file))) return project

  // the show's own music now: looped with the theme song's crossfade, the show as long as it was
  const track: MusicTrack = {
    id: `archived-${note.song || 'theme'}`,
    path: note.path,
    title: note.title,
    ...(note.artist ? { artist: note.artist } : {}),
    duration: note.duration,
    status: 'pending',
    ...(note.beats ? { beats: note.beats } : {}),
    ...(note.bpm ? { bpm: note.bpm } : {}),
    ...(note.loudness !== undefined ? { loudness: note.loudness } : {})
  }
  const s = project.settings
  const audio = { ...s.audio, repeatMusic: true, crossfade: Math.max(s.audio.crossfade, THEME_LOOP_CROSSFADE) }
  const timing = s.timing.mode === 'fitToMusic' && note.showSeconds ? { ...s.timing, mode: 'custom' as const, customTotal: Math.round(note.showSeconds * 10) / 10 } : s.timing
  return { ...project, music: [track], settings: { ...s, audio, timing } }
}
