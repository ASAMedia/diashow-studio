// Theme music: the bundled song of every theme (resources/theme-music, see src/shared/themeMusic.ts).
//
//   npm run theme-music -- <folder> [--only kenburns,origami] [--max 150] [--no-normalize]
//   npm run theme-music -- --placeholders [--only …] [--force]
//   --out <folder> writes somewhere else than resources/theme-music (to try it out first)
//
// <folder> holds the downloaded songs named by theme id (kenburns.mp3, origami.wav, … in any format
// FFmpeg reads) and sources.json, which says what each song is:
//
//   { "kenburns": { "title": "…", "artist": "…", "licence": "CC0 1.0", "source": "https://…",
//                   "start": 0, "maxSeconds": 150 }, … }
//
// "start" and "maxSeconds" are optional (seconds; --max sets maxSeconds for every song). A song that
// is cut gets a fade-out at the cut. Every song is brought to −16 LUFS (two-pass loudnorm, like the
// app's "Even out loudness") and stored as AAC 160 kbps stereo 48 kHz in resources/theme-music/
// <theme>.m4a. theme-music.json then lists per theme its file, title, artist, licence, source and
// length, plus the beats and tempo found by the app's own beat tracking (src/main/media/beats.ts) and
// the loudness, so the app needs no analysis at start. Themes without a file in the folder keep
// their current song.
//
// --placeholders makes generated stand-ins (FFmpeg lavfi: a kick drum, bass and chords, a different
// tempo and key per theme), marked "placeholder": true. They never replace a real song unless --force.
//
// Needs Node 22.18 or newer: it imports the app's TypeScript (beat tracking, loudness) directly.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET_LUFS = -16

if (typeof process.features.typescript !== 'string') {
  console.error('npm run theme-music needs Node 22.18 or newer: it imports src/main/media/beats.ts directly.')
  process.exit(1)
}

// The app's sources import without file extensions and use constructor parameter properties, which
// Node's own type stripping refuses: these hooks add ".ts" and transform instead of only stripping.
const hooks = `
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
let shared = ''
export function initialize(data) { shared = data.shared }
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@shared/')) return next(pathToFileURL(shared + '/' + specifier.slice(8) + '.ts').href, context)
  if (/^\\.\\.?\\//.test(specifier) && context.parentURL?.endsWith('.ts') && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + '.ts', context)
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, context)
  const source = await readFile(fileURLToPath(url), 'utf8')
  return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
}
`
register(`data:text/javascript,${encodeURIComponent(hooks)}`, { data: { shared: join(root, 'src', 'shared') } })
const src = (path) => pathToFileURL(join(root, 'src', ...path.split('/'))).href
const { THEMES } = await import(src('shared/themes.ts'))
const { Ffmpeg } = await import(src('main/ffmpeg.ts'))
const { detectBeatsInFile } = await import(src('main/media/beats.ts'))
const { measureLoudness } = await import(src('main/media/loudness.ts'))
const THEME_IDS = THEMES.map((t) => t.id)

// ---------- arguments
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const placeholders = flag('--placeholders')
const force = flag('--force')
const normalize = !flag('--no-normalize')
const maxAll = option('--max') !== undefined ? Number(option('--max')) : undefined
const only = option('--only')?.split(',').map((s) => s.trim()).filter(Boolean)
const folder = args.find((a, i) => !a.startsWith('--') && !['--max', '--only', '--ffmpeg', '--out'].includes(args[i - 1]))
const outDir = resolve(option('--out') ?? join(root, 'resources', 'theme-music'))
const INDEX = join(outDir, 'theme-music.json')
const ff = new Ffmpeg(option('--ffmpeg') ?? join(root, 'vendor', 'ffmpeg', 'bin'))
if (!placeholders && !folder) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
  process.exit(1)
}

/** Stops the run; nothing in the theme-music folder has changed yet. */
function fail(message) {
  throw new Error(message)
}

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits

// ---------- placeholders: a kick on every beat, bass and chords per bar, each theme in its own tempo and key
const PLACEHOLDERS = {
  kenburns: { bpm: 84, root: 220, seconds: 72 },
  origami: { bpm: 112, root: 246.94, seconds: 64 },
  reflections: { bpm: 76, root: 196, seconds: 84 },
  panels: { bpm: 120, root: 261.63, seconds: 62 },
  vintage: { bpm: 92, root: 174.61, seconds: 76, minor: true },
  classic: { bpm: 100, root: 233.08, seconds: 70 },
  magazine: { bpm: 126, root: 277.18, seconds: 62 },
  retro: { bpm: 132, root: 207.65, seconds: 66, minor: true },
  scrapbook: { bpm: 96, root: 293.66, seconds: 74 },
  snapshots: { bpm: 108, root: 329.63, seconds: 68 },
  shatter: { bpm: 88, root: 185, seconds: 60, minor: true }
}

/**
 * An aevalsrc expression (mono): a kick with a click on every beat, bass and chords. Nothing sounds
 * between the beats (a hi-hat there made the beat tracking pick 2/3 of the tempo).
 */
function placeholderExpr({ bpm, root: f, minor }) {
  const B = 60 / bpm
  const bar = 4 * B
  // I–V–vi–IV, or i–VI–III–VII in minor (frequency ratios of the chord roots)
  const roots = minor ? [1, 1.5874, 1.1892, 1.7818] : [1, 1.4983, 1.6818, 1.3348]
  const third = minor ? 1.1892 : 1.2599
  const pick = `if(eq(ld(2),0),${roots[0]},if(eq(ld(2),1),${roots[1]},if(eq(ld(2),2),${roots[2]},${roots[3]})))`
  return [
    `st(1,mod(t,${B}))`,
    `st(2,mod(floor(t/${bar}),4))`,
    `st(3,${f}*${pick})`,
    `st(4,mod(t,${bar}))`,
    `st(5,min(1,ld(4)*6)*min(1,(${bar}-ld(4))*6))`,
    [
      `0.55*sin(2*PI*52*ld(1))*exp(-ld(1)*12)`,
      `0.25*sin(2*PI*1500*ld(1))*exp(-ld(1)*160)`,
      `0.16*sin(PI*ld(3)*t)*exp(-ld(1)*2.5)`,
      `ld(5)*0.06*(sin(2*PI*ld(3)*t)+sin(2*PI*ld(3)*${third}*t)+sin(2*PI*ld(3)*1.4983*t))`
    ].join('+')
  ].join(';')
}

async function makePlaceholder(id, wav) {
  const p = PLACEHOLDERS[id]
  await ff.run([
    '-f', 'lavfi', '-i', `aevalsrc='${placeholderExpr(p)}':s=48000:d=${p.seconds}`,
    '-af', `afade=t=in:d=0.05,afade=t=out:st=${p.seconds - 1.5}:d=1.5`,
    '-ac', '2', '-c:a', 'pcm_s16le', wav
  ])
  return {
    title: `Placeholder ${p.bpm} BPM`,
    artist: 'Diashow Studio',
    licence: 'CC0 1.0',
    source: 'generated by scripts/theme-music.mjs',
    placeholder: true
  }
}

// ---------- real songs
const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|aif|aiff|mka|webm|mp4)$/i

function readSources(dir) {
  const file = join(dir, 'sources.json')
  if (!existsSync(file)) fail(`${file} is missing (title, artist, licence and source of each song)`)
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    fail(`${file}: ${e.message}`)
  }
}

/** What sources.json says about a song; complains about anything missing before the long work starts. */
function songInfo(meta, path) {
  if (!meta || typeof meta !== 'object') fail(`sources.json has no entry for ${path}`)
  for (const key of ['title', 'artist', 'licence', 'source']) if (typeof meta[key] !== 'string' || !meta[key].trim()) fail(`sources.json: "${key}" missing for ${path}`)
  if (!/^(cc0|cc-0|public domain|pd\b)/i.test(meta.licence)) console.warn(`[theme-music] ${path}: licence "${meta.licence}" is not CC0 / public domain`)
  return { title: meta.title.trim(), artist: meta.artist.trim(), licence: meta.licence.trim(), source: meta.source.trim() }
}

/** The song cut to start / maxSeconds (fading out at a cut), as WAV. */
async function prepareSong(path, meta, wav) {
  const length = Number((await ff.probe(path)).format.duration) || 0
  const start = Math.max(0, Number(meta.start) || 0)
  const max = Number(meta.maxSeconds) || maxAll || Infinity
  const keep = Math.min(max, length - start)
  if (!(keep > 5)) fail(`${path}: less than 5 seconds left after start ${start}`)
  const cut = keep < length - start - 0.05
  await ff.run([
    ...(start ? ['-ss', String(start)] : []), '-i', path,
    ...(cut ? ['-t', String(keep), '-af', `afade=t=out:st=${Math.max(0, keep - 3)}:d=3`] : []),
    '-map', '0:a:0', '-vn', '-ac', '2', '-c:a', 'pcm_s16le', wav
  ])
}

// ---------- encoding and analysis
/** Two-pass loudnorm to −16 LUFS (linear, so the music keeps its dynamics) and AAC 160 kbps stereo 48 kHz. */
async function encode(wav, m4a, info) {
  let filter = []
  if (normalize) {
    const log = await ff.log(['-i', wav, '-af', `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'])
    const m = JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1))
    filter = ['-af', `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`]
  }
  await ff.run([
    '-i', wav, ...filter, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-metadata', `title=${info.title}`, '-metadata', `artist=${info.artist}`, '-metadata', `comment=${info.licence} ${info.source}`,
    '-movflags', '+faststart', '-f', 'mp4', m4a
  ])
}

async function analyse(m4a) {
  const duration = Number((await ff.probe(m4a)).format.duration) || 0
  const beats = await detectBeatsInFile(ff, m4a)
  const loudness = await measureLoudness(ff, m4a)
  return { duration: round(duration, 3), ...(beats ? { bpm: beats.bpm, beats: beats.beats } : {}), ...(loudness !== undefined ? { loudness } : {}) }
}

// ---------- run
// Every song is made and analysed in a temp folder first; the theme-music folder only changes when
// all of them worked, so a failed run never leaves a new file next to an old theme-music.json.
async function run(work) {
  if (only?.some((id) => !THEME_IDS.includes(id))) fail(`unknown theme in --only; themes: ${THEME_IDS.join(', ')}`)
  if (maxAll !== undefined && !(maxAll > 5)) fail('--max wants seconds (more than 5)')
  let index = { version: 1, songs: {} }
  if (existsSync(INDEX)) {
    try {
      index = JSON.parse(readFileSync(INDEX, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      console.warn('[theme-music] theme-music.json was unreadable and is written anew')
    }
  }
  const sources = folder ? readSources(resolve(folder)) : {}
  const files = folder ? readdirSync(resolve(folder)).filter((n) => AUDIO.test(n)) : []
  const todo = []
  for (const id of only ?? THEME_IDS) {
    const current = index.songs[id]
    const file = files.find((n) => n.replace(/\.[^.]+$/, '').toLowerCase() === id)
    if (placeholders ? current && !current.placeholder && !force : !file) {
      console.log(`[theme-music] ${id}: kept (${current ? `"${current.title}"` : 'none'})`)
      continue
    }
    const path = file && join(resolve(folder), file)
    todo.push({ id, path, info: placeholders ? null : songInfo(sources[id], path) })
  }
  const made = []
  for (const { id, path, info: known } of todo) {
    const wav = join(work, `${id}.wav`)
    const info = known ?? (await makePlaceholder(id, wav))
    if (known) await prepareSong(path, sources[id], wav)
    const m4a = join(work, `${id}.m4a`)
    await encode(wav, m4a, info)
    const facts = await analyse(m4a)
    made.push({ id, m4a, entry: { file: `${id}.m4a`, ...info, ...facts } })
    console.log(`[theme-music] ${id}: "${info.title}" ${facts.duration.toFixed(1)} s, ${facts.bpm ?? '?'} BPM, ${facts.beats?.length ?? 0} beats, ${facts.loudness ?? '?'} LUFS`)
  }
  mkdirSync(outDir, { recursive: true })
  for (const { id, m4a, entry } of made) {
    copyFileSync(m4a, join(outDir, `${id}.m4a`))
    index.songs[id] = entry
  }
  // themes in a fixed order, so the file diffs well
  const songs = Object.fromEntries(THEME_IDS.filter((id) => index.songs[id]).map((id) => [id, index.songs[id]]))
  const json = JSON.stringify({ version: 1, note: 'Written by scripts/theme-music.mjs (npm run theme-music). Licences: THIRD_PARTY_NOTICES.txt.', songs }, null, 2)
  // beat lists on one line each
  writeFileSync(INDEX, `${json.replace(/"beats": \[\s+([^\]]*?)\s+\]/g, (_, list) => `"beats": [${list.split(/,\s*/).join(', ')}]`)}\n`)
  console.log(`[theme-music] ${made.length} song(s) written, ${Object.keys(songs).length} of ${THEME_IDS.length} themes have one -> ${INDEX}`)
}

const work = mkdtempSync(join(tmpdir(), 'theme-music-'))
try {
  await run(work)
} catch (e) {
  console.error(`[theme-music] ${e instanceof Error ? e.message : e}`)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
