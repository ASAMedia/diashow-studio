// Writes THIRD_PARTY_NOTICES.txt: the licences of everything Diashow Studio ships besides its own
// code. Runs at install (postinstall) and before packaging (npm run dist); electron-builder puts the
// file next to the exe, the About dialog shows it and the release workflow attaches it.
//
//   node scripts/third-party-notices.mjs [--out <file>]     (default: vendor/THIRD_PARTY_NOTICES.txt)
//
// What it covers:
// - FFmpeg (GPL): exact version, configuration, the BtbN release and the source of that version;
// - Electron / Chromium; the fonts (SIL OFL); the face models (MediaPipe, dlib, face-api.js);
// - the theme songs (resources/theme-music/theme-music.json, written by scripts/theme-music.mjs);
// - every npm package in the app: the production dependencies (packed into the app) and the
//   packages the source imports (bundled into main/renderer by Vite), with their dependencies.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(root, 'vendor', 'THIRD_PARTY_NOTICES.txt')
const REPO = 'https://github.com/ASAMedia/diashow-studio'
const LINE = '='.repeat(78)
const RULE = '-'.repeat(78)

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const app = readJson(join(root, 'package.json'))

// ---------- npm packages
/** Bare package names the source imports (Vite bundles them, so they ship even as devDependencies). */
function importedPackages() {
  const names = new Set()
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(m?[jt]sx?)$/.test(n)) {
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g)) {
          const spec = m[1]
          if (/^(\.|\/|node:|@shared\/|@renderer\/)/.test(spec) || spec === 'electron') continue
          const parts = spec.split('/')
          names.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
        }
      }
    }
  }
  walk(join(root, 'src'))
  return names
}

/** Finds an installed package as Node would from `fromDir` (nested node_modules first). */
function resolvePackage(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) return dirname(candidate)
    const up = dirname(dir)
    if (up === dir || !dir.startsWith(root)) return null
    dir = up
  }
}

function collectPackages() {
  const roots = new Set([...Object.keys(app.dependencies ?? {}), ...importedPackages()])
  roots.delete('electron')
  const found = new Map()
  const queue = [...roots].map((name) => ({ name, from: root }))
  while (queue.length) {
    const { name, from } = queue.shift()
    const dir = resolvePackage(name, from)
    if (!dir || found.has(dir)) continue
    const pkg = readJson(join(dir, 'package.json'))
    if (pkg.name === 'electron') continue
    found.set(dir, pkg)
    for (const dep of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) })) queue.push({ name: dep, from: dir })
  }
  return [...found.entries()].map(([dir, pkg]) => ({ dir, pkg })).sort((a, b) => a.pkg.name.localeCompare(b.pkg.name) || a.dir.localeCompare(b.dir))
}

const licenseId = (pkg) =>
  typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(' OR ') : 'UNKNOWN')

function repoUrl(pkg) {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (!r) return pkg.homepage ?? ''
  return r
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^github:/, 'https://github.com/')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
    .replace(/^(?!https?:)([\w-]+\/[\w.-]+)$/, 'https://github.com/$1')
}

function licenceFiles(dir) {
  return readdirSync(dir)
    .filter((n) => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(n) && statSync(join(dir, n)).isFile())
    .sort()
    .map((n) => ({ name: n, text: readFileSync(join(dir, n), 'utf8').slice(0, 64 * 1024).replace(/\r\n/g, '\n').trim() }))
}

const author = (pkg) => (typeof pkg.author === 'string' ? pkg.author : pkg.author?.name ?? '')

/** What some packages contain besides their own code. */
const BUNDLED = {
  'exiftool-vendored.exe':
    'Contains ExifTool by Phil Harvey (https://exiftool.org), free software under the same terms as Perl itself (GPL-1.0-or-later or Artistic License), and a Strawberry Perl runtime; its licences are in bin/exiftool_files/Licenses_Strawberry_Perl.zip of this package (installed unpacked in resources/app.asar.unpacked/node_modules).',
  '@img/sharp-win32-x64':
    'Contains libvips (LGPL-3.0-or-later) and the image libraries it is built with (see versions.json of this package and https://github.com/lovell/sharp-libvips). The DLL is installed unpacked in resources/app.asar.unpacked/node_modules/@img, so it can be replaced.',
  '@img/sharp-wasm32': 'Contains libvips (LGPL-3.0-or-later) compiled to WebAssembly (https://github.com/lovell/sharp-libvips).',
  'libraw-wasm':
    'Contains LibRaw (https://www.libraw.org, LGPL-2.1 or CDDL-1.0, source: https://github.com/LibRaw/LibRaw) compiled to WebAssembly. The package itself is ISC-licensed and includes no licence file. It is installed unpacked in resources/app.asar.unpacked/node_modules/libraw-wasm.',
  '@vladmandic/face-api':
    'Bundles TensorFlow.js (Apache-2.0, Copyright Google LLC, https://github.com/tensorflow/tfjs) and is based on face-api.js by Vincent Mühler (MIT, https://github.com/justadudewhohacks/face-api.js).',
  '@mediapipe/tasks-vision': 'Copyright Google LLC. The package includes no licence file; the Apache License 2.0 text is at the end of this file.',
  mediabunny: 'Mozilla Public License 2.0: the unmodified source of this package is available at the repository above and on npm.'
}

// ---------- FFmpeg
function ffmpegInfo() {
  const dir = join(root, 'vendor', 'ffmpeg')
  const exe = join(dir, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  if (!existsSync(exe)) return null
  let text = ''
  try {
    text = execFileSync(exe, ['-hide_banner', '-version'], { encoding: 'utf8' })
  } catch {
    return null
  }
  const version = /ffmpeg version (\S+)/.exec(text)?.[1] ?? 'unknown'
  const configuration = /configuration: (.*)/.exec(text)?.[1]?.trim() ?? ''
  let build = {}
  try {
    build = readJson(join(dir, 'build.json'))
  } catch {
    // installed before fetch-ffmpeg recorded its build
  }
  const commit = /-g([0-9a-f]{7,40})(?:-|$)/.exec(version)?.[1]
  const licence = existsSync(join(dir, 'LICENSE.txt')) ? readFileSync(join(dir, 'LICENSE.txt'), 'utf8').replace(/\r\n/g, '\n').trim() : ''
  return { version, configuration, build, commit, licence }
}

function ffmpegSection(ff) {
  if (!ff) return ['FFmpeg is not bundled in this build (it is taken from the PATH).']
  const tag = ff.build.tag && ff.build.tag !== 'latest' ? ff.build.tag : ''
  const gpl3 = /--enable-version3/.test(ff.configuration)
  return [
    `FFmpeg ${ff.version}`,
    `Licence: GNU General Public License, version ${gpl3 ? '3' : '2'} or later. This build is configured with`,
    `--enable-gpl${gpl3 ? ' --enable-version3' : ''} and links GPL libraries such as x264 and x265.`,
    '',
    'Diashow Studio starts ffmpeg.exe and ffprobe.exe as separate programs (in resources\\ffmpeg of the',
    'installation folder); they are not linked into Diashow Studio, which stays under the MIT licence.',
    '',
    'Binary build: BtbN FFmpeg-Builds (https://github.com/BtbN/FFmpeg-Builds)',
    tag ? `  release: https://github.com/BtbN/FFmpeg-Builds/releases/tag/${tag}` : '  releases: https://github.com/BtbN/FFmpeg-Builds/releases',
    ff.build.asset ? `  file: ${ff.build.asset}.zip` : '',
    'Corresponding source code of this exact version:',
    ff.commit ? `  FFmpeg: https://github.com/FFmpeg/FFmpeg/tree/${ff.commit}` : '  FFmpeg: https://ffmpeg.org/download.html',
    ff.commit ? `          (archive: https://github.com/FFmpeg/FFmpeg/archive/${ff.commit}.tar.gz)` : '',
    tag
      ? `  Build scripts, which name the version of every included library: https://github.com/BtbN/FFmpeg-Builds/tree/${tag}`
      : '  Build scripts, which name the version of every included library: https://github.com/BtbN/FFmpeg-Builds',
    `  A copy of the FFmpeg source, of the build scripts and of the source of every library compiled`,
    `  into the build (with a manifest) is attached to each Diashow Studio release:`,
    `  ${REPO}/releases`,
    '',
    'Configuration:',
    ...wrap(ff.configuration, 76).map((l) => `  ${l}`),
    '',
    'Licence text (also in resources\\ffmpeg\\LICENSE.txt):',
    '',
    ff.licence || 'GNU General Public License: https://www.gnu.org/licenses/gpl-3.0.html'
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '')
}

function wrap(text, width) {
  const lines = []
  let cur = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + word.length + 1 > width) {
      lines.push(cur)
      cur = word
    } else cur = cur ? `${cur} ${word}` : word
  }
  if (cur) lines.push(cur)
  return lines
}

// ---------- theme songs
const THEME_NAMES = {
  kenburns: 'Ken Burns', origami: 'Origami', reflections: 'Reflections', panels: 'Sliding Panels', vintage: 'Vintage Prints',
  classic: 'Classic', magazine: 'Magazine', retro: 'Retro Film', scrapbook: 'Scrapbook', snapshots: 'Snapshots', shatter: 'Shatter'
}

function themeMusicSection() {
  const file = join(root, 'resources', 'theme-music', 'theme-music.json')
  let songs = []
  try {
    const raw = readJson(file).songs ?? []
    // version 2 lists the songs; 1.2 had one per theme, keyed by the theme
    songs = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, s]) => ({ ...s, id, themes: [id] }))
  } catch {
    return ['No theme songs are bundled in this build.']
  }
  if (!songs.length) return ['No theme songs are bundled in this build.']
  const lines = [
    'Every theme has its own songs, and a small music library adds songs by mood. They play while a',
    'slideshow has no music of its own, or as songs of its own. The songs are free to use (CC0 /',
    'public domain), also in exported and shared videos. They are installed in resources\\theme-music',
    'of the installation folder.',
    ''
  ]
  for (const s of songs) {
    const where = s.themes?.length ? s.themes.map((t) => THEME_NAMES[t] ?? t).join(', ') : `music library (${(s.moods ?? []).join(', ')})`
    lines.push(`${where}: "${s.title}"${s.artist ? ` by ${s.artist}` : ''}`, `  file: ${s.file}`, `  licence: ${s.licence}`, `  source: ${s.source}`)
    if (s.placeholder) lines.push('  (a placeholder generated for development, no third-party content)')
    lines.push('')
  }
  return lines
}

// ---------- assemble
const packages = collectPackages()
const fonts = packages.filter((p) => p.pkg.name.startsWith('@fontsource/'))
const npm = packages.filter((p) => !p.pkg.name.startsWith('@fontsource/'))
const ff = ffmpegInfo()
const electronPkg = existsSync(join(root, 'node_modules', 'electron', 'package.json')) ? readJson(join(root, 'node_modules', 'electron', 'package.json')) : null
const apache = existsSync(join(root, 'node_modules', 'sharp', 'LICENSE')) ? readFileSync(join(root, 'node_modules', 'sharp', 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim() : ''
const pkgVersion = (name) => packages.find((p) => p.pkg.name === name)?.pkg.version ?? '?'

const fontLicences = [...new Set(fonts.map((p) => licenseId(p.pkg)))].join(', ')
const parts = []
const section = (title, lines) => parts.push('', LINE, title, LINE, '', ...lines)

parts.push(
  `Diashow Studio ${app.version} - third-party notices`,
  '',
  `Diashow Studio is free software under the MIT licence (${REPO}).`,
  'It includes the software and data listed below, each under its own licence.',
  '',
  'Contents',
  '  1. Diashow Studio (MIT)',
  '  2. FFmpeg (GPL)',
  '  3. Electron and Chromium',
  `  4. Fonts (${fontLicences})`,
  '  5. Face detection and recognition models',
  '  6. Theme music',
  `  7. npm packages (${npm.length})`,
  '  8. Apache License 2.0'
)

section('1. Diashow Studio', [existsSync(join(root, 'LICENSE')) ? readFileSync(join(root, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim() : 'MIT'])
section('2. FFmpeg', ffmpegSection(ff))
section('3. Electron and Chromium', [
  `Electron ${electronPkg?.version ?? ''} (MIT), https://github.com/electron/electron`,
  'Chromium and the libraries it uses come with their own licences, listed in LICENSES.chromium.html',
  'in the installation folder. Electron\'s licence is in LICENSE.electron.txt there and below.',
  '',
  existsSync(join(root, 'node_modules', 'electron', 'LICENSE')) ? readFileSync(join(root, 'node_modules', 'electron', 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim() : ''
])
section('4. Fonts', [
  'The fonts are bundled from the Fontsource packages (the CSS of each package is MIT-licensed);',
  `the fonts themselves are under the licence named with each (${fontLicences}).`,
  '',
  ...fonts.flatMap(({ dir, pkg }) => [RULE, `${pkg.name} ${pkg.version}  (${licenseId(pkg)})`, repoUrl(pkg), '', ...licenceFiles(dir).map((f) => f.text), ''])
])
section('5. Face detection and recognition models', [
  `Face detection: MediaPipe Tasks Vision ${pkgVersion('@mediapipe/tasks-vision')} (Apache-2.0, Copyright Google LLC,`,
  'https://github.com/google-ai-edge/mediapipe) with the BlazeFace short-range model',
  '(blaze_face_short_range.tflite, Apache-2.0, Copyright Google LLC). Its usage statistics are blocked.',
  '',
  "Face recognition (\"pixelate this person everywhere\"): dlib's face recognition ResNet model v1 by",
  'Davis E. King (http://dlib.net, https://github.com/davisking/dlib-models), released into the',
  'public domain (CC0-1.0), as converted and quantised by face-api.js (MIT, Copyright 2018 Vincent',
  `Mühler) and shipped with @vladmandic/face-api ${pkgVersion('@vladmandic/face-api')} (MIT), which bundles TensorFlow.js`,
  '(Apache-2.0, Copyright Google LLC).',
  '',
  'All models run offline on this computer; no picture leaves it.'
])
section('6. Theme music', themeMusicSection())
section(
  `7. npm packages`,
  npm.flatMap(({ dir, pkg }) => {
    const files = licenceFiles(dir)
    const id = licenseId(pkg)
    const head = [RULE, `${pkg.name} ${pkg.version}  (${id})`]
    const repo = repoUrl(pkg)
    if (repo) head.push(repo)
    if (BUNDLED[pkg.name]) head.push('', ...wrap(BUNDLED[pkg.name], 78))
    head.push('')
    if (files.length) return [...head, ...files.flatMap((f) => [f.text, ''])]
    if (/^Apache-2\.0$/.test(id)) return [...head, 'Licensed under the Apache License 2.0 (text in section 8).', '']
    const who = author(pkg)
    return [...head, `${id} licence${who ? `, Copyright ${who}` : ''}. The package includes no licence file; see ${repo || `https://www.npmjs.com/package/${pkg.name}`}.`, '']
  })
)
section('8. Apache License 2.0', [apache || 'https://www.apache.org/licenses/LICENSE-2.0'])

const text = `${parts.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, text.replace(/\n/g, '\r\n'), 'utf8')
console.log(`[third-party-notices] ${npm.length} npm packages, ${fonts.length} fonts, FFmpeg ${ff?.version ?? 'not bundled'} -> ${relative(process.cwd(), out) || out}`)
