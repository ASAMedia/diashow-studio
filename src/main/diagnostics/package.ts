// The diagnostics package ("Diagnosepaket"): a zip the user can e-mail when something goes wrong.
// It holds the log files, the system check, app settings, versions, the export queue's states and a
// summary of the open project made of counts only: how many slides, photos and videos, which formats
// and sizes. No names, captions or paths of pupils' photos, no face data, no media content.
// Pure (sources are passed in), so the dialog can show exactly what will be saved.
import type { DiagnosticsFile, DiagnosticsInput } from '@shared/diagnostics'
import { classifyError } from '@shared/friendlyError'
import type { SystemInfo } from '@shared/systemCheck'
import { effectiveMusic, themeSongId, type ThemeTrack } from '@shared/themeMusic'
import type { Project } from '@shared/types'
import { redact } from './redact'
import { buildZip } from './zip'

export interface PackageSources {
  now: number
  /** User profile folder (shortened to %USERPROFILE% everywhere). */
  home: string
  versions: Record<string, string>
  system: SystemInfo | { error: string }
  settings: unknown
  input: DiagnosticsInput
  /** The open project as saved (summarised, never copied). */
  project: Project | null
  /** Sizes in bytes of the open project's original files (by media id), where known. */
  sizes?: Map<string, number>
  /** The bundled theme songs (whether the open project plays one). */
  themeTracks?: ThemeTrack[]
  /** All saved projects: slide counts only. */
  projects: { slides: number }[]
  /** Damaged / too-new project files in the projects folder. */
  damaged: { reason: string; bytes: number; backups: number }[]
  logs: { name: string; text: string }[]
}

export interface PackageFile {
  name: string
  about: DiagnosticsFile['about']
  text: string
}

const count = <K extends string>(map: Record<K, number>, key: K, n = 1): void => {
  map[key] = (map[key] ?? 0) + n
}

const sortedCounts = (map: Record<string, number>, limit = 30): Record<string, number> =>
  Object.fromEntries(
    Object.entries(map)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
  )

/** Megapixel / video size classes instead of exact sizes: enough to see "4K HEVC", nothing more. */
function sizeClass(width: number, height: number, kind: string): string {
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  if (kind === 'video') return short >= 2000 ? '4K+' : short >= 1000 ? '1080p' : short >= 700 ? '720p' : 'smaller'
  const mp = (width * height) / 1e6
  return mp >= 40 ? '40+ MP' : mp >= 20 ? '20-40 MP' : mp >= 8 ? '8-20 MP' : long > 0 ? 'under 8 MP' : 'unknown'
}

/** Counts, formats and sizes of a project: nothing that names a pupil or a file. */
export function projectSummary(p: Project, sizes?: Map<string, number>, themeTracks: ThemeTrack[] = []): Record<string, unknown> {
  const slides = { total: p.entries.length, photo: 0, video: 0, text: 0, excluded: 0, withTextBoxes: 0, withPixelation: 0 }
  for (const e of p.entries) {
    slides[e.type]++
    if (e.excluded) slides.excluded++
    if (e.texts?.length) slides.withTextBoxes++
    if (e.type !== 'text' && (e.privacy?.length || (e.type === 'video' && e.privacyTracks?.length))) slides.withPixelation++
  }
  const formats: Record<string, number> = {}
  const devices: Record<string, number> = {}
  const classes: Record<string, number> = {}
  const status: Record<string, number> = {}
  const errors: Record<string, number> = {}
  let photos = 0
  let videos = 0
  let live = 0
  let hdr = 0
  let proxied = 0
  let videoSeconds = 0
  let bytes = 0
  let sized = 0
  for (const m of p.media) {
    if (m.kind === 'video') videos++
    else photos++
    if (m.live) live++
    if (m.hdr) hdr++
    if (m.proxied) proxied++
    if (m.kind === 'video' && Number.isFinite(m.duration)) videoSeconds += m.duration ?? 0
    // format labels come from the decoder ("HEIC", "XAVC HS · HEVC 4:2:2 10-bit"), never from file names
    count(formats, `${m.kind}: ${String(m.format || '?').slice(0, 60)}`)
    if (m.device) count(devices, String(m.device).slice(0, 40))
    count(classes, `${m.kind}: ${sizeClass(m.width, m.height, m.kind)}`)
    count(status, m.status)
    if (m.status === 'error') count(errors, m.error === 'missing' ? 'fileMissing' : (classifyError(m.error ?? '', 'import') ?? 'other'))
    const size = sizes?.get(m.id)
    if (size !== undefined) {
      bytes += size
      sized++
    }
  }
  // which songs play: its own, the theme song (and which), or none (theme music off or not bundled)
  const theme = p.settings ? effectiveMusic(p, themeTracks).theme : undefined
  const music = {
    tracks: p.music.length,
    seconds: Math.round(p.music.reduce((s, t) => s + (Number.isFinite(t.duration) ? t.duration : 0), 0)),
    formats: {} as Record<string, number>,
    errors: 0,
    plays: p.music.length ? 'own' : theme ? 'theme' : 'none',
    themeMusic: p.settings && themeSongId(p.settings) ? (p.settings.themeSong ?? 'auto') : 'off',
    ...(theme ? { themeSong: theme.theme } : {})
  }
  for (const t of p.music) {
    count(music.formats, /\.([a-z0-9]{1,5})$/i.exec(t.path)?.[1]?.toLowerCase() ?? '?')
    if (t.status === 'error') music.errors++
  }
  const s = p.settings
  return {
    formatVersion: p.version,
    slides,
    media: {
      total: p.media.length,
      photos,
      videos,
      livePhotos: live,
      hdrVideos: hdr,
      videosWithProxy: proxied,
      videoMinutes: Math.round(videoSeconds / 6) / 10,
      status: sortedCounts(status),
      errors: sortedCounts(errors),
      formats: sortedCounts(formats),
      sizeClasses: sortedCounts(classes),
      cameras: sortedCounts(devices, 15),
      ...(sized ? { originalsGB: Math.round(bytes / 1e7) / 100, originalsMeasured: sized } : {})
    },
    music,
    people: p.people?.length ?? 0,
    settings: {
      theme: s?.theme,
      look: s?.look,
      aspect: s?.aspect,
      timing: s?.timing?.mode,
      beatSync: !!s?.timing?.beatSync,
      transition: s?.transition?.type,
      showTitle: s?.showTitle,
      loop: s?.loop,
      normalize: s?.audio?.normalize
    }
  }
}

function lines(rec: Record<string, unknown>): string {
  return Object.entries(rec)
    .map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
    .join('\n')
}

/** The main-process part of the system check as plain text. */
export function systemReport(info: SystemInfo | { error: string }, renderer: DiagnosticsInput['renderer'] = {}): string {
  if ('error' in info) return `System check failed: ${info.error}`
  const gb = (n: number | null): string => (n === null ? '?' : `${(n / 1024 ** 3).toFixed(1)} GB`)
  const out = [
    'Graphics:',
    ...info.gpu.devices.map((d) => `  ${d.vendor} ${d.device}${d.driver ? ` (driver ${d.driver})` : ''}${d.active ? ' [active]' : ''}`),
    `  features: ${Object.entries(info.gpu.features)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
    `Encoders: H.264 ${info.encoders.h264.join(', ') || '-'}; HEVC ${info.encoders.hevc.join(', ') || '-'}; hardware ${JSON.stringify(info.encoders.hardware)}`,
    `HEVC without proxy: ${info.hevcDirect === null ? '?' : info.hevcDirect ? 'yes' : 'no'}`,
    `HDR tone mapping on the GPU: ${info.tonemap ? `Vulkan #${info.tonemap.device}, decode ${info.tonemap.decode}` : 'no (CPU)'}`,
    `CPU: ${info.cpu.model}, ${info.cpu.threads} threads`,
    `Memory: ${gb(info.memory.total)} (free ${gb(info.memory.free)})`,
    `Disk (cache): free ${gb(info.disk.free)} of ${gb(info.disk.total)} at ${info.disk.path}`,
    `Versions: ${lines(info.versions).replace(/\n/g, ', ')}`
  ]
  const r = Object.entries(renderer ?? {})
  if (r.length) out.push('', 'Renderer:', ...r.map(([k, v]) => `  ${k}: ${String(v)}`))
  return out.join('\n')
}

const README = `Diashow Studio – Diagnosepaket / diagnostics package

DE: Dieses Paket hilft bei der Fehlersuche. Es enthält die Protokolldateien der App, den Systemcheck,
die App-Einstellungen, Versionen und eine Zusammenfassung des geöffneten Projekts (nur Anzahlen,
Formate und Größenklassen). Es enthält keine Fotos oder Videos, keine Gesichtsdaten und keine Namen
oder Pfade der Fotos im Projekt. Pfade in den Protokollen sind gekürzt (%USERPROFILE%).

EN: This package helps to find a problem. It contains the app's log files, the system check, the app
settings, versions and a summary of the open project (counts, formats and size classes only). It
contains no photos or videos, no face data and no names or paths of the project's photos. Paths in the
logs are shortened (%USERPROFILE%).
`

/** The files of the package, already cleaned. */
export function packageFiles(src: PackageSources): PackageFile[] {
  const clean = (text: string, max = 4_000_000): string => redact(text, { home: src.home, maxLength: max })
  const json = (v: unknown): string => clean(JSON.stringify(v, null, 2))
  const files: PackageFile[] = [
    { name: 'README.txt', about: 'readme', text: README },
    { name: 'versions.txt', about: 'versions', text: clean(lines({ ...src.versions, created: new Date(src.now).toISOString() })) },
    { name: 'system-check.txt', about: 'system', text: clean(systemReport(src.system, src.input.renderer)) },
    { name: 'settings.json', about: 'settings', text: json({ app: src.settings, renderer: src.input.renderer ?? {} }) },
    {
      name: 'project-summary.json',
      about: 'project',
      text: json({
        openProject: src.project ? projectSummary(src.project, src.sizes, src.themeTracks) : null,
        savedProjects: { count: src.projects.length, slides: src.projects.map((p) => p.slides) },
        damagedProjectFiles: src.damaged
      })
    }
  ]
  const jobs = src.input.exportJobs ?? []
  if (jobs.length) {
    files.push({
      name: 'export-queue.json',
      about: 'exports',
      text: json(
        jobs.slice(-50).map((j) => ({
          state: String(j.state).slice(0, 20),
          size: `${Number(j.width) || 0}x${Number(j.height) || 0}`,
          codec: String(j.codec).slice(0, 10),
          ...(j.fps ? { fps: Number(j.fps) || 0 } : {}),
          ...(j.error ? { error: String(j.error).slice(0, 500), kind: classifyError(j.error, 'export') } : {})
        }))
      )
    })
  }
  for (const log of src.logs) files.push({ name: `logs/${log.name}`, about: 'log', text: clean(log.text, 20_000_000) })
  return files
}

/** The last `max` characters of a text, starting at a line. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(-max)
  const nl = cut.indexOf('\n')
  return `…\n${nl >= 0 ? cut.slice(nl + 1) : cut}`
}

export function previewOf(files: PackageFile[]): DiagnosticsFile[] {
  return files.map((f) => ({ name: f.name, about: f.about, bytes: Buffer.byteLength(f.text), preview: f.about === 'log' ? tail(f.text, 6000) : f.text.slice(0, 20000) }))
}

export function zipOf(files: PackageFile[], now: number): Buffer {
  return buildZip(
    files.map((f) => ({ name: f.name, data: f.text, mtime: now })),
    now
  )
}

/** Diashow-Studio-Diagnose-2026-10-10-1530.zip */
export function packageFileName(now: number): string {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `Diashow-Studio-Diagnose-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`
}
