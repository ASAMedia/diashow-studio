// The bundled theme songs (src/shared/themeMusic.ts): resources/theme-music with theme-music.json,
// written by scripts/theme-music.mjs. Packaged builds ship the folder in resources/theme-music
// (electron-builder extraResources), development runs read it from the repository. Electron-free.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { extOf, NATIVE_AUDIO_EXT } from '@shared/formats'
import { THEMES } from '@shared/themes'
import type { AudioPlan, ThemeId } from '@shared/types'
import type { ThemeTrack } from '@shared/themeMusic'

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

/**
 * The songs of a theme-music.json as playable tracks with absolute paths in `dir`. Entries of unknown
 * themes, without a plain file name (no folders) of a format Chromium plays, or without a length are
 * left out.
 */
export function parseThemeCatalog(raw: unknown, dir: string): ThemeTrack[] {
  const songs = isObj(raw) && isObj(raw.songs) ? raw.songs : {}
  const out: ThemeTrack[] = []
  for (const theme of THEMES.map((t) => t.id)) {
    const s = songs[theme]
    if (!isObj(s)) continue
    const file = text(s.file, 100)
    if (!file || basename(file) !== file || /[\\/:]/.test(file) || file.startsWith('.') || !NATIVE_AUDIO_EXT.includes(extOf(file))) continue
    if (!(num(s.duration) && s.duration > 0)) continue
    const path = join(dir, file)
    const beats = Array.isArray(s.beats) && s.beats.every(num) ? (s.beats as number[]).slice(0, 20_000) : undefined
    out.push({
      id: `theme-${theme}`,
      theme,
      path,
      playback: path,
      title: text(s.title) || theme,
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

/** Reads the theme songs of `dir`; songs whose file is missing are left out. Never rejects. */
export async function loadThemeMusic(dir: string): Promise<ThemeTrack[]> {
  if (!dir) return []
  try {
    const raw = JSON.parse((await readFile(join(dir, THEME_MUSIC_INDEX), 'utf8')).replace(/^\uFEFF/, '')) as unknown
    return parseThemeCatalog(raw, dir).filter((t) => existsSync(t.path))
  } catch {
    return []
  }
}

/** The theme a track of this folder belongs to ("…\theme-music\origami.m4a"), else null. */
export function themeOfFile(path: string): ThemeId | null {
  if (basename(dirname(path)).toLowerCase() !== THEME_MUSIC_FOLDER) return null
  const name = basename(path).replace(/\.[^.]+$/, '')
  return THEMES.find((t) => t.id === name)?.id ?? null
}

/**
 * An export job keeps the theme song's path from when it was queued. The portable exe unpacks to a
 * new temp folder at every start, so a job resumed after a restart finds the song in today's folder.
 */
export function rebaseThemeMusic(plan: AudioPlan, dir: string): AudioPlan {
  if (!dir) return plan
  const here = resolve(dir).toLowerCase()
  let changed = false
  const clips = plan.clips.map((c) => {
    if (c.kind !== 'music' || existsSync(c.src) || !themeOfFile(c.src) || resolve(dirname(c.src)).toLowerCase() === here) return c
    const moved = join(dir, basename(c.src))
    if (!existsSync(moved)) return c
    changed = true
    return { ...c, src: moved }
  })
  return changed ? { ...plan, clips } : plan
}
