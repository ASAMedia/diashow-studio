// Packing a project into a self-contained folder (copies of all originals + a .dshow with relative
// paths) and importing .dshow files from anywhere into the projects folder. Electron-free.
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { ProjectReportEvent } from '@shared/diagnostics'
import { OPENED_FROM_ZIP } from '@shared/friendlyError'
import type { ThemeTrack } from '@shared/themeMusic'
import type { ExportProgress, MediaItem, MusicTrack, Project } from '@shared/types'
import { abortError } from './abort'
import { withArchivedThemeSong } from './archive/themeSong'
import { mediaId } from './media/scan'
import { hasChanges, PROJECT_ID, readProjectText } from './projectSchema'
import { PROJECT_EXT, type ProjectStore } from './projects'
import { rebaseBundledPath } from './themeMusic'

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** A name that is safe as a Windows file/folder name (no reserved names, no trailing dots/spaces). */
export function safeName(name: string, fallback = 'Diashow'): string {
  let s = (name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  s = s.slice(0, 100).replace(/[. ]+$/, '')
  if (!s) s = fallback
  return RESERVED.test(s) ? `${s}_` : s
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** `<dir>/<name>`, or `<dir>/<name> (2)` … when that already exists. Created empty. */
async function freshDir(dir: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? name : `${name} (${n})`)
    if (await exists(candidate)) continue
    await mkdir(candidate, { recursive: true })
    return candidate
  }
}

const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

export interface PackOptions {
  onProgress?: (p: ExportProgress) => void
  signal?: AbortSignal
  /** Today's folder of the bundled songs: own songs from the music library are copied from there (themeMusic.ts). */
  themeMusicDir?: string
}

/** One original copied into a pack (or an archive, archive/archive.ts). */
export interface PackCopy {
  src: string
  /** Relative to the pack folder, forward slashes. */
  rel: string
  kind: 'media' | 'music'
}

export interface PackPlan {
  /** The project's media and songs with paths relative to the pack, cache-derived fields removed. */
  media: MediaItem[]
  music: MusicTrack[]
  copies: PackCopy[]
  /** Originals that are not there (or may not be read): skipped, their absolute paths stay. */
  missing: string[]
  /** Free names for more files of the pack: the same name in one folder gets " (2)", " (3)" … */
  reserve: (folder: string, srcs: string[]) => string[]
}

export interface PackPlanOptions {
  /** Today's folder of the bundled songs (PackOptions.themeMusicDir). */
  themeMusicDir?: string
  /** Whether an original is there to be copied; default: it is an existing file. */
  isFile?: (path: string) => Promise<boolean>
}

/**
 * Which files a pack copies and the project's media and songs as they point to the copies: photos,
 * videos, Live Photo MOVs next to their photo (same base name as the photo), songs. Names stay
 * (case-insensitively unique per folder: "IMG_0001 (2).JPG"); missing originals are skipped.
 */
export async function planPack(project: Project, opts: PackPlanOptions = {}): Promise<PackPlan> {
  const present = opts.isFile ?? isFile
  const copies: PackCopy[] = []
  const missing = new Map<string, string>()
  const bySource = new Map<string, string>()
  const taken = new Set<string>()

  /** Reserves one free base name for a group of files that must keep a common base (photo + its MOV). */
  const reserve = (folder: string, srcs: string[]): string[] => {
    const base = basename(srcs[0], extname(srcs[0]))
    for (let n = 1; ; n++) {
      const stem = n === 1 ? base : `${base} (${n})`
      const rels = srcs.map((s) => `${folder}/${stem}${extname(s)}`)
      if (rels.every((r) => !taken.has(r.toLowerCase()))) {
        rels.forEach((r) => taken.add(r.toLowerCase()))
        return rels
      }
    }
  }
  const plan = async (folder: 'media' | 'music', srcs: string[]): Promise<Array<string | undefined>> => {
    const known = srcs.map((s) => bySource.get(s.toLowerCase()))
    if (known.every((k) => k !== undefined)) return known
    const there = await Promise.all(srcs.map((s, i) => (known[i] === undefined ? present(s) : true)))
    srcs.forEach((s, i) => !there[i] && missing.set(s.toLowerCase(), s))
    const fresh = srcs.filter((s, i) => there[i] && known[i] === undefined)
    const rels = fresh.length ? reserve(folder, fresh) : []
    fresh.forEach((s, i) => {
      bySource.set(s.toLowerCase(), rels[i])
      copies.push({ src: s, rel: rels[i], kind: folder })
    })
    return srcs.map((s) => bySource.get(s.toLowerCase()))
  }

  const media: MediaItem[] = []
  for (const item of project.media ?? []) {
    const sibling = item.live && dirname(resolve(item.live.source)).toLowerCase() === dirname(resolve(item.path)).toLowerCase()
    const [rel, liveRel] = await plan('media', sibling ? [item.path, item.live!.source] : [item.path])
    const { thumb: _t, display: _d, playback: _p, audio: _a, liveVideo: _l, proxied: _x, progress: _g, error: _e, live, ...rest } = item
    const out: MediaItem = { ...rest, path: rel ?? item.path, status: 'pending' }
    // Motion photos keep their video inside the file; their cache copy is re-extracted
    if (live && sibling && liveRel) out.live = { ...live, source: liveRel }
    media.push(out)
  }
  const music: MusicTrack[] = []
  for (const track of project.music ?? []) {
    // a song from the bundled music library is packed like any other song
    const [rel] = await plan('music', [rebaseBundledPath(track.path, opts.themeMusicDir ?? '')])
    const { playback: _p, error: _e, ...rest } = track
    music.push({ ...rest, path: rel ?? track.path, status: 'pending' })
  }
  return { media, music, copies, missing: [...missing.values()], reserve }
}

/**
 * Creates `<dir>/<safe project name>/` with media/ and music/ holding copies of every original
 * (photos, videos, Live Photo MOVs next to their photo, music) and `<safe name>.dshow`: the project
 * with those paths made relative and cache-derived fields removed, so another PC rebuilds its cache.
 * Missing originals are skipped (their absolute paths stay in the file). Resolves with the .dshow path.
 */
export async function packProject(project: Project, dir: string, opts: PackOptions = {}): Promise<string> {
  if (!project || !Array.isArray(project.entries)) throw new Error('invalid project')
  const name = safeName(project.name)
  const root = await freshDir(dir, name)
  try {
    await mkdir(join(root, 'media'))
    await mkdir(join(root, 'music'))
    const { media, music, copies } = await planPack(project, { themeMusicDir: opts.themeMusicDir })

    const total = copies.length
    const report = (done: number): void => opts.onProgress?.({ phase: 'prepare', frame: done, totalFrames: total, message: `${done}/${total}` })
    report(0)
    for (let i = 0; i < copies.length; i++) {
      if (opts.signal?.aborted) throw abortError()
      // copyFile (CopyFileW) keeps the modification time, which the media ids are derived from
      await copyFile(copies[i].src, join(root, ...copies[i].rel.split('/')))
      report(i + 1)
    }
    const packed: Project = { ...project, media, music }
    const file = join(root, `${name}${PROJECT_EXT}`)
    await writeFile(file, JSON.stringify(packed, null, 1), 'utf8')
    return file
  } catch (err) {
    // Only this call's own, freshly created folder is removed
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    throw err
  }
}

function toAbsolute(base: string, p: string): string {
  if (typeof p !== 'string' || !p) return p
  return isAbsolute(p) ? p : resolve(base, p.split('/').join(sep))
}

/** Where ZIP programs put a file opened from inside an archive: Explorer (Temp1_<name>.zip), 7-Zip (7zO…), WinRAR (Rar$DI…). */
const ZIP_VIEW = /[\\/](Temp\d+_[^\\/]+\.zip|7zO[0-9A-F]+|Rar\$DI[^\\/]*)([\\/]|$)/i

/**
 * A packed or archived .dshow double-clicked inside a ZIP: the ZIP program extracted only that file to
 * a temp folder, so none of the photos, videos and songs it names (relative paths) are next to it.
 */
async function openedFromZip(p: Project, base: string): Promise<boolean> {
  if (!ZIP_VIEW.test(base)) return false
  const rel = [...(p.media ?? []).map((m) => m.path), ...(p.music ?? []).map((t) => t.path)].filter((x) => typeof x === 'string' && x && !isAbsolute(x))
  for (const r of rel) if (await exists(toAbsolute(base, r))) return false
  return rel.length > 0
}

/** Current id for a file (same scheme as import), or null when it is not there. */
async function idFor(path: string): Promise<string | null> {
  try {
    const st = await stat(path)
    return st.isFile() ? mediaId(path, st.size, st.mtimeMs) : null
  } catch {
    return null
  }
}

/**
 * Reads a .dshow (e.g. a packed project from another PC), resolves relative paths against its folder
 * and saves it into the projects folder: with a fresh id when that id is taken. Media and track ids
 * are recomputed from the files as they are here, so the cache and later imports of the same files
 * line up; entries follow the new ids. The renderer then calls restoreMedia/restoreMusic.
 */
export interface ImportOptions {
  /** The file had to be repaired (validation, or `salvage`); called with the id it got here. */
  onReport?: (event: ProjectReportEvent) => void
  /** Rescue what is readable from a cut-off file ("Repair"). */
  salvage?: boolean
  /** The bundled songs: an archived show plays its own copy of its theme song when this app's differs (archive/themeSong.ts). */
  themeTracks?: readonly ThemeTrack[]
  /** Opens a show's own file in the projects folder (no import); default store.load. */
  loadOwn?: (id: string) => Promise<Project>
}

export async function importProjectFile(path: string, store: ProjectStore, opts: ImportOptions = {}): Promise<Project> {
  const file = resolve(path)
  if (extname(file).toLowerCase() !== PROJECT_EXT) throw new Error('not a Diashow Studio project file (.dshow)')
  // Opening a project's own file in the projects folder: nothing to import
  const own = basename(file, extname(file))
  if (!opts.salvage && PROJECT_ID.test(own) && samePath(file, join(store.dir, `${own}${PROJECT_EXT}`))) return opts.loadOwn ? opts.loadOwn(own) : store.load(own)
  // migrated and validated: an older format is converted, a newer one refused, broken parts dropped
  const read = readProjectText(await readFile(file, 'utf8'), { salvage: opts.salvage })
  const report = read.report
  const base = dirname(file)
  if (await openedFromZip(read.project, base)) throw new Error(`${OPENED_FROM_ZIP}: extract the ZIP archive first`)
  const p = await withArchivedThemeSong(read.project, base, opts.themeTracks)

  const remap = new Map<string, string>()
  const media: MediaItem[] = []
  for (const item of Array.isArray(p.media) ? p.media : []) {
    const out: MediaItem = { ...item, path: toAbsolute(base, item.path) }
    if (item.live) out.live = { ...item.live, source: toAbsolute(base, item.live.source) }
    const id = await idFor(out.path)
    if (id && id !== item.id) {
      remap.set(item.id, id)
      out.id = id
    }
    media.push(out)
  }
  const music: MusicTrack[] = []
  const songs = new Map<string, string>()
  for (const track of Array.isArray(p.music) ? p.music : []) {
    const out: MusicTrack = { ...track, path: toAbsolute(base, track.path) }
    const id = await idFor(out.path)
    if (id && id !== track.id) {
      songs.set(track.id, id)
      out.id = id
    }
    music.push(out)
  }
  const entries = p.entries.map((e) => {
    if (e.type !== 'text') return remap.has(e.mediaId) ? { ...e, mediaId: remap.get(e.mediaId)! } : e
    // chapter songs follow their tracks' new ids
    return e.music?.some((m) => songs.has(m)) ? { ...e, music: e.music.map((m) => songs.get(m) ?? m) } : e
  })
  let id = p.id
  // a show of that id in the trash keeps it (it may be restored)
  if ((await exists(join(store.dir, `${id}${PROJECT_EXT}`))) || (await store.inTrash(id).catch(() => true))) id = randomUUID()
  const project: Project = { ...p, id, entries, media, music, updatedAt: Date.now() }
  await store.save(project)
  if (hasChanges(report)) opts.onReport?.({ projectId: id, source: 'import', report })
  return project
}
