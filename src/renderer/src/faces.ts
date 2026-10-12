// Faces in the background: detection (face-aware crops, Ken Burns, pixelation) and descriptors
// ("pixelate this person everywhere") for every photo, and faces in frames sampled across every
// video. The work runs in the vision worker (vision/), offline; results are stored with the media
// item through the main process. The queue pauses while the show plays, exports or presents.
// Detection always looks at the original picture (display image, playback frames), never at an
// edited one, so faces stay in original-image coordinates whatever the rotate / straighten / crop.
import type { MediaItem, Project, Rect, VideoFaces } from '@shared/types'
import { faceArea, faceDistance, followFace, MATCH_THRESHOLD, rectAt, sampleTimes, thinDescriptors } from '@shared/people'
import { analyzeBitmap, analyzePath, loadBitmap, setDelegate, visionWorkers } from './vision/client'
import { useStore } from './store'

/** Faces as rects normalised to the image; `thorough` adds a fine tile grid for small faces at the back of group photos. */
export async function detectFaces(path: string, thorough = false): Promise<Rect[]> {
  return (await analyzePath(path, { levels: thorough ? 'thorough' : 'photo' })).faces
}

/** Faces of a picture and their descriptors (undefined where the worker couldn't compute them). */
export async function analyzePicture(path: string, thorough = false): Promise<{ faces: Rect[]; desc?: number[][] }> {
  const r = await analyzePath(path, { levels: thorough ? 'thorough' : 'photo', describe: true })
  return { faces: r.faces, desc: r.desc }
}

/** Descriptors of faces already known by their boxes (e.g. found before descriptors existed). */
export async function describeFaces(path: string, faces: Rect[]): Promise<number[][] | undefined> {
  if (!faces.length) return []
  return (await analyzePath(path, { known: faces, describe: true })).desc
}

/** Puts face data into the open project at once (the main process stores it and sends the item back). */
function applyLocally(id: string, patch: Partial<MediaItem>): void {
  const p = useStore.getState().project
  if (p?.media.some((m) => m.id === id)) useStore.setState({ project: { ...p, media: p.media.map((m) => (m.id === id ? { ...m, ...patch } : m)) } })
}

/** Stores the faces of a photo with their descriptors. */
export async function saveFaces(id: string, faces: Rect[], desc: number[][] | undefined): Promise<void> {
  applyLocally(id, { faces, faceDesc: desc })
  await window.api.setFaces(id, faces, desc).catch(() => {})
}

/** Holds of the background analysis (the clean-up), and a counter that makes results of earlier runs void. */
let holds = 0
let epoch = 0

/**
 * Stops the background analysis until the returned function is called; what is being analysed now
 * is thrown away (the clean-up removes the face data meanwhile and must not get it back).
 */
export function holdFaceAnalysis(): () => void {
  holds++
  epoch++
  tried.clear()
  urgent.length = 0
  let released = false
  return () => {
    if (released) return
    released = true
    holds--
    wake?.()
  }
}

/** True while the show plays, exports or presents (or the clean-up runs): background analysis waits. */
export function analysisPaused(): boolean {
  const s = useStore.getState()
  return holds > 0 || s.playing || s.exportOpen || s.fullscreen || s.presenting || s.exportJobs.some((j) => j.state === 'running')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function whilePaused(cancelled: () => boolean): Promise<void> {
  while (analysisPaused() && !cancelled()) await sleep(1500)
}

/** Frames per request to the main process (one decoding pass each). */
const FRAME_BATCH = 16
/** Size video frames are analysed at (long edge, about 720p). */
export const FRAME_EDGE = 1280

/**
 * Faces with descriptors in frames sampled every 0.5 s across a clip (its playback file: rotated
 * and tone-mapped like the preview), several frames at a time (one per vision worker). Waits
 * between frames while the show plays or exports; null when cancelled.
 */
export async function analyzeVideo(m: MediaItem, cancelled: () => boolean = () => false): Promise<VideoFaces[] | null> {
  const src = m.playback ?? m.path
  const times = sampleTimes(m.duration ?? 0)
  const out: VideoFaces[] = []
  for (let i = 0; i < times.length; i += FRAME_BATCH) {
    await whilePaused(cancelled)
    if (cancelled()) return null
    const batch = times.slice(i, i + FRAME_BATCH)
    const frames = await window.api.videoFrames(src, batch, FRAME_EDGE)
    let next = 0
    const lane = async (): Promise<void> => {
      while (next < batch.length) {
        const k = next++
        if (!frames[k]?.length) continue
        await whilePaused(cancelled)
        if (cancelled()) return
        const bmp = await createImageBitmap(new Blob([frames[k] as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }))
        // the fine grid (small faces) every second sample, i.e. once a second
        const r = await analyzeBitmap(bmp, { levels: (i + k) % 2 === 0 ? 'frame' : 'frameQuick', describe: true })
        out.push(r.desc ? { t: batch[k], faces: r.faces, desc: r.desc } : { t: batch[k], faces: r.faces })
      }
    }
    await Promise.all(Array.from({ length: visionWorkers() }, lane))
    if (cancelled()) return null
  }
  out.sort((a, b) => a.t - b.t)
  return thinDescriptors(out)
}

/**
 * Follows one face through a clip from the still it was clicked on (time t0, box `box`, descriptor
 * `desc` when it has one), frame by frame every 0.25 s in both directions inside [from, to]: the
 * detector looks for it near where it was. With a descriptor, a face found must be the same person,
 * and after a quick pan it is looked for in a wide area. While it is not found (turned away,
 * covered), the area stays where it was seen last; after a second without it, following stops.
 * For faces the sampled analysis did not catch. Returns the keyframes as pixelated areas.
 */
export async function trackFace(m: MediaItem, t0: number, box: Rect, from: number, to: number, desc?: number[], cancelled: () => boolean = () => false): Promise<{ t: number; r: Rect }[]> {
  const src = m.playback ?? m.path
  const STEP = 0.25
  const keys: { t: number; r: Rect }[] = [{ t: t0, r: box }]
  const same = (d: number[] | undefined, limit: number): boolean => !desc || !d?.length || faceDistance(desc, d) <= limit
  let found = 0
  for (const dir of [1, -1]) {
    let cur = box
    let misses = 0
    let k = 1
    let stop = false
    while (!stop && !cancelled()) {
      const times: number[] = []
      for (let n = 0; n < FRAME_BATCH; n++, k++) {
        const t = Math.round((t0 + dir * STEP * k) * 1000) / 1000
        if (t < from || t > to) break
        times.push(t)
      }
      if (!times.length) break
      const asc = [...times].sort((a, b) => a - b)
      const frames = await window.api.videoFrames(src, asc, FRAME_EDGE)
      const byTime = new Map(asc.map((t, i) => [t, frames[i]]))
      for (const t of times) {
        const jpeg = byTime.get(t)
        if (!jpeg?.length) {
          stop = true
          break
        }
        const blob = new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
        let r = await analyzeBitmap(await createImageBitmap(blob), { levels: 'frame', known: [cur], locate: 'near', describe: !!desc })
        let hit = (r.score?.[0] ?? 0) > 0 && same(r.desc?.[0], 0.65)
        // lost after a quick pan: look wider, but only take the same person
        if (!hit && desc) {
          r = await analyzeBitmap(await createImageBitmap(blob), { levels: 'frame', known: [cur], locate: 'wide', describe: true })
          hit = (r.score?.[0] ?? 0) > 0 && !!r.desc?.[0]?.length && same(r.desc[0], MATCH_THRESHOLD)
        }
        if (hit) {
          cur = r.faces[0]
          misses = 0
          found++
        } else if (++misses > 4) {
          stop = true
          break
        }
        // a missed frame keeps the last place: better pixelated a moment too long than too short
        keys.push({ t, r: cur })
      }
    }
  }
  if (!found) return []
  keys.sort((a, b) => a.t - b.t)
  const round = (r: Rect): Rect => ({ x: +r.x.toFixed(4), y: +r.y.toFixed(4), w: +r.w.toFixed(4), h: +r.h.toFixed(4) })
  return keys.map((k) => ({ t: k.t, r: round(faceArea(k.r)) }))
}

/** Videos the editor wants analysed first (the pixelation editor is open on them). */
const urgent: string[] = []
/** Media analysed (or failed) in this session; not tried again unless asked for. */
const tried = new Set<string>()
let wake: (() => void) | null = null

/** Moves a video (or photo) to the front of the background analysis. */
export function analyzeSoon(mediaId: string): void {
  if (!urgent.includes(mediaId)) urgent.unshift(mediaId)
  tried.delete(mediaId)
  wake?.()
}

/** Media ids being analysed now (for status hints). */
export const analyzing = new Set<string>()

type Work = 'detect' | 'describe' | 'video'

function needsWork(m: MediaItem): Work | null {
  if (m.status !== 'ready') return null
  if (m.kind === 'photo') {
    if (!m.display) return null
    if (m.faces === undefined) return 'detect'
    if (m.faces.length > 0 && m.faceDesc === undefined) return 'describe'
    return null
  }
  return m.videoFaces === undefined && !!m.duration && !!(m.playback ?? m.path) ? 'video' : null
}

/**
 * Works through the open project's media in the background: photos first (quick, one per vision
 * worker at a time), then videos (one at a time, its frames spread over the workers). Pauses while
 * the show plays, exports or presents, so it never costs frames.
 */
export function startFaceQueue(): () => void {
  let running = 0
  let videoRunning = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const later = (ms: number): void => {
    clearTimeout(timer)
    timer = setTimeout(() => void tick(), ms)
  }
  const pick = (project: Project): { m: MediaItem; work: Work } | null => {
    const media = project.media
    const ok = (m: MediaItem | undefined): Work | null => (m && !tried.has(m.id) && !analyzing.has(m.id) ? needsWork(m) : null)
    for (const id of urgent) {
      const m = media.find((x) => x.id === id)
      const work = ok(m)
      if (m && work) return { m, work }
    }
    // after the clean-up only what the user opens in the pixelation editor, until someone is marked again
    if (project.faceDataRemovedAt && !project.people?.length) return null
    for (const m of media) {
      const work = m.kind === 'photo' ? ok(m) : null
      if (work) return { m, work }
    }
    for (const m of media) {
      const work = m.kind === 'video' ? ok(m) : null
      if (work) return { m, work }
    }
    return null
  }
  const run = async (m: MediaItem, work: Work, projectId: string): Promise<void> => {
    const started = epoch
    const cancelled = (): boolean => stopped || started !== epoch || useStore.getState().project?.id !== projectId
    try {
      // a cancelled run (show closed or switched) leaves the item to be tried again, as for videos
      if (work === 'detect') {
        const { faces, desc } = await analyzePicture(m.display!)
        if (!cancelled()) await saveFaces(m.id, faces, desc)
        else tried.delete(m.id)
      } else if (work === 'describe') {
        const desc = await describeFaces(m.display!, m.faces!)
        if (!cancelled() && desc) await saveFaces(m.id, m.faces!, desc)
        else if (cancelled()) tried.delete(m.id)
      } else {
        const samples = await analyzeVideo(m, cancelled)
        if (samples && !cancelled()) {
          applyLocally(m.id, { videoFaces: samples })
          await window.api.setVideoFaces(m.id, samples).catch(() => {})
        } else tried.delete(m.id)
      }
    } catch (e) {
      console.warn('face analysis failed', m.name, e)
    }
  }
  const tick = (): void => {
    if (stopped || videoRunning) return
    if (analysisPaused()) return later(1500)
    const s = useStore.getState()
    while (s.project && running < visionWorkers()) {
      const next = pick(s.project)
      // a video uses every worker: it waits for the photos in work, and they for it
      if (!next || (next.work === 'video' && running > 0)) break
      const { m, work } = next
      running++
      analyzing.add(m.id)
      tried.add(m.id)
      if (work === 'video') videoRunning = true
      void run(m, work, s.project.id).finally(() => {
        running--
        analyzing.delete(m.id)
        if (work === 'video') videoRunning = false
        const u = urgent.indexOf(m.id)
        if (u >= 0) urgent.splice(u, 1)
        later(20)
      })
      if (work === 'video') break
    }
  }
  wake = tick
  const unsubscribe = useStore.subscribe(tick)
  tick()
  return () => {
    stopped = true
    wake = null
    clearTimeout(timer)
    unsubscribe()
  }
}

/** Hooks for the end-to-end tests and measurements (window.__diashow.faces). */
export const faceTestApi = { analyzePath, analyzeBitmap, loadBitmap, setDelegate, analyzeVideo, describeFaces, analyzePicture, followFace, rectAt, trackFace }
