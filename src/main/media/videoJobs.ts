// Video items: what the import reads (probe, tags, Sony sidecar), then the thumbnail, and the sound
// and a playable copy side by side (the original, a remux or an H.264 proxy). Live Photo motion parts
// get their playable copy the same way. Hi-res proxies (4K exports) and stabilised copies are made on
// request.
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { constants } from 'node:os'
import { join } from 'node:path'
import type { MediaItem } from '@shared/types'
import { abortError, isAbort } from '../abort'
import { ID_FOLDER } from '../cache'
import type { ProbeResult } from '../ffmpeg'
import { fromCache, persist } from './cacheMeta'
import { captureTimeOf, deviceOf, makeOf, readTags } from './exif'
import type { ScannedFile } from './scan'
import type { HiresOptions } from './service'
import { clean, PRI_DISPLAY, PRI_THUMB, shortError, type ServiceContext, type Stages } from './serviceContext'
import { stabilizeFile } from './stabilize'
import { extractAudioWithLoudness, PROXY_MAX, remuxVideo, transcodeProxy, videoThumb } from './video'
import { analyzeVideo, canCopyAudio, playbackPlan, streamProxyReason, videoFormatLabel, type VideoInfo } from './videoInfo'

/** GPU proxies run above normal priority (see ProxyOptions.gpuPriority). */
const GPU_PRIORITY = constants.priority.PRIORITY_ABOVE_NORMAL

/** Sony XAVC sidecar (C0001M01.XML): CreationDate with offset and the camera model. */
async function sonySidecar(file: ScannedFile): Promise<{ time?: number; device?: string }> {
  for (const suffix of ['M01.XML', 'M01.xml']) {
    const p = join(file.dir, `${file.base}${suffix}`)
    if (!existsSync(p)) continue
    try {
      const xml = await readFile(p, 'utf8')
      const date = /<CreationDate\s+value="([^"]+)"/.exec(xml)?.[1]
      const model = /<Device\b[^>]*\bmodelName="([^"]+)"/.exec(xml)?.[1]
      const time = date ? Date.parse(date) : NaN
      return { time: Number.isFinite(time) ? time : undefined, device: model }
    } catch {
      return {}
    }
  }
  return {}
}

function probeTime(probe: ProbeResult): number | undefined {
  const tags = probe.format.tags ?? {}
  const raw = tags['com.apple.quicktime.creationdate'] ?? tags.creation_time
  const t = raw ? Date.parse(raw) : NaN
  return Number.isFinite(t) && t > Date.UTC(1980, 0, 1) ? t : undefined
}

export async function prepareVideo(ctx: ServiceContext, file: ScannedFile, id: string): Promise<MediaItem> {
  const base: MediaItem = {
    id,
    path: file.path,
    name: file.name,
    kind: 'video',
    format: file.ext.toUpperCase(),
    width: 0,
    height: 0,
    captureTime: file.mtimeMs,
    status: 'pending'
  }
  const [tags, sidecar, probed] = await Promise.all([
    readTags(file.path, true),
    sonySidecar(file),
    ctx.ff.probe(file.path, ctx.signal).then(
      (probe) => ({ probe }),
      (err: unknown) => ({ err })
    )
  ])
  if ('err' in probed) return { ...base, status: 'error', error: shortError('Unsupported or damaged video', probed.err) }
  const probe = probed.probe
  const info = analyzeVideo(probe)
  if (!info) return { ...base, status: 'error', error: 'No video stream' }
  // GPU path detection runs while the thumbnails are made, before the first proxy (whether HEVC
  // plays directly is only known later: assume it does)
  if (streamProxyReason(info, { hevc: true })) void ctx.gpuFor(info)
  ctx.contexts.set(id, { tags, probe })
  return clean({
    ...base,
    format: videoFormatLabel(file.path, probe, info, makeOf(tags)),
    device: deviceOf(tags) ?? sidecar.device,
    width: info.width,
    height: info.height,
    duration: info.duration,
    fps: info.fps,
    hasAudio: info.hasAudio,
    hdr: !!info.hdr,
    captureTime: sidecar.time ?? captureTimeOf(tags) ?? probeTime(probe) ?? file.mtimeMs
  })
}

/** Playable motion part of a Live/Motion photo: the source itself, a remux or an H.264 proxy (live.mp4). */
export async function makeLiveVideo(ctx: ServiceContext, id: string, source: string, probe?: ProbeResult): Promise<string> {
  const { ff, signal, trace } = ctx
  probe ??= await ff.probe(source, signal)
  const info = analyzeVideo(probe)
  if (!info) throw new Error('no video stream')
  const plan = playbackPlan(source, probe, info, await ctx.directDecode())
  if (plan.kind === 'direct') return source
  const target = join(ctx.folder(id), 'live.mp4')
  if (plan.kind === 'remux') {
    await ctx.audioWork(() => trace.span('live.remux', id, () => remuxVideo(ff, source, info, target, { signal }), { reason: plan.reason }), PRI_DISPLAY, id)
    return target
  }
  const [encoders, gpu] = await Promise.all([ff.encoders(), ctx.gpuFor(info)])
  await ctx.encodeWork(
    () => trace.span('live.proxy', id, () => transcodeProxy(ff, source, info, target, { signal, encoders, gpu, shaderCache: ctx.shaderCache, gpuPriority: GPU_PRIORITY }), { reason: plan.reason, duration: info.duration }),
    PRI_DISPLAY,
    id
  )
  return target
}

/**
 * Sets playback: the original when the renderer plays it, else a remux or an H.264 proxy (progress
 * updates). Remuxes and GPU proxies start once all thumbnails exist; proxies decoded on the CPU
 * also wait for the display images, which they would slow down.
 */
export async function makeVideoPlayback(ctx: ServiceContext, id: string, probe: ProbeResult, vi: VideoInfo): Promise<void> {
  const { ff, signal, trace } = ctx
  const item = ctx.items.get(id)!
  const plan = playbackPlan(item.path, probe, vi, await ctx.directDecode())
  if (plan.kind === 'direct') {
    trace.mark('video.direct', id, { codec: vi.stream.codec_name })
    ctx.set(id, { playback: item.path, proxied: false })
    return
  }
  // Remux and proxy share the file name: both are rebuildable playback copies (cache cleanup)
  const out = join(ctx.folder(id), 'proxy.mp4')
  let last = 0
  let lastAt = 0
  const onProgress = (p: number): void => {
    const now = Date.now()
    if (p - last >= 0.02 && now - lastAt >= 500) {
      last = p
      lastAt = now
      ctx.update(id, { progress: Math.round(p * 1000) / 1000 })
    }
  }
  await ctx.thumbGate.wait(id)
  if (plan.kind === 'remux') {
    await ctx.audioWork(async () => {
      if (ctx.disposed) throw abortError()
      await trace.span('video.remux', id, () => remuxVideo(ff, item.path, vi, out, { signal, onProgress }), { reason: plan.reason, duration: vi.duration })
    }, PRI_DISPLAY, id)
    ctx.set(id, { playback: out, proxied: false })
    return
  }
  const [encoders, gpu] = await Promise.all([ff.encoders(), ctx.gpuFor(vi)])
  const onGpu = !!gpu
  if (!onGpu) await trace.span('video.waitDisplays', id, () => ctx.displayGate.wait(id))
  const traceInfo = { reason: plan.reason, duration: vi.duration, codec: vi.stream.codec_name, edge: Math.max(vi.width, vi.height), fps: vi.fps, gpu: onGpu ? gpu!.decode : null }
  await ctx.encodeWork(async () => {
    if (ctx.disposed) throw abortError()
    await trace.span('video.proxy', id, () => transcodeProxy(ff, item.path, vi, out, { signal, encoders, gpu, shaderCache: ctx.shaderCache, onProgress, gpuPriority: GPU_PRIORITY }), traceInfo)
  }, PRI_DISPLAY, id)
  ctx.set(id, { playback: out, proxied: true })
}

/** The video's sound (audio.m4a) and its loudness, read in one pass; no sound when that fails. */
async function makeVideoSound(ctx: ServiceContext, id: string, probe: ProbeResult, vi: VideoInfo): Promise<void> {
  const { ff, signal, trace } = ctx
  const item = ctx.items.get(id)!
  const audio = join(ctx.folder(id), 'audio.m4a')
  await ctx.thumbGate.wait(id)
  try {
    const loudness = await ctx.audioWork(async () => {
      if (ctx.disposed) throw abortError()
      const extract = (copy: boolean): Promise<number | undefined> =>
        trace.span('video.audio', id, () => extractAudioWithLoudness(ff, item.path, vi, audio, { signal, copy }), { duration: vi.duration, copy })
      const copy = canCopyAudio(probe, vi)
      try {
        return await extract(copy)
      } catch (err) {
        // An odd stream the MP4 muxer refuses as is: encode it instead
        if (!copy || isAbort(err) || signal.aborted) throw err
        return await extract(false)
      }
    }, PRI_DISPLAY, id)
    ctx.set(id, { audio, hasAudio: true, loudness })
  } catch (err) {
    if (isAbort(err) || signal.aborted) throw abortError()
    ctx.set(id, { audio: undefined, hasAudio: false, loudness: undefined })
  }
  ctx.loudnessTried.add(id)
}

export async function processVideo(ctx: ServiceContext, id: string, stages: Stages): Promise<void> {
  const item = ctx.items.get(id)!
  const importCtx = ctx.contexts.get(id) ?? {}
  const thumb = join(ctx.folder(id), 'thumb.jpg')
  let probe: ProbeResult
  let vi: VideoInfo
  try {
    ;({ probe, info: vi } = await ctx.work(async () => {
      if (ctx.disposed) throw abortError()
      const probe = importCtx.probe ?? (await ctx.ff.probe(item.path, ctx.signal))
      const info = analyzeVideo(probe)
      if (!info) throw new Error('no video stream')
      await ctx.trace.span('video.thumb', id, () => videoThumb(ctx.ff, item.path, info, thumb, ctx.signal), { codec: info.stream.codec_name, hdr: info.hdr })
      ctx.update(id, { status: 'processing', thumb, error: undefined })
      return { probe, info }
    }, PRI_THUMB, id))
  } finally {
    stages.leaveThumb()
  }
  // Sound and picture on their own resources at the same time; the item is ready when both are
  const results = await Promise.allSettled([vi.hasAudio ? makeVideoSound(ctx, id, probe, vi) : Promise.resolve(), makeVideoPlayback(ctx, id, probe, vi)])
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) throw failed.reason
}

// ------------------------------------------------------------------ hi-res

export async function prepareHires(ctx: ServiceContext, ids: string[], maxEdge: number, opts: HiresOptions = {}): Promise<Record<string, string>> {
  const { ff } = ctx
  const edge = Math.round(maxEdge)
  const stop = opts.signal ? AbortSignal.any([ctx.signal, opts.signal]) : ctx.signal
  const result: Record<string, string> = {}
  const todo: Array<{ id: string; src: string; out: string; info: VideoInfo; frames: number }> = []
  for (const id of new Set(ids)) {
    const it = ctx.items.get(id)
    if (!it || it.kind !== 'video' || !it.playback) continue
    result[id] = it.playback
    if (!it.proxied || !(edge > PROXY_MAX) || Math.max(it.width, it.height) <= PROXY_MAX) continue
    const out = join(ctx.folder(id), `proxy_${edge}.mp4`)
    if (existsSync(out)) {
      result[id] = out
      continue
    }
    try {
      const info = analyzeVideo(await ff.probe(it.path, stop))
      if (info) todo.push({ id, src: it.path, out, info, frames: Math.max(1, Math.round(info.duration * info.proxyFps)) })
    } catch {
      // unreadable now: keep the regular proxy
      if (stop.aborted) throw abortError()
    }
  }
  if (!todo.length) return result
  const totalFrames = todo.reduce((n, t) => n + t.frames, 0)
  const report = opts.onProgress ?? (() => {})
  const encoders = await ff.encoders()
  let done = 0
  for (let i = 0; i < todo.length; i++) {
    const t = todo[i]
    const message = `${i + 1}/${todo.length}`
    report({ phase: 'prepare', frame: done, totalFrames, message })
    let lastAt = 0
    try {
      await mkdir(ctx.folder(t.id), { recursive: true })
      await transcodeProxy(ff, t.src, t.info, t.out, {
        signal: stop,
        encoders,
        gpu: await ctx.gpuFor(t.info),
        shaderCache: ctx.shaderCache,
        maxEdge: edge,
        onProgress: (p) => {
          const now = Date.now()
          if (now - lastAt >= 250) {
            lastAt = now
            report({ phase: 'prepare', frame: done + Math.round(p * t.frames), totalFrames, message })
          }
        }
      })
      result[t.id] = t.out
    } catch (err) {
      if (stop.aborted || isAbort(err)) throw abortError()
      // keep the regular proxy for this clip
    }
    done += t.frames
  }
  report({ phase: 'prepare', frame: totalFrames, totalFrames, message: `${todo.length}/${todo.length}` })
  return result
}

// -------------------------------------------------------------- stabilise

export async function stabilizeVideo(ctx: ServiceContext, id: string): Promise<void> {
  // e.g. forgotten by a cache cleanup before the renderer restored its project again
  if (!ctx.items.has(id) && typeof id === 'string' && ID_FOLDER.test(id)) {
    const cached = await fromCache(ctx, id)
    if (cached && !ctx.items.has(id)) ctx.items.set(id, cached)
  }
  const it = ctx.items.get(id)
  if (!it || it.kind !== 'video') throw new Error('unknown video')
  if (it.stabilized && existsSync(it.stabilized)) return
  let job = ctx.stabilizing.get(id)
  if (!job) {
    job = runStabilize(ctx, id).finally(() => ctx.stabilizing.delete(id))
    ctx.stabilizing.set(id, job)
    ctx.trackJob(`stabilize:${id}`, job.catch(() => {}))
  }
  return job
}

async function runStabilize(ctx: ServiceContext, id: string): Promise<void> {
  const { ff } = ctx
  await ctx.stabilizeLimit(async () => {
    const it = ctx.items.get(id)
    if (!it || ctx.disposed) throw abortError()
    if (it.status !== 'ready' || !it.playback) throw new Error('video not ready')
    if (it.stabilized && existsSync(it.stabilized)) return
    const out = join(ctx.folder(id), 'stab.mp4')
    let last = 0
    let lastAt = 0
    ctx.update(id, { stabilizing: 0 })
    try {
      await mkdir(ctx.folder(id), { recursive: true })
      await ctx.trace.span('video.stabilize', id, async () =>
        stabilizeFile(ff, it.playback!, out, {
          signal: ctx.signal,
          encoders: await ff.encoders(),
          onProgress: (p) => {
            const now = Date.now()
            if (p - last >= 0.02 && now - lastAt >= 400) {
              last = p
              lastAt = now
              ctx.update(id, { stabilizing: Math.round(p * 1000) / 1000 })
            }
          }
        })
      )
      if (ctx.disposed) return
      ctx.update(id, { stabilized: out, stabilizing: undefined })
      await persist(ctx, id)
    } catch (err) {
      if (!ctx.disposed && ctx.items.has(id)) ctx.update(id, { stabilizing: undefined })
      throw err
    }
  })
}
