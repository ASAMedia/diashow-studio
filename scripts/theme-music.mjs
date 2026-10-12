// Theme music: the bundled songs (resources/theme-music, see src/shared/themeMusic.ts). Every theme
// has two or three songs, the first is its default; a small library adds songs by mood (some belong
// to no theme, e.g. a festive march for graduations).
//
//   npm run theme-music -- <folder> [--only kenburns-2,festive-1] [--max 150] [--bitrate 128] [--no-normalize]
//   npm run theme-music -- --placeholders [--only …] [--force] [--bitrate 128]
//   --out <folder> writes somewhere else than resources/theme-music (to try it out first)
//
// <folder> holds the downloaded songs named by song id (kenburns-2.mp3, festive-1.flac, … in any
// format FFmpeg reads) and sources.json, a list that says what each song is:
//
//   [ { "id": "festive-1", "themes": [], "moods": ["festive"], "title": "…", "artist": "…",
//       "licence": "Public domain", "source": "https://…", "start": 0, "maxSeconds": 150 }, … ]
//
// ({ "songs": [ … ] } works too, and so does the 1.2 form { "kenburns": { "title": … }, … }: there
// the song's id is the theme's, its theme that one, and its moods stay as in theme-music.json.)
// - id: lower-case letters, digits and hyphens; the file becomes <id>.m4a. Ids are stable, projects
//   store them. The first song of every theme (1.2 had one) has the theme's id and must list it.
// - themes: the themes the song belongs to, [] for the music library only. A theme's songs are those
//   listing it, in the order of theme-music.json; the first is its default. A new song goes after the
//   last song of its first theme (without a theme: at the end). To change a default, move its entry
//   up in theme-music.json; the script keeps the order.
// - moods: one or more of calm, cheerful, festive, emotional, upbeat, nostalgic, christmas.
// - start and maxSeconds are optional (seconds; --max sets maxSeconds for every song). A song that is
//   cut gets a fade-out at the cut.
//
// Only songs with a file in <folder> are encoded (--only narrows them down), so songs are added
// without encoding the others again. An entry of sources.json without a file only passes on its
// themes and moods (to re-tag a song). Every song is brought to −16 LUFS (two-pass loudnorm, like the
// app's "Even out loudness") and stored as AAC stereo 48 kHz (--bitrate in kbps, default 128) in
// resources/theme-music/<id>.m4a. theme-music.json then lists per song its id, file, title, artist,
// licence, source, themes, moods and length, plus the beats and tempo found by the app's own beat
// tracking (src/main/media/beats.ts) and the loudness, so the app needs no analysis at start. A
// theme-music.json of 1.2 (one song per theme) is converted.
//
// --placeholders makes generated stand-ins for the planned songs (PLANNED below; FFmpeg lavfi: a kick
// drum, bass and chords, a different tempo and key per song), marked "placeholder": true. They never
// replace a real song unless --force.
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
const { MOODS, SONG_ID_RE } = await import(src('shared/themeMusic.ts'))
const { Ffmpeg } = await import(src('main/ffmpeg.ts'))
const { detectBeatsInFile } = await import(src('main/media/beats.ts'))
const { measureLoudness } = await import(src('main/media/loudness.ts'))
const THEME_IDS = THEMES.map((t) => t.id)
const MOOD_IDS = MOODS.map((m) => m.id)

// ---------- arguments
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const VALUED = ['--max', '--only', '--ffmpeg', '--out', '--bitrate']
const placeholders = flag('--placeholders')
const force = flag('--force')
const normalize = !flag('--no-normalize')
const maxAll = option('--max') !== undefined ? Number(option('--max')) : undefined
const bitrate = option('--bitrate') !== undefined ? Number(option('--bitrate')) : 128
const only = option('--only')?.split(',').map((s) => s.trim()).filter(Boolean)
const folder = args.find((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]))
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

// ---------- the planned catalogue: themes, moods and the sound of each placeholder
// The first song of each theme is the real song of 1.2 (its moods are used when a 1.2 theme-music.json
// is converted); the others are stand-ins until the real songs are chosen. A kick on every beat, bass
// and chords per bar, each song in its own tempo and key.
const PLANNED = {
  kenburns: { themes: ['kenburns'], moods: ['calm', 'emotional'], bpm: 84, root: 220, seconds: 72 },
  'kenburns-2': { themes: ['kenburns'], moods: ['calm', 'nostalgic'], bpm: 72, root: 196, seconds: 48 },
  'kenburns-3': { themes: ['kenburns'], moods: ['emotional'], bpm: 80, root: 233.08, seconds: 46, minor: true },
  origami: { themes: ['origami'], moods: ['cheerful', 'upbeat'], bpm: 112, root: 246.94, seconds: 64 },
  'origami-2': { themes: ['origami'], moods: ['cheerful'], bpm: 116, root: 261.63, seconds: 44 },
  'origami-3': { themes: ['origami'], moods: ['upbeat', 'cheerful'], bpm: 124, root: 293.66, seconds: 44 },
  reflections: { themes: ['reflections'], moods: ['calm', 'emotional'], bpm: 76, root: 196, seconds: 84 },
  'reflections-2': { themes: ['reflections'], moods: ['calm'], bpm: 70, root: 174.61, seconds: 50 },
  'reflections-3': { themes: ['reflections'], moods: ['emotional', 'calm'], bpm: 78, root: 207.65, seconds: 48, minor: true },
  panels: { themes: ['panels'], moods: ['upbeat', 'nostalgic'], bpm: 120, root: 261.63, seconds: 62 },
  'panels-2': { themes: ['panels'], moods: ['upbeat'], bpm: 118, root: 277.18, seconds: 44 },
  'panels-3': { themes: ['panels'], moods: ['cheerful', 'upbeat'], bpm: 110, root: 246.94, seconds: 44 },
  vintage: { themes: ['vintage'], moods: ['nostalgic', 'calm'], bpm: 92, root: 174.61, seconds: 76, minor: true },
  'vintage-2': { themes: ['vintage'], moods: ['nostalgic'], bpm: 90, root: 185, seconds: 46, minor: true },
  'vintage-3': { themes: ['vintage'], moods: ['nostalgic', 'emotional'], bpm: 84, root: 164.81, seconds: 48 },
  classic: { themes: ['classic'], moods: ['festive', 'cheerful'], bpm: 100, root: 233.08, seconds: 70 },
  'classic-2': { themes: ['classic'], moods: ['festive'], bpm: 100, root: 261.63, seconds: 46 },
  'classic-3': { themes: ['classic'], moods: ['festive', 'emotional'], bpm: 92, root: 220, seconds: 48 },
  magazine: { themes: ['magazine'], moods: ['upbeat'], bpm: 126, root: 277.18, seconds: 62 },
  'magazine-2': { themes: ['magazine'], moods: ['upbeat', 'cheerful'], bpm: 122, root: 311.13, seconds: 44 },
  'magazine-3': { themes: ['magazine'], moods: ['upbeat'], bpm: 128, root: 233.08, seconds: 44 },
  retro: { themes: ['retro'], moods: ['nostalgic', 'upbeat'], bpm: 132, root: 207.65, seconds: 66, minor: true },
  'retro-2': { themes: ['retro'], moods: ['nostalgic', 'upbeat'], bpm: 128, root: 196, seconds: 44, minor: true },
  'retro-3': { themes: ['retro'], moods: ['nostalgic', 'cheerful'], bpm: 104, root: 220, seconds: 46 },
  scrapbook: { themes: ['scrapbook'], moods: ['cheerful', 'calm'], bpm: 96, root: 293.66, seconds: 74 },
  'scrapbook-2': { themes: ['scrapbook'], moods: ['cheerful'], bpm: 98, root: 329.63, seconds: 46 },
  'scrapbook-3': { themes: ['scrapbook'], moods: ['calm', 'cheerful'], bpm: 88, root: 261.63, seconds: 48 },
  snapshots: { themes: ['snapshots'], moods: ['cheerful'], bpm: 108, root: 329.63, seconds: 68 },
  'snapshots-2': { themes: ['snapshots'], moods: ['cheerful', 'upbeat'], bpm: 112, root: 349.23, seconds: 44 },
  'snapshots-3': { themes: ['snapshots'], moods: ['cheerful'], bpm: 104, root: 293.66, seconds: 46 },
  shatter: { themes: ['shatter'], moods: ['upbeat', 'emotional'], bpm: 88, root: 185, seconds: 60, minor: true },
  'shatter-2': { themes: ['shatter'], moods: ['upbeat', 'emotional'], bpm: 132, root: 174.61, seconds: 44, minor: true },
  'shatter-3': { themes: ['shatter'], moods: ['emotional'], bpm: 86, root: 196, seconds: 48, minor: true },
  // the music library: songs of no theme
  'festive-1': { themes: [], moods: ['festive'], bpm: 112, root: 233.08, seconds: 50 },
  'festive-2': { themes: [], moods: ['festive', 'emotional'], bpm: 76, root: 196, seconds: 52 },
  'christmas-1': { themes: [], moods: ['christmas', 'cheerful'], bpm: 120, root: 293.66, seconds: 46 },
  'christmas-2': { themes: [], moods: ['christmas', 'calm'], bpm: 72, root: 261.63, seconds: 52 }
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
  const p = PLANNED[id]
  await ff.run([
    '-f', 'lavfi', '-i', `aevalsrc='${placeholderExpr(p)}':s=48000:d=${p.seconds}`,
    '-af', `afade=t=in:d=0.05,afade=t=out:st=${p.seconds - 1.5}:d=1.5`,
    '-ac', '2', '-c:a', 'pcm_s16le', wav
  ])
  return {
    title: `Placeholder ${id}, ${p.bpm} BPM`,
    artist: 'Diashow Studio',
    licence: 'CC0 1.0',
    source: 'generated by scripts/theme-music.mjs',
    placeholder: true
  }
}

// ---------- the catalogue (theme-music.json)
/** The songs of theme-music.json as a list; a 1.2 file (one song per theme, keyed by theme) is converted. */
function readIndex() {
  if (!existsSync(INDEX)) return []
  let raw
  try {
    raw = JSON.parse(readFileSync(INDEX, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    console.warn('[theme-music] theme-music.json was unreadable and is written anew')
    return []
  }
  if (Array.isArray(raw?.songs)) return raw.songs
  const songs = raw?.songs ?? {}
  console.log('[theme-music] theme-music.json of 1.2 (one song per theme) is converted to a list of songs')
  return THEME_IDS.filter((id) => songs[id]).map((id) => ({ ...songs[id], id, themes: [id], moods: PLANNED[id]?.moods ?? [] }))
}

/** Fixed key order and one line per list of beats, themes or moods, so the file diffs well. */
function writeIndex(songs) {
  const KEYS = ['id', 'file', 'title', 'artist', 'licence', 'source', 'themes', 'moods', 'duration', 'bpm', 'beats', 'loudness', 'placeholder']
  const ordered = songs.map((s) => Object.fromEntries([...KEYS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]), ...Object.entries(s).filter(([k]) => !KEYS.includes(k))]))
  const json = JSON.stringify({ version: 2, note: 'Written by scripts/theme-music.mjs (npm run theme-music). Licences: THIRD_PARTY_NOTICES.txt.', songs: ordered }, null, 2)
  writeFileSync(INDEX, `${json.replace(/"(beats|themes|moods)": \[\s+([^\]]*?)\s+\]/g, (_, key, list) => `"${key}": [${list.split(/,\s*/).join(', ')}]`)}\n`)
}

/** Puts a new song after the last song of its first theme (without a theme: at the end); an existing one stays in its place. */
function place(songs, entry) {
  const at = songs.findIndex((s) => s.id === entry.id)
  if (at >= 0) {
    songs[at] = entry
    return
  }
  const first = entry.themes[0]
  const last = first ? songs.findLastIndex((s) => s.themes?.includes(first)) : -1
  songs.splice(last >= 0 ? last + 1 : songs.length, 0, entry)
}

/** Checks id, themes and moods of a song before the long work starts. */
function checkTags(id, themes, moods, where) {
  if (!SONG_ID_RE.test(id)) fail(`${where}: "${id}" is no song id (lower-case letters, digits and hyphens)`)
  if (!Array.isArray(themes) || themes.some((t) => !THEME_IDS.includes(t))) fail(`${where}: "themes" of ${id} must be a list of ${THEME_IDS.join(', ')}`)
  if (!Array.isArray(moods) || !moods.length || moods.some((m) => !MOOD_IDS.includes(m))) fail(`${where}: "moods" of ${id} must list one or more of ${MOOD_IDS.join(', ')}`)
  // projects of 1.2 store the theme id for that theme's song
  if (THEME_IDS.includes(id) && !themes.includes(id)) fail(`${where}: the song "${id}" has a theme's id and must belong to that theme`)
}

// ---------- real songs
const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|aif|aiff|mka|webm|mp4)$/i

/** sources.json as a list of songs (also { songs: [...] } and the 1.2 form keyed by theme). */
function readSources(dir, index) {
  const file = join(dir, 'sources.json')
  if (!existsSync(file)) fail(`${file} is missing (id, themes, moods, title, artist, licence and source of each song)`)
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    fail(`${file}: ${e.message}`)
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.songs) ? raw.songs : null
  if (list) return list
  if (!raw || typeof raw !== 'object') fail(`${file}: a list of songs expected`)
  // 1.2: { "<theme>": { title, … } }: the song of that theme, its moods as they are
  return Object.entries(raw).map(([id, meta]) => {
    const current = index.find((s) => s.id === id)
    return { ...meta, id, themes: [id], moods: current?.moods?.length ? current.moods : (PLANNED[id]?.moods ?? []) }
  })
}

/** What sources.json says about a song; complains about anything missing before the long work starts. */
function songInfo(meta, path) {
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
/** Two-pass loudnorm to −16 LUFS (linear, so the music keeps its dynamics) and AAC stereo 48 kHz. */
async function encode(wav, m4a, info) {
  let filter = []
  if (normalize) {
    const log = await ff.log(['-i', wav, '-af', `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'])
    const m = JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1))
    filter = ['-af', `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`]
  }
  await ff.run([
    '-i', wav, ...filter, '-c:a', 'aac', '-b:a', `${bitrate}k`, '-ar', '48000', '-ac', '2',
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

// ---------- what to do
/** Placeholders for the planned songs without a real one (all of them with --force). */
function placeholderJobs(index) {
  const ids = only ?? Object.keys(PLANNED)
  const unknown = ids.filter((id) => !PLANNED[id])
  if (unknown.length) fail(`no placeholder planned for ${unknown.join(', ')}; planned: ${Object.keys(PLANNED).join(', ')}`)
  const todo = []
  for (const id of ids) {
    const current = index.find((s) => s.id === id)
    if (current && !current.placeholder && !force) {
      console.log(`[theme-music] ${id}: kept ("${current.title}")`)
      continue
    }
    // a placeholder that was re-tagged keeps its themes and moods
    todo.push({ id, themes: current?.themes ?? PLANNED[id].themes, moods: current?.moods?.length ? current.moods : PLANNED[id].moods })
  }
  return { todo, retag: [] }
}

/** The songs of <folder> with a file (encoded) and those of sources.json without one (re-tagged). */
function songJobs(dir, index) {
  const sources = readSources(dir, index)
  const files = readdirSync(dir).filter((n) => AUDIO.test(n))
  const fileOf = (id) => files.find((n) => n.replace(/\.[^.]+$/, '').toLowerCase() === id)
  const seen = new Set()
  for (const s of sources) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string') fail('sources.json: every song needs an "id"')
    if (seen.has(s.id)) fail(`sources.json: "${s.id}" is there twice`)
    seen.add(s.id)
  }
  const stray = files.filter((n) => !seen.has(n.replace(/\.[^.]+$/, '').toLowerCase()))
  if (stray.length) console.warn(`[theme-music] no entry in sources.json, left out: ${stray.join(', ')}`)
  const unknown = only?.filter((id) => !seen.has(id)) ?? []
  if (unknown.length) fail(`--only names songs that sources.json doesn't have: ${unknown.join(', ')}`)
  const todo = []
  const retag = []
  for (const s of sources) {
    if (only && !only.includes(s.id)) continue
    const themes = s.themes ?? index.find((x) => x.id === s.id)?.themes
    const moods = s.moods ?? index.find((x) => x.id === s.id)?.moods
    checkTags(s.id, themes, moods, 'sources.json')
    const file = fileOf(s.id)
    if (!file) {
      if (index.some((x) => x.id === s.id)) retag.push({ id: s.id, themes, moods })
      else console.warn(`[theme-music] ${s.id}: no audio file in ${dir}, left out`)
      continue
    }
    const path = join(dir, file)
    todo.push({ id: s.id, themes, moods, path, meta: s, info: songInfo(s, path) })
  }
  return { todo, retag }
}

// ---------- run
// Every song is made and analysed in a temp folder first; the theme-music folder only changes when
// all of them worked, so a failed run never leaves a new file next to an old theme-music.json.
async function run(work) {
  if (maxAll !== undefined && !(maxAll > 5)) fail('--max wants seconds (more than 5)')
  if (!(bitrate >= 64 && bitrate <= 320)) fail('--bitrate wants kbps (64 to 320)')
  const index = readIndex()
  for (const s of index) checkTags(s.id, s.themes ?? [], s.moods?.length ? s.moods : ['calm'], 'theme-music.json')
  const { todo, retag } = placeholders ? placeholderJobs(index) : songJobs(resolve(folder), index)
  const made = []
  for (const job of todo) {
    const wav = join(work, `${job.id}.wav`)
    const info = job.info ?? (await makePlaceholder(job.id, wav))
    if (job.path) await prepareSong(job.path, job.meta, wav)
    const m4a = join(work, `${job.id}.m4a`)
    await encode(wav, m4a, info)
    const facts = await analyse(m4a)
    made.push({ m4a, entry: { id: job.id, file: `${job.id}.m4a`, ...info, themes: job.themes, moods: job.moods, ...facts } })
    console.log(`[theme-music] ${job.id}: "${info.title}" ${facts.duration.toFixed(1)} s, ${facts.bpm ?? '?'} BPM, ${facts.beats?.length ?? 0} beats, ${facts.loudness ?? '?'} LUFS`)
  }
  mkdirSync(outDir, { recursive: true })
  const songs = [...index]
  for (const { id, themes, moods } of retag) {
    const at = songs.findIndex((s) => s.id === id)
    songs[at] = { ...songs[at], themes, moods }
    console.log(`[theme-music] ${id}: themes ${themes.join(', ') || '–'}, moods ${moods.join(', ')}`)
  }
  for (const { m4a, entry } of made) {
    copyFileSync(m4a, join(outDir, entry.file))
    place(songs, entry)
  }
  writeIndex(songs)
  const bare = THEME_IDS.filter((id) => !songs.some((s) => s.themes?.includes(id)))
  if (bare.length) console.warn(`[theme-music] themes without a song: ${bare.join(', ')}`)
  const real = songs.filter((s) => !s.placeholder).length
  console.log(`[theme-music] ${made.length} song(s) written; ${songs.length} songs (${real} real, ${songs.length - real} placeholders) -> ${INDEX}`)
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
