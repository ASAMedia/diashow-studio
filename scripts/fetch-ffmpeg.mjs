// Downloads a pinned FFmpeg build (BtbN, GPL, shared libs) into vendor/ffmpeg.
// The app needs FFmpeg >= 7.1 for HEIF/HEIC tile grids (iPhone, Sony HIF).
// The build is pinned in scripts/ffmpeg-build.json (a month-end BtbN autobuild, kept for two years)
// and checked against its SHA-256. vendor/ffmpeg/build.json records which build is installed: the
// GPL notice in THIRD_PARTY_NOTICES and the About dialog link its release and source.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'vendor', 'ffmpeg')
const PIN = JSON.parse(readFileSync(join(root, 'scripts', 'ffmpeg-build.json'), 'utf8'))
const RELEASES = 'https://github.com/BtbN/FFmpeg-Builds/releases/download'
// the floating "latest" build of the same branch, only when the pinned one is gone
const LATEST = `ffmpeg-n${PIN.branch}-latest-win64-gpl-shared-${PIN.branch}`

if (process.platform !== 'win32') {
  console.log('[fetch-ffmpeg] not on Windows, expecting ffmpeg/ffprobe on PATH')
  process.exit(0)
}
if (existsSync(join(target, 'bin', 'ffmpeg.exe')) && !process.argv.includes('--force')) {
  console.log('[fetch-ffmpeg] already present:', target)
  process.exit(0)
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(url, file) {
  console.log('[fetch-ffmpeg] downloading', url)
  const res = await fetch(url)
  if (!res.ok) return res.status
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file))
  return 200
}

const tmp = join(root, 'vendor', '.download')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
const zip = join(tmp, 'ffmpeg.zip')
let build = { tag: PIN.tag, asset: PIN.asset }
const status = await download(`${RELEASES}/${PIN.tag}/${PIN.asset}.zip`, zip)
if (status === 200) {
  const sum = await sha256(zip)
  if (sum !== PIN.sha256) throw new Error(`[fetch-ffmpeg] checksum mismatch for ${PIN.asset}: ${sum}`)
} else if (status === 404) {
  console.warn(`[fetch-ffmpeg] WARNING: pinned build ${PIN.tag} is gone, using the latest ${PIN.branch} build. Pin a new month-end build in scripts/ffmpeg-build.json.`)
  const again = await download(`${RELEASES}/latest/${LATEST}.zip`, zip)
  if (again !== 200) throw new Error(`download failed: ${again}`)
  build = { tag: 'latest', asset: LATEST }
} else {
  throw new Error(`download failed: ${status}`)
}
console.log('[fetch-ffmpeg] extracting')
// Windows' bsdtar handles zip; a GNU tar earlier on PATH (Git Bash) would not
execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp])
const extracted = readdirSync(tmp).find((d) => d.startsWith('ffmpeg-'))
if (!extracted) throw new Error('unexpected archive layout')
rmSync(target, { recursive: true, force: true })
renameSync(join(tmp, extracted), target)
rmSync(tmp, { recursive: true, force: true })
for (const d of ['doc', 'include', 'lib', 'bin/ffplay.exe']) rmSync(join(target, d), { recursive: true, force: true })
writeFileSync(join(target, 'build.json'), JSON.stringify({ ...build, downloaded: new Date().toISOString() }, null, 1))
console.log('[fetch-ffmpeg] done:', join(target, 'bin'))
