// Text boxes the user placed freely on a slide: text with an optional shadow, band, card or
// speech bubble behind it, rotated around its centre.
import type { FreeText, TextFont } from '@shared/types'
import type { FontRole, TextSpec } from './media'
import type { Ctx } from './types'

export const FONT_ROLE: Record<TextFont, FontRole> = {
  theme: 'sans',
  sans: 'sans',
  rounded: 'rounded',
  caption: 'caption',
  display: 'display',
  serif: 'serif',
  editorial: 'editorial',
  type: 'type',
  hand: 'hand'
}

export function freeTextSpec(ft: FreeText, W: number, H: number): TextSpec {
  return {
    text: ft.text,
    font: FONT_ROLE[ft.font] ?? 'sans',
    size: Math.max(4, ft.size * H),
    weight: ft.bold ? 700 : undefined,
    color: ft.color,
    align: 'center',
    shadow: ft.box === 'shadow',
    maxWidth: W * 0.9,
    lineHeight: 1.15
  }
}

export function drawFreeText(ctx: Ctx, ft: FreeText, opacity: number): void {
  if (opacity <= 0.001) return
  const { W, H } = ctx
  const spec = freeTextSpec(ft, W, H)
  const tex = ctx.text(spec)
  if (!tex) return
  const size = spec.size
  const cx = ft.x * W
  const cy = ft.y * H
  const rotZ = (ft.rotation * Math.PI) / 180
  const box = { x: cx - tex.w / 2, y: cy - tex.h / 2, w: tex.w, h: tex.h }
  if (ft.box === 'band') {
    ctx.c.quad({ ...box, color: [0, 0, 0, 0.55], radius: size * 0.18, rotZ, opacity })
  } else if (ft.box === 'card' || ft.box === 'bubble') {
    const radius = ft.box === 'bubble' ? Math.min(box.h / 2, size * 0.6) : size * 0.12
    ctx.c.shadow({ x: box.x + size * 0.04, y: box.y + size * 0.08, w: box.w, h: box.h, blur: size * 0.3, opacity: 0.45 * opacity, radius, rotZ })
    if (ft.box === 'bubble') {
      // tail below the left third, turned with the bubble
      const t = size * 0.55
      const dx = -box.w * 0.22
      const dy = box.h / 2 - t * 0.2
      const tx = cx + dx * Math.cos(rotZ) - dy * Math.sin(rotZ)
      const ty = cy + dx * Math.sin(rotZ) + dy * Math.cos(rotZ)
      ctx.c.quad({ x: tx - t / 2, y: ty - t / 2, w: t, h: t, color: [1, 1, 1, 0.96], rotZ: rotZ + Math.PI / 4, opacity })
    }
    ctx.c.quad({ ...box, color: [1, 1, 1, 0.96], radius, rotZ, opacity })
  }
  ctx.c.quad({ ...box, tex, rotZ, opacity })
}
