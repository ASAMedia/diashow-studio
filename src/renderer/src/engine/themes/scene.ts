// Themes that animate the elements of both slides themselves (no full-frame blend):
// Origami, Reflections, Sliding Panels, Vintage Prints and Magazine.
import type { Compositor, Tex } from '../gl'
import type { Ctx, Theme } from '../types'
import type { TimelineSlide } from '@shared/timeline'
import {
  aspectOf, clamp01, containBox, drawFitted, drawMedia, drawText, easeIn, easeInOut, easeOut, lerp, photoUv, rng, slideTexture,
  slotBoxes, smooth, titleOpacity, type Box
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
    const vertical = sl.index % 2 === 1
    const fromEnd = sl.index % 4 >= 2
    const fold = (q: number, draw: (o: { rotX?: number; rotY?: number; pivot: [number, number]; shade: number }) => void): void => {
      if (q <= 0.001) return
      const e = easeInOut(q)
      const a = (1 - e) * (Math.PI / 2) * (fromEnd ? 1 : -1)
      const pivot: [number, number] = vertical ? [0.5, fromEnd ? 1 : 0] : [fromEnd ? 1 : 0, 0.5]
      draw({ ...(vertical ? { rotX: -a } : { rotY: a }), pivot, shade: 0.6 * (1 - e) })
    }
    if (sl.kind === 'title' || sl.kind === 'text') {
      const box = { x: 0, y: 0, w: W, h: H }
      fold(s.inP, (o) => ctx.c.quad({ ...box, ...o, color: [0.08, 0.08, 0.085, 1] }))
      if (s.inP > 0.6) drawCenteredText(ctx, s, 'sans', '#ffffff', { opacity: smooth((s.inP - 0.6) / 0.4) })
      return
    }
    const boxes = slotBoxes(sl, { x: 0, y: 0, w: W, h: H }, Math.max(2, H * 0.008))
    boxes.forEach((box, i) => {
      const q = stagger(s.inP, i, boxes.length)
      const tex = slideTexture(ctx, s, i)
      const a = aspectOf(sl.media[i], tex)
      if (sl.kind === 'video') fold(q, (o) => drawFitted(ctx, tex, a, box, { ...o, zoom: lerp(1.06, 1, s.p) }))
      else fold(q, (o) => drawMedia(ctx, tex, a, box, { ...o, uv: photoUv(sl.entries[i], sl.media[i], box.w / box.h, tex), zoom: lerp(1.06, 1, s.p) }))
    })
    if (sl.titleOverlay) drawCenteredText(ctx, s, 'sans', '#ffffff', { opacity: titleOpacity(s.local), shadow: true })
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
      const o = smooth(s.inP) * (1 - smooth(s.outP))
      const dx = (1 - easeOut(s.inP)) * W * 0.3 - easeIn(s.outP) * W * 0.3
      const spec = { text: sl.title?.text ?? '', font: 'light' as const, size: H * 0.1, color: '#4a4a48', maxWidth: W * 0.8 }
      const box = drawText(ctx, spec, W / 2 + dx, base - H * 0.08, { opacity: o })
      if (box) drawText(ctx, spec, W / 2 + dx, box.y + box.h * 1.5, { opacity: o, flipY: true, fade: [0.28, 0] })
      if (sl.title?.subtitle) drawText(ctx, { text: sl.title.subtitle, font: 'sans', size: H * 0.032, color: '#6d6d6a', weight: 500 }, W / 2 + dx, base - H * 0.2, { opacity: o * 0.9 })
      return
    }
    const n = sl.media.length
    const cardH = H * (n === 1 ? 0.5 : n === 2 ? 0.42 : 0.34)
    const gap = H * 0.05
    const widths = sl.media.map((m, i) => cardH * Math.min(1.8, Math.max(0.6, aspectOf(m, slideTexture(ctx, s, i)))))
    const total = widths.reduce((a, b) => a + b, 0) + gap * (n - 1)
    let x = (W - total) / 2 + lerp(W * 0.03, -W * 0.03, s.p)
    sl.media.forEach((m, i) => {
      const w = widths[i]
      const qi = easeOut(stagger(s.inP, i, n, 0.15))
      const qo = easeIn(stagger(s.outP, i, n, 0.1))
      const tilt = n === 1 ? 0.22 * (sl.index % 2 ? -1 : 1) : lerp(0.38, -0.38, i / (n - 1))
      const rotY = tilt - (1 - qi) * 0.9 + qo * 0.9
      const dx = (1 - qi) * W * 0.85 - qo * W * 0.85
      const opacity = qi * (1 - qo)
      if (opacity <= 0.001) {
        x += w + gap
        return
      }
      const tex = slideTexture(ctx, s, i)
      const box = { x: x + dx, y: base - cardH, w, h: cardH }
      drawMedia(ctx, tex, aspectOf(m, tex), box, { rotY, opacity })
      drawMedia(ctx, tex, aspectOf(m, tex), { ...box, y: base + H * 0.004 }, { rotY, opacity, flipY: true, fade: [0.32, 0] })
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
      const tex = slideTexture(ctx, s, i)
      const drift = i % 2 ? lerp(1.0, 1.07, s.p) : lerp(1.07, 1.0, s.p)
      const moved = { ...box, x: box.x + dx }
      const a = aspectOf(sl.media[i], tex)
      if (sl.kind === 'video') drawFitted(ctx, tex, a, moved, { zoom: drift })
      else drawMedia(ctx, tex, a, moved, { uv: photoUv(sl.entries[i], sl.media[i], box.w / box.h, tex), zoom: drift })
    })
    if (sl.titleOverlay && sl.title) {
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
}

function printGeo(ctx: Ctx, sl: TimelineSlide, aspect: number): PrintGeo {
  const { W, H } = ctx
  const r = rng(`print${sl.id}`)
  const inner = containBox(aspect, { x: 0, y: 0, w: W * 0.6, h: H * 0.7 })
  const border = Math.min(inner.w, inner.h) * 0.045
  return {
    cx: W / 2 + (r() - 0.5) * W * 0.07,
    cy: H / 2 + (r() - 0.5) * H * 0.05,
    w: inner.w + border * 2,
    h: inner.h + border * 2,
    rot: (r() - 0.5) * 0.13
  }
}

function drawPrint(
  ctx: Ctx,
  g: PrintGeo,
  tex: Tex | null,
  aspect: number,
  o: { scale: number; opacity: number; blur: number; shade: number; rot?: number; dx?: number; dy?: number }
): void {
  const w = g.w * o.scale
  const h = g.h * o.scale
  const x = g.cx - w / 2 + (o.dx ?? 0)
  const y = g.cy - h / 2 + (o.dy ?? 0)
  const rot = o.rot ?? g.rot
  if (o.blur < 1) ctx.c.shadow({ x: x + ctx.H * 0.01, y: y + ctx.H * 0.016, w, h, blur: ctx.H * 0.03, opacity: 0.55 * o.opacity, rotZ: rot })
  ctx.c.quad({ x, y, w, h, rotZ: rot, color: [0.95, 0.94, 0.9, 1], opacity: o.opacity, shade: o.shade })
  const b = Math.min(w, h) * 0.045 / 1.09
  const inner = { x: x + b, y: y + b, w: w - 2 * b, h: h - 2 * b }
  drawMedia(ctx, tex, aspect, inner, { rotZ: rot, pivot: [0.5, 0.5], opacity: o.opacity, blur: o.blur, shade: o.shade })
}

const PILE = { scale: 1.3, blur: 3.6, shade: 0.5, opacity: 0.6 }

export const vintage: Theme = {
  mode: 'scene',
  clear: [0.09, 0.08, 0.07],
  background(ctx, states) {
    const anchor = states.length ? states[states.length - 1].slide.index : 0
    const active = new Set(states.map((s) => s.slide.index))
    for (let age = 6; age >= 1; age--) {
      const sl = ctx.tl.slides[anchor - age]
      if (!sl || active.has(sl.index) || sl.media.length === 0) continue
      const m = sl.media[0]
      const tex = ctx.image(m)
      const a = aspectOf(m, tex)
      const r = rng(`pile${sl.id}`)
      const g = printGeo(ctx, sl, a)
      const fadeAge = 1 - (age - 1) / 6
      drawPrint(ctx, g, tex, a, { ...PILE, opacity: PILE.opacity * fadeAge, dx: (r() - 0.5) * ctx.W * 0.25 * (age - 1) / 5, dy: (r() - 0.5) * ctx.H * 0.2 * (age - 1) / 5 })
    }
  },
  drawSlide(ctx, s) {
    const sl = s.slide
    const { H } = ctx
    if (sl.kind === 'title' || sl.kind === 'text') {
      drawCenteredText(ctx, s, 'serif', '#f6f1e6', { opacity: smooth(s.inP) * (1 - smooth(s.outP)), uppercase: true, tracking: 0.12, shadow: true })
      return
    }
    const m = sl.media[0]
    const tex = slideTexture(ctx, s, 0)
    const a = aspectOf(m, tex)
    const g = printGeo(ctx, sl, a)
    const qi = easeOut(s.inP)
    const qo = smooth(s.outP)
    const scale = lerp(1.32, 1, qi) * lerp(1, 1.035, s.p)
    drawPrint(ctx, g, tex, a, {
      scale: lerp(scale, PILE.scale, qo),
      opacity: lerp(smooth(s.inP * 1.6), PILE.opacity, qo),
      blur: PILE.blur * qo,
      shade: PILE.shade * qo,
      rot: g.rot + (1 - qi) * 0.06,
      dy: (1 - qi) * -H * 0.04
    })
    if (sl.titleOverlay) drawCenteredText(ctx, s, 'serif', '#f6f1e6', { opacity: titleOpacity(s.local), uppercase: true, tracking: 0.12, shadow: true })
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
    const fadeOut = 1 - smooth(s.outP / 0.3)
    if (sl.kind === 'title' || sl.kind === 'text') {
      const o = smooth(s.inP) * fadeOut
      const t = drawText(ctx, { text: sl.title?.text ?? '', font: 'rounded', size: H * 0.09, weight: 800, color: '#2b2e2c', uppercase: true, maxWidth: W * 0.8 }, W / 2, H * 0.47, { opacity: o })
      if (t && sl.title?.subtitle) drawText(ctx, { text: sl.title.subtitle, font: 'caption', size: H * 0.04, weight: 500, color: '#5d625e', uppercase: true, tracking: 0.04, maxWidth: W * 0.8 }, W / 2, t.y + t.h + H * 0.03, { opacity: o })
      return
    }
    const boxes = magazineBoxes(W, H, sl)
    const n = boxes.length
    const fade = 0.28
    const step = n > 1 ? Math.min(0.13, (0.95 - 0.05 - fade) / (n - 1)) : 0
    boxes.forEach((box, i) => {
      const q = smooth((s.inP - 0.05 - i * step) / fade)
      const opacity = q * fadeOut
      if (opacity <= 0.001) return
      const tex = slideTexture(ctx, s, i)
      const m = sl.media[i]
      if (sl.kind === 'video') drawFitted(ctx, tex, aspectOf(m, tex), box, { opacity })
      else drawMedia(ctx, tex, aspectOf(m, tex), box, { opacity, uv: photoUv(sl.entries[i], m, box.w / box.h, tex) })
    })
    // texts sit on the largest cell, bottom right
    const main = boxes.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a), boxes[0])
    const textOpacity = smooth((s.inP - 0.3) / 0.4) * fadeOut
    let bottom = main
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
