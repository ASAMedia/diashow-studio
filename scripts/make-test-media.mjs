// Generates small, representative test media in test-media/ (gitignored):
// iPhone (HEIC + Live Photo MOV, HEVC HLG with rotation, JPEG with orientation + P3),
// Android (rotated MP4, plain JPEG, Motion Photo), Sony (JPEG + placeholder ARW, 10-bit 4:2:2 HIF,
// XAVC S / HS / S-I style MP4 with PCM, AVCHD tree), misc formats and music.
// Usage: node scripts/make-test-media.mjs [--force]
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'test-media')
const DONE = join(out, '.complete-v2')
const require = createRequire(import.meta.url)
const sharp = require('sharp')

if (existsSync(DONE) && !process.argv.includes('--force')) {
  console.log('[test-media] up to date:', out)
  process.exit(0)
}

const isWin = process.platform === 'win32'
const binDir = join(root, 'vendor', 'ffmpeg', 'bin')
const FFMPEG = existsSync(join(binDir, isWin ? 'ffmpeg.exe' : 'ffmpeg')) ? join(binDir, isWin ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg'
const EXIFTOOL = (() => {
  try {
    const pkg = dirname(require.resolve('exiftool-vendored.exe/package.json'))
    return join(pkg, 'bin', 'exiftool.exe')
  } catch {
    return 'exiftool'
  }
})()

rmSync(out, { recursive: true, force: true })
const tmp = join(out, '.gen')
mkdirSync(tmp, { recursive: true })

function p(...parts) {
  const f = join(out, ...parts)
  mkdirSync(dirname(f), { recursive: true })
  return f
}

function ff(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
}

function exif(file, tags) {
  execFileSync(EXIFTOOL, ['-overwrite_original', '-n', ...tags, file], { stdio: ['ignore', 'ignore', 'inherit'] })
}

const FONT = isWin && existsSync('C:\\Windows\\Fonts\\arial.ttf') ? 'C\\:/Windows/Fonts/arial.ttf' : null
function overlay(label, size = 36) {
  if (!FONT) return 'null'
  const common = `fontfile='${FONT}':fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8:fontsize=${size}`
  return `drawtext=${common}:x=20:y=20:text='${label}',drawtext=${common}:x=20:y=h-th-20:text='%{pts\\:hms}'`
}

/** testsrc2 video (+ optional sine audio) encoded with the given args. */
function video({ file, w, h, fps = 30, dur = 4, label, vcodec, audio = null, freq = 440, extra = [], format = null }) {
  const args = ['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=${fps}:d=${dur}`]
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${dur}`)
  args.push('-vf', overlay(label, Math.max(16, Math.round(h / 18))), ...vcodec)
  if (audio) args.push('-ac', '2', ...audio)
  args.push(...extra)
  if (format) args.push('-f', format)
  args.push(file)
  ff(args)
}

/** Re-mux with a display matrix rotation (like phones do for portrait video). */
function withRotation(src, dst, degrees, extra = []) {
  ff(['-display_rotation', String(degrees), '-i', src, '-map', '0', '-c', 'copy', ...extra, dst])
}

/** An asymmetric test image so orientation mistakes are visible: red block at the top-left. */
async function testImage(w, h, label, color = { r: 40, g: 90, b: 160 }) {
  const fontSize = Math.round(h / 10)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="rgb(${color.r},${color.g},${color.b})"/><stop offset="1" stop-color="#f0e0a0"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect x="0" y="0" width="${Math.round(w / 5)}" height="${Math.round(h / 5)}" fill="#ff0000"/>
    <text x="50%" y="55%" font-family="Arial" font-size="${fontSize}" fill="#ffffff" text-anchor="middle">${label}</text>
    <text x="50%" y="${Math.round(h * 0.08)}" font-family="Arial" font-size="${Math.round(fontSize / 2)}" fill="#ffffff" text-anchor="middle">TOP</text>
  </svg>`
  return sharp(Buffer.from(svg)).removeAlpha()
}

function python(script, args) {
  const file = join(tmp, 'gen.py')
  writeFileSync(file, script)
  execFileSync('python', [file, ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
}

let hasPillowHeif = false
try {
  execFileSync('python', ['-c', 'import pillow_heif, numpy'], { stdio: 'ignore' })
  hasPillowHeif = true
} catch {
  console.warn('[test-media] python with pillow_heif + numpy not found: HEIC/HIF samples are skipped')
}

const HEIF_PY = `
import sys, json
import numpy as np
from PIL import Image
import pillow_heif
src, dst, opts = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
im = Image.open(src).convert('RGB')
exif = Image.Exif()
for k, v in opts.get('ifd0', {}).items():
    exif[int(k)] = v
sub = exif.get_ifd(0x8769)
for k, v in opts.get('exif', {}).items():
    sub[int(k)] = v
kw = dict(quality=88, exif=exif.tobytes())
# iPhones store HEIC as a grid of 512x512 tiles; FFmpeg then reports irot on the stream group
pillow_heif.options.GRID_TILE_SIZE = int(opts.get('grid', 0))
if opts.get('tenbit'):
    pillow_heif.options.SAVE_HDR_TO_12_BIT = False
    arr = (np.asarray(im).astype(np.uint16) * 257)
    heif = pillow_heif.from_bytes(mode='RGB;16', size=im.size, data=arr.tobytes())
    kw['chroma'] = opts.get('chroma', 420)
else:
    heif = pillow_heif.from_pillow(im)
for k in ('color_primaries', 'transfer_characteristic', 'matrix_coefficients'):
    if k in opts:
        kw[k] = opts[k]
heif.save(dst, **kw)
`

const step = (name) => console.log('[test-media]', name)

// ---------------------------------------------------------------- iPhone
step('iPhone')
{
  // Stored landscape 1024x768 with EXIF orientation 6 → displayed portrait 768x1024.
  const src = join(tmp, 'img1.png')
  await (await testImage(1024, 768, 'IMG_0001 HEIC')).png().toFile(src)
  if (hasPillowHeif) {
    python(HEIF_PY, [src, p('iphone', 'IMG_0001.HEIC'), JSON.stringify({
      grid: 512,
      ifd0: { 274: 6, 271: 'Apple', 272: 'iPhone 15 Pro' },
      exif: { 36867: '2025:07:14 18:30:00', 36881: '+02:00' },
      // Display P3 like an iPhone
      color_primaries: 12, transfer_characteristic: 13, matrix_coefficients: 6
    })])
  }
  // Live Photo motion part: HEVC 640x480 stored landscape, rotation metadata → portrait.
  const live = join(tmp, 'live.mov')
  video({ file: live, w: 640, h: 480, fps: 30, dur: 3, label: 'LIVE 0001', vcodec: ['-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error'], audio: ['-c:a', 'aac', '-b:a', '96k'] })
  withRotation(live, p('iphone', 'IMG_0001.MOV'), -90, ['-movflags', 'use_metadata_tags', '-metadata', 'com.apple.quicktime.make=Apple', '-metadata', 'com.apple.quicktime.model=iPhone 15 Pro', '-metadata', 'com.apple.quicktime.creationdate=2025-07-14T18:30:00+0200'])
  writeFileSync(p('iphone', 'IMG_0001.AAE'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>\n')

  // HEVC Main10 HLG, 1280x720 stored, rotated 90 → displayed 720x1280, AAC audio.
  const hlg = join(tmp, 'hlg.mov')
  video({
    file: hlg, w: 1280, h: 720, fps: 30, dur: 4, label: 'IMG_0002 HLG', freq: 523,
    vcodec: ['-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p10le', '-profile:v', 'main10',
      '-x265-params', 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
      '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc'],
    audio: ['-c:a', 'aac', '-b:a', '128k']
  })
  withRotation(hlg, p('iphone', 'IMG_0002.MOV'), -90, ['-movflags', 'use_metadata_tags', '-metadata', 'com.apple.quicktime.make=Apple', '-metadata', 'com.apple.quicktime.model=iPhone 15 Pro', '-metadata', 'com.apple.quicktime.creationdate=2025-07-14T18:31:00+0200'])

  // JPEG 1200x900 with orientation 6 and a Display P3 ICC profile → displayed 900x1200.
  const jpg = p('iphone', 'IMG_0003.JPG')
  await (await testImage(1200, 900, 'IMG_0003 JPG', { r: 30, g: 160, b: 60 })).withIccProfile('p3').jpeg({ quality: 90 }).toFile(jpg)
  exif(jpg, ['-Orientation=6', '-Make=Apple', '-Model=iPhone 15 Pro', '-DateTimeOriginal=2025:07:14 18:32:00', '-OffsetTimeOriginal=+02:00'])
}

// ---------------------------------------------------------------- Android
step('Android')
{
  const rot = join(tmp, 'pxl1.mp4')
  video({ file: rot, w: 1280, h: 720, fps: 30, dur: 4, label: 'PXL_0001', freq: 660, vcodec: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'], audio: ['-c:a', 'aac', '-b:a', '128k'] })
  withRotation(rot, p('android', 'PXL_0001.mp4'), -90, ['-metadata', 'creation_time=2025-08-01T10:00:00Z'])

  const jpg = p('android', 'PXL_0002.jpg')
  await (await testImage(1600, 1200, 'PXL_0002', { r: 160, g: 60, b: 40 })).jpeg({ quality: 88 }).toFile(jpg)
  exif(jpg, ['-Make=Google', '-Model=Pixel 8', '-DateTimeOriginal=2025:08:01 12:01:00', '-OffsetTimeOriginal=+02:00'])

  // Google Motion Photo (MicroVideo v1): JPEG + XMP offset + appended MP4.
  const mv = join(tmp, 'motion.mp4')
  video({ file: mv, w: 640, h: 480, fps: 30, dur: 2, label: 'MOTION', vcodec: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'], extra: ['-movflags', '+faststart'] })
  const mp = p('android', 'PXL_0003.MP.jpg')
  await (await testImage(1200, 900, 'PXL_0003 MOTION', { r: 120, g: 40, b: 160 })).jpeg({ quality: 88 }).toFile(mp)
  const size = statSync(mv).size
  exif(mp, ['-Make=Google', '-Model=Pixel 8', '-DateTimeOriginal=2025:08:01 12:02:00',
    '-XMP-GCamera:MicroVideo=1', '-XMP-GCamera:MicroVideoVersion=1', `-XMP-GCamera:MicroVideoOffset=${size}`, '-XMP-GCamera:MicroVideoPresentationTimestampUs=1000000'])
  appendFileSync(mp, readFileSync(mv))
}

// ---------------------------------------------------------------- Sony
step('Sony')
{
  const dcim = ['sony', 'DCIM', '100MSDCF']
  const jpg = p(...dcim, 'DSC00001.JPG')
  await (await testImage(1600, 1067, 'DSC00001 JPG', { r: 200, g: 120, b: 20 })).jpeg({ quality: 90 }).toFile(jpg)
  exif(jpg, ['-Make=SONY', '-Model=ILCE-7M4', '-DateTimeOriginal=2025:09:10 09:00:00', '-OffsetTimeOriginal=+02:00'])
  // Placeholder: a real ARW cannot be synthesised. It only exercises RAW+JPEG pairing (the RAW is dropped).
  writeFileSync(p(...dcim, 'DSC00001.ARW'), 'placeholder, not a real Sony ARW\n')

  if (hasPillowHeif) {
    const src = join(tmp, 'hif.png')
    await (await testImage(1200, 800, 'DSC00002 HIF 422 10bit', { r: 20, g: 120, b: 200 })).png().toFile(src)
    python(HEIF_PY, [src, p(...dcim, 'DSC00002.HIF'), JSON.stringify({
      tenbit: true, chroma: 422,
      ifd0: { 271: 'SONY', 272: 'ILCE-7M4' },
      exif: { 36867: '2025:09:10 09:01:00', 36881: '+02:00' },
      color_primaries: 1, transfer_characteristic: 1, matrix_coefficients: 1
    })])
  }

  const clip = ['sony', 'PRIVATE', 'M4ROOT', 'CLIP']
  const pcm = ['-c:a', 'pcm_s16be']
  const xavc = ['-brand', 'XAVC', '-metadata', 'creation_time=2025-09-10T07:02:00Z']
  // XAVC S style: H.264 8-bit 4:2:0 + PCM (PCM forces a proxy: Chromium cannot play LPCM in MP4)
  video({ file: p(...clip, 'C0001.MP4'), w: 1280, h: 720, fps: 50, dur: 4, label: 'C0001 XAVC S', freq: 330, vcodec: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-profile:v', 'high'], audio: pcm, extra: xavc, format: 'mov' })
  // XAVC HS style: HEVC 4:2:2 10-bit + PCM
  video({ file: p(...clip, 'C0002.MP4'), w: 1280, h: 720, fps: 25, dur: 4, label: 'C0002 XAVC HS', freq: 392, vcodec: ['-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv422p10le', '-profile:v', 'main422-10', '-x265-params', 'log-level=error'], audio: pcm, extra: xavc, format: 'mov' })
  writeFileSync(p(...clip, 'C0002M01.XML'), `<?xml version="1.0" encoding="UTF-8"?>
<NonRealTimeMeta xmlns="urn:schemas-professionalDisc:nonRealTimeMeta:ver.2.20" lastUpdate="2025-09-10T09:02:30+02:00">
  <Duration value="100"/>
  <CreationDate value="2025-09-10T09:02:30+02:00"/>
  <Device manufacturer="Sony" modelName="ILCE-7M4" serialNo="0000000"/>
</NonRealTimeMeta>
`)
  // XAVC S-I style: H.264 4:2:2 10-bit all-intra + PCM
  video({ file: p(...clip, 'C0003.MP4'), w: 1280, h: 720, fps: 25, dur: 3, label: 'C0003 XAVC S-I', freq: 494, vcodec: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv422p10le', '-profile:v', 'high422', '-g', '1'], audio: pcm, extra: xavc, format: 'mov' })
  // Card thumbnails must not be imported as photos
  await (await testImage(160, 90, 'T')).jpeg().toFile(p('sony', 'PRIVATE', 'M4ROOT', 'THMBNL', 'C0001T01.JPG'))

  // AVCHD tree: MPEG-TS with H.264 + AC-3 plus BDMV sidecars
  const bdmv = ['sony', 'PRIVATE', 'AVCHD', 'BDMV']
  video({ file: p(...bdmv, 'STREAM', '00000.MTS'), w: 1280, h: 720, fps: 25, dur: 3, label: '00000 AVCHD', freq: 587, vcodec: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'], audio: ['-c:a', 'ac3', '-b:a', '192k'], format: 'mpegts' })
  writeFileSync(p(...bdmv, 'index.bdm'), 'INDX0100')
  writeFileSync(p(...bdmv, 'CLIPINF', '00000.CPI'), 'HDMV0100')
  writeFileSync(p(...bdmv, 'PLAYLIST', '00000.MPL'), 'MPLS0100')
}

// ---------------------------------------------------------------- Misc
step('misc')
{
  await (await testImage(3000, 750, 'PANORAMA', { r: 90, g: 90, b: 200 })).png().toFile(p('misc', 'pano.png'))
  await (await testImage(800, 600, 'WEBP', { r: 10, g: 140, b: 140 })).webp({ quality: 85 }).toFile(p('misc', 'photo.webp'))
  video({ file: p('misc', 'clip.webm'), w: 640, h: 360, fps: 30, dur: 3, label: 'WEBM VP9', freq: 440, vcodec: ['-c:v', 'libvpx-vp9', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p'], audio: ['-c:a', 'libopus', '-b:a', '96k'] })
  video({ file: p('misc', 'plain.mp4'), w: 640, h: 360, fps: 30, dur: 3, label: 'PLAIN H264', freq: 880, vcodec: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-profile:v', 'high'], audio: ['-c:a', 'aac', '-b:a', '128k'], extra: ['-movflags', '+faststart'] })
  await (await testImage(320, 240, 'HIDDEN')).jpeg().toFile(p('misc', '.hidden.jpg'))
  writeFileSync(p('misc', 'Thumbs.db'), 'x')
  writeFileSync(p('misc', 'notes.txt'), 'not media')
}

// ---------------------------------------------------------------- Music
step('music')
{
  const tone = (freq, dur) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=44100:duration=${dur}`, '-f', 'lavfi', '-i', `sine=frequency=${freq * 1.5}:sample_rate=44100:duration=${dur}`, '-filter_complex', '[0][1]amerge=inputs=2,volume=0.5']
  ff([...tone(440, 6), '-c:a', 'libmp3lame', '-b:a', '160k', '-metadata', 'title=Morning Tone', '-metadata', 'artist=Test Orchestra', p('music', 'track1.mp3')])
  ff([...tone(330, 5), '-c:a', 'aac', '-b:a', '160k', '-metadata', 'title=Evening Tone', '-metadata', 'artist=Test Orchestra', p('music', 'track2.m4a')])
  ff([...tone(550, 5), '-c:a', 'wmav2', '-b:a', '128k', '-metadata', 'title=Windows Tone', '-metadata', 'artist=Legacy Band', p('music', 'track3.wma')])
  // ALAC inside .m4a: same extension as a native file, but the codec needs a transcode
  ff([...tone(660, 4), '-c:a', 'alac', p('music', 'track4-alac.m4a')])
}

rmSync(tmp, { recursive: true, force: true })
writeFileSync(DONE, new Date().toISOString())
console.log('[test-media] done:', out)
