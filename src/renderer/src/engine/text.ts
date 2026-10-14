// Rendered text as textures for the engine (titles, captions, text boxes), with the fonts of each role.
import type { Compositor, Tex } from './gl'

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
