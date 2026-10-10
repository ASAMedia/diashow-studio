// Disk usage of the media cache (<cacheDir>/<media id>/...) and cleaning it. Electron-free. Only
// files inside media id folders are ever deleted; originals never live there.
import type { Dirent } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { CacheInfo } from '@shared/types'

export type CachePart = keyof CacheInfo['parts']
export type CleanTarget = 'unused' | 'hires' | 'proxies'

/** Cache folders are named by media / track id: 16 hex chars (see mediaId). */
export const ID_FOLDER = /^[0-9a-f]{16}$/
const HIRES = /^proxy_\d+\.mp4$/i

/** What a file inside a media folder is, by its path relative to that folder ('/'-separated). */
export function classifyCacheFile(rel: string): CachePart {
  const parts = rel.split(/[\\/]/)
  const name = parts[parts.length - 1].toLowerCase()
  if (parts.length > 1) return parts[0].toLowerCase().startsWith('strip-') ? 'thumbs' : 'other'
  if (/^thumb.*\.jpg$/.test(name)) return 'thumbs'
  if (name === 'display.jpg') return 'display'
  // stab.mp4 (stabilised clip) is made again on request, like a proxy
  if (name === 'proxy.mp4' || name === 'live.mp4' || name === 'stab.mp4') return 'proxies'
  if (HIRES.test(name)) return 'hires'
  if (name === 'audio.m4a' || name === 'music.m4a') return 'audio'
  return 'other'
}

interface CacheFile {
  path: string
  rel: string
  size: number
  part: CachePart
}

interface CacheFolder {
  /** Media id, or null for other top-level entries (export temp files, …). */
  id: string | null
  path: string
  files: CacheFile[]
  bytes: number
}

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function walkFiles(dir: string, prefix: string, out: CacheFile[], depth = 0): Promise<void> {
  if (depth > 8) return
  const list = await entries(dir)
  await Promise.all(
    list.map(async (e) => {
      const path = join(dir, e.name)
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) return walkFiles(path, rel, out, depth + 1)
      if (!e.isFile()) return
      try {
        const size = (await stat(path)).size
        out.push({ path, rel, size, part: classifyCacheFile(rel) })
      } catch {
        // vanished while scanning
      }
    })
  )
}

/** Every top-level entry of the cache with its files. */
export async function scanCache(dir: string): Promise<CacheFolder[]> {
  const top = await entries(dir)
  const folders: CacheFolder[] = []
  // A few folders at a time: thousands of stat calls at once only queue up in libuv
  for (let i = 0; i < top.length; i += 32) {
    const batch = await Promise.all(
      top.slice(i, i + 32).map(async (e): Promise<CacheFolder | null> => {
        const path = join(dir, e.name)
        const files: CacheFile[] = []
        if (e.isDirectory()) await walkFiles(path, '', files)
        else if (e.isFile()) {
          try {
            files.push({ path, rel: e.name, size: (await stat(path)).size, part: 'other' })
          } catch {
            return null
          }
        } else return null
        const id = e.isDirectory() && ID_FOLDER.test(e.name) ? e.name : null
        return { id, path, files, bytes: files.reduce((n, f) => n + f.size, 0) }
      })
    )
    for (const f of batch) if (f) folders.push(f)
  }
  return folders
}

export interface CacheUse {
  /** Media and track ids referenced by saved projects. */
  ids: Set<string>
  /** Original files referenced by saved projects (never deleted, even if one sat inside the cache). */
  paths: string[]
  /** Ids the media service is working on right now. */
  busy: Set<string>
}

const inside = (file: string, dir: string): boolean => resolve(file).toLowerCase().startsWith(resolve(dir).toLowerCase() + sep)

function isUnused(folder: CacheFolder, use: CacheUse): boolean {
  if (!folder.id || use.ids.has(folder.id) || use.busy.has(folder.id)) return false
  return !use.paths.some((p) => inside(p, folder.path))
}

export function summarizeCache(dir: string, folders: CacheFolder[], use: CacheUse): CacheInfo {
  const parts: CacheInfo['parts'] = { thumbs: 0, display: 0, proxies: 0, hires: 0, audio: 0, other: 0 }
  let total = 0
  let unused = 0
  let unusedItems = 0
  for (const folder of folders) {
    for (const f of folder.files) {
      parts[folder.id ? f.part : 'other'] += f.size
      total += f.size
    }
    if (isUnused(folder, use)) {
      unused += folder.bytes
      unusedItems++
    }
  }
  return { dir, total, parts, unused, unusedItems }
}

export async function cacheInfo(dir: string, use: CacheUse): Promise<CacheInfo> {
  return summarizeCache(dir, await scanCache(dir), use)
}

/**
 * Deletes unused media folders, hi-res export proxies, or all proxies (proxy.mp4, live.mp4,
 * stab.mp4, proxy_<n>.mp4). Folders of busy items are left alone. Resolves with the ids whose folder was
 * removed or whose playable proxy (proxy.mp4 / live.mp4) is gone, so the caller can forget them.
 */
export async function cleanCache(dir: string, what: CleanTarget, use: CacheUse): Promise<string[]> {
  const touched: string[] = []
  const folders = await scanCache(dir)
  for (const folder of folders) {
    if (!folder.id || use.busy.has(folder.id)) continue
    if (what === 'unused') {
      if (!isUnused(folder, use)) continue
      try {
        await rm(folder.path, { recursive: true, force: true, maxRetries: 3 })
        touched.push(folder.id)
      } catch {
        // in use by another program: stays for the next clean
      }
      continue
    }
    let playableGone = false
    for (const f of folder.files) {
      const remove = f.part === 'hires' || (what === 'proxies' && f.part === 'proxies')
      if (!remove || f.rel.includes('/') || use.paths.some((p) => resolve(p).toLowerCase() === resolve(f.path).toLowerCase())) continue
      try {
        await rm(f.path, { force: true })
        if (f.part === 'proxies') playableGone = true
      } catch {
        // locked (being played): stays
      }
    }
    if (playableGone) touched.push(folder.id)
  }
  return touched
}
