// The motion of looping and bouncing Live Photos: decoded once into memory (WebCodecs through
// mediabunny), for the preview and the export alike.
import { ALL_FORMATS, Input, UrlSource, VideoSampleSink } from 'mediabunny'
import { mediaUrl } from '@shared/api'
import type { Compositor, Tex } from './gl'

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
