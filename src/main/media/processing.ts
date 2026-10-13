// Import and processing of media items.
//
// Order of work (MediaOrder): what the renderer looks at (prioritize) first, then the show order.
// Every item gets its thumbnail before any heavier work starts (thumbGate). Then, in parallel and
// each on its own resource: display images (CPU pool), the videos' sound and remuxes (audio pool)
// and proxies (encoder pool: those on the GPU path start at once, CPU-decoded ones once the display
// images are done, displayGate). Hash, sharpness and lazily filled loudness come last, once every
// item has its thumbnail, display image / playable video and sound (essentialGate); music beats and
// loudness only wait for the thumbnails and display images (afterCpuWork, musicJobs.ts).
// Measured on 625 phone files (17 GB): everything ready after 130 s instead of 558 s; the hardware
// encoder (NVENC, ~300 fps at 1080p) is then the limit.
import { mkdir } from 'node:fs/promises'
import type { MediaItem } from '@shared/types'
import { startAnalysis, wantsAnalysis } from './analysisJobs'
import { fromCache, persist, rememberSource } from './cacheMeta'
import { preparePhoto, processPhoto } from './photoJobs'
import { mediaId, pairFiles, scanPaths, type ImportGroup, type ScannedFile } from './scan'
import { once, shortError, type ServiceContext } from './serviceContext'
import { analyzeVideo } from './videoInfo'
import { makeLiveVideo, makeVideoPlayback, prepareVideo, processVideo } from './videoJobs'

function prepare(ctx: ServiceContext, group: ImportGroup): Promise<MediaItem[]> {
  const f = group.file
  const id = mediaId(f.path, f.size, f.mtimeMs)
  const current = ctx.items.get(id)
  if (current && current.status !== 'error') return Promise.resolve([current])
  const running = ctx.preparing.get(id)
  if (running) return running
  const task = ctx.metaLimit(async () => {
    const cached = await fromCache(ctx, id)
    if (cached) {
      ctx.items.set(id, cached)
      return [cached]
    }
    const result = await ctx.trace.span('prepare', id, async () => (f.kind === 'video' ? [await prepareVideo(ctx, f, id)] : await preparePhoto(ctx, group, id)), { kind: f.kind })
    for (const it of result) ctx.items.set(it.id, it)
    return result
  }).finally(() => ctx.preparing.delete(id))
  ctx.preparing.set(id, task)
  return task
}

export async function importPaths(ctx: ServiceContext, paths: string[]): Promise<MediaItem[]> {
  const { items } = await collect(ctx, paths)
  admit(ctx, items)
  return items
}

/**
 * The first half of an import: files and folders scanned, paired and their metadata read. Returns the
 * items in show order (capture time, then name) and the scanned files by media id; nothing is
 * processed until admit().
 */
export async function collect(ctx: ServiceContext, paths: string[]): Promise<{ items: MediaItem[]; files: Map<string, ScannedFile> }> {
  const { trace } = ctx
  const files = await trace.span('scan', undefined, () => scanPaths(paths))
  const groups = pairFiles(files)
  const lists = await trace.span('prepareAll', undefined, () => Promise.all(groups.map((g) => prepare(ctx, g))), { groups: groups.length })
  const seen = new Set<string>()
  const result: MediaItem[] = []
  for (const it of lists.flat()) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    result.push({ ...(ctx.items.get(it.id) ?? it) })
  }
  result.sort((a, b) => a.captureTime - b.captureTime || a.name.localeCompare(b.name, undefined, { numeric: true }))
  return { items: result, files: new Map(files.map((f) => [mediaId(f.path, f.size, f.mtimeMs), f])) }
}

/** The second half: the items join the show order and their processing starts. */
export function admit(ctx: ServiceContext, items: MediaItem[]): void {
  const now = Date.now()
  for (const it of items) ctx.recent.set(it.id, now)
  ctx.order.add(items.map((it) => it.id))
  schedule(
    ctx,
    items.filter((it) => it.status === 'pending').map((it) => it.id),
    items.filter((it) => wantsAnalysis(ctx, it)).map((it) => it.id)
  )
}

/**
 * Called once an API call has its complete result: jobs start on the next macrotask, so the IPC
 * reply carrying the 'pending' items reaches the renderer before the first media:update for them.
 */
export function schedule(ctx: ServiceContext, ids: string[], analyze: string[] = [], reproxy: string[] = []): void {
  if (ids.length || analyze.length || reproxy.length) {
    setImmediate(() => {
      for (const id of ids) startJob(ctx, id)
      for (const id of analyze) startAnalysis(ctx, id)
      for (const id of reproxy) startReproxy(ctx, id)
    })
  }
}

function startJob(ctx: ServiceContext, id: string): void {
  if (ctx.jobs.has(id) || ctx.disposed || !ctx.items.has(id)) return
  ctx.trackJob(id, runJob(ctx, id))
}

async function runJob(ctx: ServiceContext, id: string): Promise<void> {
  if (ctx.disposed) return
  const item = ctx.items.get(id)!
  // Entered synchronously, so every item of a schedule() is counted before any of them waits
  const leaveEssential = once(ctx.essentialGate)
  const leaveThumb = once(ctx.thumbGate)
  const leaveDisplay = item.kind === 'photo' ? once(ctx.displayGate) : () => {}
  let ready = false
  try {
    await mkdir(ctx.folder(id), { recursive: true })
    const stages = { leaveThumb, leaveDisplay }
    await ctx.trace.span('job', id, () => (item.kind === 'photo' ? processPhoto(ctx, id, stages) : processVideo(ctx, id, stages)), { kind: item.kind })
    if (ctx.disposed) return
    ctx.update(id, { status: 'ready', progress: undefined, error: undefined })
    ready = true
    await persist(ctx, id)
    await rememberSource(ctx, id)
  } catch (err) {
    if (ctx.disposed) return
    const context = item.kind === 'photo' ? 'Photo could not be read' : 'Video could not be converted'
    ctx.update(id, { status: 'error', progress: undefined, error: shortError(context, err) })
  } finally {
    ctx.contexts.delete(id)
    leaveThumb()
    leaveDisplay()
    leaveEssential()
  }
  if (ready && wantsAnalysis(ctx, ctx.items.get(id)!)) startAnalysis(ctx, id)
}

/** Restored item whose proxy was deleted: only the proxy is made again. */
function startReproxy(ctx: ServiceContext, id: string): void {
  if (ctx.jobs.has(id) || ctx.disposed || !ctx.items.has(id)) return
  ctx.trackJob(id, runReproxy(ctx, id))
}

async function runReproxy(ctx: ServiceContext, id: string): Promise<void> {
  const item = ctx.items.get(id)!
  const leaveEssential = once(ctx.essentialGate)
  try {
    await mkdir(ctx.folder(id), { recursive: true })
    if (item.kind === 'video') {
      const probe = await ctx.ff.probe(item.path, ctx.signal)
      const vi = analyzeVideo(probe)
      if (!vi) throw new Error('no video stream')
      await makeVideoPlayback(ctx, id, probe, vi)
      if (ctx.disposed) return
      ctx.update(id, { status: 'ready', progress: undefined, error: undefined })
    } else {
      const liveVideo = await makeLiveVideo(ctx, id, item.live!.source)
      if (ctx.disposed) return
      ctx.update(id, { liveVideo })
    }
    await persist(ctx, id)
  } catch (err) {
    if (ctx.disposed) return
    if (item.kind === 'video') ctx.update(id, { status: 'error', progress: undefined, error: shortError('Video could not be converted', err) })
    else {
      ctx.update(id, { live: undefined, liveVideo: undefined })
      await persist(ctx, id)
    }
  } finally {
    leaveEssential()
  }
  const it = ctx.items.get(id)
  if (it && wantsAnalysis(ctx, it)) startAnalysis(ctx, id)
}
