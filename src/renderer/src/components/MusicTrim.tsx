// The part of a song that plays: waveform with start and end handles, and a listen button.
import { useEffect, useRef, useState } from 'react'
import { Play, Square } from 'lucide-react'
import { mediaUrl } from '@shared/api'
import type { MusicTrack } from '@shared/types'
import { trackSpan } from '@shared/timeline'
import { useStore } from '../store'
import { fmtTime, t } from '../i18n'
import { handleProps } from './TrimStrip'

const BARS = 160

export function MusicTrim({ track }: { track: MusicTrack }) {
  const update = useStore((s) => s.update)
  const [peaks, setPeaks] = useState<number[]>([])
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const { from, to } = trackSpan(track)
  const len = track.duration

  useEffect(() => {
    if (!track.playback) return
    let alive = true
    window.api
      .waveform(track.playback, BARS)
      .then((p) => {
        const max = Math.max(...p, 1e-6)
        if (alive) setPeaks(p.map((v) => v / max))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [track.playback])

  useEffect(() => () => audioRef.current?.pause(), [])

  const save = (patch: Partial<MusicTrack>): void =>
    update((p) => {
      const tr = p.music.find((m) => m.id === track.id)
      if (tr) Object.assign(tr, patch)
    }, `music:${track.id}:trim`)

  const drag = (which: 'in' | 'out') => (e: React.PointerEvent) => {
    const bar = barRef.current!.getBoundingClientRect()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      const v = Math.round(Math.min(1, Math.max(0, (ev.clientX - bar.left) / bar.width)) * len * 10) / 10
      if (which === 'in') save({ trimIn: v <= 0.05 ? undefined : Math.min(v, to - 5) })
      else save({ trimOut: v >= len - 0.05 ? undefined : Math.max(v, from + 5) })
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const stop = (): void => {
    audioRef.current?.pause()
    setPlaying(false)
    setPos(null)
  }
  const listen = (at: number): void => {
    if (!track.playback) return
    audioRef.current?.pause()
    const a = new Audio(mediaUrl(track.playback))
    audioRef.current = a
    a.currentTime = at
    a.ontimeupdate = () => {
      setPos(a.currentTime)
      if (a.currentTime >= to) stop()
    }
    a.onended = stop
    void a.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
  }

  const pct = (v: number): string => `${len ? (v / len) * 100 : 0}%`
  return (
    <div className="music-trim">
      <div className="trim wave" ref={barRef}>
        <div className="bars">
          {peaks.map((v, i) => (
            <span key={i} style={{ height: `${Math.max(4, v * 100)}%`, opacity: (i + 0.5) / BARS >= from / len && (i + 0.5) / BARS <= to / len ? 1 : 0.35 }} />
          ))}
        </div>
        <div className="trim-dim" style={{ left: 0, width: pct(from) }} />
        <div className="trim-dim" style={{ left: pct(to), right: 0 }} />
        {pos != null && <div className="wave-pos" style={{ left: pct(pos) }} />}
        <div
          className="trim-handle"
          style={{ left: pct(from) }}
          onPointerDown={drag('in')}
          {...handleProps(t('songStart'), from, len, (v) => save({ trimIn: v <= 0.05 ? undefined : Math.min(v, to - 5) }))}
        />
        <div
          className="trim-handle end"
          style={{ left: pct(to) }}
          onPointerDown={drag('out')}
          {...handleProps(t('songEnd'), to, len, (v) => save({ trimOut: v >= len - 0.05 ? undefined : Math.max(v, from + 5) }))}
        />
      </div>
      <div className="trim-row">
        <span className="val">
          {fmtTime(from)} – {fmtTime(to)} · {fmtTime(to - from)}
        </span>
        {(track.trimIn != null || track.trimOut != null) && (
          <button className="btn small ghost" onClick={() => save({ trimIn: undefined, trimOut: undefined })}>
            {t('resetTrim')}
          </button>
        )}
        <button className="btn small" onClick={() => (playing ? stop() : listen(from))}>
          {playing ? <Square size={12} /> : <Play size={13} />} {playing ? t('stop') : t('listen')}
        </button>
      </div>
      <p className="hint">{t('musicTrimHint')}</p>
    </div>
  )
}
