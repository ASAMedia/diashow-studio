// Video trimming in the Slide tab: frames of the clip with in and out handles, and a preview of the cut.
import { useEffect, useRef, useState } from 'react'
import { mediaUrl } from '@shared/api'
import type { MediaItem, VideoEntry } from '@shared/types'
import { playerRef, useStore } from '../store'
import { timelineOf } from '../timeline'
import { fmtSeconds, t } from '../i18n'
import { Play } from 'lucide-react'

/**
 * A trim handle for the keyboard: a slider (arrows 0.1 s, with Shift 1 s, Home/End). The keys stay
 * with the handle, so the preview doesn't step at the same time.
 */
export function handleProps(label: string, value: number, max: number, set: (v: number) => void) {
  return {
    role: 'slider',
    tabIndex: 0,
    'aria-label': label,
    'aria-valuemin': 0,
    'aria-valuemax': Math.round(max * 10) / 10,
    'aria-valuenow': Math.round(value * 10) / 10,
    'aria-valuetext': fmtSeconds(value),
    onKeyDown: (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 1 : 0.1
      const next =
        e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? value - step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? value + step : e.key === 'Home' ? 0 : e.key === 'End' ? max : null
      if (next == null) return
      e.preventDefault()
      e.stopPropagation()
      set(Math.round(Math.max(0, Math.min(max, next)) * 10) / 10)
    }
  } as const
}

/** Frames of the clip with two handles for start and end, plus a preview of the trimmed part. */
export function TrimStrip({ entry, media }: { entry: VideoEntry; media: MediaItem }) {
  const setEntry = useStore((s) => s.setEntry)
  const project = useStore((s) => s.project)!
  const [frames, setFrames] = useState<string[]>([])
  const barRef = useRef<HTMLDivElement>(null)
  const len = media.duration ?? 0
  const tin = entry.trimIn ?? 0
  const tout = entry.trimOut ?? len
  const max = project.settings.maxVideoSeconds || Infinity
  const shown = Math.min(tout, tin + max)
  useEffect(() => {
    let alive = true
    const src = media.playback ?? media.path
    window.api.videoStrip(src, 10, 54).then((f) => alive && setFrames(f)).catch(() => {})
    return () => {
      alive = false
    }
  }, [media.playback, media.path])
  const drag = (which: 'in' | 'out') => (e: React.PointerEvent) => {
    const bar = barRef.current!.getBoundingClientRect()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      const t = Math.round(Math.min(1, Math.max(0, (ev.clientX - bar.left) / bar.width)) * len * 10) / 10
      if (which === 'in') setEntry(entry.id, { trimIn: Math.min(t, tout - 0.5) } as Partial<VideoEntry>)
      else setEntry(entry.id, { trimOut: Math.max(t, tin + 0.5) } as Partial<VideoEntry>)
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  const pct = (v: number): string => `${len ? (v / len) * 100 : 0}%`
  const setIn = (v: number): void => setEntry(entry.id, { trimIn: Math.max(0, Math.min(v, tout - 0.5)) } as Partial<VideoEntry>)
  const setOut = (v: number): void => setEntry(entry.id, { trimOut: Math.min(len, Math.max(v, tin + 0.5)) } as Partial<VideoEntry>)
  // the preview stops at the end of the clip, unless the user moved on in the meantime
  const stopAt = useRef(0)
  useEffect(() => () => window.clearTimeout(stopAt.current), [])
  const play = (): void => {
    const slide = timelineOf(project).slides.find((sl) => sl.entries.some((x) => x.id === entry.id))
    const p = playerRef.current
    if (!slide || !p) return
    p.seek(slide.start)
    p.play()
    window.clearTimeout(stopAt.current)
    stopAt.current = window.setTimeout(() => {
      if (p.playing && p.t >= slide.start && p.t <= slide.start + slide.duration + 0.5) p.pause()
    }, slide.duration * 1000)
  }
  return (
    <div>
      <div className="trim" ref={barRef}>
        <div className="trim-frames">
          {frames.map((f) => (
            <img key={f} src={mediaUrl(f)} alt="" draggable={false} />
          ))}
        </div>
        <div className="trim-dim" style={{ left: 0, width: pct(tin) }} />
        <div className="trim-dim" style={{ left: pct(tout), right: 0 }} />
        {shown < tout && <div className="trim-cut" style={{ left: pct(shown), width: `calc(${pct(tout)} - ${pct(shown)})` }} />}
        <div className="trim-handle" style={{ left: pct(tin) }} onPointerDown={drag('in')} {...handleProps(t('trimStart'), tin, len, setIn)} />
        <div className="trim-handle end" style={{ left: pct(tout) }} onPointerDown={drag('out')} {...handleProps(t('trimEnd'), tout, len, setOut)} />
      </div>
      <div className="trim-row">
        <span className="val">
          {fmtSeconds(tin)} – {fmtSeconds(Math.min(tout, shown))}
        </span>
        <button className="btn small" onClick={play}>
          <Play size={13} /> {t('trimPreview')}
        </button>
      </div>
      <p className="hint">{t('trimHint')}</p>
    </div>
  )
}
