// Real-time playback for the editor and the fullscreen player. The clock drives the
// render loop; videos and audio elements follow it, gains come from the audio plan.
import { mediaUrl } from '@shared/api'
import type { AudioPlan, AudioPlanClip, Project } from '@shared/types'
import { buildTimeline, slideIndexAt, type Timeline } from '@shared/timeline'
import { buildAudioPlan, gainAt } from '@shared/audioPlan'
import { Engine, loadFonts } from './engine'

interface AudioNodeSet {
  el: HTMLAudioElement
  gain: GainNode
  src: string
}

export class Player {
  readonly engine: Engine
  tl: Timeline | null = null
  plan: AudioPlan = { duration: 0, clips: [] }
  t = 0
  playing = false
  loop = false
  onTime?: (t: number) => void
  onState?: (playing: boolean) => void
  private startWall = 0
  private startT = 0
  private raf = 0
  private lastPausedRender = 0
  private dirty = true
  private actx = new AudioContext({ latencyHint: 'playback' })
  private master = this.actx.createGain()
  private nodes = new Map<string, AudioNodeSet>()
  private locale: string

  constructor(
    private canvas: HTMLCanvasElement,
    locale = 'de-DE'
  ) {
    this.locale = locale
    this.engine = new Engine(canvas, 'preview')
    this.master.connect(this.actx.destination)
    void loadFonts().then(() => (this.dirty = true))
    const loop = (): void => {
      this.frame()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  setProject(project: Project): void {
    this.tl = buildTimeline(project, this.locale)
    this.engine.setProject(project, this.tl)
    this.plan = buildAudioPlan(project, this.tl)
    this.loop = project.settings.loop
    const keys = new Set(this.plan.clips.map((c) => this.key(c)))
    for (const [k, n] of this.nodes) {
      if (keys.has(k)) continue
      n.el.pause()
      n.el.removeAttribute('src')
      n.el.load()
      n.gain.disconnect()
      this.nodes.delete(k)
    }
    if (this.t > this.tl.duration) this.t = this.tl.duration
    this.dirty = true
  }

  setVolume(v: number): void {
    this.master.gain.value = v
  }

  resize(w: number, h: number): void {
    this.engine.resize(w, h)
    this.dirty = true
  }

  play(): void {
    if (!this.tl || this.tl.duration <= 0) return
    if (this.t >= this.tl.duration - 0.05) this.t = 0
    void this.actx.resume()
    this.startWall = performance.now()
    this.startT = this.t
    this.playing = true
    this.onState?.(true)
  }

  pause(): void {
    this.playing = false
    for (const n of this.nodes.values()) n.el.pause()
    this.dirty = true
    this.onState?.(false)
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  seek(t: number): void {
    this.t = Math.max(0, Math.min(t, this.tl?.duration ?? 0))
    this.startWall = performance.now()
    this.startT = this.t
    this.dirty = true
    this.onTime?.(this.t)
  }

  /** Jump to the previous/next slide start (fully visible point). */
  step(delta: number): void {
    if (!this.tl) return
    const idx = slideIndexAt(this.tl, this.t + 0.01)
    const target = this.tl.slides[Math.max(0, Math.min(this.tl.slides.length - 1, idx + delta))]
    if (target) this.seek(target.start + target.transIn)
  }

  private key(c: AudioPlanClip): string {
    return `${c.id}|${c.src}|${c.start.toFixed(3)}|${c.offset.toFixed(3)}`
  }

  private syncAudio(t: number): void {
    for (const clip of this.plan.clips) {
      const k = this.key(clip)
      const active = this.playing && t >= clip.start && t < clip.start + clip.duration
      const soon = this.playing && t >= clip.start - 2 && t < clip.start
      let n = this.nodes.get(k)
      if (!active && !soon) {
        if (n && !n.el.paused) n.el.pause()
        continue
      }
      if (!n) {
        const el = new Audio()
        el.crossOrigin = 'anonymous'
        el.preload = 'auto'
        el.src = mediaUrl(clip.src)
        const gain = this.actx.createGain()
        gain.gain.value = 0
        this.actx.createMediaElementSource(el).connect(gain).connect(this.master)
        n = { el, gain, src: clip.src }
        this.nodes.set(k, n)
        if (soon) el.currentTime = clip.offset
      }
      if (!active) continue
      const want = clip.offset + (t - clip.start)
      if (n.el.paused) {
        n.el.currentTime = want
        void n.el.play().catch(() => {})
      } else if (Math.abs(n.el.currentTime - want) > 0.2) n.el.currentTime = want
      n.gain.gain.setTargetAtTime(gainAt(clip.gain, t), this.actx.currentTime, 0.03)
    }
  }

  /** Frame pacing while playing (for diagnostics and tests): interval, render cost, textures still loading. */
  frameLog: { t: number; dt: number; render: number; missing: number }[] = []
  private lastFrame = 0

  private frame(): void {
    if (!this.tl) return
    const now = performance.now()
    if (this.playing) {
      this.t = this.startT + (now - this.startWall) / 1000
      if (this.t >= this.tl.duration) {
        if (this.loop && this.tl.duration > 0) this.seek(0)
        else {
          this.t = this.tl.duration
          this.pause()
        }
      }
      this.syncAudio(this.t)
      this.onTime?.(this.t)
    } else if (!this.dirty && now - this.lastPausedRender < 120) return
    this.lastPausedRender = now
    this.dirty = false
    this.engine.playing = this.playing
    const r0 = performance.now()
    this.engine.render(Math.min(this.t, Math.max(0, this.tl.duration - 0.001)))
    if (this.playing) {
      if (this.frameLog.length > 20000) this.frameLog.shift()
      this.frameLog.push({ t: this.t, dt: now - this.lastFrame, render: performance.now() - r0, missing: this.engine.missing })
    }
    this.lastFrame = now
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.pause()
    for (const n of this.nodes.values()) {
      n.el.removeAttribute('src')
      n.el.load()
    }
    this.nodes.clear()
    void this.actx.close()
    this.engine.dispose()
    void this.canvas
  }
}
