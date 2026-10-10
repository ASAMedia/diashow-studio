// Animated title and chapter slides: handwriting that writes itself, a typewriter, a big word
// rising from a line, and rolling end credits. Drawn on the theme's own background.
import type { TitleStyle } from '@shared/types'
import { clamp01, drawText, easeOut, smooth } from './draw'
import type { Ctx, SlideState, Theme } from './types'

/** `overlay`: the show title on the first photo (white, shown for the first seconds only). */
export function drawStyledTitle(ctx: Ctx, s: SlideState, style: Exclude<TitleStyle, 'theme'>, theme: Theme, overlay = false): void {
  const title = s.slide.title
  if (!title) return
  const { W, H } = ctx
  const light = !overlay && theme.clear[0] + theme.clear[1] + theme.clear[2] > 1.5
  const ink = light ? '#24262b' : '#ffffff'
  const shadow = !light
  const out = (1 - smooth(s.outP)) * (overlay ? 1 - smooth((s.local - 3.6) / 0.8) : 1)
  const t = s.local
  const sub = title.subtitle?.trim()

  if (style === 'handwriting') {
    const size = H * 0.12
    const tex = ctx.text({ text: title.text, font: 'hand', size, weight: 700, color: ink, maxWidth: W * 0.86, shadow })
    if (!tex) return
    // written from left to right, about as fast as a quick hand
    const dur = Math.min(2.2, Math.max(0.8, 0.07 * title.text.length))
    const p = clamp01((t - 0.25) / dur)
    const x = W / 2 - tex.w / 2
    const y = H * 0.46 - tex.h / 2
    if (p > 0) ctx.c.quad({ tex, x, y, w: tex.w * p, h: tex.h, uv: { x: 0, y: 0, w: p, h: 1 }, opacity: out })
    if (sub) drawText(ctx, { text: sub, font: 'hand', size: size * 0.45, color: ink, maxWidth: W * 0.8, shadow }, W / 2, y + tex.h + size * 0.2, { opacity: smooth((t - 0.25 - dur) / 0.5) * out })
    return
  }

  if (style === 'typewriter') {
    const size = H * 0.07
    const spec = { text: title.text, font: 'type' as const, size, color: ink, align: 'left' as const, shadow }
    const full = ctx.text(spec)
    if (!full) return
    const cps = 14
    const typed = Math.min(title.text.length, Math.floor(Math.max(0, t - 0.3) * cps))
    const cursor = Math.floor(t * 2.4) % 2 === 0 ? '|' : ' '
    const x = W / 2 - full.w / 2
    const y = H * 0.46
    const line = ctx.text({ ...spec, text: title.text.slice(0, typed) + (typed < title.text.length || !sub ? cursor : '') })
    if (line) ctx.c.quad({ tex: line, x, y: y - line.h / 2, w: line.w, h: line.h, opacity: out })
    if (sub && typed >= title.text.length) {
      const subSpec = { ...spec, text: sub, size: size * 0.55 }
      const subFull = ctx.text(subSpec)
      const n = Math.min(sub.length, Math.floor(Math.max(0, t - 0.3 - title.text.length / cps - 0.3) * cps))
      const subLine = n > 0 ? ctx.text({ ...subSpec, text: sub.slice(0, n) + (n < sub.length ? cursor : '') }) : null
      if (subFull && subLine) ctx.c.quad({ tex: subLine, x: W / 2 - subFull.w / 2, y: y + full.h * 0.55, w: subLine.w, h: subLine.h, opacity: out })
    }
    return
  }

  if (style === 'bigDate') {
    // the big word rises from behind a line, then a short bar grows and the small line fades in
    const size = H * 0.2
    const tex = ctx.text({ text: title.text, font: 'display', size, color: ink, uppercase: true, tracking: 0.02, maxWidth: W * 0.9 })
    if (!tex) return
    // the part of the texture down to the last baseline (text textures are padded by 0.35 em)
    const lines = Math.max(1, Math.round((tex.h - 2 * Math.ceil(size * 0.35) - size * 0.3) / (size * 1.2)))
    const ink2 = Math.min(tex.h, Math.ceil(size * 0.35) + size * 0.95 + (lines - 1) * size * 1.2)
    const p = easeOut(clamp01((t - 0.1) / 0.7))
    const base = H * 0.56
    if (p > 0) ctx.c.quad({ tex, x: W / 2 - tex.w / 2, y: base - ink2 * p, w: tex.w, h: ink2 * p, uv: { x: 0, y: 0, w: 1, h: (ink2 * p) / tex.h }, opacity: out })
    const bar = Math.min(tex.w, W * 0.5) * 0.4 * easeOut(clamp01((t - 0.55) / 0.6))
    ctx.c.quad({ x: W / 2 - bar / 2, y: base + H * 0.022, w: bar, h: Math.max(2, H * 0.006), color: light ? [0.14, 0.15, 0.17, 1] : [1, 1, 1, 1], opacity: out })
    if (sub) drawText(ctx, { text: sub, font: 'sans', weight: 600, size: H * 0.042, color: ink, uppercase: true, tracking: 0.12, maxWidth: W * 0.85, shadow }, W / 2, base + H * 0.085, { opacity: smooth((t - 0.75) / 0.5) * out })
    return
  }

  // credits: the title and every line of the subtitle roll up through the picture
  const specs = [
    { text: title.text, font: 'sans' as const, weight: 700, size: H * 0.07, color: ink, shadow, maxWidth: W * 0.8 },
    ...(sub ?? '').split('\n').map((l) => ({ text: l.trim() || ' ', font: 'sans' as const, weight: 400, size: H * 0.045, color: ink, shadow, maxWidth: W * 0.8 }))
  ]
  const texs = specs.map((sp) => (sp.text.trim() ? ctx.text(sp) : null))
  const heights = specs.map((sp, i) => texs[i]?.h ?? sp.size * 1.2)
  const total = heights.reduce((sum, h) => sum + h, 0) + H * 0.06
  const p = clamp01(t / Math.max(0.1, s.slide.duration))
  let y = H - (H + total) * p
  texs.forEach((tex, i) => {
    if (tex) ctx.c.quad({ tex, x: W / 2 - tex.w / 2, y, w: tex.w, h: tex.h, opacity: smooth(s.inP) * out })
    y += heights[i] + (i === 0 ? H * 0.06 : 0)
  })
}
