// Expands dropped files/folders into importable media files and pairs Live Photos and RAW+JPEG.
import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { classify, extOf, RAW_EXT, SIDECAR_EXT } from '@shared/formats'

export interface ScannedFile {
  path: string
  dir: string
  name: string
  /** File name without extension. */
  base: string
  ext: string
  kind: 'photo' | 'video' | 'audio'
  size: number
  mtimeMs: number
}

export interface ImportGroup {
  file: ScannedFile & { kind: 'photo' | 'video' }
  /** Live Photo: the MOV next to a HEIC/JPEG with the same name. */
  live?: ScannedFile
  /** RAW file dropped in favour of its JPEG/HEIF twin. */
  raw?: ScannedFile
}

/** Stable media id: first 16 hex chars of sha1(path|size|mtime). Also the cache folder name. */
export function mediaId(path: string, size: number, mtimeMs: number): string {
  return createHash('sha1').update(`${path}|${size}|${mtimeMs}`).digest('hex').slice(0, 16)
}

const SKIP_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store', '$recycle.bin', 'system volume information', '__macosx', '@eadir', '.trashes', '.spotlight-v100', '.fseventsd'])

/**
 * Folders on camera cards that only hold sidecars, thumbnails or proxies:
 * Sony XAVC (M4ROOT/THMBNL, M4ROOT/SUB, M4ROOT/GENERAL) and AVCHD (CLIPINF, PLAYLIST, BACKUP, AVCHDTN).
 */
function skipDir(name: string, parent: string): boolean {
  const n = name.toLowerCase()
  const p = parent.toLowerCase()
  if (SKIP_NAMES.has(n) || n.startsWith('.')) return true
  if (p === 'm4root' && ['thmbnl', 'sub', 'general'].includes(n)) return true
  if (p === 'bdmv' && ['clipinf', 'playlist', 'backup', 'auxdata', 'meta'].includes(n)) return true
  if (n === 'avchdtn') return true
  return false
}

function skipFile(name: string): boolean {
  const n = name.toLowerCase()
  if (SKIP_NAMES.has(n) || n.startsWith('.') || n.startsWith('~$')) return true
  return SIDECAR_EXT.includes(extOf(n))
}

async function walk(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 32) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const parent = basename(dir)
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (!skipDir(e.name, parent)) await walk(full, out, depth + 1)
    } else if (e.isFile() && !skipFile(e.name)) {
      out.push(full)
    }
  }
}

/**
 * Files and folders (recursive) → media files with stats. Sidecars, hidden/system files and
 * camera card helper folders are skipped; explicitly passed files only need a known extension.
 * `kinds` limits the result (e.g. only audio for the music import).
 */
export async function scanPaths(
  paths: string[],
  kinds: Array<ScannedFile['kind']> = ['photo', 'video']
): Promise<ScannedFile[]> {
  const files: string[] = []
  for (const raw of paths) {
    const p = resolve(raw)
    let st
    try {
      st = await stat(p)
    } catch {
      continue
    }
    if (st.isDirectory()) await walk(p, files, 0)
    else if (st.isFile() && !SIDECAR_EXT.includes(extOf(p))) files.push(p)
  }
  const seen = new Set<string>()
  const wanted: Array<{ path: string; kind: ScannedFile['kind'] }> = []
  for (const path of files) {
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const kind = classify(path)
    if (kind && kinds.includes(kind)) wanted.push({ path, kind })
  }
  const result: Array<ScannedFile | null> = []
  for (let i = 0; i < wanted.length; i += 64) {
    const batch = wanted.slice(i, i + 64).map(async ({ path, kind }): Promise<ScannedFile | null> => {
      try {
        const st = await stat(path)
        if (st.size === 0) return null
        const name = basename(path)
        const ext = extOf(name)
        return { path, dir: dirname(path), name, base: ext ? name.slice(0, -(ext.length + 1)) : name, ext, kind, size: st.size, mtimeMs: st.mtimeMs }
      } catch {
        return null // vanished between readdir and stat
      }
    })
    result.push(...(await Promise.all(batch)))
  }
  return result.filter((f): f is ScannedFile => f !== null)
}

const LIVE_STILL = ['heic', 'heif', 'jpg', 'jpeg']
const RAW_TWIN = ['jpg', 'jpeg', 'hif', 'heif', 'heic']

/**
 * Pairs files sharing folder + base name: Live Photo (HEIC/JPEG + MOV → one photo, MOV hidden) and
 * RAW + JPEG/HIF (the RAW is dropped). Everything else stays a separate item.
 */
export function pairFiles(files: ScannedFile[]): ImportGroup[] {
  const byKey = new Map<string, ScannedFile[]>()
  for (const f of files) {
    if (f.kind === 'audio') continue
    const key = `${f.dir.toLowerCase()}|${f.base.toLowerCase()}`
    const list = byKey.get(key)
    if (list) list.push(f)
    else byKey.set(key, [f])
  }
  const groups: ImportGroup[] = []
  for (const list of byKey.values()) {
    const consumed = new Set<ScannedFile>()
    const still = list.find((f) => f.kind === 'photo' && LIVE_STILL.includes(f.ext))
    const mov = list.find((f) => f.kind === 'video' && f.ext === 'mov')
    const twin = list.find((f) => f.kind === 'photo' && RAW_TWIN.includes(f.ext))
    const raws = list.filter((f) => f.kind === 'photo' && RAW_EXT.includes(f.ext))
    let rawDropped: ScannedFile | undefined
    if (twin && raws.length) {
      for (const r of raws) consumed.add(r)
      rawDropped = raws[0]
    }
    if (still && mov) {
      consumed.add(still)
      consumed.add(mov)
      groups.push({ file: still as ImportGroup['file'], live: mov, raw: still === twin ? rawDropped : undefined })
    }
    for (const f of list) {
      if (consumed.has(f)) continue
      groups.push({ file: f as ImportGroup['file'], raw: f === twin ? rawDropped : undefined })
    }
  }
  return groups
}
