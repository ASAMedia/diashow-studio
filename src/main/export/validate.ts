// Checks of what the renderer sends to the export queue: new jobs (output path, size, codec, the
// audio plan whose sources FFmpeg reads), job ids and segment inputs.
import { statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { ExportJobRequest, NewExportJob, SegmentInput } from '@shared/exportQueue'
import type { AudioPlan, AudioPlanClip, ExportQuality, Project } from '@shared/types'

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
  // FFmpeg reads it: a local file only, never a URL or protocol
  if (typeof src !== 'string' || !src || src.length > 2000 || src.includes('\0') || !isAbsolute(src)) throw new Error(`audio clip ${i}: invalid source`)
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

function validateAudio(raw: unknown): AudioPlan {
  if (!isObject(raw)) throw new Error('audio plan missing')
  const { duration, clips } = raw
  if (!(finite(duration) && duration > 0 && duration <= 24 * 3600)) throw new Error('invalid show duration')
  if (!Array.isArray(clips) || clips.length > 10_000) throw new Error('invalid audio clips')
  return { duration, clips: clips.map(validateClip) }
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
  return { name, project: project as unknown as Project, request: validateRequest(raw.request), audio: validateAudio(raw.audio) }
}

export function validateId(id: unknown): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('invalid export job id')
  return id
}

export function validateInput(input: unknown): SegmentInput {
  if (!INPUTS.includes(input as SegmentInput)) throw new Error(`unknown segment input: ${String(input)}`)
  return input as SegmentInput
}
