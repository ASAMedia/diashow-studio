// New photos and videos for a show (media:import-new): imported like importPaths, but what the show has
// already (the rule is in src/shared/repeats.ts) is left out before any processing starts. Byte-identical
// copies are found through contentHash.ts, which reads only files that share their size with another one.
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { candidateOf, findRepeats, type ImportNewResult, type RepeatCandidate } from '@shared/repeats'
import { ContentHashes, contentKeys, type HashFile } from './contentHash'
import { admit, collect } from './processing'
import type { ServiceContext } from './serviceContext'

/** More media than any show has; a longer list is cut. */
const MAX_SHOW = 50_000

const hashers = new WeakMap<ServiceContext, ContentHashes>()
/** Size and time of the show's files, by media id and path (the id stands for both). */
const sizes = new WeakMap<ServiceContext, Map<string, { size: number; mtimeMs: number }>>()

function hasherOf(ctx: ServiceContext): ContentHashes {
  let h = hashers.get(ctx)
  if (!h) hashers.set(ctx, (h = new ContentHashes((id) => ctx.folder(id), ctx.signal)))
  return h
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0') ? v : undefined)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const localPath = (v: unknown): string | undefined => {
  const p = str(v, 4000)
  return p && isAbsolute(p) && !/^[\\/]{2}[?.][\\/]/.test(p) ? p : undefined
}

/** The show's media as the renderer sends them, checked; malformed entries are dropped. */
export function showList(raw: unknown): RepeatCandidate[] {
  if (!Array.isArray(raw)) return []
  const out: RepeatCandidate[] = []
  for (const r of raw.slice(0, MAX_SHOW) as Array<Record<string, unknown> | null>) {
    const id = str(r?.id, 64)
    const path = localPath(r?.path)
    if (!r || !id || !path || (r.kind !== 'photo' && r.kind !== 'video')) continue
    const live = localPath(r.live)
    const device = str(r.device, 200)
    out.push({ id, path, kind: r.kind, ...(live ? { live } : {}), width: num(r.width), height: num(r.height), captureTime: num(r.captureTime), ...(device ? { device } : {}) })
  }
  return out
}

/** The show's files (a Live Photo's motion part too) with size and time; missing and blocked ones are left out. */
async function showFiles(ctx: ServiceContext, show: RepeatCandidate[]): Promise<HashFile[]> {
  let known = sizes.get(ctx)
  if (!known) sizes.set(ctx, (known = new Map()))
  const cache = known
  const allow = ctx.config.allowPath ?? (() => true)
  const wanted = show.flatMap((c) => (c.live ? [[c.id, c.path], [c.id, c.live]] : [[c.id, c.path]]))
  const out: HashFile[] = []
  for (let i = 0; i < wanted.length; i += 64) {
    const batch = wanted.slice(i, i + 64).map(async ([id, path]): Promise<HashFile | null> => {
      const key = `${id}|${path.toLowerCase()}`
      let st = cache.get(key)
      if (!st) {
        // a network share the user hasn't trusted is not touched
        if (!allow(path)) return null
        const s = await stat(path).catch(() => null)
        if (!s?.isFile()) return null
        st = { size: s.size, mtimeMs: s.mtimeMs }
        cache.set(key, st)
      }
      return { path, ...st, wanted: false }
    })
    for (const f of await Promise.all(batch)) if (f) out.push(f)
  }
  return out
}

/**
 * Imports `paths` for a show whose media are `rawShow` (left-out slides included). Every item comes
 * back; the repeats (id → id of the item it repeats) are not processed and not kept, so a later
 * import of the same files ("Add anyway") starts afresh.
 */
export async function importNew(ctx: ServiceContext, paths: string[], rawShow: unknown): Promise<ImportNewResult> {
  const show = showList(rawShow)
  const before = new Set(ctx.items.keys())
  const { items, files } = await collect(ctx, paths)
  const incoming = items.map(candidateOf)
  // the same file or the same shot: nothing has to be read for these
  let repeats = findRepeats(incoming, show)
  const open: HashFile[] = []
  for (const c of incoming) {
    const f = files.get(c.id)
    if (f && !repeats.has(c.id)) open.push({ path: f.path, size: f.size, mtimeMs: f.mtimeMs, wanted: true })
  }
  if (open.length) {
    const keys = await contentKeys([...open, ...(await showFiles(ctx, show))], hasherOf(ctx))
    if (keys.size) repeats = findRepeats(incoming, show, (p) => keys.get(p.toLowerCase()))
  }
  admit(ctx, items.filter((it) => !repeats.has(it.id)))
  for (const id of repeats.keys()) {
    if (before.has(id) || ctx.jobs.has(id)) continue
    ctx.items.delete(id)
    ctx.contexts.delete(id)
  }
  return { items, repeats: Object.fromEntries(repeats) }
}
