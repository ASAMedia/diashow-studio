// Presentation on a second display. The main window shows the presenter controls; the show
// itself plays in a separate window (#present). Both talk over a BroadcastChannel.
import { useEffect, useRef, useState } from 'react'
import { MonitorX, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { aspectValue, buildTimeline, slideIndexAt } from '@shared/timeline'
import type { MediaItem, Project } from '@shared/types'
import { Player } from '../engine/player'
import { useStore } from '../store'
import { timelineOf } from '../timeline'
import { fmtTime, localeTag, t } from '../i18n'
import { keyForFocus } from '../keys'
import { Modal } from './Modal'
import { MediaThumb } from './EditedPicture'

const CHANNEL = 'diashow-present'

type Message =
  | { type: 'ready' }
  | { type: 'project'; project: Project }
  | { type: 'cmd'; action: 'toggle' | 'play' | 'pause' | 'next' | 'prev' | 'seek'; t?: number }
  | { type: 'state'; t: number; playing: boolean; duration: number }

/** The show window: a full-window player driven by the presenter. */
export function PresentView() {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL)
    const player = new Player(canvasRef.current!, localeTag())
    let aspect = 16 / 9
    const fit = (): void => {
      const el = rootRef.current!
      const w = Math.min(el.clientWidth, el.clientHeight * aspect)
      const h = w / aspect
      const c = canvasRef.current!
      Object.assign(c.style, { width: `${w}px`, height: `${h}px`, left: `${(el.clientWidth - w) / 2}px`, top: `${(el.clientHeight - h) / 2}px` })
      const scale = Math.min(window.devicePixelRatio || 1, 3840 / w)
      c.width = Math.round(w * scale)
      c.height = Math.round(h * scale)
      player.resize(c.width, c.height)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(rootRef.current!)
    let started = false
    ch.onmessage = (ev: MessageEvent<Message>) => {
      const m = ev.data
      if (m.type === 'project') {
        aspect = aspectValue(m.project.settings.aspect)
        player.setProject(m.project, buildTimeline(m.project, localeTag()))
        fit()
        if (!started) {
          started = true
          setTimeout(() => player.play(), 500)
        }
      } else if (m.type === 'cmd') {
        if (m.action === 'toggle') player.toggle()
        else if (m.action === 'play') player.play()
        else if (m.action === 'pause') player.pause()
        else if (m.action === 'next') player.step(1)
        else if (m.action === 'prev') player.step(-1)
        else if (m.action === 'seek' && m.t != null) player.seek(m.t)
      }
    }
    const report = setInterval(() => ch.postMessage({ type: 'state', t: player.t, playing: player.playing, duration: player.tl?.duration ?? 0 } satisfies Message), 200)
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void window.api.presentStop()
      else if (e.code === 'Space') player.toggle()
      else if (e.key === 'ArrowRight') player.step(1)
      else if (e.key === 'ArrowLeft') player.step(-1)
    }
    window.addEventListener('keydown', key)
    ch.postMessage({ type: 'ready' } satisfies Message)
    return () => {
      clearInterval(report)
      window.removeEventListener('keydown', key)
      ro.disconnect()
      ch.close()
      player.dispose()
    }
  }, [])
  return (
    <div ref={rootRef} className="fullscreen" data-theme="dark" style={{ cursor: 'none' }}>
      <canvas ref={canvasRef} />
    </div>
  )
}

/** Presenter controls in the main window while the show runs on the other screen. */
export function PresenterPanel() {
  const project = useStore((s) => s.project)!
  const set = useStore((s) => s.set)
  const [state, setState] = useState({ t: 0, playing: false, duration: 0 })
  const chRef = useRef<BroadcastChannel | null>(null)
  const tl = timelineOf(project)
  const send = (m: Message): void => chRef.current?.postMessage(m)

  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL)
    chRef.current = ch
    ch.onmessage = (ev: MessageEvent<Message>) => {
      const m = ev.data
      if (m.type === 'ready') ch.postMessage({ type: 'project', project: useStore.getState().project! } satisfies Message)
      else if (m.type === 'state') setState({ t: m.t, playing: m.playing, duration: m.duration })
    }
    const off = window.api.onPresentClosed(() => set({ presenting: false }))
    void window.api.presentStart()
    void window.api.keepAwake(true)
    return () => {
      off()
      ch.close()
      void window.api.presentStop()
      void window.api.keepAwake(false)
    }
  }, [set])

  // edits made while presenting go to the show window too
  useEffect(() => {
    chRef.current?.postMessage({ type: 'project', project } satisfies Message)
  }, [project])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' && keyForFocus(e)) return
      if (e.key === 'Escape') set({ presenting: false })
      else if (e.code === 'Space') {
        e.preventDefault()
        send({ type: 'cmd', action: 'toggle' })
      } else if (e.key === 'ArrowRight') send({ type: 'cmd', action: 'next' })
      else if (e.key === 'ArrowLeft') send({ type: 'cmd', action: 'prev' })
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })

  const idx = slideIndexAt(tl, state.t + 0.01)
  const cur = tl.slides[idx]
  const next = tl.slides[idx + 1]
  const shot = (i: number): MediaItem | undefined => (tl.slides[i]?.media[0]?.thumb ? tl.slides[i].media[0] : undefined)
  return (
    <Modal title={t('presenting')} onClose={() => set({ presenting: false })} noCloseButton className="wide" overlayClassName="presenter">
      <div className="presenter-slides">
        <figure>
          {cur && shot(idx) ? <MediaThumb m={shot(idx)!} /> : <div className="ph">{cur?.title?.text ?? ''}</div>}
          <figcaption>
            {t('nowShowing')} {idx + 1} / {tl.slides.length}
          </figcaption>
        </figure>
        <figure className="next">
          {next && shot(idx + 1) ? <MediaThumb m={shot(idx + 1)!} /> : <div className="ph">{next?.title?.text ?? '—'}</div>}
          <figcaption>{t('upNext')}</figcaption>
        </figure>
      </div>
      <input
        type="range"
        className="scrub"
        aria-label={t('position')}
        aria-valuetext={`${fmtTime(state.t)} / ${fmtTime(state.duration)}`}
        min={0}
        max={Math.max(0.01, state.duration)}
        step={0.1}
        value={state.t}
        onChange={(e) => send({ type: 'cmd', action: 'seek', t: Number(e.target.value) })}
      />
      <div className="presenter-controls">
        <button className="btn icon" title={t('previous')} aria-label={t('previous')} onClick={() => send({ type: 'cmd', action: 'prev' })}>
          <SkipBack size={16} />
        </button>
        <button className="btn primary" onClick={() => send({ type: 'cmd', action: 'toggle' })}>
          {state.playing ? <Pause size={16} /> : <Play size={16} />} {state.playing ? t('pause') : t('play')}
        </button>
        <button className="btn icon" title={t('next')} aria-label={t('next')} onClick={() => send({ type: 'cmd', action: 'next' })}>
          <SkipForward size={16} />
        </button>
        <span className="val">
          {fmtTime(state.t)} / {fmtTime(state.duration)}
        </span>
        <button className="btn" onClick={() => set({ presenting: false })}>
          <MonitorX size={16} /> {t('stopPresenting')}
        </button>
      </div>
      <p className="hint">{t('presentHint')}</p>
    </Modal>
  )
}
