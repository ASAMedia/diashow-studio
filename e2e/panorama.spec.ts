// Panoramas pan across their slide, end to end: generated panoramas (an 8000x1600 one with numbered,
// grey-coded columns and a tall 1600x6400 one with numbered rows), the preview and an export in Ken
// Burns, Classic, Magazine and Vintage Prints, a pixelated area that pans along, and the per-photo
// choice (pan, whole picture, crop) and direction in the Slide tab, in German or English
// (DIASHOW_LOCALE=en-US). Where the picture is on screen is measured, not guessed: the brightness of
// each screen column is matched against the panorama's own columns, which gives the position and the
// scale of the picture in every frame. DIASHOW_PANO_SHEETS=<folder> also writes a contact sheet per
// theme (all 11) there.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Rect } from '../src/shared/types'
import { copyMedia, ensureTestMedia, launch, removeDir, root, type Session } from './harness'
import { EXPORT_SIZE, SOFTWARE_GL } from './launch'

const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')
const EN = (process.env.DIASHOW_LOCALE ?? '').toLowerCase().startsWith('en')
const SHEETS = process.env.DIASHOW_PANO_SHEETS

const WIDE = { w: 8000, h: 1600, cells: 40 }
const TALL = { w: 1600, h: 6400, cells: 32 }
/** Fine vertical stripes on the wide panorama: P gets pixelated, C stays sharp (normalised). */
const P: Rect = { x: 2400 / 8000, y: 500 / 1600, w: 600 / 8000, h: 600 / 1600 }
const C: Rect = { x: 5200 / 8000, y: 500 / 1600, w: 600 / 8000, h: 600 / 1600 }

const state = <T,>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const d = window.__diashow; const s = d.store.getState(); ${fn} })()`) as Promise<T>

// ---------------------------------------------------------------- test pictures

/** Grey level of cell k: every cell differs from its neighbours, so a run of cells is unique. */
const level = (k: number): number => 40 + ((k * 23) % 37) * 5

/**
 * A panorama of numbered cells along its long side, with two stripe boards on the wide one.
 * `pixelated`: P as the pixelation shows it (an even grey ellipse), to compare frames with.
 */
async function panorama(file: string, spec: { w: number; h: number; cells: number }, wide: boolean, pixelated = false): Promise<void> {
  const { w, h, cells } = spec
  const step = (wide ? w : h) / cells
  const parts: string[] = []
  for (let k = 0; k < cells; k++) {
    const g = level(k)
    const hue = (k * 67) % 360
    const rect = wide ? `x="${k * step}" y="0" width="${step}" height="${h}"` : `x="0" y="${k * step}" width="${w}" height="${step}"`
    parts.push(`<rect ${rect} fill="hsl(${hue},45%,${Math.round((g / 255) * 100)}%)"/>`)
    const cx = wide ? k * step + step / 2 : w / 2
    const cy = wide ? h * 0.22 : k * step + step * 0.68
    parts.push(`<text x="${cx}" y="${cy}" font-family="Arial" font-weight="bold" font-size="${step * 0.55}" text-anchor="middle" fill="#fff" stroke="#000" stroke-width="6">${k}</text>`)
  }
  if (wide) {
    for (const r of [P, C]) {
      const x0 = r.x * w
      parts.push(`<rect x="${x0}" y="${r.y * h}" width="${r.w * w}" height="${r.h * h}" fill="#fff"/>`)
      for (let x = 0; x < r.w * w; x += 16) parts.push(`<rect x="${x0 + x}" y="${r.y * h}" width="8" height="${r.h * h}" fill="#000"/>`)
    }
    if (pixelated) parts.push(`<ellipse cx="${(P.x + P.w / 2) * w}" cy="${(P.y + P.h / 2) * h}" rx="${(P.w / 2) * w}" ry="${(P.h / 2) * h}" fill="#808080"/>`)
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#888"/>${parts.join('')}</svg>`
  await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(file)
}

// ---------------------------------------------------------------- measuring

interface Gray {
  data: Uint8Array
  width: number
  height: number
}

async function gray(input: Buffer | string): Promise<Gray> {
  const { data, info } = await sharp(input).greyscale().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Mean grey of each column (axis x) or row (axis y) inside a box of pixels. */
function profile(g: Gray, axis: 'x' | 'y', box = { x0: 0, y0: 0, x1: g.width, y1: g.height }): Float64Array {
  const n = axis === 'x' ? box.x1 - box.x0 : box.y1 - box.y0
  const out = new Float64Array(n)
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const v = g.data[y * g.width + x]
      out[axis === 'x' ? x - box.x0 : y - box.y0] += v
    }
  }
  const m = axis === 'x' ? box.y1 - box.y0 : box.x1 - box.x0
  for (let i = 0; i < n; i++) out[i] /= m
  return out
}

const sums = new WeakMap<Float64Array, Float64Array>()

/**
 * Mean of the source profile over [a, b) (source pixels): what a screen pixel covering that span shows
 * once the GPU has filtered the picture down (without this, fine stripes alias at small sizes).
 */
function area(s: Float64Array, a: number, b: number): number {
  let p = sums.get(s)
  if (!p) {
    p = new Float64Array(s.length + 1)
    for (let i = 0; i < s.length; i++) p[i + 1] = p[i] + s[i]
    sums.set(s, p)
  }
  const at = (x: number): number => {
    const c = Math.max(0, Math.min(s.length, x))
    const i = Math.min(s.length - 1, Math.floor(c))
    return p[i] + (c - i) * s[i]
  }
  return (at(b) - at(a)) / Math.max(1e-9, b - a)
}

/** Pearson correlation of a screen profile with the source profile; screen pixel j covers offset + [j, j + 1) / scale. */
function corr(f: Float64Array, s: Float64Array, offset: number, scale: number): number {
  let sf = 0, ss = 0, sff = 0, sss = 0, sfs = 0
  const n = f.length
  for (let j = 0; j < n; j++) {
    const v = area(s, offset + j / scale, offset + (j + 1) / scale)
    sf += f[j]; ss += v; sff += f[j] * f[j]; sss += v * v; sfs += f[j] * v
  }
  const cov = sfs - (sf * ss) / n
  const d = Math.sqrt((sff - (sf * sf) / n) * (sss - (ss * ss) / n))
  return d > 0 ? cov / d : 0
}

interface Fit {
  /** Source pixel at the profile's first screen pixel, and screen pixels per source pixel. */
  offset: number
  scale: number
  r: number
}

/**
 * Where a screen profile sits in the source profile: best scale (from `scales`, then refined unless
 * `fixed`) and offset, refined to a twentieth of a source pixel.
 */
function locate(f: Float64Array, s: Float64Array, scales: number[], fixed = false): Fit {
  let best: Fit = { offset: 0, scale: scales[0], r: -2 }
  for (const scale of scales) {
    const span = f.length / scale
    for (let o = 0; o <= s.length - span; o += 4) {
      const r = corr(f, s, o, scale)
      if (r > best.r) best = { offset: o, scale, r }
    }
  }
  // finer: scale and offset around the best
  for (const [range, step, sRange, sStep] of [[6, 0.5, 0.02, 0.005], [0.6, 0.05, 0.004, 0.001]] as const) {
    const b = best
    for (let k = fixed ? 0 : -sRange; k <= (fixed ? 0 : sRange) + 1e-9; k += sStep) {
      const scale = b.scale * (1 + k)
      for (let o = b.offset - range; o <= b.offset + range + 1e-9; o += step) {
        const r = corr(f, s, o, scale)
        if (r > best.r) best = { offset: o, scale, r }
      }
    }
  }
  return best
}

const around = (center: number, spread: number, n = 9): number[] => Array.from({ length: n }, (_, i) => center * (1 - spread + (2 * spread * i) / (n - 1)))

/** Mean absolute horizontal step of grey inside a box of pixels: stripes score high, pixelated blocks low. */
function detail(g: Gray, b: { x0: number; y0: number; x1: number; y1: number }): number {
  let s = 0
  let n = 0
  for (let y = Math.max(0, b.y0); y < Math.min(g.height, b.y1); y++) {
    for (let x = Math.max(0, b.x0); x < Math.min(g.width, b.x1) - 1; x++) {
      s += Math.abs(g.data[y * g.width + x + 1] - g.data[y * g.width + x])
      n++
    }
  }
  return n ? s / n : 0
}

// ---------------------------------------------------------------- the app

interface SlideInfo {
  id: string
  start: number
  duration: number
  transIn: number
  transOut: number
  n: number
  pano?: { axis: 'x' | 'y'; mode: string; reverse: boolean }
  template?: string
}

const slides = (page: Page): Promise<SlideInfo[]> =>
  state(page, `return d.player.current.tl.slides.map((x) => ({ id: x.id, start: x.start, duration: x.duration, transIn: x.transIn, transOut: x.transOut, n: x.entries.length, pano: x.pano, template: x.template?.id, media: x.media.map((m) => m.name) }))`)

/** The preview at time t, once every picture is loaded and the frame stands still. */
async function shotAt(page: Page, t: number): Promise<Buffer> {
  await page.evaluate((tt) => (window as any).__diashow.player.current.seek(tt), t)
  const frame = page.locator('.stage .frame')
  await page.mouse.move(1, 1)
  await page.waitForFunction(() => (window as any).__diashow.player.current.engine.missing === 0, null, { timeout: 60_000 })
  let last = await frame.screenshot()
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150)
    const next = await frame.screenshot()
    if (next.equals(last)) return next
    last = next
  }
  return last
}

/** Times on a slide's pan, as shares of the time between its transitions. */
const panTimes = (s: SlideInfo, qs: number[]): number[] => qs.map((q) => s.start + s.transIn + q * (s.duration - s.transIn - s.transOut))

test('panoramas pan in the preview and the export, per photo and in every theme', async () => {
  test.setTimeout((SOFTWARE_GL ? 40 : 15) * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-pano-'))
  const media = join(dataDir, 'media')
  mkdirSync(media)
  const wideFile = join(media, 'wide-pano.jpg')
  const tallFile = join(media, 'tall-pano.jpg')
  await panorama(wideFile, WIDE, true)
  await panorama(tallFile, TALL, false)
  const normal = copyMedia(['android/PXL_0002.jpg', 'iphone/IMG_0003.JPG', 'misc/photo.webp'], join(dataDir, 'photos'))
  const files = [normal[0], wideFile, normal[1], tallFile, normal[2]]
  const wideSrc = profile(await gray(wideFile), 'x')
  const tallSrc = profile(await gray(tallFile), 'y')
  // (not imported: the wide one as it looks once P is pixelated, to find it in frames then)
  const pixFile = join(dataDir, 'wide-pixelated.png')
  await panorama(pixFile, WIDE, true, true)
  const pixSrc = profile(await gray(pixFile), 'x')

  let s: Session | null = null
  try {
    s = await launch(dataDir)
    const { page } = s
    await page.evaluate(async (paths) => (window as any).__diashow.store.getState().createProject(paths, 'Panorama'), files)
    await page.waitForFunction(() => {
      const p = (window as any).__diashow.store.getState().project
      return p && p.media.length === 5 && p.media.every((m: any) => m.status === 'ready')
    }, null, { timeout: 300_000, polling: 250 })
    // in the order given, without a title; the display images keep the panoramas' full height
    await state(page, `s.update((p) => { const order = ${JSON.stringify(files.map((f) => f.split(/[\\/]/).pop()))}; const name = (e) => p.media.find((m) => m.id === e.mediaId).name; p.entries.sort((a, b) => order.indexOf(name(a)) - order.indexOf(name(b))) }); d.store.getState().setTheme('kenburns'); d.store.getState().setSettings({ showTitle: false })`)
    const dims = await state<Record<string, [number, number]>>(page, `return Object.fromEntries(s.project.media.map((m) => [m.name, [m.width, m.height]]))`)
    expect(dims['wide-pano.jpg']).toEqual([8000, 1600])
    expect(dims['tall-pano.jpg']).toEqual([1600, 6400])

    // ---- the timeline: both panoramas pan on slides of their own and last longer
    let tl = await slides(page)
    const wideSlide = (list: SlideInfo[]): SlideInfo => list.find((x: any) => x.media.includes('wide-pano.jpg'))!
    const tallSlide = (list: SlideInfo[]): SlideInfo => list.find((x: any) => x.media.includes('tall-pano.jpg'))!
    expect(wideSlide(tl).pano).toEqual({ axis: 'x', mode: 'pan', reverse: false })
    expect(tallSlide(tl).pano).toEqual({ axis: 'y', mode: 'pan', reverse: false })
    const normalDur = tl[0].duration
    // 5:1 in 16:9 spans 2.81 frames: 1 + 0.6 × 1.81 photo times; the tall one is capped at 2.5
    expect(wideSlide(tl).duration / normalDur).toBeCloseTo(1 + 0.6 * (5 / (16 / 9) - 1), 2)
    expect(tallSlide(tl).duration / normalDur).toBeCloseTo(2.5, 2)
    // never in a grid, also in Magazine; the photos around them still share slides there
    await state(page, `s.setTheme('magazine')`)
    tl = await slides(page)
    expect(wideSlide(tl).n).toBe(1)
    expect(tallSlide(tl).n).toBe(1)
    expect(wideSlide(tl).template).toBe('m1')
    await state(page, `s.setTheme('kenburns')`)

    // ---- the preview pans: start, middle and end show different parts, at full height (no letterbox)
    tl = await slides(page)
    const ws = wideSlide(tl)
    const preview: Fit[] = []
    for (const t of panTimes(ws, [0, 0.5, 1])) {
      const g = await gray(await shotAt(page, t))
      const fit = locate(profile(g, 'x'), wideSrc, around(g.height / WIDE.h, 0.3))
      preview.push(fit)
      // the top and bottom rows show the picture too
      expect(profile(g, 'y').slice(0, 2).every((v) => v > 25)).toBe(true)
      expect(profile(g, 'y').slice(-2).every((v) => v > 25)).toBe(true)
    }
    const h0 = (await gray(await shotAt(page, ws.start + ws.duration / 2))).height
    console.log('preview, wide:', preview.map((f) => `${f.offset.toFixed(0)} px ×${(f.scale / (h0 / WIDE.h)).toFixed(3)} r ${f.r.toFixed(3)}`).join(' | '))
    for (const f of preview) {
      expect(f.r).toBeGreaterThan(0.9)
      // full height: the scale is the frame's height over the panorama's
      expect(Math.abs(f.scale / (h0 / WIDE.h) - 1)).toBeLessThan(0.03)
    }
    const spanPx = WIDE.w - h0 * (16 / 9) / (h0 / WIDE.h)
    // left to right, from near the left end to near the right end
    expect(preview[0].offset).toBeLessThan(0.2 * spanPx)
    expect(preview[1].offset).toBeGreaterThan(0.35 * spanPx)
    expect(preview[1].offset).toBeLessThan(0.65 * spanPx)
    expect(preview[2].offset).toBeGreaterThan(0.8 * spanPx)

    // the tall one, top to bottom at full width
    const ts = tallSlide(tl)
    const tallFits: Fit[] = []
    for (const t of panTimes(ts, [0.05, 0.95])) {
      const g = await gray(await shotAt(page, t))
      tallFits.push(locate(profile(g, 'y'), tallSrc, around(g.width / TALL.w, 0.3)))
    }
    console.log('preview, tall:', tallFits.map((f) => `${f.offset.toFixed(0)} px r ${f.r.toFixed(3)}`).join(' | '))
    expect(tallFits.every((f) => f.r > 0.9)).toBe(true)
    expect(tallFits[1].offset - tallFits[0].offset).toBeGreaterThan(2000)

    // ---- a pixelated area pans along and stays pixelated; the stripes next to it stay sharp
    await state(page, `const m = s.project.media.find((x) => x.name === 'wide-pano.jpg'); const e = s.project.entries.find((x) => x.mediaId === m.id); s.setEntry(e.id, { privacy: [${JSON.stringify(P)}] })`)
    const boxOn = (g: Gray, f: Fit, r: Rect): { x0: number; y0: number; x1: number; y1: number; visible: boolean } => {
      // the middle half of the area, where the ellipse covers it all
      const x0 = Math.round((r.x * WIDE.w + r.w * WIDE.w * 0.3 - f.offset) * f.scale)
      const x1 = Math.round((r.x * WIDE.w + r.w * WIDE.w * 0.7 - f.offset) * f.scale)
      const y0 = Math.round((r.y + r.h * 0.3) * g.height)
      const y1 = Math.round((r.y + r.h * 0.7) * g.height)
      return { x0, y0, x1, y1, visible: x0 >= 0 && x1 <= g.width }
    }
    const seen = { p: [] as number[], c: [] as number[] }
    for (const q of [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1]) {
      const g = await gray(await shotAt(page, panTimes(ws, [q])[0]))
      const f = locate(profile(g, 'x'), pixSrc, around(g.height / WIDE.h, 0.05, 5))
      const pb = boxOn(g, f, P)
      const cb = boxOn(g, f, C)
      if (pb.visible) seen.p.push(detail(g, pb))
      if (cb.visible) seen.c.push(detail(g, cb))
    }
    console.log('detail: pixelated', seen.p.map((v) => v.toFixed(1)).join(' '), '| sharp', seen.c.map((v) => v.toFixed(1)).join(' '))
    expect(seen.p.length).toBeGreaterThanOrEqual(2)
    expect(seen.c.length).toBeGreaterThanOrEqual(1)
    expect(Math.max(...seen.p)).toBeLessThan(Math.min(...seen.c) * 0.35)

    // ---- the Slide tab: pan, whole picture or crop, and the direction (German or English)
    const card = (name: string) => page.locator(`.cards .card[data-entry="${tl.find((x: any) => x.media.includes(name))!.id}"]`)
    await card('wide-pano.jpg').scrollIntoViewIfNeeded()
    await card('wide-pano.jpg').click()
    await expect(page.locator('.cards .card.selected .pano-mark')).toHaveCount(1)
    const mode = page.locator('[data-testid="pano-mode"]')
    const dir = page.locator('[data-testid="pano-dir"]')
    await expect(mode).toBeVisible()
    const labels = async (sel: typeof mode): Promise<string[]> => sel.locator('option').allInnerTexts()
    expect(await labels(mode)).toEqual(EN ? ['Pan', 'Whole picture', 'Crop to fill'] : ['Schwenk', 'Ganzes Bild', 'Zuschneiden'])
    expect(await labels(dir)).toEqual(EN ? ['Left → right', 'Right → left'] : ['Links → rechts', 'Rechts → links'])
    const wideEntry = (): Promise<any> => state(page, `const m = s.project.media.find((x) => x.name === 'wide-pano.jpg'); return s.project.entries.find((x) => x.mediaId === m.id)`)
    await mode.selectOption('whole')
    expect((await wideEntry()).whole).toBe(true)
    await expect(dir).toHaveCount(0)
    tl = await slides(page)
    expect(wideSlide(tl).pano?.mode).toBe('whole')
    // shown whole the slide takes a normal photo's time
    expect(wideSlide(tl).duration).toBeCloseTo(normalDur, 3)
    await mode.selectOption('crop')
    expect((await wideEntry()).whole).toBe(false)
    await mode.selectOption('pan')
    expect((await wideEntry()).whole).toBeUndefined()
    await dir.selectOption('reverse')
    expect((await wideEntry()).panReverse).toBe(true)
    tl = await slides(page)
    expect(wideSlide(tl).pano).toEqual({ axis: 'x', mode: 'pan', reverse: true })
    // right to left: it starts at the right end
    {
      const g = await gray(await shotAt(page, panTimes(wideSlide(tl), [0])[0]))
      const f = locate(profile(g, 'x'), pixSrc, around(g.height / WIDE.h, 0.05, 5))
      expect(f.offset).toBeGreaterThan(0.8 * spanPx)
    }
    // the tall one offers top / bottom; both selected: one control for both
    await card('tall-pano.jpg').click()
    expect(await labels(dir)).toEqual(EN ? ['Top → bottom', 'Bottom → top'] : ['Oben → unten', 'Unten → oben'])
    await card('wide-pano.jpg').click({ modifiers: ['Control'] })
    await expect(page.locator('[data-testid="pano-dir"] option[value="mixed"]')).toHaveCount(1)
    await dir.selectOption('forward')
    expect((await wideEntry()).panReverse).toBeUndefined()
    expect(await labels(dir)).toEqual(EN ? ['Left → right / Top → bottom', 'Right → left / Bottom → top'] : ['Links → rechts / Oben → unten', 'Rechts → links / Unten → oben'])
    await state(page, `s.select([])`)

    // ---- Classic, Magazine and Vintage Prints pan too (preview), each in its own way
    for (const theme of ['classic', 'magazine', 'vintage'] as const) {
      await state(page, `s.setTheme(${JSON.stringify(theme)})`)
      const sl = wideSlide(await slides(page))
      expect(sl.n).toBe(1)
      const fits: Fit[] = []
      let first: Gray | null = null
      for (const t of panTimes(sl, [0.05, 0.5, 0.95])) {
        const g = await gray(await shotAt(page, t))
        first ??= g
        // full frame (Classic), inside the page margins (Magazine), a band through the print (Vintage)
        const m = Math.round(g.height * 0.021)
        const box = theme === 'classic' ? undefined : theme === 'magazine' ? { x0: m + 2, y0: m + 2, x1: g.width - m - 2, y1: g.height - m - 2 } : { x0: Math.round(g.width * 0.3), y0: Math.round(g.height * 0.42), x1: Math.round(g.width * 0.7), y1: Math.round(g.height * 0.58) }
        const h = theme === 'classic' ? g.height : theme === 'magazine' ? g.height - 2 * m : g.height * 0.66
        fits.push(locate(profile(g, 'x', box), pixSrc, around(h / WIDE.h, theme === 'vintage' ? 0.12 : 0.04, 9)))
      }
      console.log(`${theme}:`, fits.map((f) => `${f.offset.toFixed(0)} px ×${f.scale.toFixed(4)} r ${f.r.toFixed(3)}`).join(' | '))
      expect(fits.every((f) => f.r > (theme === 'vintage' ? 0.75 : 0.9))).toBe(true)
      expect(fits[1].offset).toBeGreaterThan(fits[0].offset + 300)
      expect(fits[2].offset).toBeGreaterThan(fits[1].offset + 300)
      if (theme === 'magazine') {
        // the paper shows in the margin around the one panning cell
        const g = first!
        expect(Math.abs(g.data[2 * g.width + Math.round(g.width / 2)] - 240)).toBeLessThan(12)
      }
    }

    // ---- the export pans the same way, at an even speed (Ken Burns, just this slide and its neighbours)
    const others = `const keep = ['PXL_0002.jpg', 'wide-pano.jpg', 'IMG_0003.JPG']; const ids = s.project.media.filter((m) => !keep.includes(m.name)).map((m) => m.id); const out = (e) => ids.includes(e.mediaId)`
    await state(page, `${others}; s.setTheme('kenburns'); d.store.getState().update((p) => p.entries.forEach((e) => { if (out(e)) e.excluded = true }))`)
    const cut = wideSlide(await slides(page))
    expect((await slides(page)).length).toBe(3)
    const out = join(dataDir, 'pano.mp4')
    const fps = 30
    await page.evaluate(async ({ outPath, size, fps }) => {
      const d = (window as any).__diashow
      await d.exportShow(d.store.getState().project, { outPath, ...size, fps, codec: 'h264', quality: 'high', hardware: true }, 'de-DE', () => {}, new AbortController().signal)
    }, { outPath: out, size: EXPORT_SIZE, fps })
    await state(page, `${others}; s.update((p) => p.entries.forEach((e) => { if (out(e)) delete e.excluded }))`)
    const { width: EW, height: EH } = EXPORT_SIZE
    const from = cut.start + cut.transIn
    const len = cut.duration - cut.transIn - cut.transOut
    const raw = execFileSync(ffmpeg, ['-v', 'error', '-ss', from.toFixed(3), '-i', out, '-t', len.toFixed(3), '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 })
    const frames = Math.floor(raw.length / (EW * EH))
    expect(frames).toBeGreaterThan(fps * len * 0.9)
    const scale0 = locate(profile({ data: raw.subarray(0, EW * EH), width: EW, height: EH }, 'x'), pixSrc, around(EH / WIDE.h, 0.05, 5)).scale
    const pos: number[] = []
    const diffs: number[] = []
    const exported = { p: [] as number[], c: [] as number[] }
    for (let i = 0; i < frames; i++) {
      const g = { data: raw.subarray(i * EW * EH, (i + 1) * EW * EH), width: EW, height: EH }
      const f = locate(profile(g, 'x'), pixSrc, [scale0], true)
      expect(f.r).toBeGreaterThan(0.9)
      // screen pixels from the panorama's left end
      pos.push(f.offset * f.scale)
      // the pixelated area, wherever it is in this frame
      if (i % 5 === 0) {
        const pb = boxOn(g, f, P)
        const cb = boxOn(g, f, C)
        if (pb.visible) exported.p.push(detail(g, pb))
        if (cb.visible) exported.c.push(detail(g, cb))
      }
      if (i > 0) {
        let d = 0
        const prev = raw.subarray((i - 1) * EW * EH, i * EW * EH)
        for (let k = 0; k < g.data.length; k += 7) d += Math.abs(g.data[k] - prev[k])
        diffs.push(d / (g.data.length / 7))
      }
    }
    const v = pos.slice(1).map((p, i) => p - pos[i])
    // the middle of the pan (soft starts and stops happen in the transitions or just after)
    const mid = v.slice(Math.floor(v.length * 0.25), Math.ceil(v.length * 0.75))
    const mean = mid.reduce((a, b) => a + b, 0) / mid.length
    const sd = Math.sqrt(mid.reduce((a, b) => a + (b - mean) ** 2, 0) / mid.length)
    const worst = Math.max(...mid.map((x) => Math.abs(x - mean)))
    const dm = diffs.slice(Math.floor(diffs.length * 0.25), Math.ceil(diffs.length * 0.75))
    const dMean = dm.reduce((a, b) => a + b, 0) / dm.length
    console.log(`export: ${frames} frames, ${mean.toFixed(3)} px/frame ± ${sd.toFixed(3)} (worst ${worst.toFixed(3)}), frame difference ${dMean.toFixed(2)} (${Math.min(...dm).toFixed(2)}..${Math.max(...dm).toFixed(2)})`)
    expect(mean).toBeGreaterThan(0.5)
    expect(v.every((x) => x > -0.3)).toBe(true)
    // (a 320 px wide software export measures less precisely)
    expect(sd / mean).toBeLessThan(SOFTWARE_GL ? 0.12 : 0.06)
    expect(worst / mean).toBeLessThan(SOFTWARE_GL ? 0.4 : 0.25)
    console.log('export detail: pixelated', exported.p.map((x) => x.toFixed(1)).join(' '), '| sharp', exported.c.map((x) => x.toFixed(1)).join(' '))
    expect(exported.p.length).toBeGreaterThanOrEqual(3)
    expect(exported.c.length).toBeGreaterThanOrEqual(3)
    // (in a 320 px software export the stripes are finer than a pixel and blur away: only no stripes then)
    if (!SOFTWARE_GL) expect(Math.max(...exported.p)).toBeLessThan(Math.min(...exported.c) * 0.35)
    else expect(Math.max(...exported.p)).toBeLessThan(8)
    // every frame moves: no frame repeats or jumps in the middle of the pan
    expect(Math.min(...dm)).toBeGreaterThan(dMean * 0.3)
    expect(Math.max(...dm)).toBeLessThan(dMean * 3)
    // it covers the panorama end to end (the ramps sit in the transitions around)
    expect(pos[0] / scale0).toBeLessThan(0.25 * spanPx)
    expect(pos[pos.length - 1] / scale0).toBeGreaterThan(0.75 * spanPx)

    // ---- contact sheets of every theme (on request)
    if (SHEETS) await contactSheets(page, SHEETS)

    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close()
    removeDir(dataDir)
  }
})

const ALL_THEMES = ['kenburns', 'classic', 'retro', 'shatter', 'reflections', 'origami', 'panels', 'magazine', 'vintage', 'scrapbook', 'snapshots']

/**
 * Each theme: the wide and the tall panorama from the transition in to the transition out, one row
 * each; in 16:9, and in 9:16 (<theme>-9x16.jpg), where the wide one pans at the frame's full height.
 */
async function contactSheets(page: Page, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  for (const aspect of ['16:9', '9:16']) {
    await state(page, `s.setSettings({ aspect: ${JSON.stringify(aspect)} })`)
    await page.waitForTimeout(500)
    for (const theme of ALL_THEMES) await contactSheet(page, theme, join(dir, `${theme}${aspect === '16:9' ? '' : '-9x16'}.jpg`))
  }
  await state(page, `s.setSettings({ aspect: '16:9' })`)
}

async function contactSheet(page: Page, theme: string, file: string): Promise<void> {
  await state(page, `s.setTheme(${JSON.stringify(theme)})`)
  const list = await slides(page)
  const rows: Buffer[][] = []
  for (const name of ['wide-pano.jpg', 'tall-pano.jpg']) {
    const sl = list.find((x: any) => x.media.includes(name))!
    const times = [sl.start + sl.transIn * 0.5, sl.start + sl.transIn, ...[0.25, 0.5, 0.75].map((q) => sl.start + sl.transIn + q * (sl.duration - sl.transIn - sl.transOut)), sl.start + sl.duration - sl.transOut, sl.start + sl.duration - sl.transOut * 0.5]
    const row: Buffer[] = []
    for (const t of times) row.push(await sharp(await shotAt(page, t)).resize({ height: 225 }).png().toBuffer())
    rows.push(row)
  }
  const tile = await sharp(rows[0][0]).metadata()
  const tw = tile.width!
  const th = tile.height!
  const gap = 8
  const cols = rows[0].length
  await sharp({ create: { width: cols * (tw + gap) + gap, height: rows.length * (th + gap) + gap, channels: 3, background: '#202020' } })
    .composite(rows.flatMap((row, r) => row.map((input, c) => ({ input, left: gap + c * (tw + gap), top: gap + r * (th + gap) }))))
    .jpeg({ quality: 85 })
    .toFile(file)
}
