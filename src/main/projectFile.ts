// Packing a project into a self-contained folder (copies of all originals + a .dshow with relative
// paths) and importing .dshow files from anywhere into the projects folder. Electron-free.
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { ProjectReportEvent } from '@shared/diagnostics'
import type { ExportProgress, MediaItem, MusicTrack, Project } from '@shared/types'
import { abortError } from './abort'
import { mediaId } from './media/scan'
import { hasChanges, readProjectText } from './projectSchema'
import { PROJECT_EXT, type ProjectStore } from './projects'

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
}

interface PlannedCopy {
  src: string
  /** Relative to the pack folder, forward slashes. */
  rel: string
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
    const copies: PlannedCopy[] = []
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
    const plan = async (folder: string, srcs: string[]): Promise<Array<string | undefined>> => {
      const known = srcs.map((s) => bySource.get(s.toLowerCase()))
      if (known.every((k) => k !== undefined)) return known
      const present = await Promise.all(srcs.map(isFile))
      const fresh = srcs.filter((s, i) => present[i] && known[i] === undefined)
      const rels = fresh.length ? reserve(folder, fresh) : []
      fresh.forEach((s, i) => {
        bySource.set(s.toLowerCase(), rels[i])
        copies.push({ src: s, rel: rels[i] })
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
      const [rel] = await plan('music', [track.path])
      const { playback: _p, error: _e, ...rest } = track
      music.push({ ...rest, path: rel ?? track.path, status: 'pending' })
    }

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
}

export async function importProjectFile(path: string, store: ProjectStore, opts: ImportOptions = {}): Promise<Project> {
  const file = resolve(path)
  if (extname(file).toLowerCase() !== PROJECT_EXT) throw new Error('not a Diashow Studio project file (.dshow)')
  // Opening a project's own file in the projects folder: nothing to import
  const own = basename(file, extname(file))
  if (!opts.salvage && /^[A-Za-z0-9_-]{1,128}$/.test(own) && samePath(file, join(store.dir, `${own}${PROJECT_EXT}`))) return store.load(own)
  // migrated and validated: an older format is converted, a newer one refused, broken parts dropped
  const { project: p, report } = readProjectText(await readFile(file, 'utf8'), { salvage: opts.salvage })

  const base = dirname(file)
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
  if (await exists(join(store.dir, `${id}${PROJECT_EXT}`))) id = randomUUID()
  const project: Project = { ...p, id, entries, media, music, updatedAt: Date.now() }
  await store.save(project)
  if (hasChanges(report)) opts.onReport?.({ projectId: id, source: 'import', report })
  return project
}
