// Turns a project into a timed sequence of slides. Pure and deterministic: the editor
// preview, the fullscreen player and the export all use the same result.
import type { AspectRatio, Entry, MediaItem, Project, TextEntry, VideoEntry } from './types'
import { classicTransitionSeconds, themeMeta } from './themes'
import { groupEntries, mediaAspect, pickTemplate, templatesFor, type Template } from './layout'

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
  /** Video slide: source time at slide start, and the playable span. */
  video?: { trimIn: number; trimOut: number }
  /** Grid slides: playable span of each video cell (null for photos), aligned with entries. */
  clips?: ({ trimIn: number; trimOut: number } | null)[]
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

export interface Timeline {
  slides: TimelineSlide[]
  duration: number
  /** Computed seconds for an automatic single-photo slide. */
  photoSeconds: number
  musicDuration: number
  /** Output aspect ratio as width / height. */
  aspect: number
}

export const MIN_PHOTO_SECONDS = 1.5
export const MAX_PHOTO_SECONDS = 30
const TEXT_SECONDS = 3.5

export function aspectValue(a: AspectRatio): number {
  const [w, h] = a.split(':').map(Number)
  return w / h
}

/** Playlist length including crossfades between songs. */
export function musicLength(project: Project): number {
  const tracks = project.music.filter((t) => t.status !== 'error' && t.duration > 0)
  if (tracks.length === 0) return 0
  const total = tracks.reduce((s, t) => s + t.duration, 0)
  return Math.max(0, total - project.settings.audio.crossfade * (tracks.length - 1))
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

export function buildTimeline(project: Project, locale = 'de-DE'): Timeline {
  const { settings } = project
  const meta = themeMeta(settings.theme)
  const aspect = aspectValue(settings.aspect)
  const byId = new Map(project.media.map((m) => [m.id, m]))
  const usable = project.entries.filter((e) => e.type === 'text' || byId.get(e.mediaId)?.status !== 'error')
  const span = (e: VideoEntry, m: MediaItem): { trimIn: number; trimOut: number } => {
    const len = m.duration ?? 0
    const trimIn = Math.min(Math.max(0, e.trimIn ?? 0), Math.max(0, len - 0.5))
    return { trimIn, trimOut: Math.max(trimIn + 0.5, Math.min(len || trimIn + 0.5, e.trimOut ?? len)) }
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
    if (first.type === 'text' && meta.textAsCaption && nextIsMedia) {
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
        fixed: e.duration ?? TEXT_SECONDS,
        weight: 0,
        min: 0
      })
    } else if (first.type === 'video' && g.entries.length === 1) {
      const e = first as VideoEntry
      const m = byId.get(e.mediaId)!
      const { trimIn, trimOut } = span(e, m)
      const clip = trimOut - trimIn
      const slide = { id: e.id, index: 0, kind: 'video' as const, entries: [e], media: [m], customDuration: e.duration != null, video: { trimIn, trimOut }, caption, captionEntryId }
      if (e.duration != null) drafts.push({ slide, fixed: Math.min(e.duration, clip), weight: 0, min: 0 })
      else if (settings.playFullVideos) drafts.push({ slide, fixed: Math.max(1, clip), weight: 0, min: 0 })
      else drafts.push({ slide, weight: 1, min: Math.min(1, clip), max: clip })
    } else {
      let entries = g.entries
      let media = entries.map((e) => byId.get((e as { mediaId: string }).mediaId)!)
      let template: Template | undefined
      if (entries.length > 1 || settings.theme === 'magazine') {
        const placed = pickTemplate(media.map(mediaAspect), aspect, templatesFor(settings.theme, entries.length), prevTemplate, first.layout)
        template = placed.template
        prevTemplate = template.id
        entries = placed.order.map((i) => entries[i])
        media = placed.order.map((i) => media[i])
      }
      const live = playsLive(first) ? { duration: media[0].live!.duration } : undefined
      // a slide's own time lives on its first entry (in show order)
      const custom = first.duration != null
      // videos in a grid play side by side; with "play in full" the slide lasts as long as the longest
      const clips = entries.map((e, i) => (e.type === 'video' ? span(e, media[i]) : null))
      const longest = Math.max(0, ...clips.map((c) => (c ? c.trimOut - c.trimIn : 0)))
      drafts.push({
        slide: { id: first.id, index: 0, kind: 'photos', entries, media, template, customDuration: custom, live, caption, captionEntryId, ...(longest > 0 ? { clips } : {}) },
        fixed: custom ? first.duration : undefined,
        weight: 1 + 0.4 * (g.entries.length - 1),
        min: Math.max(live ? live.duration + 0.8 : 0, settings.playFullVideos ? longest : 0)
      })
    }
  }

  // Attach a pending title overlay to the first content slide.
  const pending = drafts.findIndex((d) => d.slide.id === '__pending_title')
  if (pending >= 0) {
    const [p] = drafts.splice(pending, 1)
    const target = drafts[pending]
    if (target) {
      target.slide.titleOverlay = true
      target.slide.title = p.slide.title
      target.min = Math.max(target.min, 3)
    }
  }

  const musicDuration = musicLength(project)
  const target =
    settings.timing.mode === 'custom' ? settings.timing.customTotal : musicDuration > 0 ? musicDuration : undefined
  const transitionFor = (): number =>
    meta.freeTransition ? classicTransitionSeconds(settings.transition.speed) : meta.transition

  // Every transition of a show has the same length; automatic slides are kept long enough
  // for it, only very short fixed slides (a 1 s clip) shorten their own transitions.
  const T = transitionFor()
  const minAuto = Math.max(MIN_PHOTO_SECONDS, 2.4 * T)
  const durationsFor = (p: number): number[] =>
    drafts.map((d) => (d.fixed != null ? d.fixed : Math.min(d.max ?? Infinity, Math.max(d.min, minAuto, p * d.weight))))
  const overlaps = (dur: number[]): number[] => dur.slice(0, -1).map((d, i) => Math.min(T, 0.45 * d, 0.45 * dur[i + 1]))
  const lengthFor = (p: number): number => {
    const dur = durationsFor(p)
    return dur.reduce((s, d) => s + d, 0) - overlaps(dur).reduce((s, d) => s + d, 0)
  }

  let p = meta.photoSeconds
  const autoWeight = drafts.reduce((s, d) => s + (d.fixed == null ? d.weight : 0), 0)
  if (target != null && autoWeight > 0) {
    // length is monotonic in p, so bisect
    let lo = minAuto
    let hi = MAX_PHOTO_SECONDS
    if (lengthFor(lo) >= target) p = lo
    else if (lengthFor(hi) <= target) p = hi
    else {
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2
        if (lengthFor(mid) < target) lo = mid
        else hi = mid
      }
      p = (lo + hi) / 2
    }
  }

  const dur = durationsFor(p)
  const ov = overlaps(dur)
  const slides: TimelineSlide[] = []
  let t = 0
  drafts.forEach((d, i) => {
    slides.push({ ...d.slide, index: i, start: t, duration: dur[i], transIn: i > 0 ? ov[i - 1] : 0, transOut: ov[i] ?? 0 })
    t += dur[i] - (ov[i] ?? 0)
  })
  if (settings.timing.beatSync) {
    const beats = musicBeatTimes(project, t + 30)
    snapToBeats(slides, beats, drafts.map((d) => d.fixed != null), minAuto * 0.8)
  }
  const duration = slides.length ? slides[slides.length - 1].start + slides[slides.length - 1].duration : 0
  return { slides, duration, photoSeconds: p, musicDuration, aspect }
}

/** Beat times of the playlist on the show timeline (same placement as the audio plan). */
export function musicBeatTimes(project: Project, until: number): number[] {
  const a = project.settings.audio
  const tracks = project.music.filter((tr) => tr.status === 'ready' && tr.duration > 0 && tr.playback)
  const out: number[] = []
  let t = 0
  for (let i = 0; tracks.length && t < until && i < 500; i++) {
    const tr = tracks[i % tracks.length]
    for (const b of tr.beats ?? []) if (b < tr.duration && t + b < until) out.push(t + b)
    if (!a.repeatMusic && i === tracks.length - 1) break
    t += tr.duration - Math.min(a.crossfade, tr.duration / 2)
  }
  return out.sort((x, y) => x - y)
}

/**
 * Moves every slide change (the middle of its transition) onto the nearest beat. Slides with a
 * fixed length (videos, custom times) keep it; automatic slides never get shorter than minDur.
 */
export function snapToBeats(slides: TimelineSlide[], beats: number[], fixed: boolean[], minDur: number): void {
  if (beats.length < 2 || slides.length < 2) return
  const cuts = [0]
  for (let k = 0; k < slides.length - 1; k++) {
    const s = slides[k]
    const span = s.duration - s.transIn / 2 - s.transOut / 2
    if (fixed[k]) {
      cuts.push(cuts[k] + span)
      continue
    }
    const nominal = slides[k + 1].start + slides[k + 1].transIn / 2
    const earliest = cuts[k] + Math.max(0.3, minDur - s.transIn / 2 - s.transOut / 2)
    let best = Math.max(nominal, earliest)
    let bestDist = Infinity
    for (const b of beats) {
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
