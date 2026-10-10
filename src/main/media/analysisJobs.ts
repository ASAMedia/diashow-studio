// The last pass over ready items: hash and sharpness of photos, the signature of video clips
// (finding the same clip twice) and the loudness of video sound that older cache entries lack.
import { stat } from 'node:fs/promises'
import type { MediaItem } from '@shared/types'
import { analyzeImage, imageHash, videoFrameHash } from './analysis'
import { persist } from './cacheMeta'
import { PRI_ANALYSIS, type ServiceContext } from './serviceContext'

/** Ready items from older versions lack the analysis fields; they are filled in lazily. */
function needsAnalysis(item: MediaItem): boolean {
  if (item.status !== 'ready') return false
  if (item.kind === 'photo') return !!item.display && (item.hash === undefined || item.sharpness === undefined)
  // hash2 and bitrate (finding the same clip twice) came later than the thumbnail hash
  return !!item.thumb && (item.hash === undefined || (!!item.playback && item.hash2 === undefined))
}

const wantsLoudness = (ctx: ServiceContext, it: MediaItem): boolean =>
  it.status === 'ready' && it.kind === 'video' && !!it.audio && it.loudness === undefined && !ctx.loudnessTried.has(it.id)

export const wantsAnalysis = (ctx: ServiceContext, it: MediaItem): boolean => needsAnalysis(it) || wantsLoudness(ctx, it)

/**
 * Videos: hash of a frame at 60 % of the playable copy (with the thumbnail's hash at 10 % it tells
 * the same clip from another one of the same scene) and the original's bit rate (to keep the
 * original over a re-encode). Each part stays unset when it can't be read (retried on restore).
 */
async function clipSignature(ctx: ServiceContext, it: MediaItem): Promise<Partial<MediaItem>> {
  const out: Partial<MediaItem> = {}
  try {
    out.hash2 = await videoFrameHash(ctx.ff, it.playback!, (it.duration ?? 0) * 0.6, ctx.signal)
  } catch {
    // unreadable frame
  }
  try {
    const size = (await stat(it.path)).size
    if (it.duration && it.duration > 0) out.bitrate = Math.round((size * 8) / it.duration)
  } catch {
    // original gone
  }
  return out
}

/**
 * Hash / sharpness (photos), hash (videos) and loudness of older cache entries. Waits until every
 * item has its essential files (thumbnail, display image, playable video, sound), unless the
 * renderer focuses this item; runs at the lowest priority of the CPU pool.
 */
export function startAnalysis(ctx: ServiceContext, id: string): void {
  const { trace } = ctx
  const key = `analysis:${id}`
  if (ctx.jobs.has(key) || ctx.disposed) return
  const job = (async () => {
    await ctx.essentialGate.wait(id)
    await ctx.work(async () => {
      const it = ctx.items.get(id)
      if (!it || ctx.disposed || !wantsAnalysis(ctx, it)) return
      const patch: Partial<MediaItem> = {}
      if (needsAnalysis(it)) {
        try {
          Object.assign(patch, await trace.span('analysis', id, async () => (it.kind === 'photo' ? await analyzeImage(it.display!) : { hash: it.hash ?? (await imageHash(it.thumb!)) }), { kind: it.kind }))
        } catch {
          // retried on the next restore
        }
        if (it.kind === 'video' && it.playback) Object.assign(patch, await trace.span('analysis.clip', id, () => clipSignature(ctx, it)))
      }
      if (wantsLoudness(ctx, it)) {
        ctx.loudnessTried.add(id)
        const loudness = await trace.span('loudness', id, () => ctx.loudnessOf(it.audio!))
        if (loudness !== undefined) patch.loudness = loudness
      }
      if (ctx.disposed || !Object.keys(patch).length || ctx.items.get(id)?.status !== 'ready') return
      ctx.update(id, patch)
      await persist(ctx, id)
    }, PRI_ANALYSIS, id)
  })().catch(() => {})
  ctx.trackJob(key, job)
}
