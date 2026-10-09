// Texture sources for the engine: photos, video frames (live <video> in preview,
// frame-exact WebCodecs decoding via mediabunny in export) and rendered text.
import { ALL_FORMATS, Input, UrlSource, VideoSampleSink, type VideoSample } from 'mediabunny'
import { mediaUrl } from '@shared/api'
import type { Compositor, Tex } from './gl'

interface ImageEntry {
  tex?: Tex
  loading?: Promise<void>
  failed?: boolean
  used: number
}

export class ImageStore {
  private map = new Map<string, ImageEntry>()
  private frame = 0

  constructor(
    private c: Compositor,
    private maxSize: number,
    private limit = 28
  ) {}

  /** Texture if loaded; otherwise starts loading and returns null. */
  get(path: string | undefined): Tex | null {
    if (!path) return null
    let e = this.map.get(path)
    if (!e) {
      e = { used: this.frame }
      this.map.set(path, e)
      e.loading = this.load(path, e)
    }
    e.used = this.frame
    return e.tex ?? null
  }

  async ensure(path: string | undefined): Promise<void> {
    if (!path) return
    this.get(path)
    await this.map.get(path)?.loading
  }

  private async load(path: string, e: ImageEntry): Promise<void> {
    try {
      const blob = await (await fetch(mediaUrl(path))).blob()
      let bmp = await createImageBitmap(blob)
      const scale = Math.min(1, this.maxSize / Math.max(bmp.width, bmp.height))
      if (scale < 1) {
        const resized = await createImageBitmap(bmp, {
          resizeWidth: Math.round(bmp.width * scale),
          resizeHeight: Math.round(bmp.height * scale),
          resizeQuality: 'high'
        })
        bmp.close()
        bmp = resized
      }
      e.tex = this.c.upload(bmp, bmp.width, bmp.height, true)
      bmp.close()
    } catch {
      e.failed = true
    }
  }

  /** Called once per rendered frame; drops least recently used textures over the limit. */
  tick(): void {
    this.frame++
    if (this.map.size <= this.limit) return
    const old = [...this.map.entries()].filter(([, e]) => e.tex).sort((a, b) => a[1].used - b[1].used)
    for (const [k, e] of old.slice(0, this.map.size - this.limit)) {
      if (e.used >= this.frame - 2) continue
      this.c.deleteTexture(e.tex!)
      this.map.delete(k)
    }
  }

  dispose(): void {
    for (const e of this.map.values()) if (e.tex) this.c.deleteTexture(e.tex)
    this.map.clear()
  }
}

/** Preview: one muted <video> per file, kept in sync with the show clock. */
export class VideoPool {
  private els = new Map<string, { el: HTMLVideoElement; tex?: Tex; touched: boolean }>()

  constructor(private c: Compositor) {}

  frame(path: string, time: number, playing: boolean): Tex | null {
    let v = this.els.get(path)
    if (!v) {
      const el = document.createElement('video')
      el.muted = true
      el.preload = 'auto'
      el.playsInline = true
      el.crossOrigin = 'anonymous'
      el.src = mediaUrl(path)
      v = { el, touched: true }
      this.els.set(path, v)
    }
    v.touched = true
    const el = v.el
    const target = Math.max(0, Math.min(time, (el.duration || Infinity) - 0.03))
    if (playing) {
      if (el.paused) {
        el.currentTime = target
        void el.play().catch(() => {})
      } else if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target
    } else {
      if (!el.paused) el.pause()
      if (!el.seeking && Math.abs(el.currentTime - target) > 0.03) el.currentTime = target
    }
    if (el.readyState >= 2 && el.videoWidth > 0) {
      v.tex = this.c.upload(el, el.videoWidth, el.videoHeight, true, v.tex)
    }
    return v.tex ?? null
  }

  /** Pause videos that were not drawn since the last sweep. */
  sweep(): void {
    for (const [k, v] of this.els) {
      if (!v.touched) {
        v.el.pause()
        if (v.tex) this.c.deleteTexture(v.tex)
        v.el.removeAttribute('src')
        v.el.load()
        this.els.delete(k)
      } else v.touched = false
    }
  }

  dispose(): void {
    for (const v of this.els.values()) {
      v.el.pause()
      v.el.removeAttribute('src')
      v.el.load()
      if (v.tex) this.c.deleteTexture(v.tex)
    }
    this.els.clear()
  }
}

/** Export: sequential, frame-exact decoding of one file. */
class FrameReader {
  private input?: Input
  private sink?: VideoSampleSink
  private it?: AsyncGenerator<VideoSample, void, unknown>
  private cur?: VideoSample
  private next?: VideoSample
  private ended = false

  constructor(private path: string) {}

  private async open(): Promise<void> {
    this.input = new Input({ source: new UrlSource(mediaUrl(this.path)), formats: ALL_FORMATS })
    const track = await this.input.getPrimaryVideoTrack()
    if (!track) throw new Error(`no video track in ${this.path}`)
    this.sink = new VideoSampleSink(track)
  }

  private async restart(t: number): Promise<void> {
    this.cur?.close()
    this.next?.close()
    this.cur = this.next = undefined
    await this.it?.return()
    this.it = this.sink!.samples(t)
    this.ended = false
    this.cur = (await this.it.next()).value ?? undefined
    this.next = (await this.it.next()).value ?? undefined
  }

  async at(t: number): Promise<VideoSample | undefined> {
    if (!this.sink) await this.open()
    if (!this.it || !this.cur || t < this.cur.timestamp - 0.001 || t > this.cur.timestamp + 3) await this.restart(t)
    while (this.next && this.next.timestamp <= t + 1e-4) {
      this.cur?.close()
      this.cur = this.next
      const r = this.ended ? { value: undefined } : await this.it!.next()
      if (!r.value) this.ended = true
      this.next = r.value ?? undefined
    }
    return this.cur
  }

  dispose(): void {
    this.cur?.close()
    this.next?.close()
    void this.it?.return()
    this.input?.dispose()
  }
}

export class ExportVideoStore {
  private readers = new Map<string, FrameReader>()
  private texs = new Map<string, { tex: Tex; ts: number }>()
  private ready = new Map<string, Tex>()

  constructor(private c: Compositor) {}

  /** Decode the frame for (path, time) and upload it; `get` then returns it synchronously. */
  async prepare(path: string, time: number): Promise<void> {
    let r = this.readers.get(path)
    if (!r) this.readers.set(path, (r = new FrameReader(path)))
    const sample = await r.at(time)
    if (!sample) return
    const prev = this.texs.get(path)
    if (prev && prev.ts === sample.timestamp) {
      this.ready.set(path, prev.tex)
      return
    }
    const frame = sample.toVideoFrame()
    const tex = this.c.upload(frame, frame.displayWidth, frame.displayHeight, true, prev?.tex)
    frame.close()
    this.texs.set(path, { tex, ts: sample.timestamp })
    this.ready.set(path, tex)
  }

  get(path: string): Tex | null {
    return this.ready.get(path) ?? null
  }

  /** Release readers that are no longer needed. */
  keepOnly(paths: Set<string>): void {
    for (const [k, r] of this.readers) {
      if (paths.has(k)) continue
      r.dispose()
      this.readers.delete(k)
      const t = this.texs.get(k)
      if (t) this.c.deleteTexture(t.tex)
      this.texs.delete(k)
      this.ready.delete(k)
    }
  }

  dispose(): void {
    this.keepOnly(new Set())
  }
}

export type FontRole = 'sans' | 'light' | 'display' | 'serif' | 'type' | 'editorial' | 'caption' | 'rounded'

const FONT_FAMILY: Record<FontRole, string> = {
  sans: "'Inter', 'Segoe UI', sans-serif",
  light: "'Inter', 'Segoe UI', sans-serif",
  display: "'Anton', 'Impact', sans-serif",
  serif: "'Cinzel', 'Georgia', serif",
  type: "'Special Elite', 'Courier New', monospace",
  editorial: "'Playfair Display', 'Georgia', serif",
  caption: "'Barlow Semi Condensed', 'Bahnschrift', sans-serif",
  rounded: "'Nunito Sans', 'Segoe UI', sans-serif"
}

export interface TextSpec {
  text: string
  font: FontRole
  /** Font size in output pixels. */
  size: number
  weight?: number
  color?: string
  /** Extra letter spacing in em. */
  tracking?: number
  uppercase?: boolean
  maxWidth?: number
  lineHeight?: number
  align?: 'left' | 'center' | 'right'
  shadow?: boolean
}

export class TextStore {
  private map = new Map<string, { tex: Tex; used: number }>()
  private frame = 0
  private canvas = document.createElement('canvas')

  constructor(private c: Compositor) {}

  get(spec: TextSpec): Tex | null {
    if (!spec.text.trim()) return null
    const key = JSON.stringify(spec)
    const hit = this.map.get(key)
    if (hit) {
      hit.used = this.frame
      return hit.tex
    }
    const tex = this.render(spec)
    this.map.set(key, { tex, used: this.frame })
    return tex
  }

  private render(s: TextSpec): Tex {
    const ctx = this.canvas.getContext('2d')!
    const weight = s.weight ?? (s.font === 'light' ? 300 : s.font === 'sans' ? 600 : 400)
    const font = `${weight} ${s.size}px ${FONT_FAMILY[s.font]}`
    ctx.font = font
    ctx.letterSpacing = `${(s.tracking ?? 0) * s.size}px`
    const text = s.uppercase ? s.text.toLocaleUpperCase() : s.text
    const lines: string[] = []
    for (const para of text.split('\n')) {
      if (!s.maxWidth) {
        lines.push(para)
        continue
      }
      let line = ''
      for (const word of para.split(/\s+/)) {
        const tryLine = line ? `${line} ${word}` : word
        if (line && ctx.measureText(tryLine).width > s.maxWidth) {
          lines.push(line)
          line = word
        } else line = tryLine
      }
      lines.push(line)
    }
    const lh = s.size * (s.lineHeight ?? 1.2)
    const pad = Math.ceil(s.size * 0.35)
    const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + pad * 2
    const h = Math.ceil(lh * lines.length + s.size * 0.3) + pad * 2
    this.canvas.width = Math.max(1, w)
    this.canvas.height = Math.max(1, h)
    ctx.font = font
    ctx.letterSpacing = `${(s.tracking ?? 0) * s.size}px`
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = s.color ?? '#fff'
    ctx.textAlign = s.align ?? 'center'
    if (s.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)'
      ctx.shadowBlur = s.size * 0.25
      ctx.shadowOffsetY = s.size * 0.04
    }
    const x = s.align === 'left' ? pad : s.align === 'right' ? w - pad : w / 2
    lines.forEach((l, i) => ctx.fillText(l, x, pad + s.size * 0.95 + i * lh))
    return this.c.upload(this.canvas, w, h, false)
  }

  tick(): void {
    this.frame++
    if (this.map.size < 64) return
    for (const [k, v] of this.map) {
      if (v.used < this.frame - 120) {
        this.c.deleteTexture(v.tex)
        this.map.delete(k)
      }
    }
  }

  dispose(): void {
    for (const v of this.map.values()) this.c.deleteTexture(v.tex)
    this.map.clear()
  }
}
