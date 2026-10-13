// Themes after iPhoto's older slideshow styles: Scrapbook, Snapshots (instant photos on a
// table) and Shatter (the picture breaks into shards).
import type { Compositor, Tex } from '../gl'
import type { Ctx, SlideState, Theme } from '../types'
import type { TimelineSlide } from '@shared/timeline'
import { localeTag } from '../../i18n'
import {
  aspectOf, clamp01, containBox, drawCell, drawMedia, drawText, dropFall, easeIn, easeOut, lerp, photoUv, rng, slideTexture, slotBoxes, smooth, titleOpacity, type Box
} from '../draw'
import { drawCenteredText } from './simple'

// ---------------------------------------------------------------- generated backgrounds

const textures = new WeakMap<Compositor, Map<string, { tex: Tex; w: number; h: number }>>()

function texture(c: Compositor, name: string, W: number, H: number, paint: (g: CanvasRenderingContext2D, w: number, h: number) => void): Tex {
  let m = textures.get(c)
  if (!m) textures.set(c, (m = new Map()))
  const hit = m.get(name)
  if (hit && hit.w === W && hit.h === H) return hit.tex
  const cv = document.createElement('canvas')
  cv.width = Math.max(2, Math.round(W / 2))
  cv.height = Math.max(2, Math.round(H / 2))
  paint(cv.getContext('2d')!, cv.width, cv.height)
  if (hit) c.deleteTexture(hit.tex)
  const tex = c.upload(cv, cv.width, cv.height, false)
  m.set(name, { tex, w: W, h: H })
  return tex
}

function kraftPaper(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = '#c4a173'
  g.fillRect(0, 0, w, h)
  const r = rng('kraft')
  for (let i = 0; i < (w * h) / 40; i++) {
    const v = r()
    g.fillStyle = v < 0.5 ? `rgba(90,60,30,${0.05 + r() * 0.08})` : `rgba(255,240,210,${0.04 + r() * 0.07})`
    g.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2)
  }
  g.strokeStyle = 'rgba(110,80,45,0.10)'
  for (let i = 0; i < 160; i++) {
    const x = r() * w
    const y = r() * h
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + (r() - 0.5) * 60, y + (r() - 0.5) * 12)
    g.stroke()
  }
  const v = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75)
  v.addColorStop(0, 'rgba(0,0,0,0)')
  v.addColorStop(1, 'rgba(60,35,10,0.35)')
  g.fillStyle = v
  g.fillRect(0, 0, w, h)
}

function woodTable(g: CanvasRenderingContext2D, w: number, h: number): void {
  const base = g.createLinearGradient(0, 0, w, h)
  base.addColorStop(0, '#4a2f1d')
  base.addColorStop(1, '#2e1c11')
  g.fillStyle = base
  g.fillRect(0, 0, w, h)
  const r = rng('wood')
  // planks with grain lines
  const plank = h / 5
  for (let p = 0; p < 6; p++) {
    g.fillStyle = `rgba(0,0,0,${0.12 + r() * 0.1})`
    g.fillRect(0, p * plank - 1, w, 2)
    for (let i = 0; i < 26; i++) {
      const y = p * plank + r() * plank
      g.strokeStyle = r() < 0.5 ? `rgba(20,10,4,${0.12 + r() * 0.12})` : `rgba(150,100,60,${0.06 + r() * 0.08})`
      g.lineWidth = 1 + r() * 1.5
      g.beginPath()
      g.moveTo(0, y)
      for (let x = 0; x <= w; x += 40) g.lineTo(x, y + Math.sin(x / (60 + r() * 80) + i) * (2 + r() * 3))
      g.stroke()
    }
  }
  const v = g.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.7)
  v.addColorStop(0, 'rgba(255,220,170,0.10)')
  v.addColorStop(1, 'rgba(0,0,0,0.45)')
  g.fillStyle = v
  g.fillRect(0, 0, w, h)
}

const PAPER: [number, number, number, number] = [0.97, 0.96, 0.93, 1]
const TAPE: [number, number, number, number] = [0.94, 0.9, 0.76, 0.72]

/**
 * A print with a white border, soft shadow and optional tape, rotated around its centre. `lift`
 * (0..1) holds it above the table: its shadow is further away and softer. `shade` darkens a print
 * lying under newer ones.
 */
function print(
  ctx: Ctx,
  tex: Tex | null,
  aspect: number,
  box: Box,
  rot: number,
  o: { opacity: number; border: number; bottom?: number; tape?: boolean; uv?: ReturnType<typeof photoUv>; lift?: number; shade?: number; shadow?: number }
): void {
  const { H } = ctx
  const b = o.border
  const bb = o.bottom ?? b
  const lift = o.lift ?? 0
  const shade = o.shade ?? 0
  const outer = { x: box.x - b, y: box.y - b, w: box.w + 2 * b, h: box.h + b + bb }
  ctx.c.shadow({
    x: outer.x + H * (0.008 + 0.05 * lift),
    y: outer.y + H * (0.014 + 0.07 * lift),
    w: outer.w,
    h: outer.h,
    blur: H * 0.022 * (1 + 2.5 * lift),
    opacity: 0.5 * o.opacity * (1 - 0.6 * lift) * (1 - shade) * (o.shadow ?? 1),
    rotZ: rot
  })
  ctx.c.quad({ ...outer, rotZ: rot, color: PAPER, opacity: o.opacity, shade })
  // the picture rotates around the print's centre, not its own
  const pivot: [number, number] = [(outer.x + outer.w / 2 - box.x) / box.w, (outer.y + outer.h / 2 - box.y) / box.h]
  drawMedia(ctx, tex, aspect, box, { rotZ: rot, pivot, opacity: o.opacity, shade, ...(o.uv ? { uv: o.uv } : { fit: 'cover' }) })
  if (o.tape) {
    const tw = Math.min(outer.w * 0.32, H * 0.12)
    const th = H * 0.032
    for (const side of [-1, 1]) {
      const cx = outer.x + outer.w / 2 + side * outer.w * 0.38
      const cy = outer.y + th * 0.2
      const pv: [number, number] = [(outer.x + outer.w / 2 - (cx - tw / 2)) / tw, (outer.y + outer.h / 2 - (cy - th / 2)) / th]
      ctx.c.quad({ x: cx - tw / 2, y: cy - th / 2, w: tw, h: th, color: TAPE, rotZ: rot, pivot: pv, opacity: o.opacity, shade })
      // the tape strip itself sits askew
      ctx.c.quad({ x: cx - tw / 2, y: cy - th / 2, w: tw, h: th, color: [1, 1, 1, 0.12], rotZ: rot + side * 0.6, opacity: o.opacity })
    }
  }
}

function captionLines(sl: TimelineSlide): string {
  const c = sl.caption ?? (sl.titleOverlay ? sl.title : undefined)
  return c ? [c.text, c.subtitle].filter(Boolean).join(' – ') : ''
}

// ---------------------------------------------------------------- Scrapbook

export const scrapbook: Theme = {
  mode: 'scene',
  clear: [0.77, 0.63, 0.45],
  ownCaption: true,
  background(ctx) {
    ctx.c.quad({ tex: texture(ctx.c, 'kraft', ctx.W, ctx.H, kraftPaper), x: 0, y: 0, w: ctx.W, h: ctx.H })
  },
  drawSlide(ctx, s) {
    const { W, H } = ctx
    const sl = s.slide
    // the old page is swept off to the left first, then the new prints drop onto the paper, so the
    // two don't pile up; paper never turns see-through
    const out = easeIn(Math.min(1, s.outP / 0.55))
    if (sl.kind === 'title' || sl.kind === 'text') {
      const o = smooth(s.inP) * (1 - smooth(Math.min(1, s.outP / 0.5)))
      const card = { x: W * 0.22, y: H * 0.3, w: W * 0.56, h: H * 0.4 }
      ctx.c.shadow({ x: card.x + H * 0.008, y: card.y + H * 0.014, w: card.w, h: card.h, blur: H * 0.022, opacity: 0.5 * o, rotZ: -0.02 })
      ctx.c.quad({ ...card, color: PAPER, rotZ: -0.02, opacity: o })
      const t = drawText(ctx, { text: sl.title?.text ?? '', font: 'hand', size: H * 0.11, weight: 700, color: '#3a2716', maxWidth: card.w * 0.9 }, W / 2, H * 0.47, { opacity: o, rotZ: -0.02 })
      if (t && sl.title?.subtitle) drawText(ctx, { text: sl.title.subtitle, font: 'hand', size: H * 0.05, color: '#5a4126', maxWidth: card.w * 0.9 }, W / 2, t.y + t.h + H * 0.01, { opacity: o, rotZ: -0.02 })
      return
    }
    const r = rng(`scrap${sl.id}`)
    const rd = rng(`scrapdrop${sl.id}`)
    const frame = { x: W * 0.07, y: H * 0.08, w: W * 0.86, h: H * 0.76 }
    const boxes = slotBoxes(sl, frame, H * 0.06)
    // far enough that the rightmost print has left the picture
    const sweep = -out * W * 1.15
    boxes.forEach((cell, i) => {
      const m = sl.media[i]
      const tex = slideTexture(ctx, s, i)
      const a = aspectOf(m, tex)
      const inner = containBox(a, { x: cell.x + cell.w * 0.06, y: cell.y + cell.h * 0.06, w: cell.w * 0.88, h: cell.h * 0.88 })
      const rot = (r() - 0.5) * 0.12
      // each print falls from above the top edge onto its place, one after another; the last one
      // lands exactly when the transition ends
      const step = Math.min(0.12, 0.35 / Math.max(1, boxes.length - 1))
      const q = clamp01((s.inP - 0.25 - i * step) / (0.75 - (boxes.length - 1) * step))
      const startDx = (rd() - 0.5) * W * 0.15
      const startRot = (rd() < 0.5 ? -1 : 1) * (0.12 + rd() * 0.12)
      if (q <= 0) return
      const { lift, travel } = dropFall(q)
      const scale = 1 + 0.15 * lift
      const w = inner.w * scale
      const h = inner.h * scale
      const startDy = -(inner.y + inner.h / 2 + h * 0.75 + H * 0.02)
      const box = { x: inner.x + (inner.w - w) / 2 + startDx * travel + sweep, y: inner.y + (inner.h - h) / 2 + startDy * travel, w, h }
      print(ctx, tex, a, box, rot + startRot * travel - out * 0.15, { opacity: 1, border: Math.min(w, h) * 0.04, tape: true, lift, shadow: smooth(q / 0.2) })
    })
    const text = captionLines(sl)
    if (text) {
      const o = smooth((s.inP - 0.6) / 0.35)
      drawText(ctx, { text, font: 'hand', size: H * 0.06, weight: 700, color: '#3a2716', maxWidth: W * 0.8 }, W / 2 + sweep, H * 0.92, { opacity: o, rotZ: -0.015 })
    }
  }
}

// ---------------------------------------------------------------- Snapshots

interface Pose {
  x: number
  y: number
  rot: number
  scale: number
}

function snapPoses(ctx: Ctx, sl: TimelineSlide): { center: Pose; pile: Pose; from: Pose } {
  const { W, H } = ctx
  const r = rng(`snap${sl.id}`)
  const side = Math.floor(r() * 4)
  const center = { x: W / 2 + (r() - 0.5) * W * 0.06, y: H * 0.47 + (r() - 0.5) * H * 0.05, rot: (r() - 0.5) * 0.14, scale: 1 }
  const angle = r() * Math.PI * 2
  const pile = { x: W / 2 + Math.cos(angle) * W * (0.26 + r() * 0.1), y: H / 2 + Math.sin(angle) * H * (0.25 + r() * 0.1), rot: (r() - 0.5) * 0.7, scale: 0.72 }
  const from = [
    { x: -W * 0.4, y: H * (0.3 + r() * 0.4), rot: -0.6, scale: 1.05 },
    { x: W * 1.4, y: H * (0.3 + r() * 0.4), rot: 0.6, scale: 1.05 },
    { x: W * (0.3 + r() * 0.4), y: -H * 0.6, rot: 0.4, scale: 1.05 },
    { x: W * (0.3 + r() * 0.4), y: H * 1.6, rot: -0.4, scale: 1.05 }
  ][side]
  return { center, pile, from }
}

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), rot: lerp(a.rot, b.rot, t), scale: lerp(a.scale, b.scale, t) }
}

const snapDate = new Map<number, string>()
function dateLabel(time: number): string {
  if (!time) return ''
  const day = Math.floor(time / 86400000)
  let s = snapDate.get(day)
  if (!s) snapDate.set(day, (s = new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'long', year: 'numeric' }).format(time)))
  return s
}

/** An instant photo: square picture, thick bottom border with a handwritten line. */
function polaroid(ctx: Ctx, s: SlideState, pose: Pose, opacity: number, text: string, o: { shade?: number; textOpacity?: number } = {}): void {
  const { H } = ctx
  const size = H * 0.56 * pose.scale
  const b = size * 0.06
  const bottom = size * 0.24
  const box = { x: pose.x - size / 2, y: pose.y - (size + b + bottom) / 2 + b, w: size, h: size }
  const tex = slideTexture(ctx, s, 0)
  const m = s.slide.media[0]
  print(ctx, tex, aspectOf(m, tex), box, pose.rot, { opacity, border: b, bottom, uv: photoUv(s.slide.entries[0], m, 1, tex), shade: o.shade })
  const textOpacity = opacity * (o.textOpacity ?? 1)
  if (text && textOpacity > 0.001) {
    const cx = pose.x
    const cy = box.y + size + bottom * 0.55
    // rotate the text with the print around the print's centre
    const dx = cx - pose.x
    const dy = cy - pose.y
    const x = pose.x + dx * Math.cos(pose.rot) - dy * Math.sin(pose.rot)
    const y = pose.y + dx * Math.sin(pose.rot) + dy * Math.cos(pose.rot)
    drawText(ctx, { text, font: 'hand', size: H * 0.045 * pose.scale, weight: 600, color: '#2b2b33', maxWidth: size * 0.95 }, x, y, { opacity: textOpacity, rotZ: pose.rot })
  }
}

export const snapshots: Theme = {
  mode: 'scene',
  clear: [0.2, 0.13, 0.08],
  ownCaption: true,
  background(ctx, states) {
    ctx.c.quad({ tex: texture(ctx.c, 'wood', ctx.W, ctx.H, woodTable), x: 0, y: 0, w: ctx.W, h: ctx.H })
    const newest = states.length ? states[states.length - 1] : null
    const anchor = newest ? newest.slide.index : 0
    // depth grows smoothly while the next print comes in, so the pile never jumps: deeper prints
    // only get a little darker (real prints aren't see-through), and the fifth fades away
    const landing = newest ? smooth(newest.inP) : 1
    const active = new Set(states.map((x) => x.slide.index))
    for (let age = 5; age >= 1; age--) {
      const sl = ctx.tl.slides[anchor - age]
      if (!sl || active.has(sl.index) || sl.kind !== 'photos') continue
      const depth = age - 1 + landing
      const opacity = clamp01(5 - depth)
      if (opacity <= 0.001) continue
      const st: SlideState = { slide: sl, local: sl.duration, p: 1, inP: 1, outP: 1 }
      polaroid(ctx, st, snapPoses(ctx, sl).pile, opacity, '', { shade: Math.min(0.45, 0.11 * Math.max(0, depth - 1)) })
    }
  },
  drawSlide(ctx, s) {
    const { W, H } = ctx
    const sl = s.slide
    if (sl.kind !== 'photos') {
      if (sl.kind === 'video') {
        // videos play on a big print that slides in like the instant photos and out the other side
        const box = containBox(aspectOf(sl.media[0]), { x: W * 0.12, y: H * 0.1, w: W * 0.76, h: H * 0.8 })
        const poses = snapPoses(ctx, sl)
        const away = { x: 2 * poses.center.x - poses.from.x, y: 2 * poses.center.y - poses.from.y }
        const qi = easeOut(s.inP)
        const qo = easeIn(s.outP)
        const dx = (poses.from.x - poses.center.x) * (1 - qi) + (away.x - poses.center.x) * qo
        const dy = (poses.from.y - poses.center.y) * (1 - qi) + (away.y - poses.center.y) * qo
        const rot = poses.from.rot * 0.5 * (1 - qi) - poses.from.rot * 0.5 * qo
        print(ctx, slideTexture(ctx, s, 0), aspectOf(sl.media[0]), { ...box, x: box.x + dx, y: box.y + dy }, rot, { opacity: 1, border: H * 0.02 })
        return
      }
      drawCenteredText(ctx, s, 'hand', '#f4ead8', { opacity: smooth(s.inP) * (1 - smooth(s.outP)), scale: 1.4, shadow: true })
      return
    }
    const poses = snapPoses(ctx, sl)
    const inP = easeOut(s.inP)
    const pose = s.outP > 0 ? lerpPose(poses.center, poses.pile, smooth(s.outP)) : lerpPose(poses.from, poses.center, inP)
    const text = captionLines(sl) || dateLabel(sl.media[0]?.captureTime ?? 0)
    // the handwritten line fades as the print goes onto the pile (pile prints show none)
    polaroid(ctx, s, pose, 1, text, { textOpacity: 1 - smooth(s.outP / 0.4) })
  }
}

// ---------------------------------------------------------------- Shatter

export const shatter: Theme = {
  mode: 'composite',
  clear: [0, 0, 0],
  boxes: (W, H) => [{ x: 0, y: 0, w: W, h: H }],
  drawSlide(ctx, s) {
    const { W, H } = ctx
    const sl = s.slide
    if (sl.kind === 'title' || sl.kind === 'text') {
      drawCenteredText(ctx, s, 'sans', '#ffffff', { scale: 0.95 })
      return
    }
    drawCell(ctx, s, 0, { x: 0, y: 0, w: W, h: H }, { zoom: lerp(1, 1.05, s.p) }, 'blur', 0.08)
    if (sl.titleOverlay) drawCenteredText(ctx, s, 'sans', '#ffffff', { opacity: titleOpacity(s.local), shadow: true, overlay: true })
  },
  transition() {
    return { kind: 'shatter', dir: [1, 0] }
  }
}

/** Shards of the outgoing picture flying apart from an impact point, over the incoming one. */
export function drawShatter(c: Compositor, a: Tex, b: Tex, p: number, seed: string): void {
  const W = c.W
  const H = c.H
  c.quad({ tex: b, x: 0, y: 0, w: W, h: H, flipY: true })
  const r = rng(seed)
  const cols = 8
  const rows = 5
  const ix = 0.35 + r() * 0.3
  const iy = 0.35 + r() * 0.3
  const t = Math.max(0, (p - 0.08) / 0.92)
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      for (const tri of [1, 2] as const) {
        const x0 = gx / cols
        const y0 = gy / rows
        const w = 1 / cols
        const h = 1 / rows
        const cx = x0 + w * (tri === 1 ? 0.33 : 0.67)
        const cy = y0 + h * (tri === 1 ? 0.67 : 0.33)
        const dx = cx - ix
        const dy = cy - iy
        const dist = Math.hypot(dx, dy) + 0.05
        // shards near the impact go first and fastest
        const delay = Math.min(0.35, dist * 0.45)
        const k = Math.max(0, (t - delay) / (1 - delay))
        const speed = (0.6 + r() * 0.6) / dist
        const spin = (r() - 0.5) * 6
        const tilt = (r() - 0.5) * 3
        const move = k * k
        c.quad({
          tex: a,
          flipY: true,
          uv: { x: x0, y: 1 - y0 - h, w, h },
          x: (x0 + (dx / dist) * move * speed * 0.35) * W,
          y: (y0 + (dy / dist) * move * speed * 0.35 + move * 0.5) * H,
          w: w * W + 0.5,
          h: h * H + 0.5,
          rotZ: spin * move,
          rotX: tilt * move,
          z: move * H * 0.5,
          opacity: 1 - smooth((k - 0.55) / 0.45),
          tri
        })
      }
    }
  }
}

