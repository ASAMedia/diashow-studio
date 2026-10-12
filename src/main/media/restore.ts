// Media of a project opened again: each item is checked against its original and its cache files
// (ready as it is, only the proxy rebuilt, or processed again), and moved originals are found again.
import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { MediaItem } from '@shared/types'
import { withProjectFields } from '@shared/mediaEdit'
import { wantsAnalysis } from './analysisJobs'
import { cacheFilesPresent, isInside, knownSize, META, readJson, withStabilized, writeJson } from './cacheMeta'
import { importPaths, schedule } from './processing'
import { mediaId, scanPaths, type ScannedFile } from './scan'
import { clean, type ServiceContext } from './serviceContext'

/**
 * A ready item whose only missing cache file is its transcoded proxy (e.g. after a cache cleanup):
 * 'video' (playback proxy) or 'live' (Live Photo motion proxy); null when anything else is missing.
 */
function missingProxyOnly(item: MediaItem, cacheDir: string): 'video' | 'live' | null {
  if (item.status !== 'ready' || (item.live && !existsSync(item.live.source))) return null
  for (const key of ['thumb', 'display', 'audio'] as const) {
    const v = item[key]
    if (typeof v === 'string' && !existsSync(v)) return null
  }
  if (item.kind === 'video') {
    // A proxy or a remux (proxied false): any playback copy in the cache can be made again
    if (!item.thumb || !item.playback || existsSync(item.playback) || !isInside(item.playback, cacheDir)) return null
    return 'video'
  }
  if (!item.display || !item.live || !item.liveVideo || existsSync(item.liveVideo) || !isInside(item.liveVideo, cacheDir)) return null
  return 'live'
}

function stripDerived(item: MediaItem): MediaItem {
  const { thumb: _t, display: _d, playback: _p, audio: _a, liveVideo: _l, proxied: _x, progress: _g, error: _e, stabilized: _s, stabilizing: _r, ...rest } = item
  return { ...rest, status: 'pending' }
}

/** Derived files point into the cache (or are the original itself); others are dropped and rebuilt. */
function withoutForeignFiles(it: MediaItem, allow: (path: string) => boolean): MediaItem {
  const out = { ...it }
  for (const key of ['thumb', 'display', 'playback', 'audio', 'liveVideo', 'stabilized'] as const) {
    const p = out[key]
    if (typeof p === 'string' && p !== it.path && !allow(p)) delete out[key]
  }
  return out
}

/** What the main process keeps has no photo edit: edits belong to a project, the cache serves them all. */
function withoutEdit(item: MediaItem): MediaItem {
  const { edit: _e, ...rest } = item
  return rest
}

export async function restoreMedia(ctx: ServiceContext, items: MediaItem[]): Promise<MediaItem[]> {
  // a malformed entry from the renderer must not fail the whole project
  const list = items.filter((it) => !!it && typeof it.id === 'string' && typeof it.path === 'string')
  ctx.order.add(list.map((it) => it.id))
  const requeue: string[] = []
  const analyze: string[] = []
  const reproxy: string[] = []
  const result = await Promise.all(
    list.map(async (it) => {
      const current = ctx.items.get(it.id)
      // the photo edit and the kept face centre belong to the project, not to the cache
      if (current && current.status !== 'error') return withProjectFields({ ...current }, it)
      // a network share from a project made elsewhere: not touched until the user trusts the host
      const allow = ctx.config.allowPath ?? (() => true)
      if (!allow(it.path)) return clean({ ...it, status: 'error' as const, error: 'network-blocked', progress: undefined })
      it = withoutForeignFiles(it, allow)
      let changed = false
      try {
        const st = await stat(it.path)
        // Same id scheme as import: a different size/mtime means the original was edited
        changed = mediaId(it.path, st.size, st.mtimeMs) !== it.id
      } catch {
        return clean({ ...it, status: 'error' as const, error: 'missing', progress: undefined })
      }
      it = withStabilized(it)
      if (!changed && it.status === 'ready' && cacheFilesPresent(it)) {
        ctx.items.set(it.id, withoutEdit(it))
        if (wantsAnalysis(ctx, it)) analyze.push(it.id)
        return { ...it }
      }
      const proxyGone = changed ? null : missingProxyOnly(it, ctx.config.cacheDir)
      if (proxyGone) {
        // Thumbnail, display image and audio are still there: only the proxy is rebuilt
        const fresh: MediaItem =
          proxyGone === 'video'
            ? clean({ ...it, playback: undefined, proxied: undefined, status: 'processing' as const, progress: 0, error: undefined })
            : clean({ ...it, liveVideo: undefined })
        ctx.items.set(it.id, withoutEdit(fresh))
        reproxy.push(it.id)
        if (wantsAnalysis(ctx, fresh)) analyze.push(it.id)
        return { ...fresh }
      }
      let fresh = stripDerived(it)
      // An edited original invalidates what was derived from its content
      if (changed) fresh = clean({ ...fresh, faces: undefined, faceDesc: undefined, videoFaces: undefined, sharpness: undefined, hash: undefined, loudness: undefined, hash2: undefined, bitrate: undefined })
      if (fresh.live && !existsSync(fresh.live.source)) delete fresh.live
      ctx.items.set(it.id, withoutEdit(fresh))
      requeue.push(it.id)
      return { ...fresh }
    })
  )
  schedule(ctx, requeue, analyze, reproxy)
  return result
}

// ----------------------------------------------------------------- relink

/**
 * Best match for a missing item among same-named files: same size and modification time (the media
 * id proves it) first, then the known size (a known, different size never matches), then the longest
 * run of matching parent folder names. Ties without a size match return null rather than a guess.
 */
export function pickRelinkCandidate(
  item: MediaItem,
  candidates: ScannedFile[],
  knownSize?: number
): { file: ScannedFile; exact: boolean } | null {
  if (!candidates.length) return null
  const folders = (p: string): string[] => dirname(p).split(/[\\/]/).reverse().map((s) => s.toLowerCase())
  const old = folders(item.path)
  const ranked = candidates
    .map((file) => {
      const f = folders(file.path)
      let tail = 0
      while (tail < old.length && tail < f.length && old[tail] === f[tail]) tail++
      const exact = mediaId(item.path, file.size, file.mtimeMs) === item.id
      return { file, exact, size: exact || file.size === knownSize, tail }
    })
    .sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.size) - Number(a.size) || b.tail - a.tail)
  const [best, second] = ranked
  if (best.exact) return { file: best.file, exact: true }
  if (knownSize !== undefined && !best.size) return null
  if (best.size || !second || best.tail > second.tail) return { file: best.file, exact: false }
  return null
}

/**
 * Gives a moved original (proven identical: same size and time) the cache of its old id, so it
 * needs no processing. Hard links where possible: the pipeline replaces cache files by rename,
 * never in place, so the two folders cannot affect each other.
 */
async function migrateCache(ctx: ServiceContext, oldId: string, file: ScannedFile, live?: ScannedFile): Promise<void> {
  const newId = mediaId(file.path, file.size, file.mtimeMs)
  const from = ctx.folder(oldId)
  const to = ctx.folder(newId)
  if (oldId === newId || existsSync(join(to, META))) return
  const cached = await readJson<MediaItem>(join(from, META))
  if (!cached || cached.id !== oldId || cached.status !== 'ready') return
  await mkdir(to, { recursive: true })
  for (const e of await readdir(from, { withFileTypes: true })) {
    if (!e.isFile() || e.name === META || /\.(tmp|part)/i.test(e.name)) continue
    const src = join(from, e.name)
    const dst = join(to, e.name)
    await link(src, dst).catch(() => copyFile(src, dst))
  }
  const moved = (p: string | undefined): string | undefined => {
    if (!p) return p
    if (isInside(p, from)) return join(to, relative(from, p))
    if (p === cached.path) return file.path
    if (live && cached.live && p === cached.live.source) return live.path
    return p
  }
  const next: MediaItem = clean({
    ...cached,
    id: newId,
    path: file.path,
    name: file.name,
    thumb: moved(cached.thumb),
    display: moved(cached.display),
    playback: moved(cached.playback),
    audio: moved(cached.audio),
    liveVideo: moved(cached.liveVideo),
    stabilized: moved(cached.stabilized),
    live: cached.live ? { ...cached.live, source: moved(cached.live.source)! } : undefined
  })
  await writeJson(join(to, META), next)
}

export async function relinkMedia(ctx: ServiceContext, missing: MediaItem[], dir: string): Promise<Record<string, MediaItem>> {
  const wanted = (Array.isArray(missing) ? missing : []).filter(
    (m): m is MediaItem => !!m && typeof m.id === 'string' && typeof m.path === 'string' && !!m.path
  )
  if (!wanted.length || typeof dir !== 'string' || !dir) return {}
  const files = await scanPaths([dir])
  const byName = new Map<string, ScannedFile[]>()
  for (const f of files) {
    const key = f.name.toLowerCase()
    const list = byName.get(key)
    if (list) list.push(f)
    else byName.set(key, [f])
  }
  const found = new Map<string, { file: ScannedFile; exact: boolean; live?: ScannedFile }>()
  for (const m of wanted) {
    const match = pickRelinkCandidate(m, byName.get(basename(m.path).toLowerCase()) ?? [], await knownSize(ctx, m.id))
    if (!match) continue
    let live: ScannedFile | undefined
    // A Live Photo's MOV sits next to the photo with the same base name
    if (m.live && dirname(m.live.source).toLowerCase() === dirname(m.path).toLowerCase()) {
      const movName = basename(m.live.source).toLowerCase()
      live = files.find((f) => f.dir.toLowerCase() === match.file.dir.toLowerCase() && f.name.toLowerCase() === movName)
    }
    found.set(m.id, { ...match, live })
  }
  for (const [oldId, f] of found) {
    if (f.exact) await migrateCache(ctx, oldId, f.file, f.live).catch(() => {})
  }
  const paths = [...new Set([...found.values()].flatMap((f) => (f.live ? [f.file.path, f.live.path] : [f.file.path])))]
  if (!paths.length) return {}
  const imported = await importPaths(ctx, paths)
  const byPath = new Map(imported.map((it) => [it.path.toLowerCase(), it]))
  const result: Record<string, MediaItem> = {}
  for (const [oldId, f] of found) {
    const it = byPath.get(f.file.path.toLowerCase())
    // the item comes from the cache: the project's own fields (photo edit, kept face centre) go along
    if (it) result[oldId] = withProjectFields(it, wanted.find((m) => m.id === oldId))
  }
  return result
}
