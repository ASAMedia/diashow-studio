// Integrated loudness (EBU R128) of an audio file with FFmpeg's ebur128 filter.
import type { Ffmpeg } from '../ffmpeg'

/**
 * Quieter than this counts as silence: normalising it would only amplify noise. ebur128 reports
 * -70 LUFS (its absolute gate) for digital silence.
 */
export const SILENCE_LUFS = -60

/** Parses the "Integrated loudness: I: -23.0 LUFS" summary ebur128 logs at the end. */
export function parseIntegratedLoudness(log: string): number | undefined {
  const m = /Integrated loudness:\s*[\r\n]+\s*I:\s*(-?[\d.]+|-?inf|nan)\s*LUFS/i.exec(log)
  if (!m) return undefined
  const value = Number(m[1])
  return Number.isFinite(value) ? value : undefined
}

/**
 * Integrated loudness of the first audio stream in LUFS, rounded to 0.1; undefined for silent or
 * near-silent audio (below SILENCE_LUFS). Throws when FFmpeg cannot decode the file.
 */
export async function measureLoudness(ff: Ffmpeg, path: string, signal?: AbortSignal): Promise<number | undefined> {
  const log = await ff.log(['-i', path, '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { signal })
  const lufs = parseIntegratedLoudness(log)
  if (lufs === undefined || lufs < SILENCE_LUFS) return undefined
  return Math.round(lufs * 10) / 10
}
