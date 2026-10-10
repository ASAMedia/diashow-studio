// The media service's cache folders, one per media / music id: meta.json (music.json) holds the
// processed item, source.json the original it was made from. A cached item counts only while its
// files are there; the cache cleanup leaves alone whatever is in work.
import { existsSync } from 'node:fs'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { CacheInfo, MediaItem } from '@shared/types'
import { cacheInfo as scanCacheInfo, cleanCache as cleanCacheDir, ID_FOLDER, type CleanTarget } from '../cache'
import { mediaId } from './scan'
import type { CacheUsage } from './service'
import { clean, type ServiceContext } from './serviceContext'

export const META = 'meta.json'
export const MUSIC_META = 'music.json'
/** Size and modification time of the original a media folder was made from (relink). */
const SOURCE = 'source.json'
/** Freshly imported items count as used by the cache cleanup until the renderer saved its project. */
const RECENT_MS = 5 * 60_000

export async function writeJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(data))
  await rename(tmp, path)
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * Writes a cache JSON file with the latest state, one write per file at a time (several jobs can
 * touch the same item: processing, lazy analysis, faces). A failed write only costs the cache.
 */
function persistFile(ctx: ServiceContext, path: string, data: () => unknown): Promise<void> {
  const next = (ctx.writes.get(path) ?? Promise.resolve())
    .then(async () => {
      const value = data()
      if (value) await writeJson(path, value)
    })
    .catch(() => {})
  ctx.writes.set(path, next)
  void next.finally(() => {
    if (ctx.writes.get(path) === next) ctx.writes.delete(path)
  })
  return next
}

export const persist = (ctx: ServiceContext, id: string): Promise<void> =>
  persistFile(ctx, join(ctx.folder(id), META), () => {
    const it = ctx.items.get(id)
    return it && it.status === 'ready' ? it : null
  })

export const persistTrack = (ctx: ServiceContext, id: string): Promise<void> =>
  persistFile(ctx, join(ctx.folder(id), MUSIC_META), () => {
    const t = ctx.tracks.get(id)
    return t && t.status === 'ready' ? t : null
  })

const DERIVED: Array<keyof MediaItem> = ['thumb', 'display', 'audio', 'liveVideo']

export function cacheFilesPresent(item: MediaItem): boolean {
  for (const key of DERIVED) {
    const v = item[key]
    if (typeof v === 'string' && !existsSync(v)) return false
  }
  if (item.kind === 'photo' && !item.display) return false
  if (item.kind === 'video' && (!item.playback || !existsSync(item.playback) || !item.thumb)) return false
  if (item.live && !existsSync(item.live.source)) return false
  return true
}

export const isInside = (file: string, dir: string): boolean => resolve(file).toLowerCase().startsWith(resolve(dir).toLowerCase() + sep)

/**
 * Without a stabilised version whose file is gone (cache cleanup: made again on request) and without
 * the progress of a run that ended with the app.
 */
export function withStabilized(item: MediaItem): MediaItem {
  const gone = !!item.stabilized && !existsSync(item.stabilized)
  if (item.stabilizing === undefined && !gone) return item
  return clean({ ...item, stabilizing: undefined, stabilized: gone ? undefined : item.stabilized })
}

export async function fromCache(ctx: ServiceContext, id: string): Promise<MediaItem | null> {
  const cached = await readJson<MediaItem>(join(ctx.folder(id), META))
  if (!cached || cached.id !== id || cached.status !== 'ready' || !cacheFilesPresent(cached)) return null
  return withStabilized(cached)
}

/** Size + time of the original next to the cache, so relinking can recognise a moved file. */
export async function rememberSource(ctx: ServiceContext, id: string): Promise<void> {
  const it = ctx.items.get(id)
  if (!it) return
  try {
    const st = await stat(it.path)
    await writeJson(join(ctx.folder(id), SOURCE), { size: st.size, mtimeMs: st.mtimeMs })
  } catch {
    // only relinking gets less precise
  }
}

export async function knownSize(ctx: ServiceContext, id: string): Promise<number | undefined> {
  const src = await readJson<{ size?: unknown }>(join(ctx.folder(id), SOURCE))
  return typeof src?.size === 'number' ? src.size : undefined
}

/** Media cache folder a video path belongs to: its cache folder, the item using it, or by its id. */
export async function stripFolder(ctx: ServiceContext, path: string): Promise<string> {
  const full = resolve(path)
  if (isInside(full, ctx.config.cacheDir)) {
    const first = relative(resolve(ctx.config.cacheDir), full).split(sep)[0]
    if (ID_FOLDER.test(first)) return ctx.folder(first)
  }
  for (const it of ctx.items.values()) if (it.path === path || it.playback === path) return ctx.folder(it.id)
  const st = await stat(full)
  return ctx.folder(mediaId(full, st.size, st.mtimeMs))
}

// ------------------------------------------------------------------ cleanup

function busyIds(ctx: ServiceContext): Set<string> {
  const busy = new Set<string>()
  const now = Date.now()
  for (const it of ctx.items.values()) if (it.status === 'pending' || it.status === 'processing') busy.add(it.id)
  for (const t of ctx.tracks.values()) if (t.status === 'pending' || t.status === 'processing') busy.add(t.id)
  for (const key of [...ctx.jobs.keys(), ...ctx.preparing.keys()]) busy.add(key.split(':').pop()!)
  for (const path of ctx.writes.keys()) busy.add(basename(dirname(path)))
  for (const dir of ctx.strips.keys()) busy.add(basename(dirname(dir)))
  for (const [id, at] of ctx.recent) {
    if (now - at < RECENT_MS) busy.add(id)
    else ctx.recent.delete(id)
  }
  return busy
}

/** Items whose cache files were deleted: the next restore validates them against the disk again. */
function forget(ctx: ServiceContext, ids: string[]): void {
  for (const id of ids) {
    if (ctx.jobs.has(id)) continue
    ctx.items.delete(id)
    ctx.tracks.delete(id)
    ctx.contexts.delete(id)
  }
}

export function cacheInfo(ctx: ServiceContext, used: CacheUsage): Promise<CacheInfo> {
  return scanCacheInfo(ctx.config.cacheDir, { ids: used.ids, paths: used.paths, busy: busyIds(ctx) })
}

export async function cleanCache(ctx: ServiceContext, what: CleanTarget, used: CacheUsage): Promise<CacheInfo> {
  if (what !== 'unused' && what !== 'hires' && what !== 'proxies') throw new Error(`unknown cache part: ${String(what)}`)
  forget(ctx, await cleanCacheDir(ctx.config.cacheDir, what, { ids: used.ids, paths: used.paths, busy: busyIds(ctx) }))
  return scanCacheInfo(ctx.config.cacheDir, { ids: used.ids, paths: used.paths, busy: busyIds(ctx) })
}
