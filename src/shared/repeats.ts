// Photos and videos that are already in a show when new ones come in (Add photos / folder, a drop on
// the window or the filmstrip, Ctrl+V, "Insert…", the assistant, pupils' uploads). Pure: the main
// process (src/main/media/repeats.ts) supplies the content keys of files that share their size with
// another file and leaves out what this module calls a repeat; the renderer offers "Add anyway".
//
// A new item repeats an item of the show (left-out slides included) or an earlier item of the same
// import when it is
// - the same file: the same media id (path, size and time) or the same path, also the motion part of a
//   Live Photo of the show (a Live Photo or RAW+JPEG pair is one item, as everywhere);
// - a byte-identical copy under another name or folder: the same size and the same content hash;
// - the same shot saved in another file format: a photo with the same capture time to the millisecond,
//   the same camera and the same picture size, e.g. an iPhone's HEIC and the JPEG it makes of it for an
//   upload. A burst comes from one camera in one format, so its photos never count, and capture times
//   without milliseconds (most cameras without sub-second tags) never count either. A Live Photo never
//   repeats a still of its shot: it brings the motion the still lacks, so both go in.
// Recompressed copies without that data (messengers strip it) stay for "Find rejects" (duplicates.ts).
import { extOf } from './formats'
import type { MediaItem, MediaKind, Project } from './types'

/** What the rule looks at of a photo or video. */
export interface RepeatCandidate {
  id: string
  path: string
  kind: MediaKind
  /** Live Photo: its motion part (the MOV next to it). */
  live?: string
  width: number
  height: number
  /** ms since 1970. */
  captureTime: number
  device?: string
}

/** importNew's answer: every item of the import, and of the skipped ones the id each repeats. */
export interface ImportNewResult {
  items: MediaItem[]
  repeats: Record<string, string>
}

export const candidateOf = (m: MediaItem): RepeatCandidate => ({
  id: m.id,
  path: m.path,
  kind: m.kind,
  ...(m.live?.source ? { live: m.live.source } : {}),
  width: m.width,
  height: m.height,
  captureTime: m.captureTime,
  ...(m.device ? { device: m.device } : {})
})

/** What a new import is checked against: every photo and video with a slide, left-out ones too. */
export function showCandidates(p: Project | null): RepeatCandidate[] {
  if (!p) return []
  const used = new Set(p.entries.flatMap((e) => (e.type === 'text' ? [] : [e.mediaId])))
  return p.media.filter((m) => used.has(m.id)).map(candidateOf)
}

const low = (p: string): string => p.toLowerCase()

/** File types of one format: a JPEG is a JPEG whatever its extension says. */
const FAMILY: Record<string, string> = { jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg', heif: 'heic', hif: 'heic', tiff: 'tif' }
const family = (path: string): string => FAMILY[extOf(path)] ?? extOf(path)

/** Same shot in another format: same camera, picture size and capture time with milliseconds. */
export function sameShot(a: RepeatCandidate, b: RepeatCandidate): boolean {
  return (
    a.kind === 'photo' &&
    b.kind === 'photo' &&
    !!a.device &&
    a.device === b.device &&
    Number.isFinite(a.captureTime) &&
    a.captureTime === b.captureTime &&
    a.captureTime % 1000 !== 0 &&
    a.width > 0 &&
    a.width === b.width &&
    a.height === b.height &&
    family(a.path) !== family(b.path)
  )
}

const shotKey = (c: RepeatCandidate): string | null =>
  c.kind === 'photo' && c.device && c.captureTime % 1000 !== 0 ? `${c.captureTime}|${c.device}|${c.width}x${c.height}` : null

/**
 * The repeats among `incoming` (in import order): id of a new item → the id of the item of `show` or
 * the earlier new item it repeats. `contentOf` gives the content key of a file (size and hash of the
 * whole file); files without one are never compared by content.
 */
export function findRepeats(
  incoming: readonly RepeatCandidate[],
  show: readonly RepeatCandidate[],
  contentOf: (path: string) => string | undefined = () => undefined
): Map<string, string> {
  const ids = new Set<string>()
  const paths = new Map<string, string>()
  const contents = new Map<string, string>()
  const shots = new Map<string, RepeatCandidate[]>()
  const add = (c: RepeatCandidate): void => {
    ids.add(c.id)
    for (const p of c.live ? [c.path, c.live] : [c.path]) {
      if (!paths.has(low(p))) paths.set(low(p), c.id)
      const key = contentOf(p)
      if (key && !contents.has(key)) contents.set(key, c.id)
    }
    const shot = shotKey(c)
    if (shot) shots.set(shot, [...(shots.get(shot) ?? []), c])
  }
  for (const c of show) add(c)
  const out = new Map<string, string>()
  for (const c of incoming) {
    const key = contentOf(c.path)
    const shot = shotKey(c)
    const match =
      (ids.has(c.id) ? c.id : undefined) ??
      paths.get(low(c.path)) ??
      (key ? contents.get(key) : undefined) ??
      (shot ? shots.get(shot)?.find((o) => sameShot(c, o) && !(c.live && !o.live))?.id : undefined)
    if (match !== undefined) out.set(c.id, match)
    else add(c)
  }
  return out
}
