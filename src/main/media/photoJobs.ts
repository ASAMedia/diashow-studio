// Photo items: what the import reads (a header-only read for JPEG & co., else exiftool), then the
// thumbnail, the display image and, for Live / Motion Photos, the playable motion part.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { extOf, SHARP_IMAGE_EXT } from '@shared/formats'
import type { MediaItem } from '@shared/types'
import { abortError, isAbort } from '../abort'
import { fromCache } from './cacheMeta'
import { captureTimeOf, deviceOf, orientationOf, readTags, type Tags } from './exif'
import { endsAtJpegEoi, extractMotionVideo, isMotionPhoto } from './motion'
import { photoFormatLabel, renderPhoto, renderThumb } from './photo'
import { quickPhotoMeta } from './quickMeta'
import { mediaId, type ImportGroup } from './scan'
import { clean, PRI_DISPLAY, PRI_THUMB, type ImportContext, type ServiceContext, type Stages } from './serviceContext'
import { analyzeVideo } from './videoInfo'
import { makeLiveVideo, prepareVideo } from './videoJobs'

/** A Live Photo's motion part is ~3 s; a longer same-named MOV is treated as a separate video. */
const LIVE_MAX_SECONDS = 10
/** Stills that may carry a Motion Photo video after their image data. */
const JPEG_EXT = ['jpg', 'jpeg', 'jpe', 'jfif']

export async function preparePhoto(ctx: ServiceContext, group: ImportGroup, id: string): Promise<MediaItem[]> {
  const file = group.file
  const base = { id, path: file.path, name: file.name, kind: 'photo' as const, status: 'pending' as const }
  const importCtx: ImportContext = {}
  let item: MediaItem
  // JPEG & co. with a zoned EXIF date: header-only read; exiftool runs later in the background, and
  // only when the file may hold a Motion Photo
  const quick = SHARP_IMAGE_EXT.includes(file.ext) ? await quickPhotoMeta(file.path) : null
  if (quick?.captureTime !== undefined) {
    importCtx.motionXmp = !!quick.motionXmp
    item = clean({
      ...base,
      format: photoFormatLabel(file.path, {} as Tags),
      device: deviceOf({ Make: quick.make, Model: quick.model } as Tags),
      width: quick.width,
      height: quick.height,
      captureTime: quick.captureTime
    })
  } else {
    const tags = await readTags(file.path, false)
    const t = tags as Record<string, unknown>
    let w = Number(t.ImageWidth) || quick?.width || 0
    let h = Number(t.ImageHeight) || quick?.height || 0
    if (t.ImageWidth && orientationOf(tags) >= 5) [w, h] = [h, w]
    item = clean({
      ...base,
      format: photoFormatLabel(file.path, tags),
      device: deviceOf(tags),
      width: w,
      height: h,
      captureTime: captureTimeOf(tags) ?? file.mtimeMs
    })
    importCtx.tags = tags
  }
  const extra: MediaItem[] = []
  if (group.live) {
    try {
      const liveProbe = await ctx.ff.probe(group.live.path, ctx.signal)
      const info = analyzeVideo(liveProbe)
      if (info && info.duration <= LIVE_MAX_SECONDS) {
        item.live = { source: group.live.path, duration: info.duration }
        importCtx.liveProbe = liveProbe
      }
    } catch {
      // unreadable MOV: handled as a separate (error) video below
    }
    if (!item.live) {
      const mov = group.live
      const movId = mediaId(mov.path, mov.size, mov.mtimeMs)
      extra.push(ctx.items.get(movId) ?? (await fromCache(ctx, movId)) ?? (await prepareVideo(ctx, mov, movId)))
    }
  }
  ctx.contexts.set(id, importCtx)
  return [item, ...extra]
}

export async function processPhoto(ctx: ServiceContext, id: string, stages: Stages): Promise<void> {
  const { trace } = ctx
  const item = ctx.items.get(id)!
  const importCtx = ctx.contexts.get(id) ?? {}
  const dir = ctx.folder(id)
  const thumb = join(dir, 'thumb.jpg')
  const display = join(dir, 'display.jpg')
  let quickThumb = false
  if (SHARP_IMAGE_EXT.includes(extOf(item.path))) {
    quickThumb = await ctx.work(async () => {
      if (ctx.disposed) throw abortError()
      try {
        await trace.span('photo.thumb', id, () => renderThumb(item.path, thumb))
        return true
      } catch {
        return false // the display pass below reports the real problem
      }
    }, PRI_THUMB, id)
    if (quickThumb) ctx.update(id, { status: 'processing', thumb, error: undefined })
  }
  // Formats without a quick thumbnail (HEIC, RAW, …) get theirs with the display image, which
  // then counts as their thumbnail stage
  if (quickThumb) stages.leaveThumb()
  // Full tags (motion photo markers, RAW previews). Read after the thumbnail pass so exiftool's
  // ~120 ms per photo doesn't compete with it, and before the display slot is taken.
  // A plain JPEG (nothing after its image data, no video in its XMP) needs nothing else from them:
  // sharp reads its orientation and colour profile itself. That saves exiftool's ~150 ms of CPU
  // per photo while the thumbnails are made.
  const plainJpeg = importCtx.motionXmp === false && JPEG_EXT.includes(extOf(item.path)) && (await endsAtJpegEoi(item.path))
  const tags = importCtx.tags ?? (plainJpeg ? ({} as Tags) : await trace.span('photo.tags', id, () => readTags(item.path, false)))
  await ctx.work(async () => {
    if (ctx.disposed) throw abortError()
    if (!quickThumb) ctx.update(id, { status: 'processing', error: undefined })
    const out = await trace.span('photo.display', id, () => renderPhoto({ ff: ctx.ff, raw: ctx.raw }, item.path, tags, { display, thumb: quickThumb ? undefined : thumb }, ctx.signal), { ext: extOf(item.path) })
    ctx.set(id, { width: out.width, height: out.height, display, thumb })
  }, quickThumb ? PRI_DISPLAY : PRI_THUMB, id)
  stages.leaveThumb()
  stages.leaveDisplay()

  let live = item.live && existsSync(item.live.source) ? item.live : undefined
  let liveProbe = live ? importCtx.liveProbe : undefined
  if (!live && isMotionPhoto(tags)) {
    try {
      const motion = join(dir, 'motion.mp4')
      await trace.span('photo.motion', id, () => extractMotionVideo(item.path, tags, motion))
      liveProbe = await ctx.ff.probe(motion, ctx.signal)
      const info = analyzeVideo(liveProbe)
      if (info) live = { source: motion, duration: info.duration }
    } catch (err) {
      if (isAbort(err)) throw err
      live = undefined
    }
  }
  if (!live) {
    ctx.set(id, { live: undefined, liveVideo: undefined })
    return
  }
  try {
    ctx.set(id, { live, liveVideo: await makeLiveVideo(ctx, id, live.source, liveProbe) })
  } catch (err) {
    if (isAbort(err)) throw err
    // The still is fine; only the motion part is unusable
    ctx.set(id, { live: undefined, liveVideo: undefined })
  }
}
