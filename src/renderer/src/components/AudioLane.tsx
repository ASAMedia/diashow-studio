// The audio lane under the filmstrip: song waveforms and beats (the show's own songs or its theme
// song), video sound, and the music volume.
import { useEffect, useMemo, useState } from 'react'
import { buildAudioPlan, gainAt } from '@shared/audioPlan'
import { musicBeatTimes, type Timeline } from '@shared/timeline'
import { playerRef, useStore } from '../store'
import { t } from '../i18n'
import { STEP, timeToX, xToTime } from './stripScale'

/** Peaks of a track at about 10 values per second, cached per file for the session. */
const waveCache = new Map<string, Promise<number[]>>()
function useWaveforms(tracks: { path: string; duration: number }[]): Map<string, number[]> {
  const [waves, setWaves] = useState(new Map<string, number[]>())
  const key = tracks.map((x) => x.path).join('|')
  useEffect(() => {
    let alive = true
    for (const tr of tracks) {
      if (waves.has(tr.path)) continue
      let p = waveCache.get(tr.path)
      if (!p) waveCache.set(tr.path, (p = window.api.waveform(tr.path, Math.max(50, Math.round(tr.duration * 10))).catch(() => [])))
      void p.then((peaks) => {
        if (!alive || !peaks.length) return
        const max = Math.max(...peaks) || 1
        setWaves((w) => new Map(w).set(tr.path, peaks.map((v) => v / max)))
      })
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return waves
}

/** A song title shortened to about `px` pixels of 10 px text (titles of short songs don't run into the next). */
function fitText(text: string, px: number): string {
  const chars = Math.floor(px / 5.8)
  if (chars < 3) return ''
  return text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1)).trimEnd()}…`
}

/** Beat marks closer than this (px) are left out: at small zoom they would only make a grey band. */
const BEAT_GAP = 3

/**
 * `step`: the filmstrip's width of one slide at its zoom; the lane maps time to x exactly like the cards.
 * `from`..`to`: the part of the lane in view (x), where beat marks and waveforms are drawn: a long show
 * loops its song for thousands of beats and tens of thousands of pixels.
 */
export function AudioLane({ tl, width, step = STEP, from = 0, to = Infinity }: { tl: Timeline; width: number; step?: number; from?: number; to?: number }) {
  const project = useStore((s) => s.project)!
  const plan = useMemo(() => buildAudioPlan(project, tl), [project, tl])
  const H = 40
  // kept per plan: the volume line and the waveforms below are only drawn again when it changes (a long
  // show re-renders the filmstrip on every scroll frame)
  const music = useMemo(() => plan.clips.filter((c) => c.kind === 'music'), [plan])
  const videos = useMemo(() => plan.clips.filter((c) => c.kind === 'video'), [plan])
  // the songs that play: the timeline's (its own, or the theme song)
  const tracks = tl.music.filter((m) => m.playback && m.status === 'ready').map((m) => ({ path: m.playback!, duration: m.duration }))
  const waves = useWaveforms(tracks)
  const beats = useMemo(() => musicBeatTimes(project, tl.duration, tl), [project, tl])
  const beatXs = useMemo(() => beats.map((b) => timeToX(tl, b, step)).sort((a, b) => a - b), [beats, tl, step])
  // the beats in view, each at least BEAT_GAP from the last one drawn
  const shownBeats: { x: number; i: number }[] = []
  let lo = 0
  for (let hi = beatXs.length; lo < hi; ) {
    const mid = (lo + hi) >> 1
    if (beatXs[mid] < from) lo = mid + 1
    else hi = mid
  }
  for (let i = lo, last = -Infinity; i < beatXs.length && beatXs[i] <= to; i++) {
    if (beatXs[i] - last < BEAT_GAP) continue
    last = beatXs[i]
    shownBeats.push({ x: last, i })
  }
  const maxGain = Math.max(0.01, ...music.map((c) => Math.max(...c.gain.map((g) => g.g))))
  const points = useMemo(() => {
    if (!music.length) return ''
    const pts: string[] = []
    const n = Math.min(600, Math.max(40, Math.round(width / 3)))
    for (let i = 0; i <= n; i++) {
      const time = (tl.duration * i) / n
      const g = music.reduce((sum, c) => sum + (time >= c.start && time <= c.start + c.duration ? gainAt(c.gain, time) : 0), 0)
      pts.push(`${timeToX(tl, time, step).toFixed(1)},${(4 + (1 - Math.min(1, g / maxGain)) * (H - 12)).toFixed(1)}`)
    }
    return pts.join(' ')
  }, [music, tl, width, maxGain, step])
  // waveform of every placed song in view (from..to), following the filmstrip's time-to-x mapping; the
  // points stay on a 2 px grid from the song's start, so they don't move while the filmstrip scrolls
  const wavePaths = useMemo(() => {
    const mid = (H - 6) / 2 + 2
    return music.map((c) => {
      const peaks = waves.get(c.src)
      if (!peaks) return ''
      const x0 = timeToX(tl, c.start, step)
      const x1 = Math.min(to, timeToX(tl, c.start + c.duration, step))
      const top: string[] = []
      const bottom: string[] = []
      for (let x = x0 + Math.max(0, Math.ceil((from - x0) / 2)) * 2; x <= x1; x += 2) {
        const time = c.offset + xToTime(tl, x, step) - c.start
        const v = peaks[Math.min(peaks.length - 1, Math.max(0, Math.round(time * 10)))] ?? 0
        const a = v * (H - 14) * 0.5
        top.push(`${x.toFixed(1)},${(mid - a).toFixed(1)}`)
        bottom.push(`${x.toFixed(1)},${(mid + a).toFixed(1)}`)
      }
      return top.length ? `M${top.join(' L')} L${bottom.reverse().join(' L')} Z` : ''
    })
  }, [music, waves, tl, step, from, to])
  const titles = new Map(tl.music.map((m) => [m.playback, tl.themeSong === m ? `${t('themeMusic')}: ${m.title}` : m.title]))
  // songs overlap in crossfades: a title ends where the next song begins
  const starts = music.map((c) => c.start).sort((a, b) => a - b)
  const nextStart = (start: number): number => {
    const next = starts.find((s) => s > start + 1e-3)
    return next === undefined ? Infinity : timeToX(tl, next, step)
  }
  return (
    <svg
      className="lane"
      width={width}
      height={H}
      aria-hidden
      onClick={(e) => {
        const r = (e.currentTarget as SVGElement).getBoundingClientRect()
        playerRef.current?.seek(xToTime(tl, e.clientX - r.left, step))
      }}
    >
      {music.map((c, i) => {
        const x0 = timeToX(tl, c.start, step)
        const x1 = timeToX(tl, c.start + c.duration, step)
        return (
          <g key={c.id}>
            <rect className={`music ${i % 2 ? 'alt' : ''} ${tl.themeSong ? 'theme' : ''}`} x={x0} y={2} width={Math.max(1, x1 - x0)} height={H - 6} rx={4} />
            {wavePaths[i] && <path className="wave" d={wavePaths[i]} />}
            <text className="title" x={x0 + 6} y={H - 8}>
              {fitText(titles.get(c.src) ?? '', Math.min(x1, nextStart(c.start)) - x0 - 10)}
            </text>
          </g>
        )
      })}
      {shownBeats.map((b) => (
        <line key={b.i} className="beat" x1={b.x} x2={b.x} y1={2} y2={6} />
      ))}
      {videos.map((c) => {
        const x0 = timeToX(tl, c.start, step)
        const x1 = timeToX(tl, c.start + c.duration, step)
        return <rect key={c.id} className="clip" data-clip={c.id} x={x0} y={H - 5} width={Math.max(1, x1 - x0)} height={4} rx={2} />
      })}
      {points && <polyline className="gain" points={points} />}
    </svg>
  )
}
