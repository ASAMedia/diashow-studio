// Full-frame themes that blend whole slides with a transition shader:
// Classic, Ken Burns and Retro Film.
import type { PhotoEntry } from '@shared/types'
import type { Ctx, SlideState, Theme } from '../types'
import { aspectOf, dirVector, drawCell, drawMedia, drawText, drawWhole, easeInOut, kenBurnsUv, showsWhole, titleOpacity, rng } from '../draw'
import type { FontRole } from '../media'
import type { Box } from '../draw'

export function drawCenteredText(
  ctx: Ctx,
  s: SlideState,
  font: FontRole,
  color: string,
  opts: { opacity?: number; uppercase?: boolean; tracking?: number; shadow?: boolean; scale?: number; dy?: number; dx?: number } = {}
): void {
  const { W, H } = ctx
  const title = s.slide.title
  if (!title) return
  const k = opts.scale ?? 1
  const size = H * 0.075 * k
  const y = H * 0.5 + (opts.dy ?? 0)
  const x = W / 2 + (opts.dx ?? 0)
  const main = drawText(
    ctx,
    { text: title.text, font, size, color, uppercase: opts.uppercase, tracking: opts.tracking, maxWidth: W * 0.8, shadow: opts.shadow },
    x,
    y,
    { opacity: opts.opacity ?? 1 }
  )
  if (title.subtitle && main) {
    drawText(
      ctx,
      { text: title.subtitle, font: font === 'display' ? 'sans' : font, size: size * 0.42, color, tracking: 0.04, shadow: opts.shadow },
      x,
      main.y + main.h + size * 0.25,
      { opacity: (opts.opacity ?? 1) * 0.8 }
    )
  }
}

function fullFrameMedia(ctx: Ctx, s: SlideState, extra: { zoom?: number; dx?: number; dy?: number } = {}): void {
  const box = { x: extra.dx ?? 0, y: extra.dy ?? 0, w: ctx.W, h: ctx.H }
  drawCell(ctx, s, 0, box, { zoom: extra.zoom }, 'blur', 0.08)
}

const fullBox = (W: number, H: number): Box[] => [{ x: 0, y: 0, w: W, h: H }]

export const classic: Theme = {
  mode: 'composite',
  clear: [0, 0, 0],
  boxes: (W, H, _sl, st) => (st.scaleToFill ? fullBox(W, H) : []),
  drawSlide(ctx, s) {
    const sl = s.slide
    if (sl.kind === 'title' || sl.kind === 'text') {
      drawCenteredText(ctx, s, 'sans', '#ffffff', { scale: 0.9 })
      return
    }
    fullFrameMedia(ctx, s)
    if (sl.titleOverlay) drawCenteredText(ctx, s, 'sans', '#ffffff', { opacity: titleOpacity(s.local), shadow: true })
  },
  transition(ctx) {
    return { kind: ctx.settings.transition.type, dir: dirVector(ctx.settings.transition.direction) }
  }
}

export const kenburns: Theme = {
  mode: 'composite',
  clear: [0, 0, 0],
  drawSlide(ctx, s) {
    const { W, H } = ctx
    const sl = s.slide
    if (sl.kind === 'title' || sl.kind === 'text') {
      drawCenteredText(ctx, s, 'light', '#ffffff', { scale: 1.05, tracking: 0.02 })
      return
    }
    if (sl.kind === 'photos' && !(sl.live && s.local < sl.live.duration)) {
      const m = sl.media[0]
      const tex = ctx.image(m)
      const a = aspectOf(m, tex)
      const box = { x: 0, y: 0, w: W, h: H }
      // whole picture: a gentle zoom of the fitted photo instead of a pan across a crop
      if (tex && showsWhole(sl.entries[0], ctx.settings, a, W / H)) drawWhole(ctx, tex, a, box, {}, 'blur', 1 + 0.06 * easeInOut(s.p))
      else drawMedia(ctx, tex, a, box, { uv: kenBurnsUv(sl.entries[0] as PhotoEntry, m, W / H, s.p) })
    } else fullFrameMedia(ctx, s)
    if (sl.titleOverlay) drawCenteredText(ctx, s, 'light', '#ffffff', { opacity: titleOpacity(s.local), shadow: true, scale: 1.1 })
  },
  transition() {
    return { kind: 'dissolve', dir: [1, 0] }
  }
}

export const retro: Theme = {
  mode: 'composite',
  clear: [0.02, 0.02, 0.015],
  boxes: (W, H) => fullBox(W, H),
  drawSlide(ctx, s) {
    const { H } = ctx
    // gate weave: a small jitter that changes 18 times per second
    const step = Math.floor(ctx.t * 18)
    const r = rng(`weave${step}`)
    const dx = (r() - 0.5) * H * 0.004
    const dy = (r() - 0.5) * H * 0.006
    const sl = s.slide
    if (sl.kind === 'title' || sl.kind === 'text') {
      drawCenteredText(ctx, s, 'type', '#f3e9d2', { dx, dy, scale: 0.95 })
      return
    }
    // constant slight zoom (room for the weave): a drifting zoom made the two pictures in a
    // burn transition differ in size
    fullFrameMedia(ctx, s, { zoom: 1.04, dx, dy })
    if (sl.titleOverlay) drawCenteredText(ctx, s, 'type', '#f3e9d2', { opacity: titleOpacity(s.local), shadow: true, dx, dy })
  },
  transition() {
    return { kind: 'burn', dir: [1, 0] }
  },
  post(ctx) {
    return { grain: 0.09, vignette: 0.6, flicker: 0.07, sepia: 0.18, time: Math.floor(ctx.t * 24) / 24 }
  }
}
