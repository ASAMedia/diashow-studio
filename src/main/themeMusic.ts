// The bundled songs (src/shared/themeMusic.ts): resources/theme-music with theme-music.json, written
// by scripts/theme-music.mjs. Packaged builds ship the folder in resources/theme-music
// (electron-builder extraResources), development runs read it from the repository. Electron-free.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { extOf, NATIVE_AUDIO_EXT } from '@shared/formats'
import { THEMES } from '@shared/themes'
import type { AudioPlan, ThemeId } from '@shared/types'
import { isMood, isSongId, type Mood, type ThemeTrack } from '@shared/themeMusic'

export const THEME_MUSIC_FOLDER = 'theme-music'
export const THEME_MUSIC_INDEX = 'theme-music.json'

export interface ThemeMusicLocation {
  /** process.resourcesPath in a packaged Electron app. */
  resourcesPath?: string
  /** Project root in development (app.getAppPath() or process.cwd()). */
  appPath?: string
  packaged?: boolean
}

/** The folder with the theme songs, '' when there is none (the shows are then silent without music of their own). */
export function resolveThemeMusicDir(loc: ThemeMusicLocation = {}): string {
  const candidates: string[] = []
  if (loc.resourcesPath) candidates.push(join(loc.resourcesPath, THEME_MUSIC_FOLDER))
  if (!loc.packaged) {
    if (loc.appPath) candidates.push(join(loc.appPath, 'resources', THEME_MUSIC_FOLDER))
    candidates.push(join(process.cwd(), 'resources', THEME_MUSIC_FOLDER))
  }
  return candidates.find((d) => existsSync(join(d, THEME_MUSIC_INDEX))) ?? ''
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const text = (v: unknown, max = 300): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const isTheme = (v: unknown): v is ThemeId => THEMES.some((t) => t.id === v)
/** Known values of a list, each once, in their order. */
const known = <T>(v: unknown, ok: (x: unknown) => x is T): T[] => (Array.isArray(v) ? [...new Set(v.filter(ok))] : [])

/** A plain file name (no folders) of a format Chromium plays. */
const songFileName = (file: string): boolean =>
  !!file && basename(file) === file && !/[\\/:]/.test(file) && !file.startsWith('.') && NATIVE_AUDIO_EXT.includes(extOf(file))

/**
 * The entries of a theme-music.json: version 2 lists the songs; version 1 (1.2) had one song per
 * theme, keyed by the theme, which becomes the song's id and its only theme.
 */
function catalogEntries(raw: unknown): Record<string, unknown>[] {
  if (!isObj(raw)) return []
  const songs = raw.songs
  if (Array.isArray(songs)) return songs.filter(isObj)
  if (!isObj(songs)) return []
  return THEMES.flatMap((t) => {
    const s = songs[t.id]
    return isObj(s) ? [{ ...s, id: t.id, themes: [t.id] }] : []
  })
}

/**
 * The songs of a theme-music.json as playable tracks with absolute paths in `dir`, in catalogue
 * order. Entries without a valid id (or with one seen before), without a plain file name of a format
 * Chromium plays or without a length are left out; unknown themes and moods are dropped.
 */
export function parseThemeCatalog(raw: unknown, dir: string): ThemeTrack[] {
  const out: ThemeTrack[] = []
  const seen = new Set<string>()
  for (const s of catalogEntries(raw)) {
    const song = text(s.id, 64)
    if (!isSongId(song) || seen.has(song)) continue
    const file = text(s.file, 100)
    if (!songFileName(file)) continue
    if (!(num(s.duration) && s.duration > 0)) continue
    seen.add(song)
    const path = join(dir, file)
    const beats = Array.isArray(s.beats) && s.beats.every(num) ? (s.beats as number[]).slice(0, 20_000) : undefined
    out.push({
      id: `theme-${song}`,
      song,
      themes: known<ThemeId>(s.themes, isTheme),
      moods: known<Mood>(s.moods, isMood),
      path,
      playback: path,
      title: text(s.title) || song,
      ...(text(s.artist) ? { artist: text(s.artist) } : {}),
      duration: s.duration,
      status: 'ready',
      ...(beats ? { beats } : {}),
      ...(num(s.bpm) ? { bpm: s.bpm } : {}),
      ...(num(s.loudness) ? { loudness: s.loudness } : {}),
      licence: text(s.licence, 100),
      source: text(s.source, 500),
      ...(s.placeholder === true ? { placeholder: true } : {})
    })
  }
  return out
}

/** Reads the songs of `dir`; songs whose file is missing are left out. Never rejects. */
export async function loadThemeMusic(dir: string): Promise<ThemeTrack[]> {
  if (!dir) return []
  try {
    const raw = JSON.parse((await readFile(join(dir, THEME_MUSIC_INDEX), 'utf8')).replace(/^\uFEFF/, '')) as unknown
    return parseThemeCatalog(raw, dir).filter((t) => existsSync(t.path))
  } catch {
    return []
  }
}

/** The file name of a song in a theme-music folder ("…\theme-music\festive-1.m4a" → "festive-1.m4a"), else null. */
export function bundledFileName(path: string): string | null {
  if (typeof path !== 'string' || basename(dirname(path)).toLowerCase() !== THEME_MUSIC_FOLDER) return null
  const name = basename(path)
  return songFileName(name) && isSongId(name.replace(/\.[^.]+$/, '').toLowerCase()) ? name : null
}

/**
 * Where a bundled song is today. The theme song of an export job, and a song added from the library
 * to the show's own music, keep the path of the theme-music folder they came from; the portable exe
 * unpacks to a new temp folder at every start and another PC installs elsewhere. A missing file of
 * some theme-music folder becomes the same file in `dir` when that is there; any other path stays.
 * A path `allow` refuses (a network share the user hasn't trusted) counts as missing, unopened.
 */
export function rebaseBundledPath(path: string, dir: string, allow: (path: string) => boolean = () => true): string {
  if (!dir || !bundledFileName(path) || resolve(dirname(path)).toLowerCase() === resolve(dir).toLowerCase()) return path
  if (allow(path) && existsSync(path)) return path
  const moved = join(dir, basename(path))
  return existsSync(moved) ? moved : path
}

/** An export job's audio plan with its bundled songs (theme song or own songs from the library) in today's folder. */
export function rebaseThemeMusic(plan: AudioPlan, dir: string): AudioPlan {
  if (!dir) return plan
  let changed = false
  const clips = plan.clips.map((c) => {
    const src = c.kind === 'music' ? rebaseBundledPath(c.src, dir) : c.src
    if (src === c.src) return c
    changed = true
    return { ...c, src }
  })
  return changed ? { ...plan, clips } : plan
}
