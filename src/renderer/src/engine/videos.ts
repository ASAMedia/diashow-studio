// Video frames as textures for the engine: a live <video> per file in the preview, kept in sync with
// the show clock, and frame-exact WebCodecs decoding (mediabunny) in the export.
import { ALL_FORMATS, Input, UrlSource, VideoSampleSink, type VideoSample } from 'mediabunny'
import { mediaUrl } from '@shared/api'
import type { Compositor, Tex } from './gl'

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
