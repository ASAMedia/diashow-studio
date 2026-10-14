// The files of a show in the trash (trash.ts): its description trash.json, read back with every field
// checked (a damaged or foreign file is never trusted, and no path in it leads out of the projects
// folder), and its project file: the photos and videos it uses, pointed at uploads that came back under
// another name. Electron-free.
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import { validDeleteAt } from '@shared/cleanup'
import { cleanProjectText, PROJECT_ID } from './projectSchema'
import { BACKUPS } from './projects'
import type { TrashedMedia } from './trash'

/** The trash's folder in the projects folder (and its name in userData). */
export const TRASH = '.trash'
export const MANIFEST = 'trash.json'
export const SHOW = 'show.json'
export const FORMAT = 'diashow-trash'
/** An entry's folder is named by the show's id; the folders of export jobs fit the same safe pattern. */
export const ID = PROJECT_ID

export type State = 'moving' | 'trashed' | 'restoring' | 'purging'
const STATES: readonly State[] = ['moving', 'trashed', 'restoring', 'purging']

/** What went into the trash: the show, its older versions, its undo history, a file of the projects folder (relative path), an export job. */
export type Item = { kind: 'show' } | { kind: 'backups' } | { kind: 'history' } | { kind: 'file'; path: string } | { kind: 'job'; job: string }

export interface Manifest {
  format: typeof FORMAT
  version: 1
  id: string
  name: string
  state: State
  deletedAt: number
  purgeAt: number
  deleteAt?: number
  slideCount: number
  versions: number
  faces: boolean
  items: Item[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const count = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0)

/** One folder or file name directly in the trash: no separators, no drive, not . or .. */
export function checkKey(key: string): string {
  if (typeof key !== 'string' || !key || key.length > 255 || key === '.' || key === '..' || /[\\/:\0]/.test(key)) throw new Error('invalid trash entry')
  return key
}

/**
 * A file's path relative to the projects folder as stored in trash.json, or null: it must lie in a
 * subfolder (Uploads, Eingefügt, …), never in the trash or the older versions, and never lead out.
 */
export function checkRel(rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel || rel.length > 2000 || rel.includes('\0') || rel.includes(':') || isAbsolute(rel)) return null
  if (normalize(rel) !== rel) return null
  const parts = rel.split(sep)
  if (parts.length < 2 || parts.some((p) => !p || p === '.' || p === '..')) return null
  const top = parts[0].toLowerCase()
  return top === TRASH || top === BACKUPS ? null : rel
}

function checkItem(v: unknown): Item | null {
  if (!isObj(v)) return null
  if (v.kind === 'show' || v.kind === 'backups' || v.kind === 'history') return { kind: v.kind }
  if (v.kind === 'file') {
    const path = checkRel(v.path)
    return path ? { kind: 'file', path } : null
  }
  if (v.kind === 'job' && typeof v.job === 'string' && ID.test(v.job)) return { kind: 'job', job: v.job }
  return null
}

/** trash.json read and checked; null when it is missing or damaged. */
export function parseManifest(text: string, key: string): Manifest | null {
  let m: unknown
  try {
    m = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(m) || m.format !== FORMAT || m.version !== 1 || m.id !== key || typeof m.name !== 'string' || !STATES.includes(m.state as State)) return null
  if (!Number.isFinite(m.deletedAt) || !Number.isFinite(m.purgeAt) || !Array.isArray(m.items)) return null
  const items: Item[] = []
  for (const raw of m.items) {
    const item = checkItem(raw)
    if (!item) return null
    items.push(item)
  }
  return {
    format: FORMAT,
    version: 1,
    id: key,
    name: m.name.slice(0, 300),
    state: m.state as State,
    deletedAt: m.deletedAt as number,
    purgeAt: m.purgeAt as number,
    ...(validDeleteAt(m.deleteAt) ? { deleteAt: m.deleteAt } : {}),
    slideCount: count(m.slideCount),
    versions: count(m.versions),
    faces: m.faces === true,
    items
  }
}

/**
 * Points the media of a project (parsed JSON) at the files' new places; true when something changed.
 * `ids` (by the old path, lower case): the media id of a file at its new place (path, size and time,
 * media/scan.ts). A photo or video whose file moved takes it, and its slides follow: with its old id
 * opening the show would take it for an edited original each time (media/restore.ts).
 */
export function followFiles(p: unknown, renamed: ReadonlyMap<string, string>, ids: ReadonlyMap<string, string> = new Map()): boolean {
  let changed = false
  const to = (v: unknown): unknown => {
    if (typeof v !== 'string') return v
    const next = renamed.get(resolve(v).toLowerCase())
    if (!next) return v
    changed = true
    return next
  }
  const remap = new Map<string, string>()
  for (const m of isObj(p) && Array.isArray(p.media) ? p.media : []) {
    if (!isObj(m)) continue
    const id = typeof m.path === 'string' ? ids.get(resolve(m.path).toLowerCase()) : undefined
    if (id && typeof m.id === 'string' && m.id !== id) {
      remap.set(m.id, id)
      m.id = id
    }
    m.path = to(m.path)
    if (isObj(m.live)) m.live.source = to(m.live.source)
  }
  for (const e of remap.size && isObj(p) && Array.isArray(p.entries) ? p.entries : []) {
    if (isObj(e) && typeof e.mediaId === 'string' && remap.has(e.mediaId)) e.mediaId = remap.get(e.mediaId)
  }
  return changed
}

/** The photos and videos of a project file's text (raw JSON: only what is well-formed counts). */
export function mediaOf(text: string): TrashedMedia[] {
  let p: unknown
  try {
    p = JSON.parse(cleanProjectText(text))
  } catch {
    return []
  }
  const out: TrashedMedia[] = []
  for (const m of isObj(p) && Array.isArray(p.media) ? p.media : []) {
    if (!isObj(m) || typeof m.id !== 'string' || typeof m.path !== 'string') continue
    const live = isObj(m.live) && typeof m.live.source === 'string' ? m.live.source : undefined
    out.push(live ? { id: m.id, path: m.path, live } : { id: m.id, path: m.path })
  }
  return out
}
