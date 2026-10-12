// Builds the audio mix for a timeline: the music playlist (repeated if needed, with
// crossfades and fades) and the sound of video clips, with the music ducked while a
// clip with sound plays. Preview (Web Audio) and export (FFmpeg mixer) both consume it.
// The songs are the timeline's (its own, or the theme song, which loops: shared/themeMusic.ts).
import type { AudioPlan, AudioPlanClip, GainPoint, MediaItem, Project, VideoEntry } from './types'
import { playableTrack, speedHasSound, trackSpan, type Timeline, type TimelineSlide } from './timeline'
import { placementAudio } from './themeMusic'

/** Linear interpolation of gain points; clamps before the first and after the last point. */
export function gainAt(points: GainPoint[], t: number): number {
  if (points.length === 0) return 1
  if (t <= points[0].t) return points[0].g
  for (let i = 1; i < points.length; i++) {
    const b = points[i]
    if (t <= b.t) {
      const a = points[i - 1]
      return b.t === a.t ? b.g : a.g + ((b.g - a.g) * (t - a.t)) / (b.t - a.t)
    }
  }
  return points[points.length - 1].g
}

/** Loudness every song and video sound is brought to when normalising (LUFS). */
export const TARGET_LUFS = -16

/** Gain that brings a measured loudness to the target, limited to ±12 dB. */
export function loudnessGain(lufs: number | undefined, enabled: boolean): number {
  if (!enabled || lufs == null || !Number.isFinite(lufs)) return 1
  return Math.min(4, Math.max(0.25, Math.pow(10, (TARGET_LUFS - lufs) / 20)))
}

export interface DuckInterval {
  start: number
  end: number
}

export interface AudibleClip {
  entry: VideoEntry
  media: MediaItem
  trimIn: number
  trimOut: number
  speed: number
}

/**
 * Videos of a slide whose sound plays. With several videos on one slide only the first one
 * is heard unless another is switched on explicitly (muted === false).
 */
export function audibleClips(s: TimelineSlide): AudibleClip[] {
  const out: AudibleClip[] = []
  let first = true
  s.entries.forEach((e, i) => {
    if (e.type !== 'video') return
    const m = s.media[i]
    const span = s.kind === 'video' ? s.video : s.clips?.[i]
    // very slow or fast clips play silently
    if (!m?.hasAudio || !m.audio || !span || (e.volume ?? 1) <= 0 || !speedHasSound(span.speed)) return
    const on = e.muted === false || (first && !e.muted)
    if (m.hasAudio && !e.muted) first = false
    if (on) out.push({ entry: e, media: m, trimIn: span.trimIn, trimOut: span.trimOut, speed: span.speed })
  })
  return out
}

/** Timeline intervals during which a video plays its sound and the music should duck. */
export function duckIntervals(project: Project, tl: Timeline): DuckInterval[] {
  const a = project.settings.audio
  if (!a.videoSound) return []
  const raw: DuckInterval[] = []
  for (const s of tl.slides) {
    if (!audibleClips(s).some((c) => c.entry.duck ?? a.duck)) continue
    raw.push({ start: s.start, end: s.start + s.duration })
  }
  // merge intervals that touch or nearly touch, so the music doesn't pump in between
  const merged: DuckInterval[] = []
  for (const iv of raw) {
    const last = merged[merged.length - 1]
    if (last && iv.start <= last.end + 2 * a.duckFade) last.end = Math.max(last.end, iv.end)
    else merged.push({ ...iv })
  }
  return merged
}

/** Factor (duckLevel..1) applied to the music over time. */
export function duckPoints(intervals: DuckInterval[], level: number, fade: number): GainPoint[] {
  const pts: GainPoint[] = []
  for (const iv of intervals) {
    const f = Math.min(fade, (iv.end - iv.start) / 2)
    pts.push({ t: iv.start, g: 1 }, { t: iv.start + f, g: level }, { t: iv.end - f, g: level }, { t: iv.end, g: 1 })
  }
  return pts
}

function product(a: GainPoint[], b: GainPoint[], from: number, to: number): GainPoint[] {
  const times = new Set<number>([from, to])
  for (const p of [...a, ...b]) if (p.t > from && p.t < to) times.add(p.t)
  // interpolating down to 0 can round to -1e-16, which the export refuses as a gain
  return [...times].sort((x, y) => x - y).map((t) => ({ t, g: Math.max(0, gainAt(a, t) * (b.length ? gainAt(b, t) : 1)) }))
}

export function buildAudioPlan(project: Project, tl: Timeline): AudioPlan {
  const a = placementAudio(project.settings.audio, !!tl.themeSong)
  const L = tl.duration
  const clips: AudioPlanClip[] = []
  const duck = duckPoints(duckIntervals(project, tl), a.duckLevel, a.duckFade)

  // Each stretch of music plays its own songs from its first slide on; the songs of the stretch
  // before fade out over the crossfade time while the next ones fade in.
  const songs = new Map(tl.music.map((m) => [m.id, m]))
  const xf = a.crossfade
  let n = 0
  tl.musicSegments.forEach((seg, k) => {
    const tracks = seg.tracks.map((id) => songs.get(id)).filter(playableTrack)
    const last = k === tl.musicSegments.length - 1
    const from = seg.start
    const to = last ? L : Math.min(L, seg.end + xf)
    if (!tracks.length || to - from < 0.05) return
    let t = from
    for (let i = 0; t < to - 0.05 && i < 500; i++) {
      const track = tracks[i % tracks.length]
      const span = trackSpan(track)
      const dur = Math.min(span.length, to - t)
      const end = t + dur
      const fadeIn = i === 0 ? Math.min(k === 0 ? a.fadeIn : xf, dur / 2) : Math.min(xf, dur / 2)
      const endsHere = end >= to - 1e-6
      const fadeOut = endsHere ? Math.min(last ? a.fadeOut : xf, dur / 2) : Math.min(xf, dur / 2)
      const v = a.musicVolume * loudnessGain(track.loudness, a.normalize ?? true)
      const base: GainPoint[] = [
        { t, g: fadeIn > 0 ? 0 : v },
        { t: t + fadeIn, g: v },
        { t: end - fadeOut, g: v },
        { t: end, g: fadeOut > 0 ? 0 : v }
      ]
      clips.push({ id: `music-${n++}`, kind: 'music', src: track.playback!, start: t, offset: span.from, duration: dur, gain: product(base, duck, t, end) })
      if (endsHere || (!a.repeatMusic && i === tracks.length - 1)) break
      t = end - Math.min(xf, dur / 2)
    }
  })

  if (a.videoSound) {
    for (const s of tl.slides) for (const c of audibleClips(s)) {
      const vol = Math.min(2, Math.max(0, c.entry.volume ?? 1)) * loudnessGain(c.media.loudness, a.normalize ?? true)
      const dur = Math.min(s.duration, (c.trimOut - c.trimIn) / c.speed)
      const fi = Math.max(0.15, Math.min(s.transIn, dur / 2))
      const fo = Math.max(0.15, Math.min(s.transOut, dur / 2))
      clips.push({
        id: `video-${c.entry.id}`,
        kind: 'video',
        src: c.media.audio!,
        start: s.start,
        offset: c.trimIn,
        duration: dur,
        ...(c.speed !== 1 ? { rate: c.speed } : {}),
        gain: [
          { t: s.start, g: 0 },
          { t: s.start + fi, g: vol },
          { t: s.start + dur - fo, g: vol },
          { t: s.start + dur, g: 0 }
        ]
      })
    }
  }
  return { duration: L, clips }
}
