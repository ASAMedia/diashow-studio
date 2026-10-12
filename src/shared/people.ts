// "This person everywhere": recognising marked people by their face descriptors, following faces
// through the sampled frames of a video, and the areas the engine pixelates at a given time.
// Pure functions, shared by the engine, the editor and the tests.
import type { MediaItem, Person, Project, Rect, VideoEntry, VideoFaces, PhotoEntry } from './types'
import { facesInEdit, isEdited, sourceAspect } from './mediaEdit'

/**
 * Largest descriptor distance (Euclidean, 128-d dlib descriptors) still counted as the same person.
 * dlib's own recommendation is 0.6 with its 5-point alignment; our alignment from BlazeFace's
 * keypoints and the small, blurry faces of group photos and video frames call for a stricter value
 * (tuned on class-trip photos; see README).
 */
export const MATCH_THRESHOLD = 0.5

/** Video analysis: one frame every half second, at most VIDEO_MAX_SAMPLES per clip. */
export const VIDEO_SAMPLE_STEP = 0.5
export const VIDEO_MAX_SAMPLES = 180

/** Sample times (source seconds) for a clip: centres of equal slices, every 0.5 s or fewer for long clips. */
export function sampleTimes(duration: number): number[] {
  if (!(duration > 0)) return []
  const n = Math.max(1, Math.min(VIDEO_MAX_SAMPLES, Math.round(duration / VIDEO_SAMPLE_STEP)))
  const step = duration / n
  return Array.from({ length: n }, (_, i) => Math.round((i + 0.5) * step * 1000) / 1000)
}

/** Centre of faces weighted by their size (where crops and Ken Burns aim), or null without faces. */
export function faceCentre(faces: readonly Rect[] | undefined): { x: number; y: number } | null {
  if (!faces?.length) return null
  let sum = 0
  let x = 0
  let y = 0
  for (const f of faces) {
    const a = f.w * f.h
    sum += a
    x += (f.x + f.w / 2) * a
    y += (f.y + f.h / 2) * a
  }
  return { x: x / sum, y: y / sum }
}

/** A detected face grown to cover hair and chin, as the area to pixelate. */
export function faceArea(r: Rect): Rect {
  const x = Math.max(0, r.x - r.w * 0.18)
  const y = Math.max(0, r.y - r.h * 0.3)
  return { x, y, w: Math.min(1 - x, r.w * 1.36), h: Math.min(1 - y, r.h * 1.5) }
}

export function faceDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || !a.length) return Infinity
  let s = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    s += d * d
  }
  return Math.sqrt(s)
}

const hasDesc = (d: number[] | undefined): d is number[] => !!d && d.length > 0

/** Smallest distance of a descriptor to any of a person's descriptors. */
export function personDistance(desc: readonly number[], person: Person): number {
  let best = Infinity
  for (const p of person.desc) best = Math.min(best, faceDistance(desc, p))
  return best
}

/** The closest person within the threshold, or null. */
export function matchPerson(desc: readonly number[] | undefined, people: readonly Person[] | undefined, threshold = MATCH_THRESHOLD): { person: Person; d: number } | null {
  if (!desc?.length || !people?.length) return null
  let best: { person: Person; d: number } | null = null
  for (const person of people) {
    const d = personDistance(desc, person)
    if (d <= threshold && (!best || d < best.d)) best = { person, d }
  }
  return best
}

// ---------------------------------------------------------------- video tracks

export interface TrackKey {
  t: number
  r: Rect
  desc?: number[]
}

/** One face followed through a clip's sampled frames. */
export interface FaceTrack {
  keys: TrackKey[]
}

const centre = (r: Rect): [number, number] => [r.x + r.w / 2, r.y + r.h / 2]

/** Spacing of samples: the smallest gap between them (keys of a track may skip samples), at least 0.1 s. */
function sampleStep(times: number[]): number {
  let step = Infinity
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > 1e-3) step = Math.min(step, times[i] - times[i - 1])
  return step === Infinity ? VIDEO_SAMPLE_STEP : Math.max(0.1, step)
}

/** How far apart (in samples) a face may vanish and still be the same track. */
const MAX_MISSED = 3

/**
 * Links the faces of consecutive samples into tracks: a face continues the track whose last face is
 * near (within about a face width per sample, more after missed samples), of similar size, and not
 * clearly someone else by descriptor. Greedy by cost; a face that continues no track starts one.
 */
export function buildFaceTracks(samples: readonly VideoFaces[] | undefined): FaceTrack[] {
  if (!samples?.length) return []
  const sorted = [...samples].sort((a, b) => a.t - b.t)
  const step = sampleStep(sorted.map((s) => s.t))
  const maxGap = step * (MAX_MISSED + 0.6)
  const done: FaceTrack[] = []
  let active: { track: FaceTrack; last: TrackKey; desc?: number[] }[] = []
  for (const s of sorted) {
    active = active.filter((a) => {
      if (s.t - a.last.t <= maxGap) return true
      done.push(a.track)
      return false
    })
    const faces = s.faces.map((r, i): TrackKey => (hasDesc(s.desc?.[i]) ? { t: s.t, r, desc: s.desc![i] } : { t: s.t, r }))
    const pairs: { a: number; f: number; cost: number }[] = []
    active.forEach((a, ai) => {
      const missed = Math.max(1, Math.round((s.t - a.last.t) / step))
      faces.forEach((f, fi) => {
        const [ax, ay] = centre(a.last.r)
        const [fx, fy] = centre(f.r)
        const move = Math.hypot((fx - ax) / Math.max(a.last.r.w, f.r.w), (fy - ay) / Math.max(a.last.r.h, f.r.h))
        const size = Math.max(a.last.r.w, f.r.w) / Math.max(1e-6, Math.min(a.last.r.w, f.r.w))
        if (move > 1.2 + 0.8 * (missed - 1) || size > 1.8) return
        const dd = a.desc && f.desc ? faceDistance(a.desc, f.desc) : undefined
        if (dd !== undefined && dd > 0.7) return
        pairs.push({ a: ai, f: fi, cost: move + (dd ?? 0.4) * 1.5 + (missed - 1) * 0.3 })
      })
    })
    pairs.sort((x, y) => x.cost - y.cost)
    const usedA = new Set<number>()
    const usedF = new Set<number>()
    for (const p of pairs) {
      if (usedA.has(p.a) || usedF.has(p.f)) continue
      usedA.add(p.a)
      usedF.add(p.f)
      const a = active[p.a]
      const f = faces[p.f]
      a.track.keys.push(f)
      a.last = f
      if (f.desc) a.desc = f.desc
    }
    faces.forEach((f, fi) => {
      if (usedF.has(fi)) return
      const track = { keys: [f] }
      active.push({ track, last: f, desc: f.desc })
    })
  }
  done.push(...active.map((a) => a.track))
  return done.sort((a, b) => a.keys[0].t - b.keys[0].t)
}

/**
 * What is stored of a clip's analysis: every face, but descriptors (1 kB each in the project) only on
 * every second sample, and on faces that just appeared (nothing near them in the sample before), so
 * every track has some. Faces without one get an empty descriptor.
 */
export function thinDescriptors(samples: readonly VideoFaces[]): VideoFaces[] {
  return samples.map((s, i) => {
    if (!s.desc) return { t: s.t, faces: s.faces }
    const prev = samples[i - 1]?.faces ?? []
    const desc = s.desc.map((d, fi) => {
      const f = s.faces[fi]
      const fresh = !prev.some((p) => {
        const [ax, ay] = centre(p)
        const [bx, by] = centre(f)
        return Math.hypot((bx - ax) / Math.max(p.w, f.w), (by - ay) / Math.max(p.h, f.h)) < 1.2
      })
      return i % 2 === 0 || fresh ? d : []
    })
    return desc.some((d) => d.length) ? { t: s.t, faces: s.faces, desc } : { t: s.t, faces: s.faces }
  })
}

/** Closest person of a track: its best descriptor within the threshold. */
export function matchTrack(track: FaceTrack, people: readonly Person[] | undefined, threshold = MATCH_THRESHOLD): { person: Person; d: number } | null {
  let best: { person: Person; d: number } | null = null
  for (const k of track.keys) {
    const m = matchPerson(k.desc, people, threshold)
    if (m && (!best || m.d < best.d)) best = m
  }
  return best
}

const lerp = (a: number, b: number, u: number): number => a + (b - a) * u

/**
 * The area of a keyframed track at time t, or null when the track doesn't cover t. Between keys the
 * box moves linearly and grows by part of the distance between them (the face may not move in a
 * straight line); before the first and after the last key it stays for `hold` seconds, so the
 * pixelation starts a little early and ends a little late rather than the other way round. Keys
 * further apart than `maxGap` are not joined.
 */
export function rectAt(keys: readonly { t: number; r: Rect }[], t: number, hold?: number, maxGap?: number): Rect | null {
  if (!keys.length) return null
  const step = sampleStep(keys.map((k) => k.t))
  const h = hold ?? Math.max(0.3, step)
  const gap = maxGap ?? step * (MAX_MISSED + 0.6)
  if (t < keys[0].t - h || t > keys[keys.length - 1].t + h) return null
  if (t <= keys[0].t) return keys[0].r
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].r
  let i = 0
  while (i < keys.length - 2 && keys[i + 1].t < t) i++
  const a = keys[i]
  const b = keys[i + 1]
  if (b.t - a.t > gap) {
    if (t - a.t <= h) return a.r
    if (b.t - t <= h) return b.r
    return null
  }
  const u = (t - a.t) / Math.max(1e-6, b.t - a.t)
  const spread = 4 * u * (1 - u) * 0.5
  const ex = Math.abs(b.r.x + b.r.w / 2 - (a.r.x + a.r.w / 2)) * spread
  const ey = Math.abs(b.r.y + b.r.h / 2 - (a.r.y + a.r.h / 2)) * spread
  const x = lerp(a.r.x, b.r.x, u) - ex / 2
  const y = lerp(a.r.y, b.r.y, u) - ey / 2
  const x0 = Math.max(0, x)
  const y0 = Math.max(0, y)
  return { x: x0, y: y0, w: Math.min(1 - x0, lerp(a.r.w, b.r.w, u) + ex - (x0 - x)), h: Math.min(1 - y0, lerp(a.r.h, b.r.h, u) + ey - (y0 - y)) }
}

/** A track as pixelated keyframes (faces grown to cover hair and chin), times rounded to ms. */
export function trackAreas(track: FaceTrack): { t: number; r: Rect }[] {
  return track.keys.map((k) => ({ t: Math.round(k.t * 1000) / 1000, r: roundRect(faceArea(k.r)) }))
}

const roundRect = (r: Rect): Rect => ({ x: +r.x.toFixed(4), y: +r.y.toFixed(4), w: +r.w.toFixed(4), h: +r.h.toFixed(4) })

const iou = (a: Rect, b: Rect): number => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = x * y
  return inter / Math.max(1e-9, a.w * a.h + b.w * b.h - inter)
}

/**
 * The keyframes that follow a face clicked on a still at time `t` (face box `r`, descriptor `desc`
 * if known) through the clip: the track at that place and time, joined by later or earlier tracks of
 * the same person (descriptor) that don't overlap it in time. Null when no track is near.
 */
export function followFace(samples: readonly VideoFaces[] | undefined, t: number, r: Rect, desc?: readonly number[], threshold = MATCH_THRESHOLD): { t: number; r: Rect }[] | null {
  const tracks = buildFaceTracks(samples)
  let best: { track: FaceTrack; score: number } | null = null
  for (const track of tracks) {
    const at = rectAt(track.keys, t, 0.6)
    if (!at) continue
    const overlap = iou(at, r)
    const dd = desc?.length ? Math.min(...track.keys.map((k) => (k.desc ? faceDistance(desc, k.desc) : Infinity))) : Infinity
    if (overlap < 0.2 && !(dd <= threshold && overlap > 0)) continue
    const score = overlap - (dd === Infinity ? 0.2 : dd * 0.5)
    if (!best || score > best.score) best = { track, score }
  }
  if (!best) return null
  // the same person further on (or before): every descriptor of the track counts
  const own = best.track.keys.filter((k) => k.desc).map((k) => k.desc!)
  if (desc?.length) own.push([...desc])
  const person: Person = { id: '', desc: own }
  const keys = [...best.track.keys]
  for (const other of tracks) {
    if (other === best.track || !own.length || !matchTrack(other, [person], threshold)) continue
    const from = other.keys[0].t
    const to = other.keys[other.keys.length - 1].t
    if (keys.some((k) => k.t >= from - 0.01 && k.t <= to + 0.01)) continue
    keys.push(...other.keys)
  }
  keys.sort((a, b) => a.t - b.t)
  return trackAreas({ keys })
}

/** Every face of a clip (inside its trimmed part) as followed areas: "all faces" for a video. */
export function allVideoTracks(e: VideoEntry, m: MediaItem): { t: number; r: Rect }[][] {
  const from = (e.trimIn ?? 0) - 0.5
  const to = (e.trimOut ?? m.duration ?? Infinity) + 0.5
  return buildFaceTracks(m.videoFaces)
    .filter((tr) => tr.keys[tr.keys.length - 1].t >= from && tr.keys[0].t <= to)
    .map(trackAreas)
}

// ---------------------------------------------------------------- project-wide matches

/** Faces of a photo that belong to a marked person (index into media.faces). */
export function photoPersonFaces(m: MediaItem, people: readonly Person[] | undefined, threshold = MATCH_THRESHOLD): { i: number; person: Person; d: number }[] {
  if (!people?.length || !m.faces?.length || !m.faceDesc) return []
  const out: { i: number; person: Person; d: number }[] = []
  m.faces.forEach((_, i) => {
    const hit = matchPerson(m.faceDesc![i], people, threshold)
    if (hit) out.push({ i, ...hit })
  })
  return out
}

/** A marked person's track in a video: pixelated keyframes and the track's descriptors. */
export interface PersonTrack {
  person: Person
  d: number
  keys: { t: number; r: Rect }[]
  /** Face box and time of the key with the best match (for a picture of it). */
  best: { t: number; r: Rect }
  desc: number[][]
}

/** Tracks of a video that belong to a marked person, as pixelated keyframes. */
export function videoPersonTracks(m: MediaItem, people: readonly Person[] | undefined, threshold = MATCH_THRESHOLD): PersonTrack[] {
  if (!people?.length || !m.videoFaces?.length) return []
  const out: PersonTrack[] = []
  for (const track of buildFaceTracks(m.videoFaces)) {
    const hit = matchTrack(track, people, threshold)
    if (!hit) continue
    const withDesc = track.keys.filter((k) => k.desc)
    const best = withDesc.reduce((a, b) => (personDistance(b.desc!, hit.person) < personDistance(a.desc!, hit.person) ? b : a), withDesc[0])
    out.push({ ...hit, keys: trackAreas(track), best: { t: best.t, r: best.r }, desc: withDesc.map((k) => k.desc!) })
  }
  return out
}

/** Short fingerprint of the marked people (ids and descriptor counts and first values). */
export function peopleKey(people: readonly Person[] | undefined): string {
  return (people ?? []).map((p) => `${p.id}:${p.desc.length}:${p.desc.map((d) => d[0]).join(',')}`).join('|')
}

/** Short fingerprint of a media item's face data, to know when cached matches are stale. */
export function faceDataKey(m: MediaItem): string {
  const f = m.faces ?? []
  const v = m.videoFaces ?? []
  let s = 0
  for (const r of f) s += r.x + 2 * r.y + 3 * r.w
  for (const d of m.faceDesc ?? []) s += d[0] ?? 0
  for (const x of v) s += x.t + x.faces.length * 7 + (x.desc?.length ?? 0) * 3
  return `${m.id}:${f.length}:${m.faceDesc?.length ?? -1}:${v.length}:${s.toFixed(5)}`
}

// ---------------------------------------------------------------- coverage (review before export)

/** Is a face (box) hidden by one of the pixelated areas (ellipses inside the rects)? */
export function isCovered(face: Rect, areas: readonly Rect[]): boolean {
  const [cx, cy] = centre(face)
  return areas.some((a) => {
    const dx = (cx - (a.x + a.w / 2)) / (a.w / 2)
    const dy = (cy - (a.y + a.h / 2)) / (a.h / 2)
    if (dx * dx + dy * dy > 1) return false
    const x = Math.max(0, Math.min(face.x + face.w, a.x + a.w) - Math.max(face.x, a.x))
    const y = Math.max(0, Math.min(face.y + face.h, a.y + a.h) - Math.max(face.y, a.y))
    return (x * y) / Math.max(1e-9, face.w * face.h) >= 0.6
  })
}

/** Faces of a photo entry that stay recognisable: neither in an area nor a marked person. */
export function openPhotoFaces(e: PhotoEntry, m: MediaItem, people: readonly Person[] | undefined, threshold = MATCH_THRESHOLD): Rect[] {
  if (!m.faces?.length) return []
  const marked = new Set(photoPersonFaces(m, people, threshold).map((x) => x.i))
  return m.faces.filter((f, i) => !marked.has(i) && !isCovered(f, e.privacy ?? []))
}

/**
 * Sampled frames of a video entry (inside its trimmed part) with faces that stay recognisable:
 * not in a static area, a followed track or a marked person's track at that time.
 */
export function openVideoFaces(e: VideoEntry, m: MediaItem, people: readonly Person[] | undefined, threshold = MATCH_THRESHOLD): VideoFaces[] {
  if (!m.videoFaces?.length) return []
  const from = (e.trimIn ?? 0) - 0.25
  const to = (e.trimOut ?? m.duration ?? Infinity) + 0.25
  const tracks = [...(e.privacyTracks ?? []), ...videoPersonTracks(m, people, threshold).map((x) => x.keys)]
  const out: VideoFaces[] = []
  for (const s of m.videoFaces) {
    if (s.t < from || s.t > to) continue
    const areas = [...(e.privacy ?? []), ...tracks.map((k) => rectAt(k, s.t)).filter((r): r is Rect => !!r)]
    const open = s.faces.filter((f) => !isCovered(f, areas))
    if (open.length) out.push({ t: s.t, faces: open })
  }
  return out
}

/** A face recognised as a marked person, for the people list. */
export interface PersonMatch {
  mediaId: string
  /** Face box (normalised) and, for videos, the source time of the frame it was seen in. */
  r: Rect
  t?: number
  d: number
  /** Descriptors behind the match (one for a photo face, the track's for a video). */
  desc: number[][]
}

/** Every face in the project that belongs to each marked person (photos and video tracks). */
export function peopleMatches(project: Project, threshold = MATCH_THRESHOLD): Map<string, PersonMatch[]> {
  const people = project.people ?? []
  const out = new Map<string, PersonMatch[]>(people.map((p) => [p.id, []]))
  if (!people.length) return out
  const used = new Set(project.entries.flatMap((e) => (e.type === 'text' || e.excluded ? [] : [e.mediaId])))
  for (const m of project.media) {
    if (!used.has(m.id)) continue
    for (const x of photoPersonFaces(m, people, threshold)) out.get(x.person.id)!.push({ mediaId: m.id, r: m.faces![x.i], d: x.d, desc: [m.faceDesc![x.i]] })
    for (const x of videoPersonTracks(m, people, threshold)) out.get(x.person.id)!.push({ mediaId: m.id, r: x.best.r, t: x.best.t, d: x.d, desc: x.desc })
  }
  return out
}

/**
 * "Not this person": drops the descriptors of a person that make a wrongly matched face (or every
 * face of a wrongly matched video track) count as them, i.e. all within the threshold of it.
 * Returns the person's remaining descriptors.
 */
export function withoutMatch(person: Person, wrong: readonly number[] | readonly (readonly number[])[], threshold = MATCH_THRESHOLD): number[][] {
  const list = (Array.isArray(wrong[0]) ? wrong : [wrong]) as readonly (readonly number[])[]
  return person.desc.filter((d) => list.every((w) => !w.length || faceDistance(d, w) > threshold))
}

/** A slide item of the show with faces that stay recognisable (review before export). */
export interface OpenFaces {
  entry: PhotoEntry | VideoEntry
  media: MediaItem
  /** Photos: the open faces; videos: sampled frames (source time) with their open faces. */
  faces: Rect[]
  samples: VideoFaces[]
}

/** Faces (original coordinates) still on the edited picture: a face the crop cut away is not in the show. */
const onPicture = (faces: Rect[], m: MediaItem): Rect[] =>
  isEdited(m.edit) ? faces.filter((f) => facesInEdit([f], m.edit, sourceAspect(m), 0.15).length > 0) : faces

/** Items of the show (in order, left-out ones skipped) whose detected faces are not all pixelated. */
export function openFacesInShow(project: Project, threshold = MATCH_THRESHOLD): OpenFaces[] {
  const media = new Map(project.media.map((m) => [m.id, m]))
  const out: OpenFaces[] = []
  for (const e of project.entries) {
    if (e.type === 'text' || e.excluded) continue
    const m = media.get(e.mediaId)
    if (!m) continue
    if (e.type === 'photo') {
      const faces = onPicture(openPhotoFaces(e, m, project.people, threshold), m)
      if (faces.length) out.push({ entry: e, media: m, faces, samples: [] })
    } else {
      const samples = openVideoFaces(e, m, project.people, threshold)
        .map((s) => ({ ...s, faces: onPicture(s.faces, m) }))
        .filter((s) => s.faces.length)
      if (samples.length) out.push({ entry: e, media: m, faces: [], samples })
    }
  }
  return out
}

/** Photos and videos of the show searched for faces so far (with descriptors), and in all. */
export function faceSearchProgress(project: Project): { done: number; total: number } {
  // after the clean-up nothing is searched in the background until someone is marked again
  if (project.faceDataRemovedAt && !project.people?.length) return { done: 0, total: 0 }
  const used = new Set(project.entries.flatMap((e) => (e.type === 'text' || e.excluded ? [] : [e.mediaId])))
  let done = 0
  let total = 0
  for (const m of project.media) {
    if (!used.has(m.id) || m.status === 'error') continue
    total++
    if (m.kind === 'video' ? m.videoFaces !== undefined : m.faces !== undefined && (m.faces.length === 0 || m.faceDesc !== undefined)) done++
  }
  return { done, total }
}

/**
 * Faces of a closer search added to those known: known faces keep their place (areas made from
 * them stay valid) and get the new descriptor where they had none; new faces are appended.
 */
export function mergeFaces(known: Rect[], knownDesc: number[][] | undefined, found: Rect[], foundDesc: number[][] | undefined): { faces: Rect[]; desc: number[][] | undefined } {
  const used = new Set<number>()
  const desc: number[][] = known.map((k, i) => {
    let best = -1
    let bestIou = 0.5
    found.forEach((f, j) => {
      const v = iou(k, f)
      if (!used.has(j) && v > bestIou) {
        best = j
        bestIou = v
      }
    })
    if (best >= 0) used.add(best)
    return knownDesc?.[i]?.length ? knownDesc[i] : best >= 0 ? (foundDesc?.[best] ?? []) : []
  })
  const extra = found.map((f, j) => ({ f, j })).filter(({ f, j }) => !used.has(j) && !known.some((k) => iou(k, f) > 0.3))
  const faces = [...known, ...extra.map((x) => x.f)]
  const all = [...desc, ...extra.map((x) => foundDesc?.[x.j] ?? [])]
  return { faces, desc: knownDesc || foundDesc ? all : undefined }
}

/**
 * Zoom of a stabilised clip ("Reduce shake"; src/main/media/stabilize.ts uses it too), and the
 * largest shift of a frame (half the zoom margin of the short side). Keep in step with it.
 */
export const STABILIZE_ZOOM = 0.06

/**
 * An area found in the plain clip, for the stabilised copy: zoomed about the centre like the
 * picture, and grown by the largest shift the stabiliser applies (the frame-by-frame shift is not
 * known here), so the face stays covered.
 */
export function stabilizedArea(r: Rect, width: number, height: number): Rect {
  const k = 1 + STABILIZE_ZOOM
  const shift = (Math.min(width, height) * STABILIZE_ZOOM) / 2
  const mx = shift / Math.max(1, width)
  const my = shift / Math.max(1, height)
  const x = 0.5 + (r.x - 0.5) * k - mx
  const y = 0.5 + (r.y - 0.5) * k - my
  const x0 = Math.max(0, x)
  const y0 = Math.max(0, y)
  return { x: x0, y: y0, w: Math.min(1, x + r.w * k + 2 * mx) - x0, h: Math.min(1, y + r.h * k + 2 * my) - y0 }
}
