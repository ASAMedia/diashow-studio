// Free collage: the items of a slide placed, sized and turned by hand. Light themes show them as
// prints with a white border, dark themes as pictures with a soft shadow.
import { clamp01, drawCell, easeOut, lerp, smooth } from './draw'
import type { Ctx, SlideState, Theme } from './types'

export function drawCollage(ctx: Ctx, s: SlideState, theme: Theme): void {
  const places = s.slide.places
  if (!places) return
  const { W, H } = ctx
  const light = theme.clear[0] + theme.clear[1] + theme.clear[2] > 1.5
  const out = 1 - smooth(s.outP)
  // back to front; each one lands a moment after the one below
  const order = places.map((_, i) => i).sort((a, b) => places[a].z - places[b].z)
  order.forEach((i, rank) => {
    const p = places[i]
    const appear = easeOut(clamp01((s.local - rank * 0.12) / 0.6))
    const o = smooth(appear * 1.3) * out
    if (o <= 0.001) return
    const k = lerp(1.08, 1, appear)
    const w = p.w * W * k
    const h = p.h * H * k
    const box = { x: p.x * W + (p.w * W - w) / 2, y: p.y * H + (p.h * H - h) / 2, w, h }
    const rotZ = (p.rot * Math.PI) / 180
    const lift = Math.min(w, h)
    ctx.c.shadow({ x: box.x + lift * 0.015, y: box.y + lift * 0.03, w, h, blur: lift * 0.06, opacity: (light ? 0.35 : 0.55) * o, rotZ })
    let inner = box
    if (light) {
      const b = lift * 0.035
      ctx.c.quad({ ...box, color: [0.97, 0.96, 0.93, 1], rotZ, opacity: o })
      inner = { x: box.x + b, y: box.y + b, w: w - 2 * b, h: h - 2 * b }
    }
    drawCell(ctx, s, i, inner, { rotZ, opacity: o }, 'none')
  })
}
