import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ffmpeg, resolveFfmpegDir } from '../../src/main/ffmpeg'

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const TEST_MEDIA = join(ROOT, 'test-media')
export const FFMPEG_DIR = resolveFfmpegDir({ appPath: ROOT })
export const ff = new Ffmpeg(FFMPEG_DIR)

/** Generates test-media/ with scripts/make-test-media.mjs when it is missing. */
export function ensureTestMedia(): void {
  if (existsSync(join(TEST_MEDIA, '.complete-v2'))) return
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'make-test-media.mjs')], { stdio: 'inherit', cwd: ROOT })
}
