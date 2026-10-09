// Downloads a pinned FFmpeg build (BtbN, GPL, shared libs) into vendor/ffmpeg.
// The app needs FFmpeg >= 7.1 for HEIF/HEIC tile grids (iPhone, Sony HIF).
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'vendor', 'ffmpeg')
const VERSION = '9.0'
const NAME = `ffmpeg-n${VERSION}-latest-win64-gpl-shared-${VERSION}`
const URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${NAME}.zip`

if (process.platform !== 'win32') {
  console.log('[fetch-ffmpeg] not on Windows, expecting ffmpeg/ffprobe on PATH')
  process.exit(0)
}
if (existsSync(join(target, 'bin', 'ffmpeg.exe')) && !process.argv.includes('--force')) {
  console.log('[fetch-ffmpeg] already present:', target)
  process.exit(0)
}

const tmp = join(root, 'vendor', '.download')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
const zip = join(tmp, 'ffmpeg.zip')
console.log('[fetch-ffmpeg] downloading', URL)
const res = await fetch(URL)
if (!res.ok) throw new Error(`download failed: ${res.status}`)
await pipeline(Readable.fromWeb(res.body), createWriteStream(zip))
console.log('[fetch-ffmpeg] extracting')
// Windows' bsdtar handles zip; a GNU tar earlier on PATH (Git Bash) would not
execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp])
const extracted = readdirSync(tmp).find((d) => d.startsWith('ffmpeg-'))
if (!extracted) throw new Error('unexpected archive layout')
rmSync(target, { recursive: true, force: true })
renameSync(join(tmp, extracted), target)
rmSync(tmp, { recursive: true, force: true })
for (const d of ['doc', 'include', 'lib', 'bin/ffplay.exe']) rmSync(join(target, d), { recursive: true, force: true })
console.log('[fetch-ffmpeg] done:', join(target, 'bin'))
