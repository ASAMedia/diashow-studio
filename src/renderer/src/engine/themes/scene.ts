// Themes that animate the elements of both slides themselves (no full-frame blend):
// Origami, Reflections, Sliding Panels, Vintage Prints and Magazine.
import type { Compositor, Tex, UvRect } from '../gl'
import type { Ctx, Theme } from '../types'
import type { TimelineSlide } from '@shared/timeline'
import {
  aspectOf, clamp01, containBox, drawCell, drawMedia, drawText, drawTextBlock, dropFall, easeIn, easeInOut, easeOut, lerp, panoPrintUv, panoShape, panProgress, rng,
  slideTexture, textPosition, slotBoxes, smooth, titleOpacity, type Box
} from '../draw'
import { drawCenteredText } from './simple'

const stagger = (p: number, i: number, n: number, step = 0.12): number => {
  const span = 1 - step * (n - 1)
  return clamp01((p - i * step) / Math.max(0.2, span))
}

// ---------------------------------------------------------------- Origami

export const origami: Theme = {
  mode: 'scene',
  clear: [0.05, 0.05, 0.055],
  boxes: (W, H, sl) => slotBoxes(sl, { x: 0, y: 0, w: W, h: H }, Math.max(2, H * 0.008)),
  drawSlide(ctx, s) {
    const { W, H } = ctx
    const sl = s.slide
    // every slide folds in the same way, from the left edge
    const vertical = false
    const fromEnd = false
    const fold = (q: number, draw: (o: { rotX?: number; rotY?: number; pivot: [number, number]; shade: number; opacity: number }) => void): void => {
      if (q <= 0.001) return
      const e = easeInOut(q)
      // the flap swings up from behind the picture plane: swinging towards the camera it passed
      // outside the view for the first half and then appeared all at once. Standing upright it is a
      // wall in perspective, so it fades in over the first moment instead of appearing in one frame
      const a = (1 - e) * (Math.PI / 2) * (fromEnd ? -1 : 1)
      const pivot: [number, number] = vertical ? [0.5, fromEnd ? 1 : 0] : [fromEnd ? 1 : 0, 0.5]
      draw({ ...(vertical ? { rotX: -a } : { rotY: a }), pivot, shade: 0.6 * (1 - e), opacity: smooth(q / 0.15) })
    }
    // the old picture shows through the gaps between the new cells; it darkens towards the end so
    // the gaps don't flash from picture to background when the old slide is gone
    if (s.inP < 1 && s.slide.index > 0) ctx.c.quad({ x: 0, y: 0, w: W, h: H, color: [...origami.clear, 1] as [number, number, number, number], opacity: smooth((s.inP - 0.55) / 0.45) })
    if (sl.kind === 'title' || sl.kind === 'text') {
      const box = { x: 0, y: 0, w: W, h: H }
      fold(s.inP, (o) => ctx.c.quad({ ...box, ...o, color: [0.08, 0.08, 0.085, 1] }))
      if (s.inP > 0.6) drawCenteredText(ctx, s, 'sans', '#ffffff', { opacity: smooth((s.inP - 0.6) / 0.4) })
      return
    }
    const boxes = slotBoxes(sl, { x: 0, y: 0, w: W, h: H }, Math.max(2, H * 0.008))
    // a panning panorama moves on its own: no slow zoom on top
    const zoom = sl.pano?.mode === 'pan' ? undefined : lerp(1.06, 1, s.p)
    boxes.forEach((box, i) => {
      const q = stagger(s.inP, i, boxes.length)
      fold(q, (o) => drawCell(ctx, s, i, box, { ...o, zoom }))
    })
    if (sl.titleOverlay) drawCenteredText(ctx, s, 'sans', '#ffffff', { opacity: titleOpacity(s.local), shadow: true, overlay: true })
  }
}

// ---------------------------------------------------------------- Reflections

const stageCache = new WeakMap<Compositor, { tex: Tex; w: number; h: number }>()

function stage(c: Compositor, W: number, H: number): Tex {
  const hit = stageCache.get(c)
  if (hit && hit.w === W && hit.h === H) return hit.tex
  const cv = document.createElement('canvas')
  cv.width = Math.max(2, Math.round(W / 4))
  cv.height = Math.max(2, Math.round(H / 4))
  const g = cv.getContext('2d')!
  const grad = g.createRadialGradient(cv.width / 2, cv.height * 0.45, 0, cv.width / 2, cv.height * 0.45, cv.width * 0.75)
  grad.addColorStop(0, '#fbfbfa')
  grad.addColorStop(0.55, '#e4e4e1')
  grad.addColorStop(1, '#a9a9a5')
  g.fillStyle = grad
  g.fillRect(0, 0, cv.width, cv.height)
  const floor = g.createLinearGradient(0, cv.height * 0.66, 0, cv.height)
  floor.addColorStop(0, 'rgba(0,0,0,0)')
  floor.addColorStop(1, 'rgba(0,0,0,0.12)')
  g.fillStyle = floor
  g.fillRect(0, cv.height * 0.66, cv.width, cv.height)
  if (hit) c.deleteTexture(hit.tex)
  const tex = c.upload(cv, cv.width, cv.height, false)
  stageCache.set(c, { tex, w: W, h: H })
  return tex
}

export const reflections: Theme = {
  mode: 'scene',
  clear: [0.88, 0.88, 0.87],
  background(ctx) {
    ctx.c.quad({ tex: stage(ctx.c, ctx.W, ctx.H), x: 0, y: 0, w: ctx.W, h: ctx.H })
  },
  drawSlide(ctx, s) {
    const { W, H } = ctx
    const sl = s.slide
    const base = H * 0.68
    if (sl.kind === 'title' || sl.kind === 'text') {
      // the old text leaves in the first half, the new one comes in the second, so two texts never
      // slide through each other in the middle
      const qi = clamp01((s.inP - 0.45) / 0.55)
      const qo = clamp01(s.outP / 0.55)
      const o = smooth(qi) * (1 - smooth(qo))
      const dx = (1 - easeOut(qi)) * W * 0.3 - easeIn(qo) * W * 0.3
      const spec = { text: sl.title?.text ?? '', font: 'light' as const, size: H * 0.1, color: '#4a4a48', maxWidth: W * 0.8 }
      const box = drawText(ctx, spec, W / 2 + dx, base - H * 0.08, { opacity: o })
      if (box) drawText(ctx, spec, W / 2 + dx, box.y + box.h * 1.5, { opacity: o, flipY: true, fade: [0.28, 0] })
      if (sl.title?.subtitle) drawText(ctx, { text: sl.title.subtitle, font: 'sans', size: H * 0.032, color: '#6d6d6a', weight: 500 }, W / 2 + dx, base - H * 0.2, { opacity: o * 0.9 })
      return
    }
    const n = sl.media.length
    let cardH = H * (n === 1 ? 0.5 : n === 2 ? 0.42 : 0.34)
    const gap = H * 0.05
    let widths = sl.media.map((m, i) => cardH * Math.min(1.8, Math.max(0.6, aspectOf(m, slideTexture(ctx, s, i)))))
    // a panorama stands as one card across the stage (a tall one up to the top), with its reflection,
    // and pans inside it once the card has come in; it doesn't drift as well
    const pano = sl.pano
    let uvOf: (tex: Tex | null, a: number) => UvRect | undefined = () => undefined
    if (pano) {
      const a = aspectOf(sl.media[0], slideTexture(ctx, s, 0))
      const area = pano.axis === 'x' ? { x: 0, y: 0, w: W * 0.92, h: Math.min(H * 0.5, W * 0.46) } : { x: 0, y: 0, w: W * 0.6, h: H * 0.62 }
      const card = containBox(panoShape(sl, a, area), area)
      cardH = card.h
      widths = [card.w]
      const q = panProgress(s, sl.transIn, sl.duration - sl.transOut)
      uvOf = (tex, aa) => panoPrintUv(sl, sl.media[0], tex, aa, card.w / card.h, q)
    }
    const total = widths.reduce((a, b) => a + b, 0) + gap * (n - 1)
    let x = (W - total) / 2 + (pano?.mode === 'pan' ? 0 : lerp(W * 0.03, -W * 0.03, s.p))
    sl.media.forEach((m, i) => {
      const w = widths[i]
      const qi = easeOut(stagger(s.inP, i, n, 0.15))
      const qo = easeIn(stagger(s.outP, i, n, 0.1))
      const tilt = n === 1 ? (pano ? 0.08 : 0.22) * (sl.index % 2 ? -1 : 1) : lerp(0.38, -0.38, i / (n - 1))
      const rotY = tilt - (1 - qi) * 0.9 + qo * 0.9
      const dx = (1 - qi) * W * 0.85 - qo * W * 0.85
      // cards are solid soon after they appear and only fade once they are almost gone
      const opacity = smooth(qi * 3) * (1 - smooth((qo - 0.6) / 0.4))
      if (opacity <= 0.001) {
        x += w + gap
        return
      }
      const tex = slideTexture(ctx, s, i)
      const box = { x: x + dx, y: base - cardH, w, h: cardH }
      const uv = uvOf(tex, aspectOf(m, tex))
      drawMedia(ctx, tex, aspectOf(m, tex), box, { rotY, opacity, uv })
      drawMedia(ctx, tex, aspectOf(m, tex), { ...box, y: base + H * 0.004 }, { rotY, opacity, flipY: true, fade: [0.32, 0], uv })
      x += w + gap
    })
    if (sl.titleOverlay) {
      drawText(ctx, { text: sl.title?.text ?? '', font: 'light', size: H * 0.07, color: '#4a4a48' }, W / 2, H * 0.12, { opacity: titleOpacity(s.local) })
    }
  }
}

// ---------------------------------------------------------------- Sliding Panels

export const panels: Theme = {
  mode: 'scene',
  clear: [0, 0, 0],
  boxes: (W, H, sl) => slotBoxes(sl, { x: 0, y: 0, w: W, h: H }, Math.max(2, H * 0.006)),
  drawSlide(ctx, s) {
    const { W, H } = ctx
    const sl = s.slide
    const out = easeInOut(s.outP) * W
    if (sl.kind === 'title' || sl.kind === 'text') {
      const dx = (1 - easeInOut(s.inP)) * W - out
      ctx.c.quad({ x: dx, y: 0, w: W, h: H, color: [0.06, 0.06, 0.06, 1] })
      drawCenteredText(ctx, s, 'sans', '#ffffff', { dx })
      return
    }
    const boxes = slotBoxes(sl, { x: 0, y: 0, w: W, h: H }, Math.max(2, H * 0.006))
    boxes.forEach((box, i) => {
      const q = easeInOut(stagger(s.inP, i, boxes.length, 0.14))
      const dx = (1 - q) * W - out
      // a panning panorama moves on its own: no drifting zoom on top
      const drift = sl.pano?.mode === 'pan' ? undefined : i % 2 ? lerp(1.0, 1.07, s.p) : lerp(1.07, 1.0, s.p)
      drawCell(ctx, s, i, { ...box, x: box.x + dx }, { zoom: drift })
    })
    if (sl.titleOverlay && sl.title && textPosition(ctx) !== 'theme') {
      const specs = [{ text: sl.title.text, font: 'sans' as const, size: H * 0.085, weight: 700, color: '#ffffff', shadow: true }]
      if (sl.title.subtitle) specs.push({ text: sl.title.subtitle, font: 'sans' as const, size: H * 0.032, weight: 500, color: '#ffffff', shadow: true })
      drawTextBlock(ctx, specs, textPosition(ctx) as 'center', { x: 0, y: 0, w: W, h: H }, titleOpacity(s.local))
    } else if (sl.titleOverlay && sl.title) {
      const o = titleOpacity(s.local)
      const slide = (1 - easeOut(s.local / 0.9)) * W * 0.15
      const t = drawText(ctx, { text: sl.title.text, font: 'sans', size: H * 0.085, weight: 700, color: '#ffffff', shadow: true, align: 'left' }, H * 0.06 - slide, H * 0.82, { opacity: o, anchor: 'left' })
      if (t && sl.title.subtitle) {
        drawText(ctx, { text: sl.title.subtitle, font: 'sans', size: H * 0.032, weight: 500, color: '#ffffff', shadow: true, align: 'left' }, H * 0.07 - slide, t.y - H * 0.01, { opacity: o * 0.9, anchor: 'left' })
      }
    }
  }
}

// ---------------------------------------------------------------- Vintage Prints

interface PrintGeo {
  cx: number
  cy: number
  w: number
  h: number
  rot: number
  /** Shape of the picture on the print (a panorama's window, else the picture's own shape). */
  shape: number
}

/**
 * Where a slide's print lies on the table: a little off centre and turned, the same every time. A
 * panorama is a big wide (tall) print, closer to the centre and straighter, that its picture pans in.
 */
function printGeo(ctx: Ctx, sl: TimelineSlide, aspect: number): PrintGeo {
  const { W, H } = ctx
  const r = rng(`print${sl.id}`)
  const pano = sl.pano
  const area = !pano ? { x: 0, y: 0, w: W * 0.6, h: H * 0.7 } : pano.axis === 'x' ? { x: 0, y: 0, w: W * 0.84, h: H * 0.66 } : { x: 0, y: 0, w: W * 0.6, h: H * 0.82 }
  const shape = panoShape(sl, aspect, area)
  const inner = containBox(shape, area)
  const border = Math.min(inner.w, inner.h) * 0.045
  const k = pano ? 0.4 : 1
  return {
    cx: W / 2 + (r() - 0.5) * W * 0.09 * k,
    cy: H / 2 + (r() - 0.5) * H * 0.06 * k,
    w: inner.w + border * 2,
    h: inner.h + border * 2,
    rot: (r() - 0.5) * 0.16 * k,
    shape
  }
}

function drawPrint(
  ctx: Ctx,
  g: PrintGeo,
  tex: Tex | null,
  aspect: number,
  o: { scale: number; blur: number; shade: number; rot?: number; dx?: number; dy?: number; lift?: number; opacity?: number; shadow?: number; uv?: UvRect }
): void {
  const { H } = ctx
  const w = g.w * o.scale
  const h = g.h * o.scale
  const x = g.cx - w / 2 + (o.dx ?? 0)
  const y = g.cy - h / 2 + (o.dy ?? 0)
  const rot = o.rot ?? g.rot
  const opacity = o.opacity ?? 1
  // the higher above the table, the further away, softer and fainter the shadow
  const lift = o.lift ?? 0
  ctx.c.shadow({
    x: x + H * (0.01 + 0.05 * lift),
    y: y + H * (0.016 + 0.07 * lift),
    w,
    h,
    blur: H * 0.03 * (1 + 2.5 * lift),
    opacity: 0.55 * (1 - 0.6 * lift) * (1 - o.shade) * opacity * (o.shadow ?? 1),
    rotZ: rot
  })
  ctx.c.quad({ x, y, w, h, rotZ: rot, color: [0.95, 0.94, 0.9, 1], opacity, shade: o.shade })
  const b = Math.min(w, h) * 0.045 / 1.09
  const inner = { x: x + b, y: y + b, w: w - 2 * b, h: h - 2 * b }
  drawMedia(ctx, tex, aspect, inner, { rotZ: rot, pivot: [0.5, 0.5], opacity, blur: o.blur, shade: o.shade, uv: o.uv })
}

/**
 * A print under `depth` newer ones (continuous: 0 on top, 1 right below it): it stays where it
 * landed and only gets darker, softer and a little smaller with depth (further from the camera), so
 * the pile never jumps. The sixth one fades into the table.
 */
function pileLook(depth: number): { scale: number; blur: number; shade: number; opacity: number } {
  return {
    scale: 1 - 0.012 * depth,
    blur: depth <= 1 ? 3 * depth : 3 + 0.4 * (depth - 1),
    shade: depth <= 1 ? 0.38 * depth : Math.min(0.92, 0.38 + 0.12 * (depth - 1)),
    opacity: clamp01(6 - depth)
  }
}

/** How far the top print has sunk into the pile while the next one falls: it darkens as it gets covered. */
const sink = (p: number): number => smooth(clamp01((p - 0.3) / 0.7))

export const vintage: Theme = {
  mode: 'scene',
  clear: [0.09, 0.08, 0.07],
  background(ctx, states) {
    const newest = states.length ? states[states.length - 1] : null
    const anchor = newest ? newest.slide.index : 0
    // one more print lands on the pile while the newest slide comes in
    const landing = newest ? sink(newest.inP) : 1
    const active = new Set(states.map((s) => s.slide.index))
    for (let age = 6; age >= 1; age--) {
      const sl = ctx.tl.slides[anchor - age]
      if (!sl || active.has(sl.index) || sl.media.length === 0) continue
      const look = pileLook(age - 1 + landing)
      if (look.opacity <= 0.001) continue
      const m = sl.media[0]
      const tex = ctx.image(m)
      const a = aspectOf(m, tex)
      const g = printGeo(ctx, sl, a)
      // a panorama lies on the pile as its pan ended
      drawPrint(ctx, g, tex, a, { ...look, uv: panoPrintUv(sl, m, tex, a, g.shape, 1) })
    }
  },
  drawSlide(ctx, s) {
    const sl = s.slide
    const { W, H } = ctx
    if (sl.kind === 'title' || sl.kind === 'text') {
      drawCenteredText(ctx, s, 'serif', '#f6f1e6', { opacity: smooth(s.inP) * (1 - smooth(s.outP)), uppercase: true, tracking: 0.12, shadow: true })
      return
    }
    const m = sl.media[0]
    const tex = slideTexture(ctx, s, 0)
    const a = aspectOf(m, tex)
    const g = printGeo(ctx, sl, a)
    // from just above the picture's top edge (lifted, so 1.25× its size), a little to one side and
    // turned, onto the pile
    const r = rng(`drop${sl.id}`)
    const dx0 = (r() - 0.5) * W * 0.5
    const rot0 = (r() < 0.5 ? -1 : 1) * (0.18 + r() * 0.14)
    // half the height of the turned, lifted print: it starts just outside the top edge
    const half = 1.25 * ((g.h / 2) * Math.abs(Math.cos(g.rot + rot0)) + (g.w / 2) * Math.abs(Math.sin(g.rot + rot0)))
    const from = { dx: dx0, dy: -(g.cy + half + H * 0.01), rot: rot0 }
    // the incoming print falls onto the pile
    const { lift, travel } = dropFall(s.inP)
    // the camera drifts a little closer while the print lies on top
    const drift = lerp(1, 1.025, s.p)
    // once the next print falls, this one becomes the top of the pile
    const sunk = sink(s.outP)
    const pile = pileLook(sunk)
    drawPrint(ctx, g, tex, a, {
      scale: lerp(drift * (1 + 0.25 * lift), pile.scale, sunk),
      blur: pile.blur,
      shade: pile.shade,
      rot: g.rot + from.rot * travel,
      dx: from.dx * travel,
      dy: from.dy * travel,
      lift,
      // the soft shadow of the print in the air would otherwise be on screen before the print
      shadow: smooth(s.inP / 0.2),
      // a panorama pans while it lies on top, between its landing and the next print's fall
      uv: panoPrintUv(sl, m, tex, a, g.shape, panProgress(s, sl.transIn, sl.duration - sl.transOut))
    })
    if (sl.titleOverlay) drawCenteredText(ctx, s, 'serif', '#f6f1e6', { opacity: titleOpacity(s.local), uppercase: true, tracking: 0.12, shadow: true, overlay: true })
  },
  post() {
    return { vignette: 0.35 }
  }
}

// ---------------------------------------------------------------- Magazine

// Measured from a Photos export: background #EDF2EE, margin and gutter about 2.1 % of the height.
const PAPER: [number, number, number] = [237 / 255, 242 / 255, 238 / 255]
const magazineBoxes = (W: number, H: number, sl: TimelineSlide): Box[] => {
  const m = Math.round(H * 0.021)
  return slotBoxes(sl, { x: m, y: m, w: W - 2 * m, h: H - 2 * m }, m)
}

/** White text block at the bottom right of a cell, like Photos' Magazine captions. */
function cornerText(ctx: Ctx, box: Box, lines: string, font: 'caption' | 'rounded', size: number, opacity: number): Box | null {
  if (!lines.trim() || opacity <= 0.001) return null
  const pad = ctx.H * 0.028
  const spec = { text: lines, font, size, weight: font === 'rounded' ? 800 : 600, color: '#ffffff', uppercase: true, align: 'right' as const, shadow: true, maxWidth: box.w * 0.7, lineHeight: 1.08 }
  const tex = ctx.text(spec)
  if (!tex) return null
  const r = { x: box.x + box.w - pad - tex.w, y: box.y + box.h - pad - tex.h, w: tex.w, h: tex.h }
  ctx.c.quad({ tex, ...r, opacity })
  return r
}

export const magazine: Theme = {
  mode: 'scene',
  clear: PAPER,
  ownCaption: true,
  boxes: (W, H, sl) => magazineBoxes(W, H, sl),
  drawSlide(ctx, s) {
    const { W, H } = ctx
    const sl = s.slide
    // the old slide fades out quickly while the new cells fade in one after another
    // Timings in seconds for the standard 1.2 s transition, so every slide change has the same
    // rhythm whatever the number of cells; scaled down only when a transition had to be shorter.
    const kIn = sl.transIn > 0 ? sl.transIn / 1.2 : 1
    const kOut = sl.transOut > 0 ? sl.transOut / 1.2 : 1
    const fadeOut = sl.transOut > 0 ? 1 - smooth((s.local - (sl.duration - sl.transOut)) / (0.36 * kOut)) : 1
    if (sl.kind === 'title' || sl.kind === 'text') {
      const o = smooth(s.inP) * fadeOut
      const t = drawText(ctx, { text: sl.title?.text ?? '', font: 'rounded', size: H * 0.09, weight: 800, color: '#2b2e2c', uppercase: true, maxWidth: W * 0.8 }, W / 2, H * 0.47, { opacity: o })
      if (t && sl.title?.subtitle) drawText(ctx, { text: sl.title.subtitle, font: 'caption', size: H * 0.04, weight: 500, color: '#5d625e', uppercase: true, tracking: 0.04, maxWidth: W * 0.8 }, W / 2, t.y + t.h + H * 0.03, { opacity: o })
      return
    }
    const boxes = magazineBoxes(W, H, sl)
    boxes.forEach((box, i) => {
      const q = sl.transIn > 0 ? smooth((s.local - (0.06 + i * 0.15) * kIn) / (0.33 * kIn)) : 1
      const opacity = q * fadeOut
      if (opacity <= 0.001) return
      // whole pictures sit on the paper, as in a printed magazine
      drawCell(ctx, s, i, box, { opacity }, 'none')
    })
    // texts sit on the largest cell, bottom right
    const main = boxes.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a), boxes[0])
    const textOpacity = (sl.transIn > 0 ? smooth((s.local - 0.36 * kIn) / (0.48 * kIn)) : 1) * fadeOut
    let bottom = main
    const pos = textPosition(ctx)
    if (pos !== 'theme') {
      // one block with title and caption at the chosen position in the main cell
      const specs = []
      if (sl.titleOverlay && sl.title) specs.push({ text: sl.title.text, font: 'rounded' as const, size: H * 0.072, weight: 800, color: '#ffffff', uppercase: true, shadow: true, lineHeight: 1.08 })
      if (sl.caption) for (const line of [sl.caption.text, sl.caption.subtitle].filter(Boolean)) specs.push({ text: line!, font: 'caption' as const, size: H * 0.046, weight: 600, color: '#ffffff', uppercase: true, shadow: true, lineHeight: 1.08 })
      drawTextBlock(ctx, specs, pos, main, textOpacity)
      return
    }
    if (sl.titleOverlay && sl.title) {
      const t = cornerText(ctx, main, sl.title.text, 'rounded', H * 0.072, textOpacity)
      if (t) bottom = { ...main, h: t.y - main.y + H * 0.028 - H * 0.012 }
    }
    if (sl.caption) {
      const lines = [sl.caption.text, sl.caption.subtitle].filter(Boolean).join('\n')
      cornerText(ctx, bottom, lines, 'caption', H * 0.046, textOpacity)
    }
  }
}
