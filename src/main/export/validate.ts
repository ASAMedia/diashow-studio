// Checks of what the renderer sends to the export queue: new jobs (output path, size, codec, the
// audio plan whose sources FFmpeg reads), job ids and segment inputs.
import { statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { ExportJobRequest, NewExportJob, SegmentInput } from '@shared/exportQueue'
import type { AudioPlan, AudioPlanClip, ExportQuality, Project } from '@shared/types'
import { MAX_CHAPTER_TITLE, oneLine, type Chapter } from '@shared/chapters'
import { THEMES } from '@shared/themes'
import { isMood, isSongId, type ThemeTrack } from '@shared/themeMusic'

/** Job ids, also the names of the job folders. */
export const ID_RE = /^[0-9a-z]{6,12}-[0-9a-f]{8}$/
const OUT_EXT = /\.(mp4|m4v|mov)$/i
const QUALITIES: readonly ExportQuality[] = ['standard', 'high', 'max']
const INPUTS: readonly SegmentInput[] = ['yuv', 'rgba', 'h264', 'hevc']

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function validateRequest(raw: unknown): ExportJobRequest {
  if (!isObject(raw)) throw new Error('export request missing')
  const { outPath, width, height, fps, codec, quality, hardware, locale, hires } = raw
  if (typeof outPath !== 'string' || !outPath || outPath.length > 1000 || outPath.includes('\0') || !isAbsolute(outPath)) {
    throw new Error('the output must be an absolute file path')
  }
  if (!OUT_EXT.test(outPath)) throw new Error('the output must be an .mp4, .m4v or .mov file')
  const out = resolve(outPath)
  let folder = false
  try {
    folder = statSync(dirname(out)).isDirectory()
  } catch {
    // missing
  }
  if (!folder) throw new Error(`the folder ${dirname(out)} does not exist`)
  for (const [key, v] of [['width', width], ['height', height]] as const) {
    if (!(Number.isInteger(v) && (v as number) >= 16 && (v as number) <= 8192)) throw new Error(`invalid ${key}`)
  }
  if (!(finite(fps) && fps >= 1 && fps <= 240)) throw new Error('invalid frame rate')
  if (codec !== 'h264' && codec !== 'hevc') throw new Error('invalid codec')
  if (!QUALITIES.includes(quality as ExportQuality)) throw new Error('invalid quality')
  if (typeof locale !== 'string' || !/^[A-Za-z0-9-]{1,35}$/.test(locale)) throw new Error('invalid locale')
  if (hires !== undefined && typeof hires !== 'boolean') throw new Error('invalid hires flag')
  return {
    outPath: out,
    width: width as number,
    height: height as number,
    fps,
    codec,
    quality: quality as ExportQuality,
    hardware: hardware === true,
    locale,
    ...(hires !== undefined ? { hires } : {})
  }
}

function validateClip(raw: unknown, i: number): AudioPlanClip {
  if (!isObject(raw)) throw new Error(`audio clip ${i} invalid`)
  const { id, kind, src, start, offset, duration, gain } = raw
  const rate = (raw as { rate?: unknown }).rate
  if (typeof id !== 'string' || id.length > 200) throw new Error(`audio clip ${i}: invalid id`)
  if (kind !== 'music' && kind !== 'video') throw new Error(`audio clip ${i}: invalid kind`)
  // FFmpeg reads it: a local file only, never a URL or protocol, no device path (\\?\…, \\.\…, \??\…)
  // and no alternate data stream (a colon past the drive letter), as for dsmedia:// (protocol.ts)
  if (typeof src !== 'string' || !src || src.length > 2000 || src.includes('\0') || !isAbsolute(src)) throw new Error(`audio clip ${i}: invalid source`)
  if (/^[\\/]{2}[?.][\\/]|^[\\/]\?\?[\\/]/.test(src) || src.indexOf(':', /^[A-Za-z]:/.test(src) ? 2 : 0) >= 0) throw new Error(`audio clip ${i}: invalid source`)
  for (const [key, v] of [['start', start], ['offset', offset], ['duration', duration]] as const) {
    if (!(finite(v) && v >= 0)) throw new Error(`audio clip ${i}: invalid ${key}`)
  }
  if (!Array.isArray(gain) || gain.length > 100_000) throw new Error(`audio clip ${i}: invalid gain`)
  const points = gain.map((p) => {
    if (!isObject(p) || !finite(p.t) || !finite(p.g) || p.g < 0) throw new Error(`audio clip ${i}: invalid gain point`)
    return { t: p.t, g: p.g }
  })
  if (rate !== undefined && !(finite(rate) && rate > 0 && rate <= 100)) throw new Error(`audio clip ${i}: invalid rate`)
  const clip: AudioPlanClip = { id, kind, src, start: start as number, offset: offset as number, duration: duration as number, gain: points }
  if (rate !== undefined) (clip as AudioPlanClip & { rate?: number }).rate = rate
  return clip
}

export function validateAudio(raw: unknown): AudioPlan {
  if (!isObject(raw)) throw new Error('audio plan missing')
  const { duration, clips } = raw
  if (!(finite(duration) && duration > 0 && duration <= 24 * 3600)) throw new Error('invalid show duration')
  if (!Array.isArray(clips) || clips.length > 10_000) throw new Error('invalid audio clips')
  return { duration, clips: clips.map(validateClip) }
}

/** Chapter marks: ascending starts inside the show, one-line titles (they go into an ffmetadata file). */
export function validateChapters(raw: unknown, duration: number): Chapter[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length > 1000) throw new Error('invalid chapters')
  let last = -1
  return raw.map((c, i) => {
    if (!isObject(c)) throw new Error(`chapter ${i} invalid`)
    const { start, title } = c
    if (!(finite(start) && start >= 0 && start < duration)) throw new Error(`chapter ${i}: invalid start`)
    if (start <= last) throw new Error(`chapter ${i}: chapters must be in ascending order`)
    last = start
    const text = typeof title === 'string' ? oneLine(title).slice(0, MAX_CHAPTER_TITLE) : ''
    if (!text) throw new Error(`chapter ${i}: invalid title`)
    return { start, title: text }
  })
}

const isTheme = (v: unknown): v is ThemeTrack['themes'][number] => THEMES.some((t) => t.id === v)

/**
 * The theme song of a job: only what the worker's timeline needs (song, themes, length, beats), as a
 * clean copy. A job queued by 1.2 names it by its theme, which is also the id of that theme's song.
 */
export function validateThemeSong(raw: unknown): ThemeTrack | undefined {
  if (raw === undefined) return undefined
  if (!isObject(raw)) throw new Error('invalid theme song')
  const { id, path, title, duration, beats, bpm, loudness } = raw
  const legacy = raw.song === undefined
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('theme song: invalid id')
  if (legacy && !isTheme(raw.theme)) throw new Error('theme song: unknown theme')
  const song = legacy ? raw.theme : raw.song
  const themes = legacy ? [raw.theme] : raw.themes
  const moods = raw.moods ?? []
  if (!isSongId(song)) throw new Error('theme song: invalid song id')
  if (!(Array.isArray(themes) && themes.length <= THEMES.length && themes.every(isTheme))) throw new Error('theme song: unknown theme')
  if (!(Array.isArray(moods) && moods.length <= 20 && moods.every(isMood))) throw new Error('theme song: unknown mood')
  if (typeof path !== 'string' || !path || path.length > 2000 || path.includes('\0') || !isAbsolute(path)) throw new Error('theme song: invalid path')
  if (!(finite(duration) && duration > 0)) throw new Error('theme song: invalid duration')
  if (beats !== undefined && !(Array.isArray(beats) && beats.length <= 100_000 && beats.every(finite))) throw new Error('theme song: invalid beats')
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  return {
    id,
    song,
    themes: [...themes],
    moods: [...moods],
    path,
    playback: path,
    title: text(title, 300),
    duration,
    status: 'ready',
    ...(beats ? { beats: beats as number[] } : {}),
    ...(finite(bpm) ? { bpm } : {}),
    ...(finite(loudness) ? { loudness } : {}),
    licence: text(raw.licence, 100),
    source: text(raw.source, 500)
  }
}

/** Checks a job coming from the renderer; returns a clean copy. */
export function validateNewJob(raw: unknown): NewExportJob {
  if (!isObject(raw)) throw new Error('invalid export job')
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 200) : ''
  if (!name) throw new Error('the export job needs a name')
  const project = raw.project
  if (!isObject(project) || typeof project.id !== 'string' || !Array.isArray(project.media) || !Array.isArray(project.entries) || !isObject(project.settings)) {
    throw new Error('the export job needs a project')
  }
  const request = validateRequest(raw.request)
  const audio = validateAudio(raw.audio)
  const chapters = validateChapters(raw.chapters, audio.duration)
  const themeSong = validateThemeSong(raw.themeSong)
  return { name, project: project as unknown as Project, request, audio, ...(chapters?.length ? { chapters } : {}), ...(themeSong ? { themeSong } : {}) }
}

export function validateId(id: unknown): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('invalid export job id')
  return id
}

export function validateInput(input: unknown): SegmentInput {
  if (!INPUTS.includes(input as SegmentInput)) throw new Error(`unknown segment input: ${String(input)}`)
  return input as SegmentInput
}
