// Checks of renderer input that reaches the file system or FFmpeg outside the export queue (which has
// its own, export/validate.ts): the direct export (benchmark, tests) writes and on cancel deletes its
// output file, so the path must be a video file in an existing folder, never a device path or URL.
// "Problem melden" may open the browser, but only on pages of the project on GitHub (checkProjectUrl).
import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { MAX_URL_LENGTH, PROJECT_PAGE_PREFIX } from '@shared/reportProblem'
import type { ExportOptions } from '@shared/types'
import { validateAudio } from './export/validate'

const OUT_EXT = /\.(mp4|m4v|mov)$/i

/** The strings of a list from the renderer (paths, ids); anything else is dropped. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
}

/**
 * A path FFmpeg may read for the renderer (frames, filmstrip, waveform): an existing local or network
 * file, never a URL or protocol FFmpeg would follow (http:, tcp:, concat:, …) nor a device path. A
 * project file from elsewhere can hold any string as a path; this keeps it from reaching the network.
 * `allow` (netTrust.ts allowPath): a share the user hasn't trusted is refused before it is looked at.
 */
export async function checkLocalFile(raw: unknown, allow?: (path: string) => boolean): Promise<string> {
  if (typeof raw !== 'string' || !raw || raw.length > 4000 || raw.includes('\0') || !isAbsolute(raw)) throw new Error('not a local file')
  // "C:\…" and "\\server\share\…" only: no "scheme:" (a drive letter is one character), no \\?\, \\.\ or \??\
  if (/^[a-z][a-z0-9+.-]+:/i.test(raw) || /^(?:[\\/]{2}[?.]|[\\/]\?\?)[\\/]/.test(raw)) throw new Error('not a local file')
  if (allow && !allow(raw)) throw new Error('network-blocked: the share is not trusted')
  const st = await stat(raw).catch(() => null)
  if (!st?.isFile()) throw new Error(`ENOENT: no such file '${raw}'`)
  return raw
}

/** An output path the export may write (and delete on cancel): an absolute .mp4/.m4v/.mov in an existing folder. */
export function checkOutputPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 1000 || raw.includes('\0') || !isAbsolute(raw)) throw new Error('the output must be an absolute file path')
  if (/^[\\/]{2}[?.][\\/]/.test(raw)) throw new Error('the output must be an ordinary file path')
  if (raw.indexOf(':', /^[A-Za-z]:/.test(raw) ? 2 : 0) >= 0) throw new Error('the output must be an ordinary file path')
  if (!OUT_EXT.test(raw)) throw new Error('the output must be an .mp4, .m4v or .mov file')
  const out = resolve(raw)
  let folder = false
  try {
    folder = statSync(dirname(out)).isDirectory()
  } catch {
    // missing
  }
  if (!folder) throw new Error(`the folder ${dirname(out)} does not exist`)
  return out
}

/** The direct export's options (export:start), checked; returns a clean copy. */
export function checkDirectExport(raw: unknown): ExportOptions {
  if (!raw || typeof raw !== 'object') throw new Error('invalid export options')
  const o = raw as Record<string, unknown>
  const outPath = checkOutputPath(o.outPath)
  const int = (v: unknown, min: number, max: number, what: string): number => {
    if (!(typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max)) throw new Error(`invalid ${what}`)
    return v
  }
  const width = int(o.width, 16, 8192, 'width')
  const height = int(o.height, 16, 8192, 'height')
  if (!(typeof o.fps === 'number' && Number.isFinite(o.fps) && o.fps >= 1 && o.fps <= 240)) throw new Error('invalid frame rate')
  if (o.codec !== 'h264' && o.codec !== 'hevc') throw new Error('invalid codec')
  if (o.quality !== 'standard' && o.quality !== 'high' && o.quality !== 'max') throw new Error('invalid quality')
  if (o.input !== undefined && !['rgba', 'yuv', 'h264', 'hevc'].includes(o.input as string)) throw new Error('invalid export input')
  return {
    // fields this check does not know (added later) pass through; the ones that reach disk and FFmpeg are checked
    ...(o as unknown as ExportOptions),
    outPath,
    width,
    height,
    fps: o.fps,
    codec: o.codec,
    quality: o.quality,
    hardware: o.hardware === true,
    audio: validateAudio(o.audio),
    ...(o.input !== undefined ? { input: o.input as ExportOptions['input'] } : {})
  }
}

/**
 * A URL the browser may open for the app (shell:open-github): a page of the project on GitHub
 * (https://github.com/ASAMedia/diashow-studio/…), nothing else. Returns it as the URL parser
 * normalises it; throws for anything else, also for tricks that leave the project after parsing
 * ("/../", "%2e%2e", encoded slashes, user names, ports, control characters).
 */
export function checkProjectUrl(raw: unknown): string {
  const fail = (): never => {
    throw new Error('only pages of the project on GitHub can be opened')
  }
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH || !raw.startsWith(PROJECT_PAGE_PREFIX)) return fail()
  if (/[\s\\\u0000-\u001f\u007f-\u009f]/.test(raw)) return fail()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return fail()
  }
  const prefix = new URL(PROJECT_PAGE_PREFIX)
  if (url.protocol !== 'https:' || url.host !== prefix.host || url.username || url.password || url.port) return fail()
  if (!url.pathname.startsWith(prefix.pathname) || /%2f|%5c|%2e/i.test(url.pathname)) return fail()
  return url.href
}
