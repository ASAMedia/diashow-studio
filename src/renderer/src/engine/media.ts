// Texture sources for the engine: photos, video frames (live <video> in preview,
// frame-exact WebCodecs decoding via mediabunny in export), the motion of looping and bouncing
// Live Photos (decoded once into memory, for both) and rendered text.
import { ALL_FORMATS, Input, UrlSource, VideoSampleSink, type VideoSample } from 'mediabunny'
import { mediaUrl } from '@shared/api'
import type { Compositor, Tex } from './gl'

interface ImageEntry {
  tex?: Tex
  loading?: Promise<void>
  failed?: boolean
  used: number
  /** A load is running (the first one, or a sharper one for a panorama shown bigger). */
  busy?: boolean
  /** Short side of the texture, and the size of the file it was loaded from. */
  short?: number
  src?: [number, number]
  /** Share of the cache the texture takes: 1 per photo at maxSize, more for a big panorama. */
  units?: number
}

export class ImageStore {
  private map = new Map<string, ImageEntry>()
  private frame = 0
  /** Diagnostics: textures loaded and dropped so far. */
  loads = 0
  evictions = 0

  constructor(
    private c: Compositor,
    /** Longest edge of loaded photos; lower for weak machines (applies to new loads). */
    public maxSize: number,
    private limit = 28
  ) {}

  /**
   * Texture if loaded; otherwise starts loading and returns null. `need`: a panorama that fills the
   * frame's height (width) and pans along needs this many pixels on its short side (0 for others).
   */
  get(path: string | undefined, need = 0): Tex | null {
    if (!path) return null
    let e = this.map.get(path)
    if (!e) {
      e = { used: this.frame }
      this.map.set(path, e)
      e.loading = this.load(path, e, need)
    } else if (need > 0 && e.tex && e.src && !e.busy && !e.failed) {
      // shown bigger than it was loaded (a larger preview): load it sharper, the old texture stays until then
      const [w, h] = e.src
      if (Math.min(w, h) * this.scaleFor(w, h, need) > (e.short ?? 0) * 1.15) e.loading = this.load(path, e, need)
    }
    e.used = this.frame
    return e.tex ?? null
  }

  async ensure(path: string | undefined, need = 0): Promise<void> {
    if (!path) return
    this.get(path, need)
    await this.map.get(path)?.loading
  }

  /**
   * Scale a picture is loaded at: its long side at most maxSize; a panorama keeps `need` pixels on its
   * short side (up to maxSize) instead, and its long side only has to fit into a texture.
   */
  scaleFor(w: number, h: number, need: number): number {
    const long = Math.max(w, h)
    const normal = this.maxSize / long
    if (!(need > 0)) return Math.min(1, normal)
    return Math.min(1, Math.max(normal, Math.min(need, this.maxSize) / Math.min(w, h)), this.c.maxTexture / long)
  }

  private async load(path: string, e: ImageEntry, need: number): Promise<void> {
    e.busy = true
    try {
      const blob = await (await fetch(mediaUrl(path))).blob()
      let bmp = await createImageBitmap(blob)
      e.src = [bmp.width, bmp.height]
      const scale = this.scaleFor(bmp.width, bmp.height, need)
      if (scale < 1) {
        const resized = await createImageBitmap(bmp, {
          resizeWidth: Math.round(bmp.width * scale),
          resizeHeight: Math.round(bmp.height * scale),
          resizeQuality: 'high'
        })
        bmp.close()
        bmp = resized
      }
      // dropped from the cache meanwhile (a sharper load of an evicted panorama): not kept
      if (this.map.get(path) !== e) {
        bmp.close()
        return
      }
      const tex = this.c.upload(bmp, bmp.width, bmp.height, true)
      if (e.tex) this.c.deleteTexture(e.tex)
      e.tex = tex
      e.short = Math.min(bmp.width, bmp.height)
      e.units = Math.max(1, (bmp.width * bmp.height) / (this.maxSize * this.maxSize))
      this.loads++
      bmp.close()
    } catch {
      e.failed = true
    } finally {
      e.busy = false
    }
  }

  /** Called once per rendered frame; drops least recently used textures over the limit. */
  tick(): void {
    this.frame++
    let total = 0
    for (const e of this.map.values()) total += e.units ?? 1
    if (total <= this.limit) return
    const old = [...this.map.entries()].filter(([, e]) => e.tex && !e.busy).sort((a, b) => a[1].used - b[1].used)
    for (const [k, e] of old) {
      if (total <= this.limit) break
      if (e.used >= this.frame - 2) continue
      this.c.deleteTexture(e.tex!)
      this.map.delete(k)
      total -= e.units ?? 1
      this.evictions++
    }
  }

  dispose(): void {
    for (const e of this.map.values()) if (e.tex) this.c.deleteTexture(e.tex)
    this.map.clear()
  }
}

/** Preview: one muted <video> per file, kept in sync with the show clock. */
export class VideoPool {
  private els = new Map<string, { el: HTMLVideoElement; tex?: Tex; touched: boolean; idle: number; seeks: number }>()
  /** Diagnostics: per file, how often it was sought and whether it plays. */
  stats(): { path: string; seeks: number; paused: boolean; time: number }[] {
    return [...this.els].map(([path, v]) => ({ path, seeks: v.seeks, paused: v.el.paused, time: v.el.currentTime }))
  }

  constructor(private c: Compositor) {}

  /** Every video has its frame (or can't have one): nothing more will arrive without a new seek. */
  settled(): boolean {
    for (const { el } of this.els.values()) if (!el.error && (el.seeking || el.readyState < 2)) return false
    return true
  }

  private get(path: string): { el: HTMLVideoElement; tex?: Tex; touched: boolean; idle: number; seeks: number } {
    let v = this.els.get(path)
    if (!v) {
      const el = document.createElement('video')
      el.muted = true
      el.preload = 'auto'
      el.playsInline = true
      el.crossOrigin = 'anonymous'
      el.src = mediaUrl(path)
      v = { el, touched: true, idle: 0, seeks: 0 }
      this.els.set(path, v)
    }
    return v
  }

  /** Opens a video that will be needed soon and parks it on its first frame. */
  preload(path: string, time: number): void {
    const v = this.get(path)
    v.touched = true
    if (!v.el.seeking && v.el.paused && Math.abs(v.el.currentTime - time) > 0.03) v.el.currentTime = time
  }

  /** `playing` false also covers a clip that holds its last frame. `rate` is the clip's speed. */
  frame(path: string, time: number, playing: boolean, rate = 1): Tex | null {
    const v = this.get(path)
    v.touched = true
    v.idle = 0
    const el = v.el
    if (el.playbackRate !== rate) el.playbackRate = rate
    const target = Math.max(0, Math.min(time, (el.duration || Infinity) - 0.03))
    if (playing) {
      if (el.paused) {
        el.currentTime = target
        v.seeks++
        void el.play().catch(() => {})
      } else if (Math.abs(el.currentTime - target) > 0.25 * rate) {
        el.currentTime = target
        v.seeks++
      }
    } else {
      if (!el.paused) el.pause()
      if (!el.seeking && Math.abs(el.currentTime - target) > 0.03) {
        el.currentTime = target
        v.seeks++
      }
    }
    if (el.readyState >= 2 && el.videoWidth > 0) {
      v.tex = this.c.upload(el, el.videoWidth, el.videoHeight, true, v.tex)
    }
    return v.tex ?? null
  }

  /**
   * Videos not drawn since the last sweep are paused, and released only after a while: a cell
   * that skips a few frames (its staggered fade-in) must not lose its decoder and texture.
   */
  sweep(): void {
    for (const [k, v] of this.els) {
      if (v.touched) {
        v.touched = false
        continue
      }
      if (!v.el.paused) v.el.pause()
      // decoders are heavy: keep idle ones only briefly, and only a few of them
      if (++v.idle < 120 && this.els.size <= 12) continue
      if (v.tex) this.c.deleteTexture(v.tex)
      v.el.removeAttribute('src')
      v.el.load()
      this.els.delete(k)
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

/** The motion part of a Live Photo with every frame in memory, in presentation order. */
export interface MotionClip {
  frames: { data: Uint8Array; init: VideoFrameBufferInit }[]
  /** Source seconds of each frame, and the frame rate they give. */
  times: number[]
  fps: number
  /** Bytes held, and the frame size kept (smaller than the clip's when it didn't fit the budget). */
  bytes: number
  width: number
  height: number
  format: string
}

/**
 * Decodes a whole motion part once (WebCodecs through mediabunny). Frames stay as the decoder gave
 * them (I420 / NV12, about 1.5 bytes a pixel) when all of them fit into `budget` bytes; otherwise each
 * is drawn scaled down to RGBA so they do. Every frame is kept either way, so cycles stay frame-exact.
 */
async function decodeMotion(path: string, budget: number): Promise<MotionClip> {
  const input = new Input({ source: new UrlSource(mediaUrl(path)), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error(`no video track in ${path}`)
    const count = Math.max(1, (await track.computePacketStats()).packetCount)
    const frames: MotionClip['frames'] = []
    const times: number[] = []
    let native: boolean | undefined
    let size = { w: 0, h: 0 }
    let canvas: OffscreenCanvas | undefined
    for await (const s of new VideoSampleSink(track).samples()) {
      try {
        // frames before the start of an edit list are never shown
        if (s.timestamp + s.duration <= 0) continue
        if (native === undefined) {
          native = !!s.format && s.rotation === 0 && s.allocationSize() * count <= budget
          const scale = native ? 1 : Math.min(1, Math.sqrt(budget / (count * s.displayWidth * s.displayHeight * 4)))
          size = native ? { w: s.visibleRect.width, h: s.visibleRect.height } : { w: Math.max(2, Math.round(s.displayWidth * scale)), h: Math.max(2, Math.round(s.displayHeight * scale)) }
        }
        const timestamp = s.microsecondTimestamp
        if (native) {
          const data = new Uint8Array(s.allocationSize())
          const layout = await s.copyTo(data)
          const init = { format: s.format as VideoPixelFormat, codedWidth: size.w, codedHeight: size.h, displayWidth: s.displayWidth, displayHeight: s.displayHeight, timestamp, layout, colorSpace: s.colorSpace.toJSON() }
          frames.push({ data, init })
        } else {
          canvas ??= new OffscreenCanvas(size.w, size.h)
          const g = canvas.getContext('2d', { willReadFrequently: true })!
          s.draw(g, 0, 0, size.w, size.h)
          frames.push({ data: new Uint8Array(g.getImageData(0, 0, size.w, size.h).data.buffer), init: { format: 'RGBA', codedWidth: size.w, codedHeight: size.h, timestamp } })
        }
        times.push(s.timestamp)
      } finally {
        s.close()
      }
    }
    if (!frames.length) throw new Error(`no frames in ${path}`)
    const n = frames.length
    const span = times[n - 1] - times[0]
    const fps = n > 1 && span > 0 ? (n - 1) / span : 30
    return { frames, times, fps, bytes: frames.reduce((sum, f) => sum + f.data.byteLength, 0), width: size.w, height: size.h, format: native ? frames[0].init.format : 'RGBA' }
  } finally {
    input.dispose()
  }
}

interface MotionEntry {
  clip?: MotionClip
  loading: Promise<void>
  failed?: boolean
  touched: boolean
  idle: number
  slots: ({ tex: Tex; index: number } | undefined)[]
}

/**
 * Loop and Bounce, in the preview and the export alike: motion parts decoded into memory, so any
 * frame is at hand, backwards too, without seeking a decoder. A clip has two textures: the frame
 * shown and, at a Loop's seam, the one blended over it; each is uploaded only when its frame changes.
 */
export class MotionStore {
  private clips = new Map<string, MotionEntry>()

  constructor(
    private c: Compositor,
    /** Bytes one clip may take (applies to clips decoded from then on). */
    public budget: number
  ) {}

  private entry(path: string): MotionEntry {
    let e = this.clips.get(path)
    if (!e) {
      const fresh: MotionEntry = { touched: true, idle: 0, slots: [], loading: Promise.resolve() }
      fresh.loading = decodeMotion(path, this.budget).then(
        (clip) => void (fresh.clip = clip),
        () => void (fresh.failed = true)
      )
      this.clips.set(path, (e = fresh))
    }
    e.touched = true
    e.idle = 0
    return e
  }

  /** The decoded clip; null while it is decoded (the first call starts it) or when it can't be. */
  get(path: string): MotionClip | null {
    return this.entry(path).clip ?? null
  }

  /** Export: wait until the clip is decoded (or failed). */
  async ensure(path: string): Promise<void> {
    await this.entry(path).loading
  }

  failed(path: string): boolean {
    return !!this.clips.get(path)?.failed
  }

  /** Frame `index` of a decoded clip as a texture; slot 1 holds the frame blended in at a Loop's seam. */
  frame(path: string, index: number, slot: 0 | 1): Tex | null {
    const e = this.clips.get(path)
    const f = e?.clip?.frames[index]
    if (!e || !f) return null
    const s = e.slots[slot]
    if (s?.index === index) return s.tex
    const vf = new VideoFrame(f.data, f.init)
    try {
      const tex = this.c.upload(vf, vf.displayWidth, vf.displayHeight, true, s?.tex)
      e.slots[slot] = { tex, index }
      return tex
    } finally {
      vf.close()
    }
  }

  /** Preview: clips not asked for since the last sweeps are dropped soon, their memory is big. */
  sweep(): void {
    for (const [k, e] of this.clips) {
      if (e.touched) {
        e.touched = false
        continue
      }
      if (++e.idle >= 90 || this.clips.size > 2) this.release(k)
    }
  }

  /** Export: release the clips no longer needed. */
  keepOnly(paths: Set<string>): void {
    for (const k of [...this.clips.keys()]) if (!paths.has(k)) this.release(k)
  }

  private release(path: string): void {
    const e = this.clips.get(path)
    for (const s of e?.slots ?? []) if (s) this.c.deleteTexture(s.tex)
    this.clips.delete(path)
  }

  /** Diagnostics for tests: what each clip holds. */
  stats(): { path: string; frames: number; fps: number; bytes: number; width: number; height: number; format: string }[] {
    return [...this.clips].flatMap(([path, e]) => (e.clip ? [{ path, frames: e.clip.frames.length, fps: e.clip.fps, bytes: e.clip.bytes, width: e.clip.width, height: e.clip.height, format: e.clip.format }] : []))
  }

  dispose(): void {
    this.keepOnly(new Set())
  }
}

export type FontRole = 'sans' | 'light' | 'display' | 'serif' | 'type' | 'editorial' | 'caption' | 'rounded' | 'hand'

export const FONT_FAMILY: Record<FontRole, string> = {
  sans: "'Inter', 'Segoe UI', sans-serif",
  light: "'Inter', 'Segoe UI', sans-serif",
  display: "'Anton', 'Impact', sans-serif",
  serif: "'Cinzel', 'Georgia', serif",
  type: "'Special Elite', 'Courier New', monospace",
  editorial: "'Playfair Display', 'Georgia', serif",
  caption: "'Barlow Semi Condensed', 'Bahnschrift', sans-serif",
  rounded: "'Nunito Sans', 'Segoe UI', sans-serif",
  hand: "'Caveat', 'Segoe Print', cursive"
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
