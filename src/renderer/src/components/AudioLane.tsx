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
  return (
    <svg
      className="lane"
      width={width}
      height={H}
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
            <rect x={x0} y={2} width={Math.max(1, x1 - x0)} height={H - 6} rx={4} fill={i % 2 ? 'rgba(77,159,255,0.10)' : 'rgba(77,159,255,0.16)'} />
            {wavePaths[i] && <path d={wavePaths[i]} fill="rgba(143,184,232,0.35)" />}
            <text x={x0 + 6} y={H - 8} fontSize={10} fill="#8fb8e8">
              {titles.get(c.src) ?? ''}
            </text>
          </g>
        )
      })}
      {beats.map((b, i) => (
        <line key={i} x1={timeToX(tl, b)} x2={timeToX(tl, b)} y1={2} y2={6} stroke="rgba(255,255,255,0.35)" strokeWidth={1} />
      ))}
      {videos.map((c) => {
        const x0 = timeToX(tl, c.start)
        const x1 = timeToX(tl, c.start + c.duration)
        return <rect key={c.id} x={x0} y={H - 5} width={Math.max(1, x1 - x0)} height={4} rx={2} fill="var(--video)" />
      })}
      {points && <polyline points={points} fill="none" stroke="#4d9fff" strokeWidth={1.5} />}
    </svg>
  )
}
