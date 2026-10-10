// The audio lane under the filmstrip: song waveforms and beats, video sound, and the music volume.
import { useEffect, useMemo, useState } from 'react'
import { buildAudioPlan, gainAt } from '@shared/audioPlan'
import { musicBeatTimes, type Timeline } from '@shared/timeline'
import { playerRef, useStore } from '../store'
import { timeToX, xToTime } from './stripScale'

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

export function AudioLane({ tl, width }: { tl: Timeline; width: number }) {
  const project = useStore((s) => s.project)!
  const plan = useMemo(() => buildAudioPlan(project, tl), [project, tl])
  const H = 40
  const music = plan.clips.filter((c) => c.kind === 'music')
  const videos = plan.clips.filter((c) => c.kind === 'video')
  const tracks = project.music.filter((m) => m.playback && m.status === 'ready').map((m) => ({ path: m.playback!, duration: m.duration }))
  const waves = useWaveforms(tracks)
  const beats = useMemo(() => musicBeatTimes(project, tl.duration, tl), [project, tl])
  const maxGain = Math.max(0.01, ...music.map((c) => Math.max(...c.gain.map((g) => g.g))))
  const points = useMemo(() => {
    if (!music.length) return ''
    const pts: string[] = []
    const n = Math.min(600, Math.max(40, Math.round(width / 3)))
    for (let i = 0; i <= n; i++) {
      const time = (tl.duration * i) / n
      const g = music.reduce((sum, c) => sum + (time >= c.start && time <= c.start + c.duration ? gainAt(c.gain, time) : 0), 0)
      pts.push(`${timeToX(tl, time).toFixed(1)},${(4 + (1 - Math.min(1, g / maxGain)) * (H - 12)).toFixed(1)}`)
    }
    return pts.join(' ')
  }, [music, tl, width, maxGain])
  // waveform of every placed song, following the filmstrip's time-to-x mapping
  const wavePaths = useMemo(() => {
    const mid = (H - 6) / 2 + 2
    return music.map((c) => {
      const peaks = waves.get(c.src)
      if (!peaks) return ''
      const x0 = timeToX(tl, c.start)
      const x1 = timeToX(tl, c.start + c.duration)
      const top: string[] = []
      const bottom: string[] = []
      for (let x = x0; x <= x1; x += 2) {
        const time = c.offset + xToTime(tl, x) - c.start
        const v = peaks[Math.min(peaks.length - 1, Math.max(0, Math.round(time * 10)))] ?? 0
        const a = v * (H - 14) * 0.5
        top.push(`${x.toFixed(1)},${(mid - a).toFixed(1)}`)
        bottom.unshift(`${x.toFixed(1)},${(mid + a).toFixed(1)}`)
      }
      return `M${top.join(' L')} L${bottom.join(' L')} Z`
    })
  }, [music, waves, tl])
  const titles = new Map(project.music.map((m) => [m.playback, m.title]))
  // songs overlap in crossfades: a title ends where the next song begins
  const starts = music.map((c) => c.start).sort((a, b) => a - b)
  const nextStart = (start: number): number => {
    const next = starts.find((s) => s > start + 1e-3)
    return next === undefined ? Infinity : timeToX(tl, next)
  }
  return (
    <svg
      className="lane"
      width={width}
      height={H}
      aria-hidden
      onClick={(e) => {
        const r = (e.currentTarget as SVGElement).getBoundingClientRect()
        playerRef.current?.seek(xToTime(tl, e.clientX - r.left))
      }}
    >
      {music.map((c, i) => {
        const x0 = timeToX(tl, c.start)
        const x1 = timeToX(tl, c.start + c.duration)
        return (
          <g key={c.id}>
            <rect className={`music ${i % 2 ? 'alt' : ''}`} x={x0} y={2} width={Math.max(1, x1 - x0)} height={H - 6} rx={4} />
            {wavePaths[i] && <path className="wave" d={wavePaths[i]} />}
            <text className="title" x={x0 + 6} y={H - 8}>
              {fitText(titles.get(c.src) ?? '', Math.min(x1, nextStart(c.start)) - x0 - 10)}
            </text>
          </g>
        )
      })}
      {beats.map((b, i) => (
        <line key={i} className="beat" x1={timeToX(tl, b)} x2={timeToX(tl, b)} y1={2} y2={6} />
      ))}
      {videos.map((c) => {
        const x0 = timeToX(tl, c.start)
        const x1 = timeToX(tl, c.start + c.duration)
        return <rect key={c.id} className="clip" x={x0} y={H - 5} width={Math.max(1, x1 - x0)} height={4} rx={2} />
      })}
      {points && <polyline className="gain" points={points} />}
    </svg>
  )
}
