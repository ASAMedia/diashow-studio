import { useEffect, useRef, useState } from 'react'
import { Pause, Play, SkipBack, SkipForward, Volume2, X } from 'lucide-react'
import { aspectValue } from '@shared/timeline'
import { Player } from '../engine/player'
import { useStore } from '../store'
import { timelineOf } from '../timeline'
import { fmtTime, localeTag, t } from '../i18n'

export function FullscreenPlayer() {
  const project = useStore((s) => s.project)
  const kiosk = useStore((s) => s.kiosk)
  const set = useStore((s) => s.set)
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<Player | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [ui, setUi] = useState(true)
  const [volume, setVolume] = useState(1)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const exit = (): void => {
    void window.api.setFullscreen(false)
    set({ fullscreen: false, kiosk: false })
  }

  useEffect(() => {
    void window.api.setFullscreen(true)
    void window.api.keepAwake(true)
    const p = new Player(canvasRef.current!, localeTag())
    playerRef.current = p
    let last = 0
    p.onTime = (tt) => {
      const now = performance.now()
      if (now - last > 250) {
        last = now
        setTime(tt)
      }
    }
    p.onState = setPlaying
    const fit = (): void => {
      const el = rootRef.current!
      const proj = useStore.getState().project
      if (!proj) return
      const aspect = aspectValue(proj.settings.aspect)
      const W = el.clientWidth
      const H = el.clientHeight
      const w = Math.min(W, H * aspect)
      const h = w / aspect
      const c = canvasRef.current!
      c.style.width = `${w}px`
      c.style.height = `${h}px`
      c.style.left = `${(W - w) / 2}px`
      c.style.top = `${(H - h) / 2}px`
      const dpr = window.devicePixelRatio || 1
      const scale = Math.min(dpr, 3840 / w)
      c.width = Math.round(w * scale)
      c.height = Math.round(h * scale)
      p.resize(c.width, c.height)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(rootRef.current!)
    const proj = useStore.getState().project
    if (proj) p.setProject(proj, timelineOf(proj))
    fit()
    // give the first textures a moment, then start like Photos does
    const startTimer = setTimeout(() => p.play(), 400)
    return () => {
      clearTimeout(startTimer)
      ro.disconnect()
      p.dispose()
      playerRef.current = null
      void window.api.keepAwake(false)
    }
  }, [])

  useEffect(() => {
    if (!project || !playerRef.current) return
    playerRef.current.setProject(project, timelineOf(project))
    // kiosk mode loops whatever the project says
    if (kiosk) playerRef.current.loop = true
  }, [project, kiosk])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      const p = playerRef.current
      if (e.key === 'Escape') exit()
      else if (e.code === 'Space') {
        e.preventDefault()
        p?.toggle()
      } else if (e.key === 'ArrowLeft') p?.step(-1)
      else if (e.key === 'ArrowRight') p?.step(1)
      poke()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const poke = (): void => {
    setUi(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setUi(false), 2500)
  }

  const duration = playerRef.current?.tl?.duration ?? 0
  return (
    <div ref={rootRef} className={`fullscreen ${ui ? 'show-ui' : ''}`} onMouseMove={poke} onClick={() => playerRef.current?.toggle()}>
      <canvas ref={canvasRef} />
      <div className="fs-controls" onClick={(e) => e.stopPropagation()}>
        <button title={t('previous')} onClick={() => playerRef.current?.step(-1)}>
          <SkipBack size={18} />
        </button>
        <button title={playing ? t('pause') : t('play')} onClick={() => playerRef.current?.toggle()}>
          {playing ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <button title={t('next')} onClick={() => playerRef.current?.step(1)}>
          <SkipForward size={18} />
        </button>
        <span className="time">
          {fmtTime(time)} / {fmtTime(duration)}
        </span>
        <Volume2 size={16} color="#ccc" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => {
            const v = Number(e.target.value)
            setVolume(v)
            playerRef.current?.setVolume(v)
          }}
        />
        <button title={t('exitFullscreen')} onClick={exit}>
          <X size={18} />
        </button>
      </div>
    </div>
  )
}
