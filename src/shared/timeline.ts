// Turns a project into a timed sequence of slides. Pure and deterministic: the editor
// preview, the fullscreen player and the export all use the same result.
import type { AspectRatio, CollagePlace, Entry, MediaItem, MusicTrack, Project, ProjectSettings, TextEntry, TitleStyle, VideoEntry } from './types'
import { classicTransitionSeconds, themeMeta } from './themes'
import { effectiveMusic, placementAudio, type ThemeTrack } from './themeMusic'
import { groupEntries, mediaAspect, pickTemplate, templatesFor, type Slot, type Template } from './layout'

export type SlideKind = 'photos' | 'video' | 'text' | 'title'

export interface TimelineSlide {
  /** Id of the first entry ('title' for the generated title slide). */
  id: string
  index: number
  kind: SlideKind
  entries: Entry[]
  /** Media of each entry (photos/video), aligned with entries. */
  media: MediaItem[]
  template?: Template
  start: number
  duration: number
  /** Overlap with the previous / next slide (transition time). */
  transIn: number
  transOut: number
  customDuration: boolean
  /** Video slide: the playable span of the source and its speed. */
  video?: ClipSpan
  /** Grid slides: playable span of each video cell (null for photos), aligned with entries. */
  clips?: (ClipSpan | null)[]
  /** Free collage (layout 'free'): where each item sits, aligned with entries. */
  places?: CollagePlace[]
  /** Photo slide playing a Live/Motion photo first. */
  live?: { duration: number }
  /** Title drawn over this slide (themes without a separate title slide). */
  titleOverlay?: boolean
  title?: { text: string; subtitle?: string }
  /** Text shown on the slide: a preceding text slide (Magazine) or a photo's own caption. */
  caption?: { text: string; subtitle?: string }
  /** Text entry shown as this slide's caption (so the filmstrip can still select it). */
  captionEntryId?: string
}

/** Part of a video that plays (source seconds) and how fast. */
export interface ClipSpan {
  trimIn: number
  trimOut: number
  speed: number
}

/** On-screen seconds of a clip span. */
export const clipSeconds = (c: ClipSpan): number => (c.trimOut - c.trimIn) / c.speed

export const MIN_SPEED = 0.25
export const MAX_SPEED = 8

/** Clip speed with sound: outside this range the clip plays silently. */
export const speedHasSound = (speed: number): boolean => speed >= 0.5 - 1e-9 && speed <= 2 + 1e-9

export interface Timeline {
  slides: TimelineSlide[]
  duration: number
  /** Computed seconds for an automatic single-photo slide. */
  photoSeconds: number
  /** Length of the show's own songs ("Fit to music"); 0 with the theme song, which loops instead. */
  musicDuration: number
  /** The songs that play (shared/themeMusic.ts effectiveMusic): the show's own, or its theme song. */
  music: MusicTrack[]
  /** Set when the theme song plays. */
  themeSong?: ThemeTrack
  /** Output aspect ratio as width / height. */
  aspect: number
  /** Where which songs play: the show playlist from the start, then each chapter with its own songs. */
  musicSegments: MusicSegment[]
}

/** A stretch of the show with its own songs ("music from here on"). */
export interface MusicSegment {
  /** Timeline seconds. */
  start: number
  end: number
  /** Song ids in playing order. */
  tracks: string[]
  /** Text slide that starts it; undefined for the show playlist at the beginning. */
  chapterId?: string
}

/** Style of a title or chapter slide: its own, else the show's ('credits' is only chosen per slide). */
export function titleStyleOf(e: TextEntry | undefined, settings: ProjectSettings): TitleStyle {
  return e?.titleStyle ?? (settings.titleStyle && settings.titleStyle !== 'credits' ? settings.titleStyle : 'theme')
}

/** Credits roll slowly enough to read every line. */
export function creditsSeconds(e: TextEntry): number {
  const lines = 1 + (e.subtitle?.split(/\r?\n/).length ?? 0)
  return Math.max(6, 2.5 + 1.2 * lines)
}

/**
 * Where an item of a free collage starts: inside the cell the automatic layout gave it, with
 * its own shape and a slight tilt like a print laid on a table.
 */
export function defaultPlace(slot: Slot, itemAspect: number, frameAspect: number, seed: string, z: number): CollagePlace {
  const m = 0.05
  const box = { x: m + slot.x * (1 - 2 * m), y: m + slot.y * (1 - 2 * m), w: slot.w * (1 - 2 * m), h: slot.h * (1 - 2 * m) }
  let w = box.w * 0.9
  let h = box.h * 0.9
  // shapes compare in pixels: a slide coordinate unit is frameAspect times wider than high
  if (itemAspect > (w * frameAspect) / h) h = (w * frameAspect) / itemAspect
  else w = (h * itemAspect) / frameAspect
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  const rot = Math.round((((hash >>> 0) % 1000) / 1000 - 0.5) * 8 * 10) / 10
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h, rot, z }
}

export const MIN_PHOTO_SECONDS = 1.5
export const MAX_PHOTO_SECONDS = 30
const TEXT_SECONDS = 3.5

export function aspectValue(a: AspectRatio): number {
  const [w, h] = a.split(':').map(Number)
  return w / h
}

/** The part of a song that plays (its trim), in seconds of the file. */
export function trackSpan(t: MusicTrack): { from: number; to: number; length: number } {
  const from = Math.min(Math.max(0, t.trimIn ?? 0), Math.max(0, t.duration - 1))
  const to = Math.max(from + Math.min(1, t.duration), Math.min(t.duration, t.trimOut ?? t.duration))
  return { from, to, length: to - from }
}

/** Songs given to chapters: text slide id -> song ids in playlist order. */
export function chapterMusic(project: Project): Map<string, string[]> {
  const order = new Map(project.music.map((m, i) => [m.id, i]))
  const out = new Map<string, string[]>()
  for (const e of project.entries) {
    if (e.type !== 'text' || e.excluded || !e.music?.length) continue
    const ids = e.music.filter((id) => order.has(id)).sort((a, b) => order.get(a)! - order.get(b)!)
    if (ids.length) out.set(e.id, ids)
  }
  return out
}

/** The show playlist: every song not given to a chapter. */
export function showPlaylist(project: Project): MusicTrack[] {
  const assigned = new Set([...chapterMusic(project).values()].flat())
  return project.music.filter((m) => !assigned.has(m.id))
}

/** Length of songs played one after another, including crossfades between them. */
export function playlistLength(tracks: MusicTrack[], crossfade: number): number {
  const ts = tracks.filter((t) => t.status !== 'error' && t.duration > 0)
  if (ts.length === 0) return 0
  return Math.max(0, ts.reduce((sum, t) => sum + trackSpan(t).length, 0) - crossfade * (ts.length - 1))
}

/** Length of all music: the show playlist plus every chapter's songs. */
export function musicLength(project: Project): number {
  const xf = project.settings.audio.crossfade
  const byId = new Map(project.music.map((m) => [m.id, m]))
  const chapters = [...chapterMusic(project).values()].map((ids) => playlistLength(ids.map((id) => byId.get(id)!), xf))
  return playlistLength(showPlaylist(project), xf) + chapters.reduce((sum, x) => sum + x, 0)
}

/** Songs that can play: ready, with a playable file. */
export const playableTrack = (t: MusicTrack | undefined): t is MusicTrack => !!t && t.status === 'ready' && t.duration > 0 && !!t.playback

/**
 * Beat times of songs played one after another from `from` (same placement as the audio plan:
 * repeated if the show says so, crossfades between songs), up to `until`.
 */
export function placedBeats(tracks: MusicTrack[], audio: Project['settings']['audio'], from: number, until: number): number[] {
  const out: number[] = []
  let t = from
  for (let i = 0; tracks.length && t < until && i < 500; i++) {
    const tr = tracks[i % tracks.length]
    const { from: a, to: b, length } = trackSpan(tr)
    for (const beat of tr.beats ?? []) if (beat >= a && beat < b && t + beat - a < until) out.push(t + beat - a)
    if (!audio.repeatMusic && i === tracks.length - 1) break
    t += length - Math.min(audio.crossfade, length / 2)
  }
  return out.sort((x, y) => x - y)
}

export function formatDateRange(media: MediaItem[], locale = 'de-DE'): string {
  const times = media.map((m) => m.captureTime).filter((t) => t > 0)
  if (times.length === 0) return ''
  const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' })
  const a = Math.min(...times)
  const b = Math.max(...times)
  const da = fmt.format(a)
  const db = fmt.format(b)
  return da === db ? da : `${da} – ${db}`
}

interface Draft {
  slide: Omit<TimelineSlide, 'start' | 'duration' | 'transIn' | 'transOut'>
  fixed?: number
  weight: number
  /** Bounds for automatic slides (live photo motion, clip length). */
  min: number
  max?: number
}

/**
 * `themeTracks`: the bundled theme songs (shared/themeMusic.ts); the show's theme song plays from
 * them while it has no songs of its own.
 */
export function buildTimeline(project: Project, locale = 'de-DE', themeTracks: readonly ThemeTrack[] = []): Timeline {
  const { settings } = project
  const meta = themeMeta(settings.theme)
  const aspect = aspectValue(settings.aspect)
  const byId = new Map(project.media.map((m) => [m.id, m]))
  const usable = project.entries.filter((e) => !e.excluded && (e.type === 'text' || byId.get(e.mediaId)?.status !== 'error'))
  const maxClip = settings.maxVideoSeconds && settings.maxVideoSeconds > 0 ? settings.maxVideoSeconds : Infinity
  const span = (e: VideoEntry, m: MediaItem): ClipSpan => {
    const len = m.duration ?? 0
    const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, e.speed ?? 1))
    const trimIn = Math.min(Math.max(0, e.trimIn ?? 0), Math.max(0, len - 0.5))
    // the show's maximum video length counts on screen, from the clip's start point
    const out = Math.min(len || trimIn + 0.5, e.trimOut ?? len, trimIn + maxClip * speed)
    return { trimIn, trimOut: Math.max(trimIn + 0.5, out), speed }
  }
  const playsLive = (e: Entry): boolean =>
    e.type === 'photo' && !!byId.get(e.mediaId)?.live && (e.playLive ?? settings.playLivePhotos)

  const drafts: Draft[] = []
  if (settings.showTitle) {
    const title = {
      text: settings.titleText?.trim() || project.name,
      subtitle: settings.subtitleText ?? formatDateRange(project.media, locale)
    }
    if (meta.titleSlide || usable.length === 0) {
      drafts.push({ slide: { id: 'title', index: 0, kind: 'title', entries: [], media: [], customDuration: false, title }, fixed: TEXT_SECONDS, weight: 0, min: 0 })
    } else {
      // remembered and attached to the first content slide below
      drafts.push({ slide: { id: '__pending_title', index: 0, kind: 'title', entries: [], media: [], customDuration: false, title }, fixed: 0, weight: 0, min: 0 })
    }
  }

  const entryAspect = (e: Entry): number => mediaAspect(e.type === 'text' ? undefined : byId.get(e.mediaId))
  let prevTemplate: string | undefined
  let pendingCaption: { text: string; subtitle?: string; id: string } | undefined
  const groups = groupEntries(usable, settings.theme, playsLive, entryAspect)
  for (const [gi, g] of groups.entries()) {
    const first = g.entries[0]
    const nextIsMedia = groups[gi + 1] && groups[gi + 1].entries[0].type !== 'text'
    // a text slide with an animated style stays a slide of its own
    if (first.type === 'text' && meta.textAsCaption && nextIsMedia && titleStyleOf(first as TextEntry, settings) === 'theme') {
      pendingCaption = { text: (first as TextEntry).title, subtitle: (first as TextEntry).subtitle, id: first.id }
      continue
    }
    const ownCaption = g.entries.find((e) => e.caption?.trim())?.caption?.trim()
    const caption = pendingCaption ? { text: pendingCaption.text, subtitle: pendingCaption.subtitle } : ownCaption ? { text: ownCaption } : undefined
    const captionEntryId = pendingCaption?.id
    pendingCaption = undefined
    if (first.type === 'text') {
      const e = first as TextEntry
      drafts.push({
        slide: { id: e.id, index: 0, kind: 'text', entries: [e], media: [], customDuration: e.duration != null, title: { text: e.title, subtitle: e.subtitle } },
        fixed: e.duration ?? (titleStyleOf(e, settings) === 'credits' ? creditsSeconds(e) : TEXT_SECONDS),
        weight: 0,
        min: 0
      })
    } else if (first.type === 'video' && g.entries.length === 1) {
      const e = first as VideoEntry
      const m = byId.get(e.mediaId)!
      const video = span(e, m)
      const clip = clipSeconds(video)
      const slide = { id: e.id, index: 0, kind: 'video' as const, entries: [e], media: [m], customDuration: e.duration != null, video, caption, captionEntryId }
      if (e.duration != null) drafts.push({ slide, fixed: Math.min(e.duration, clip), weight: 0, min: 0 })
      else if (settings.playFullVideos) drafts.push({ slide, fixed: Math.max(1, clip), weight: 0, min: 0 })
      else drafts.push({ slide, weight: 1, min: Math.min(1, clip), max: clip })
    } else {
      let entries = g.entries
      let media = entries.map((e) => byId.get((e as { mediaId: string }).mediaId)!)
      let template: Template | undefined
      let places: CollagePlace[] | undefined
      if (entries.length > 1 || settings.theme === 'magazine') {
        const free = first.layout === 'free' && entries.length > 1
        const placed = pickTemplate(media.map(mediaAspect), aspect, templatesFor(settings.theme, entries.length), prevTemplate, free ? undefined : first.layout)
        if (free) {
          // free collage: items keep their order and start from the cells of the automatic layout
          const slotOf = new Map(placed.order.map((orig, k) => [orig, placed.template.slots[k]]))
          const m = media
          places = entries.map((e, i) => e.place ?? defaultPlace(slotOf.get(i)!, mediaAspect(m[i]), aspect, e.id, i))
          template = { id: 'free', slots: places.map(({ x, y, w, h }) => ({ x, y, w, h })) }
        } else {
          template = placed.template
          prevTemplate = template.id
          entries = placed.order.map((i) => entries[i])
          media = placed.order.map((i) => media[i])
        }
      }
      const live = playsLive(first) ? { duration: media[0].live!.duration } : undefined
      // a slide's own time lives on its first entry (in show order)
      const custom = first.duration != null
      // videos in a grid play side by side; with "play in full" the slide lasts as long as the longest
      const clips = entries.map((e, i) => (e.type === 'video' ? span(e, media[i]) : null))
      const longest = Math.max(0, ...clips.map((c) => (c ? clipSeconds(c) : 0)))
      drafts.push({
        slide: { id: first.id, index: 0, kind: 'photos', entries, media, template, customDuration: custom, live, caption, captionEntryId, ...(longest > 0 ? { clips } : {}), ...(places ? { places } : {}) },
        fixed: custom ? first.duration : undefined,
        weight: 1 + 0.4 * (g.entries.length - 1),
        min: Math.max(live ? live.duration + 0.8 : 0, settings.playFullVideos ? longest : 0)
      })
    }
  }

  // Attach a pending title overlay to the first content slide. A show that starts with a text slide
  // (e.g. the first day title) gets the title as a slide of its own: the overlay would replace that
  // slide's text, so the chapter would never be shown.
  const pending = drafts.findIndex((d) => d.slide.id === '__pending_title')
  if (pending >= 0) {
    const [p] = drafts.splice(pending, 1)
    const target = drafts[pending]
    if (target?.slide.kind === 'text') {
      drafts.splice(pending, 0, { ...p, slide: { ...p.slide, id: 'title' }, fixed: TEXT_SECONDS })
    } else if (target) {
      target.slide.titleOverlay = true
      target.slide.title = p.slide.title
      target.min = Math.max(target.min, 3)
    }
  }

  // The theme song plays like a playlist of one song that loops; "Fit to music" ignores it, so a
  // long show is never squeezed into the song (nominal durations, or the custom total)
  const eff = effectiveMusic(project, themeTracks)
  const playing: Project = eff.theme ? { ...project, music: eff.tracks } : project
  const audio = placementAudio(settings.audio, !!eff.theme)
  const musicDuration = eff.theme ? 0 : musicLength(project)
  const target =
    settings.timing.mode === 'custom' ? settings.timing.customTotal : musicDuration > 0 ? musicDuration : undefined
  // Music from here on: a text slide with its own songs starts a new stretch of music
  const chapters = chapterMusic(playing)
  const songs = new Map(eff.tracks.map((m) => [m.id, m]))
  const segStarts: { draft: number; tracks: string[]; chapterId?: string }[] = [{ draft: 0, tracks: showPlaylist(playing).map((m) => m.id) }]
  drafts.forEach((d, i) => {
    const id = [d.slide.captionEntryId, ...d.slide.entries.map((e) => e.id)].find((x): x is string => !!x && chapters.has(x))
    if (!id) return
    if (i === 0) segStarts[0] = { draft: 0, tracks: chapters.get(id)!, chapterId: id }
    else segStarts.push({ draft: i, tracks: chapters.get(id)!, chapterId: id })
  })
  const transitionFor = (): number =>
    meta.freeTransition ? classicTransitionSeconds(settings.transition.speed) : meta.transition

  // Every transition of a show has the same length; automatic slides are kept long enough
  // for it, only very short fixed slides (a 1 s clip) shorten their own transitions.
  const T = transitionFor()
  const minAuto = Math.max(MIN_PHOTO_SECONDS, 2.4 * T)
  const durOf = (d: Draft, p: number): number => (d.fixed != null ? d.fixed : Math.min(d.max ?? Infinity, Math.max(d.min, minAuto, p * d.weight)))
  const overlaps = (dur: number[]): number[] => dur.slice(0, -1).map((d, i) => Math.min(T, 0.45 * d, 0.45 * dur[i + 1]))
  /** Seconds per automatic photo that make drafts [from, to) last `want` seconds. */
  const solve = (from: number, to: number, want: number | undefined): number => {
    const part = drafts.slice(from, to)
    const lengthFor = (p: number): number => {
      const dur = part.map((d) => durOf(d, p))
      return dur.reduce((sum, d) => sum + d, 0) - overlaps(dur).reduce((sum, d) => sum + d, 0)
    }
    const autoWeight = part.reduce((sum, d) => sum + (d.fixed == null ? d.weight : 0), 0)
    if (want == null || !(want > 0) || autoWeight <= 0) return meta.photoSeconds
    // length is monotonic in p, so bisect
    let lo = minAuto
    let hi = MAX_PHOTO_SECONDS
    if (lengthFor(lo) >= want) return lo
    if (lengthFor(hi) <= want) return hi
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (lengthFor(mid) < want) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }

  // With chapter music, "fit to music" fits every stretch to its own songs
  const pOf: number[] = new Array(drafts.length).fill(meta.photoSeconds)
  if (settings.timing.mode === 'fitToMusic' && segStarts.length > 1) {
    segStarts.forEach((seg, k) => {
      const to = segStarts[k + 1]?.draft ?? drafts.length
      const p = solve(seg.draft, to, playlistLength(seg.tracks.map((id) => songs.get(id)!), settings.audio.crossfade))
      pOf.fill(p, seg.draft, to)
    })
  } else pOf.fill(solve(0, drafts.length, target))
  const p = pOf[0] ?? meta.photoSeconds

  const dur = drafts.map((d, i) => durOf(d, pOf[i]))
  const ov = overlaps(dur)
  const slides: TimelineSlide[] = []
  let t = 0
  drafts.forEach((d, i) => {
    slides.push({ ...d.slide, index: i, start: t, duration: dur[i], transIn: i > 0 ? ov[i - 1] : 0, transOut: ov[i] ?? 0 })
    t += dur[i] - (ov[i] ?? 0)
  })
  if (settings.timing.beatSync) {
    // each stretch's songs start with its first slide, which earlier snapping may have moved
    const at = new Map(segStarts.map((seg) => [seg.draft, seg]))
    const beatsFrom = (k: number, start: number): number[] | null => {
      const seg = at.get(k)
      return seg ? placedBeats(seg.tracks.map((id) => songs.get(id)).filter(playableTrack), audio, k === 0 ? 0 : start, t + 30) : null
    }
    snapToBeats(slides, beatsFrom, drafts.map((d) => d.fixed != null), minAuto * 0.8)
  }
  const duration = slides.length ? slides[slides.length - 1].start + slides[slides.length - 1].duration : 0
  const musicSegments = segStarts.map((seg, k) => ({
    start: k === 0 ? 0 : (slides[seg.draft]?.start ?? duration),
    end: k + 1 < segStarts.length ? (slides[segStarts[k + 1].draft]?.start ?? duration) : duration,
    tracks: seg.tracks,
    chapterId: seg.chapterId
  }))
  return { slides, duration, photoSeconds: p, musicDuration, music: eff.tracks, ...(eff.theme ? { themeSong: eff.theme } : {}), aspect, musicSegments }
}

/** Beat times of the music on the show timeline (same placement as the audio plan). */
export function musicBeatTimes(project: Project, until: number, tl?: Timeline): number[] {
  const songs = new Map((tl?.music ?? project.music).map((m) => [m.id, m]))
  const audio = placementAudio(project.settings.audio, !!tl?.themeSong)
  const segments = tl?.musicSegments ?? [{ start: 0, end: until, tracks: showPlaylist(project).map((m) => m.id) }]
  return segments.flatMap((seg) =>
    placedBeats(seg.tracks.map((id) => songs.get(id)).filter(playableTrack), audio, seg.start, Math.min(until, seg.end))
  )
}

/**
 * Moves every slide change (the middle of its transition) onto the nearest beat. Slides with a
 * fixed length (videos, custom times) keep it; automatic slides never get shorter than minDur.
 * `beats` can also be asked per slide: at a slide where other songs start it returns their
 * beats (given that slide's start after the earlier snapping), else null.
 */
export function snapToBeats(slides: TimelineSlide[], beats: number[] | ((k: number, start: number) => number[] | null), fixed: boolean[], minDur: number): void {
  if (slides.length < 2) return
  const fresh = typeof beats === 'function' ? beats : (k: number): number[] | null => (k === 0 ? beats : null)
  let cur: number[] = []
  const cuts = [0]
  for (let k = 0; k < slides.length - 1; k++) {
    const s = slides[k]
    cur = fresh(k, cuts[k] - s.transIn / 2) ?? cur
    const span = s.duration - s.transIn / 2 - s.transOut / 2
    if (fixed[k] || cur.length < 2) {
      cuts.push(fixed[k] ? cuts[k] + span : Math.max(slides[k + 1].start + slides[k + 1].transIn / 2, cuts[k] + 0.3))
      continue
    }
    const nominal = slides[k + 1].start + slides[k + 1].transIn / 2
    const earliest = cuts[k] + Math.max(0.3, minDur - s.transIn / 2 - s.transOut / 2)
    let best = Math.max(nominal, earliest)
    let bestDist = Infinity
    for (const b of cur) {
      if (b < earliest) continue
      const d = Math.abs(b - nominal)
      if (d < bestDist) {
        bestDist = d
        best = b
      } else if (b > nominal) break
    }
    cuts.push(best)
  }
  slides.forEach((s, k) => {
    s.start = cuts[k] - s.transIn / 2
    if (k < slides.length - 1) s.duration = cuts[k + 1] - cuts[k] + s.transIn / 2 + s.transOut / 2
  })
}

/** Slides visible at time t (one, or two during a transition), in drawing order. */
export function slidesAt(tl: Timeline, t: number): TimelineSlide[] {
  const out: TimelineSlide[] = []
  for (const s of tl.slides) {
    if (s.start > t) break
    if (t < s.start + s.duration) out.push(s)
  }
  return out
}

export function slideIndexAt(tl: Timeline, t: number): number {
  let idx = 0
  for (const s of tl.slides) {
    if (s.start <= t + 1e-6) idx = s.index
    else break
  }
  return idx
}
