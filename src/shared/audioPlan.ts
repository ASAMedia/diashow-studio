// Builds the audio mix for a timeline: the music playlist (repeated if needed, with
// crossfades and fades) and the sound of video clips, with the music ducked while a
// clip with sound plays. Preview (Web Audio) and export (FFmpeg mixer) both consume it.
import type { AudioPlan, AudioPlanClip, GainPoint, Project, VideoEntry } from './types'
import type { Timeline } from './timeline'

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

export interface DuckInterval {
  start: number
  end: number
}

/** Timeline intervals during which a video plays its sound and the music should duck. */
export function duckIntervals(project: Project, tl: Timeline): DuckInterval[] {
  const a = project.settings.audio
  if (!a.videoSound) return []
  const raw: DuckInterval[] = []
  for (const s of tl.slides) {
    if (s.kind !== 'video') continue
    const e = s.entries[0] as VideoEntry
    const m = s.media[0]
    if (!m?.hasAudio || e.muted || (e.volume ?? 1) <= 0) continue
    if (!(e.duck ?? a.duck)) continue
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
  return [...times].sort((x, y) => x - y).map((t) => ({ t, g: gainAt(a, t) * (b.length ? gainAt(b, t) : 1) }))
}

export function buildAudioPlan(project: Project, tl: Timeline): AudioPlan {
  const a = project.settings.audio
  const L = tl.duration
  const clips: AudioPlanClip[] = []
  const duck = duckPoints(duckIntervals(project, tl), a.duckLevel, a.duckFade)

  const tracks = project.music.filter((t) => t.status === 'ready' && t.duration > 0 && t.playback)
  if (tracks.length > 0 && L > 0) {
    let t = 0
    let i = 0
    let n = 0
    const xf = a.crossfade
    while (t < L - 0.05 && n < 500) {
      const track = tracks[i % tracks.length]
      const first = n === 0
      const dur = Math.min(track.duration, L - t)
      const end = t + dur
      const fadeIn = first ? Math.min(a.fadeIn, dur / 2) : Math.min(xf, dur / 2)
      const endsShow = end >= L - 1e-6
      const fadeOut = endsShow ? Math.min(a.fadeOut, dur / 2) : Math.min(xf, dur / 2)
      const v = a.musicVolume
      const base: GainPoint[] = [
        { t, g: fadeIn > 0 ? 0 : v },
        { t: t + fadeIn, g: v },
        { t: end - fadeOut, g: v },
        { t: end, g: fadeOut > 0 ? 0 : v }
      ]
      clips.push({ id: `music-${n}`, kind: 'music', src: track.playback!, start: t, offset: 0, duration: dur, gain: product(base, duck, t, end) })
      if (endsShow || (!a.repeatMusic && i === tracks.length - 1)) break
      t = end - Math.min(xf, dur / 2)
      i++
      n++
    }
  }

  if (a.videoSound) {
    for (const s of tl.slides) {
      if (s.kind !== 'video' || !s.video) continue
      const e = s.entries[0] as VideoEntry
      const m = s.media[0]
      if (!m?.hasAudio || !m.audio || e.muted) continue
      const vol = Math.min(2, Math.max(0, e.volume ?? 1))
      if (vol <= 0) continue
      const dur = Math.min(s.duration, s.video.trimOut - s.video.trimIn)
      const fi = Math.max(0.15, Math.min(s.transIn, dur / 2))
      const fo = Math.max(0.15, Math.min(s.transOut, dur / 2))
      clips.push({
        id: `video-${s.id}`,
        kind: 'video',
        src: m.audio,
        start: s.start,
        offset: s.video.trimIn,
        duration: dur,
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
