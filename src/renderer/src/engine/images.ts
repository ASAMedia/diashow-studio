// Photos as textures for the engine: loaded once, cached by path (the least recently used are
// dropped), sharper for a panorama shown bigger.
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
