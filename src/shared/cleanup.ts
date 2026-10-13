// "Clean up after the project": what the app keeps per project that a teacher may want gone once the
// show is finished (face data, the pupils' uploads, caches, older versions, export jobs), and the
// deletion reminder. The main process finds and deletes the files (src/main/cleanup.ts); this part is
// pure and shared with the dialog and the tests.
import type { MediaItem, Project, Rect, VideoEntry } from './types'
import { faceArea, faceCentre, photoPersonFaces, videoPersonTracks } from './people'

/** 'history': the stored undo history (src/main/history.ts); it also goes with face data and uploads. */
export type CleanupCategory = 'faces' | 'uploads' | 'caches' | 'backups' | 'history' | 'exports'
export const CLEANUP_CATEGORIES: readonly CleanupCategory[] = ['faces', 'uploads', 'caches', 'backups', 'history', 'exports']

/** Uploads: none, all of this show's, or only those that are not in the show (left out, removed). */
export type UploadChoice = 'none' | 'all' | 'leftOut'

export interface CleanupChoice {
  faces: boolean
  uploads: UploadChoice
  caches: boolean
  backups: boolean
  exports: boolean
  /** The undo history (removed anyway with face data, uploads or whenever the show is rewritten). */
  history?: boolean
}

export const NOTHING: CleanupChoice = { faces: false, uploads: 'none', caches: false, backups: false, exports: false }

export interface FaceDataStats {
  /** Photos and videos in which faces were found. */
  media: number
  /** Faces found in photos, and their descriptors (biometric). */
  faces: number
  descriptors: number
  /** Video frames with faces. */
  videoFrames: number
  /** Marked people, and how many of them have a name. */
  people: number
  named: number
  /** Pixelated areas the clean-up turns into fixed ones (photos) or followed ones (videos). */
  matches: number
}

/** What a project keeps, with sizes (bytes), as the clean-up dialog lists it. */
export interface CleanupInventory {
  projectId: string
  name: string
  deleteAt?: number
  faceDataRemovedAt?: number
  faces: FaceDataStats
  uploads: {
    files: number
    bytes: number
    /** Pupils who sent something (folders by name). */
    uploaders: number
    /** Of `files`, pictures pasted with Ctrl+V (Documents\Diashow Studio\Eingefügt\<project>); older versions leave it out. */
    pasted?: number
    /** Uploads used by slides of the show, and slides that would lose their picture. */
    inShow: { files: number; bytes: number; slides: number }
    /** Uploads not in the show: left out, removed from it, or never added. */
    leftOut: { files: number; bytes: number }
    /** Uploads another show uses: never deleted with this one. */
    shared: number
  }
  caches: {
    /** Cache folders (one per photo, video or song) only this show uses. */
    folders: number
    bytes: number
    /** Folders other shows use too: they stay. */
    shared: number
  }
  backups: { files: number; bytes: number }
  /** The stored undo history (earlier states of the show, with face data, names and captions). */
  history: { files: number; bytes: number }
  exports: {
    /** Finished, cancelled or failed exports still listed in the queue (snapshot and parts). */
    jobs: number
    bytes: number
    /** Exports of this show still waiting or running: they keep their snapshot. */
    unfinished: number
  }
}

export interface CleanupResult {
  removed: Record<CleanupCategory, { files: number; bytes: number }>
  /** Bytes freed in all. */
  freed: number
  /** Files that could not be deleted (in use), shown to the user. */
  failed: string[]
  /** Cache folders left because they were still being prepared. */
  busy: number
  /** The face data that was removed (as counted before). */
  faces?: FaceDataStats
  /** The project as it is now, when the clean-up changed it. */
  project?: Project
}

export const emptyRemoved = (): CleanupResult['removed'] => ({
  faces: { files: 0, bytes: 0 },
  uploads: { files: 0, bytes: 0 },
  caches: { files: 0, bytes: 0 },
  backups: { files: 0, bytes: 0 },
  history: { files: 0, bytes: 0 },
  exports: { files: 0, bytes: 0 }
})

/** The undo history goes when chosen, and always with face data or uploads (it holds them too). */
export const historyGoes = (c: CleanupChoice): boolean => !!c.history || c.faces || c.uploads !== 'none'

// ---------------------------------------------------------------- face data

type Keys = { t: number; r: Rect }[]

/** Per media item: the areas the engine pixelates because of marked people (engine/privacy.ts). */
function personAreas(project: Project): Map<string, { rects: Rect[]; tracks: Keys[] }> {
  const out = new Map<string, { rects: Rect[]; tracks: Keys[] }>()
  const people = project.people ?? []
  if (!people.length) return out
  for (const m of project.media) {
    const rects = photoPersonFaces(m, people).map((x) => faceArea(m.faces![x.i]))
    const tracks = videoPersonTracks(m, people).map((x) => x.keys)
    if (rects.length || tracks.length) out.set(m.id, { rects, tracks })
  }
  return out
}

const hasFaceData = (m: MediaItem): boolean => m.faces !== undefined || m.faceDesc !== undefined || m.videoFaces !== undefined
/** Faces were found (a search that found none holds nothing personal). */
const holdsFaces = (m: MediaItem): boolean => !!m.faces?.length || !!m.faceDesc?.some((d) => d.length) || !!m.videoFaces?.some((s) => s.faces.length)

export function faceDataStats(project: Project): FaceDataStats {
  const people = project.people ?? []
  let matches = 0
  for (const a of personAreas(project).values()) matches += a.rects.length + a.tracks.length
  const media = project.media.filter(holdsFaces)
  return {
    media: media.length,
    faces: media.reduce((n, m) => n + (m.faces?.length ?? 0), 0),
    descriptors:
      media.reduce((n, m) => n + (m.faceDesc ?? []).filter((d) => d.length).length, 0) +
      media.reduce((n, m) => n + (m.videoFaces ?? []).reduce((k, s) => k + (s.desc ?? []).filter((d) => d.length).length, 0), 0) +
      people.reduce((n, p) => n + p.desc.length, 0),
    videoFrames: media.reduce((n, m) => n + (m.videoFaces ?? []).filter((s) => s.faces.length).length, 0),
    people: people.length,
    named: people.filter((p) => !!p.name?.trim()).length,
    matches
  }
}

/**
 * The project without face data, with every area that is pixelated now still pixelated:
 * - marked people ("pixelate this person everywhere") become fixed areas on the photos' entries and
 *   followed areas (keyframes) on the videos' entries, appended after the entry's own, where the
 *   engine put them before, so preview and export draw the same picture;
 * - areas drawn by hand and faces followed through a clip are stored on the entries already;
 * - the centre of a photo's faces stays as `faceFocus`, so crops and Ken Burns moves don't change.
 * Faces, descriptors, video faces and the people list (names) go. Entries that are left out get the
 * areas too: they may come back into the show. Pure.
 */
export function withoutFaceData(project: Project, now = Date.now()): Project {
  const areas = personAreas(project)
  const entries = project.entries.map((e) => {
    if (e.type === 'text') return e
    const a = areas.get(e.mediaId)
    if (!a) return e
    const out = { ...e }
    if (a.rects.length) out.privacy = [...(e.privacy ?? []), ...a.rects.map((r) => ({ ...r }))]
    if (a.tracks.length && out.type === 'video') {
      ;(out as VideoEntry).privacyTracks = [...((e as VideoEntry).privacyTracks ?? []), ...a.tracks.map((k) => k.map((x) => ({ t: x.t, r: { ...x.r } })))]
    }
    return out
  })
  const media = project.media.map((m) => {
    if (!hasFaceData(m)) return m
    const { faces, faceDesc: _d, videoFaces: _v, ...rest } = m
    const focus = faceCentre(faces) ?? m.faceFocus
    return focus ? { ...rest, faceFocus: focus } : rest
  })
  const { people: _p, ...rest } = project
  return { ...rest, entries, media, faceDataRemovedAt: now }
}

/** The project without the given media items and the slide items that show them. */
export function withoutMedia(project: Project, drop: (m: MediaItem) => boolean): Project {
  const gone = new Set(project.media.filter(drop).map((m) => m.id))
  if (!gone.size) return project
  return {
    ...project,
    entries: project.entries.filter((e) => e.type === 'text' || !gone.has(e.mediaId)),
    media: project.media.filter((m) => !gone.has(m.id))
  }
}

// ---------------------------------------------------------------- deletion reminder

/** Periods offered for the deletion reminder, in months. */
export const DELETE_MONTHS = [1, 3, 6, 12] as const

/** Start of the local day of a time. */
export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The same day `months` later (the month's last day when it is shorter), at the start of the day. */
export function addMonths(ms: number, months: number): number {
  const d = new Date(startOfDay(ms))
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + months)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, last))
  return d.getTime()
}

/** The reminder is due: its day has come. */
export function deletionDue(deleteAt: number | undefined, now = Date.now()): boolean {
  return typeof deleteAt === 'number' && Number.isFinite(deleteAt) && deleteAt > 0 && deleteAt <= now
}

/** A plausible reminder time: after 2000 and before 2200. */
export function validDeleteAt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 946_684_800_000 && v < 7_258_118_400_000
}
