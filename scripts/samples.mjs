// The sample trip: freely licensed photos and videos (CC0 or public domain, from Wikimedia Commons),
// arranged as a five-day class trip to Athens. The handbook screenshots (e2e/handbook-shots.spec.ts)
// and the website's demo video (e2e/demo-video.spec.ts) are made from it, and it is a quick way to
// try the app with real pictures. The media are not committed (samples/media/ is in .gitignore);
// this script fetches and prepares them:
//
//   npm run samples [-- --only <id,…>] [--force] [--cache <folder>]
//
// samples/samples.json lists every item: its id, the file it becomes, the story day and its folder,
// the capture date to set, a description, whether it shows faces (paintings, busts, a gold mask: for
// the privacy pictures), the source page, the download URL, the licence and author, the SHA-256 of
// the download and, for videos, the part to keep (`clip`: start and length in seconds).
//
// For each item it
// - downloads `url` into a new empty temp folder, with a User-Agent that says who asks (Wikimedia's
//   rule), and checks it against `sha256`. An item without one (a new item) gets the hash of its first
//   download written into the manifest; a different hash stops the item (the file changed upstream:
//   look at it, then empty its sha256). Nothing downloaded is ever run: photos are decoded by sharp,
//   videos by FFmpeg, and exiftool only writes tags into our own copy.
// - photos: JPEG (quality 88, sRGB), upright, long edge at most 3000 px. EXIF DateTimeOriginal and
//   CreateDate are the item's date; Artist, Copyright and ImageDescription name the source. Nothing
//   else of the original's metadata is kept (no GPS, no camera serials).
// - videos: MP4, H.264 1080p (1920×1080, upright clips 1080×1920) at the original frame rate, AAC
//   sound when the original has any, only the `clip` part; creation_time is the item's date.
// - sets the file's modification time to the date too (local time of this PC, like a camera's clock),
//   and puts it into samples/media/<folder>/<day folder>/, e.g. "Studienfahrt Athen 2026/1_Montag
//   Anreise/IMG_20260504_055200.jpg", so "Chapters from folder names" gives the days their titles.
//
// Re-runnable: samples/media/.made.json remembers what each file was made from; a file that is there,
// unchanged and made from the same item and settings is skipped. Files of items no longer in the
// manifest are removed. --force makes every file again, --only some of them (ids or file names).
// --cache <folder> keeps the checked downloads there, so making the files again downloads nothing.
//
// It also writes samples/SOURCES.md (file, day, description, author, licence and page of every item)
// from the manifest.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { ExifTool } from 'exiftool-vendored'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const samples = join(root, 'samples')
const MANIFEST = join(samples, 'samples.json')
const SOURCES = join(samples, 'SOURCES.md')
const mediaRoot = join(samples, 'media')
const MADE = join(mediaRoot, '.made.json')
const USER_AGENT = 'DiashowStudio-samples/1.0 (open-source slideshow app; https://github.com/ASAMedia/diashow-studio)'
const bin = (name) => {
  const local = join(root, 'vendor', 'ffmpeg', 'bin', process.platform === 'win32' ? `${name}.exe` : name)
  return existsSync(local) ? local : name
}
const FFMPEG = bin('ffmpeg')
const FFPROBE = bin('ffprobe')
/** What a made file depends on besides its item; a change here makes every file again. */
const RECIPE = { photo: { maxEdge: 3000, quality: 88, profile: 'none', colorSpace: 'sRGB' }, video: { height: 1080, crf: 19, preset: 'slow', audio: '160k' }, version: 1 }

// ---------- arguments
const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const force = args.includes('--force')
const only = option('--only')?.split(',').map((s) => s.trim()).filter(Boolean)
const cache = option('--cache') ? resolve(option('--cache')) : null
if (args.includes('--help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
  process.exit(0)
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const days = new Map(manifest.days.map((d) => [d.day, d]))
const target = join(mediaRoot, manifest.folder)
for (const item of manifest.items) {
  if (!/^[a-z0-9-]+$/.test(item.id)) throw new Error(`samples.json: bad id "${item.id}"`)
  if (!/^(IMG|VID)_\d{8}_\d{6}\.(jpg|mp4)$/.test(item.file)) throw new Error(`${item.id}: bad file name "${item.file}"`)
  if (days.get(item.day)?.folder !== item.folder) throw new Error(`${item.id}: folder "${item.folder}" is not day ${item.day}'s`)
  if (!item.date.startsWith(days.get(item.day).date)) throw new Error(`${item.id}: date ${item.date} is not on day ${item.day}`)
  if (!/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(item.url)) throw new Error(`${item.id}: downloads come from Wikimedia only`)
}
const ids = new Set(manifest.items.map((i) => i.id))
if (ids.size !== manifest.items.length) throw new Error('samples.json: an id is used twice')
const unknown = only?.filter((x) => !manifest.items.some((i) => i.id === x || i.file === x))
if (unknown?.length) throw new Error(`--only: no item ${unknown.join(', ')}`)

// ---------- helpers
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`

/** Downloads `url` to `file`, retrying a few times when the server is busy. */
async function download(url, file) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (res.ok) {
      await pipeline(Readable.fromWeb(res.body), createWriteStream(file))
      return
    }
    await res.body?.cancel()
    if (attempt >= 4 || !(res.status === 429 || res.status >= 500)) throw new Error(`HTTP ${res.status} for ${url}`)
    await sleep(attempt * 5000)
  }
}

/** The local date of an item ("2026-05-04T05:52:00" is 5:52 on this PC's clock). */
const localDate = (s) => {
  const [d, t] = s.split('T')
  const [y, mo, da] = d.split('-').map(Number)
  const [h, mi, se] = t.split(':').map(Number)
  return new Date(y, mo - 1, da, h, mi, se || 0)
}
const exifDate = (s) => s.replace(/-/g, ':').replace('T', ' ')

/**
 * The checked download of an item, in a new empty temp folder (or from --cache). Returns its path
 * and a function that removes the temp folder.
 */
async function fetchItem(item) {
  const name = decodeURIComponent(item.url.split('/').pop()).replace(/[^\w.,()'-]+/g, '_')
  const cached = cache && item.sha256 ? join(cache, `${item.sha256}${name.slice(name.lastIndexOf('.'))}`) : null
  if (cached && existsSync(cached) && (await sha256(cached)) === item.sha256) return { file: cached, done: () => {} }
  const dir = mkdtempSync(join(tmpdir(), 'diashow-samples-'))
  const done = () => rmSync(dir, { recursive: true, force: true })
  try {
    const file = join(dir, name)
    process.stdout.write(`  downloading ${item.id} … `)
    await download(item.url, file)
    const hash = await sha256(file)
    console.log(`${mb(statSync(file).size)}`)
    if (!item.sha256) {
      // written at once, so a run that stops later keeps it
      item.sha256 = hash
      writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
      console.log(`  ${item.id}: new item, SHA-256 ${hash} written to samples.json`)
    } else if (hash !== item.sha256) {
      throw new Error(`${item.id}: the download's SHA-256 is ${hash}, samples.json expects ${item.sha256}. The file changed on Wikimedia: check it, then empty its sha256 to accept the new one.`)
    }
    if (cache) {
      mkdirSync(cache, { recursive: true })
      const keep = join(cache, `${hash}${name.slice(name.lastIndexOf('.'))}`)
      copyFileSync(file, keep)
    }
    return { file, done }
  } catch (e) {
    done()
    throw e
  }
}

const ffprobe = (file) => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8', maxBuffer: 1 << 26 }))

// ---------- making the files

async function makePhoto(item, src, out, et) {
  const tmp = `${out}.part.jpg`
  await sharp(src, { limitInputPixels: 2e8 })
    .rotate()
    .resize({ width: RECIPE.photo.maxEdge, height: RECIPE.photo.maxEdge, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
    // sRGB without a profile in the file: an embedded one would show up as the "device" in the app
    .toColourspace('srgb')
    .jpeg({ quality: RECIPE.photo.quality, mozjpeg: true })
    .toFile(tmp)
  await et.write(
    tmp,
    {
      DateTimeOriginal: exifDate(item.date),
      CreateDate: exifDate(item.date),
      // exiftool would mark a new EXIF block "uncalibrated"
      ColorSpace: 'sRGB',
      Artist: item.author,
      Copyright: `${item.licence}, ${item.page}`,
      ImageDescription: item.description
    },
    { writeArgs: ['-overwrite_original'] }
  )
  renameSync(tmp, out)
}

function makeVideo(item, src, out) {
  const info = ffprobe(src)
  const video = info.streams.find((s) => s.codec_type === 'video')
  const audio = info.streams.some((s) => s.codec_type === 'audio')
  if (!video) throw new Error(`${item.id}: no video stream`)
  const upright = video.height > video.width
  const [w, h] = upright ? [RECIPE.video.height, Math.round((RECIPE.video.height * 16) / 9)] : [Math.round((RECIPE.video.height * 16) / 9), RECIPE.video.height]
  const { start, duration } = item.clip
  const tmp = `${out}.part.mp4`
  const created = localDate(item.date).toISOString()
  execFileSync(
    FFMPEG,
    [
      '-v', 'error', '-y', '-nostdin',
      '-ss', String(start), '-i', src, '-t', String(duration),
      '-map', '0:v:0', ...(audio ? ['-map', '0:a:0'] : []),
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1`,
      '-c:v', 'libx264', '-preset', RECIPE.video.preset, '-crf', String(RECIPE.video.crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      ...(audio ? ['-c:a', 'aac', '-b:a', RECIPE.video.audio, '-ac', '2', '-af', `afade=t=in:d=0.3,afade=t=out:st=${Math.max(0, duration - 0.4)}:d=0.4`] : []),
      '-map_metadata', '-1', '-metadata', `creation_time=${created}`,
      '-movflags', '+faststart',
      tmp
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
  renameSync(tmp, out)
}

// ---------- SOURCES.md

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
function sourcesMd() {
  const rows = manifest.items.map((i) => {
    const day = days.get(i.day)
    const part = i.kind === 'video' ? ` – clip of ${i.clip.duration} s from ${clock(i.clip.start)}` : ''
    return `| \`${i.file}\` | ${cell(day.folder)} | ${cell(i.description)}${part}${i.faces ? ' – faces' : ''} | ${cell(i.author)} | ${cell(i.licence)}; the page says \`${cell(i.licenceTemplate)}\` | ${i.page} |`
  })
  const count = (kind) => manifest.items.filter((i) => i.kind === kind).length
  return `# Sample trip: sources and licences

The sample media of Diashow Studio are ${count('photo')} photos and ${count('video')} video clips from Wikimedia Commons, arranged as a
five-day class trip ("${manifest.title.de}"). The handbook screenshots and the demo video on the website
are made from them.

All of them are free to use, change and share without asking, also in published videos. Most are
CC0 1.0: their authors waived every right. Three are photographs of paintings whose painters died more
than 100 years ago, which are in the public domain. Credit is not required, but it is given here. The
licence statements are quoted from each file's page on Wikimedia Commons, checked on 2026-10-12.

The files are not in the repository: \`npm run samples\` downloads them into \`samples/media/\` (see
\`scripts/samples.mjs\`). \`samples/samples.json\` lists the download URLs and the SHA-256 of every download.

What the script changes:
- the capture dates are made up for the story (Monday 4 to Friday 8 May 2026) and written to EXIF and
  the file time. The real dates and places are on each file's page; not every picture was taken where
  the story puts it (the food was photographed on Crete, the evening time-lapse in Linz, and so on);
- photos: at most 3000 px on the long edge, JPEG, without the original's other metadata;
- videos: a part of 8 to 15 seconds, as MP4 (H.264, 1080p).

No picture shows an identifiable living person: people in the station, street and beach pictures are
tiny figures in the distance. The faces are those of paintings, sculptures and a gold mask (marked
"faces" below); they are what the privacy pictures pixelate.

| File | Day folder | What it shows | Author | Licence | Page |
|---|---|---|---|---|---|
${rows.join('\n')}
`
}

function putText(file, text) {
  const old = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (old === text) return false
  writeFileSync(file, text)
  return true
}

// ---------- run

const made = readJson(MADE, {})
/** Everything a made file depends on: its source, date and settings, and for photos the tags written into them. */
const recipeOf = (item) =>
  JSON.stringify(
    item.kind === 'photo'
      ? { url: item.url, sha256: item.sha256, date: item.date, tags: [item.author, item.licence, item.page, item.description], recipe: RECIPE.photo, version: RECIPE.version }
      : { url: item.url, sha256: item.sha256, date: item.date, clip: item.clip, recipe: RECIPE.video, version: RECIPE.version }
  )
const wanted = manifest.items.filter((i) => !only || only.includes(i.id) || only.includes(i.file))
mkdirSync(target, { recursive: true })
const et = new ExifTool({ maxProcs: 2, taskTimeoutMillis: 60_000 })
const failed = []
let fresh = 0
let skipped = 0
try {
  for (const item of wanted) {
    const dir = join(target, item.folder)
    const out = join(dir, item.file)
    const rel = relative(mediaRoot, out).replaceAll('\\', '/')
    const prev = made[rel]
    if (!force && prev && prev.recipe === recipeOf(item) && existsSync(out) && statSync(out).size === prev.size && (await sha256(out)) === prev.sha256) {
      skipped++
      continue
    }
    console.log(`${item.id} → ${rel}`)
    let got
    try {
      got = await fetchItem(item)
      mkdirSync(dir, { recursive: true })
      if (item.kind === 'photo') await makePhoto(item, got.file, out, et)
      else makeVideo(item, got.file, out)
      const when = localDate(item.date)
      utimesSync(out, when, when)
      // the recipe includes the sha256, which a new item only has now
      made[rel] = { id: item.id, recipe: recipeOf(item), size: statSync(out).size, sha256: await sha256(out) }
      writeFileSync(MADE, JSON.stringify(made, null, 1))
      fresh++
    } catch (e) {
      console.error(`  FAILED ${item.id}: ${e.message}`)
      failed.push(item.id)
    } finally {
      got?.done()
    }
  }
} finally {
  await et.end()
}

// files of items that are no longer in the manifest
if (!only) {
  const keep = new Set(manifest.items.map((i) => `${manifest.folder}/${i.folder}/${i.file}`))
  for (const rel of Object.keys(made)) {
    if (keep.has(rel)) continue
    rmSync(join(mediaRoot, ...rel.split('/')), { force: true })
    delete made[rel]
    console.log(`removed ${rel} (no longer in samples.json)`)
  }
  for (const folder of existsSync(target) ? readdirSync(target) : []) {
    const dir = join(target, folder)
    if (statSync(dir).isDirectory() && !readdirSync(dir).length) rmSync(dir, { recursive: true })
  }
  writeFileSync(MADE, JSON.stringify(made, null, 1))
}

if (putText(SOURCES, sourcesMd())) console.log('samples/SOURCES.md written')

const files = manifest.items.map((i) => join(target, i.folder, i.file)).filter((f) => existsSync(f))
const total = files.reduce((s, f) => s + statSync(f).size, 0)
console.log(`${fresh} made, ${skipped} already there; samples/media holds ${files.length} of ${manifest.items.length} files (${mb(total)}) in "${relative(root, target)}".`)
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`)
  process.exitCode = 1
}
