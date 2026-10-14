// Live Photos as Loop and Bounce, end to end, with the generated test media: the iPhone Live Photo
// (HEIC + HEVC MOV, 3 s of FFmpeg's testsrc2) and the Android Motion Photo (JPEG with an embedded 2 s
// MP4). The Slide tab sets Off, Live, Loop or Bounce for one or several photos (in German, or in
// English with DIASHOW_LOCALE=en-US) and the filmstrip marks the effect. The motion is measured in the
// engine's own frames: every frame the preview renders between the slide's transitions, and every
// frame of an export, is matched against the clip's frames as FFmpeg decodes them. That gives the frame
// shown (or, at a Loop's seam, how well the blend of the two frames explains it), so a Loop must repeat
// and a Bounce reverse all the slide long, one frame per frame time, with no hard jump at a seam. A
// pixelated area stays pixelated while the motion loops, and every theme draws the motion; the prints
// on Snapshots' pile show the photo (an export decodes each motion part once), and Magazine's preview
// keeps the motion part of a Loop on screen.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loopFadeFrames, motionFrame, type MotionFrame } from '../src/shared/livePhoto'
import type { LiveEffect, Rect } from '../src/shared/types'
import { copyMedia, ensureTestMedia, launch, mediaDir, removeDir, root, type Session } from './harness'
import { EXPORT_SIZE, SOFTWARE_GL } from './launch'

const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')
const EN = (process.env.DIASHOW_LOCALE ?? '').toLowerCase().startsWith('en')
const FPS = 30
/** Pixelated in the iPhone clip: the checkerboard at the bottom left (normalised to the picture). */
const PRIVATE: Rect = { x: 0.1, y: 0.58, w: 0.32, h: 0.3 }

const state = <T,>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const d = window.__diashow; const s = d.store.getState(); ${fn} })()`) as Promise<T>

// ---------------------------------------------------------------- measuring

/** A frame's signature: RGB means of a grid of cells over the picture, inside a 5 % margin. */
interface Grid {
  gx: number
  gy: number
}
const MARGIN = 0.05

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Where a picture of `aspect` sits when shown whole in a W×H frame (Classic, "Whole picture"). */
function fitted(W: number, H: number, aspect: number): Box {
  const w = Math.min(W, H * aspect)
  const h = w / aspect
  return { x: (W - w) / 2, y: (H - h) / 2, w, h }
}

/** A box in pixels as shares of a W×H frame. */
const norm = (b: Box, W: number, H: number): Box => ({ x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H })

/** The part of a box that an area of the picture covers (the middle half of `r`: inside its ellipse). */
const inner = (b: Box, r: Rect): Box => ({ x: b.x + (r.x + r.w * 0.25) * b.w, y: b.y + (r.y + r.h * 0.25) * b.h, w: r.w * 0.5 * b.w, h: r.h * 0.5 * b.h })

/** A box inside the margin. */
const within = (b: Box): Box => ({ x: b.x + b.w * MARGIN, y: b.y + b.h * MARGIN, w: b.w * (1 - 2 * MARGIN), h: b.h * (1 - 2 * MARGIN) })

/**
 * RGB means of a grid of cells over a box of an RGB frame, edge pixels counted by the share they
 * cover: small exports (320×180 without a GPU) move a few pixels per frame, rounded cell edges would
 * shift the cells by as much.
 */
function cells(rgb: Uint8Array, W: number, box: Box, g: Grid): Float64Array {
  const out = new Float64Array(g.gx * g.gy * 3)
  for (let cy = 0; cy < g.gy; cy++) {
    const y0 = box.y + (cy * box.h) / g.gy
    const y1 = box.y + ((cy + 1) * box.h) / g.gy
    for (let cx = 0; cx < g.gx; cx++) {
      const x0 = box.x + (cx * box.w) / g.gx
      const x1 = box.x + ((cx + 1) * box.w) / g.gx
      const sum = [0, 0, 0]
      let area = 0
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0)
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const w = (Math.min(x + 1, x1) - Math.max(x, x0)) * wy
          for (let c = 0; c < 3; c++) sum[c] += rgb[(y * W + x) * 3 + c] * w
          area += w
        }
      }
      for (let c = 0; c < 3; c++) out[(cy * g.gx + cx) * 3 + c] = sum[c] / area
    }
  }
  return out
}

/** Every frame of a video as RGB (`matrix`: how to read a clip that doesn't say), as signatures of a box. */
function videoSigs(file: string, W: number, H: number, box: Box, g: Grid, matrix?: string): Float64Array[] {
  const vf = matrix ? `scale=in_color_matrix=${matrix},format=rgb24` : 'format=rgb24'
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 })
  const size = W * H * 3
  return Array.from({ length: Math.floor(raw.length / size) }, (_, i) => cells(raw.subarray(i * size, (i + 1) * size), W, box, g))
}

const cropOf = (b: Box): string => `crop=${Math.round(b.w)}:${Math.round(b.h)}:${Math.round(b.x)}:${Math.round(b.y)}`

/** Detail of an area in every exported frame (grey, full resolution). */
function exportDetail(file: string, b: Box): number[] {
  const w = Math.round(b.w)
  const h = Math.round(b.h)
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', `format=gray,${cropOf(b)}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 })
  return Array.from({ length: Math.floor(raw.length / (w * h)) }, (_, i) => detail(raw.subarray(i * w * h, (i + 1) * w * h), w, h))
}

/** Mean step between horizontal neighbours: fine detail scores high, pixelated blocks low. */
function detail(grey: Uint8Array, w: number, h: number): number {
  let s = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) s += Math.abs(grey[y * w + x + 1] - grey[y * w + x])
  return s / (h * (w - 1))
}

/** Pearson correlation of two signatures after taking away what all frames share (the still parts). */
function corr(a: Float64Array, b: Float64Array, mean: Float64Array): number {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0
  const n = a.length
  for (let i = 0; i < n; i++) {
    const x = a[i] - mean[i]
    const y = b[i] - mean[i]
    sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y
  }
  const d = Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n))
  return d > 0 ? (sab - (sa * sb) / n) / d : 0
}

const meanOf = (sigs: Float64Array[]): Float64Array => {
  const m = new Float64Array(sigs[0].length)
  for (const s of sigs) for (let i = 0; i < m.length; i++) m[i] += s[i] / sigs.length
  return m
}
const blend = (a: Float64Array, b: Float64Array, w: number): Float64Array => a.map((v, i) => v * (1 - w) + b[i] * w)
const dist = (a: Float64Array, b: Float64Array): number => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length
const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]

interface Clip {
  refs: Float64Array[]
  mean: Float64Array
  matrix: string
}

/**
 * The clip as the app's decoder shows it: the test clips carry no colour matrix, which WebCodecs here
 * reads as BT.709 (another decoder may take BT.601); the matrix whose frames fit the rendered ones best.
 */
function reference(file: string, size: { width: number; height: number }, g: Grid, rendered: Float64Array[]): Clip {
  const { width: W, height: H } = size
  const options = ['bt709', 'bt601'].map((matrix) => {
    const refs = videoSigs(file, W, H, within({ x: 0, y: 0, w: W, h: H }), g, matrix)
    const mean = meanOf(refs)
    return { refs, mean, matrix, fit: median(rendered.map((s) => Math.max(...refs.map((r) => corr(s, r, mean))))) }
  })
  return options.sort((a, b) => b.fit - a.fit)[0]
}

interface Match {
  /** The single frame that fits best. */
  best: number
  bestR: number
  /** Fit of the frame (or blend) that should show, and at a seam the better of its two frames alone. */
  expR: number
  singleR: number
}

function match(sig: Float64Array, clip: Clip, want: MotionFrame): Match {
  const rs = clip.refs.map((r) => corr(sig, r, clip.mean))
  const best = rs.indexOf(Math.max(...rs))
  const expected = want.b != null ? blend(clip.refs[want.a], clip.refs[want.b], want.w!) : clip.refs[want.a]
  return { best, bestR: rs[best], expR: corr(sig, expected, clip.mean), singleR: want.b != null ? Math.max(rs[want.a], rs[want.b]) : rs[want.a] }
}

/**
 * Rendered frames against the frames the slide's time asks for: each frame (outside a seam) is the
 * expected one, a Loop repeats with blends at its seams, a Bounce turns at both ends, every step one
 * frame, and a seam has no jump like a cut from the last frame to the first.
 */
function check(what: string, effect: LiveEffect, n: number, want: MotionFrame[], sigs: Float64Array[], clip: Clip): void {
  const got = sigs.map((sig, k) => match(sig, clip, want[k]))
  const pure = got.map((m, k) => ({ m, w: want[k] })).filter((x) => x.w.b == null)
  const exact = pure.filter((x) => x.m.best === x.w.a).length
  const blends = got.map((m, k) => ({ m, w: want[k] })).filter((x) => x.w.b != null)
  const steps = sigs.slice(1).map((s, k) => dist(s, sigs[k]))
  const seamSteps = steps.filter((_, k) => want[k].b != null || want[k + 1].b != null)
  // a cut from the last frame to the first, in the rendered frames' scale
  const refSteps = clip.refs.slice(1).map((r, i) => dist(r, clip.refs[i]))
  const cut = (dist(clip.refs[n - 1], clip.refs[0]) * median(steps)) / median(refSteps)
  console.log(
    `${what} ${effect}: ${got.length} frames (refs ${clip.matrix}), ${exact}/${pure.length} exact, fit ${median(got.map((m) => m.bestR)).toFixed(2)}; ` +
      `${blends.length} blended; steps ${median(steps).toFixed(2)}, at seams up to ${Math.max(0, ...seamSteps).toFixed(2)}, a cut ${cut.toFixed(2)}`
  )
  console.log(`  ${got.map((m, k) => (want[k].b != null ? `[${m.best}]` : m.best === want[k].a ? `${m.best}` : `${m.best}!${want[k].a}`)).join(' ')}`)
  expect(exact).toBe(pure.length)
  // the order as measured: one frame per step (Bounce), a Loop starts over after each seam
  const shown = pure.map((x) => x.m.best)
  if (effect === 'bounce') {
    for (let k = 1; k < got.length; k++) expect(Math.abs(got[k].best - got[k - 1].best)).toBe(1)
    const turns = got.slice(1, -1).filter((m, k) => (m.best - got[k].best) * (got[k + 2].best - m.best) < 0).length
    expect(turns).toBeGreaterThanOrEqual(2)
    expect(Math.max(...shown)).toBe(n - 1)
    expect(Math.min(...shown)).toBe(0)
  } else {
    const restarts = shown.slice(1).filter((v, k) => v < shown[k]).length
    expect(restarts).toBeGreaterThanOrEqual(1)
    for (let k = 1; k < got.length; k++) if (want[k].b == null && want[k - 1].b == null) expect(got[k].best - got[k - 1].best).toBe(1)
    expect(blends.length).toBeGreaterThanOrEqual(loopFadeFrames(n, FPS))
    // each blend explains its frame at least as well as either frame alone, clearly so in the middle
    for (const { m, w } of blends) {
      expect(m.expR).toBeGreaterThan(m.singleR - 0.01)
      if (w.w! > 0.3 && w.w! < 0.7) expect(m.expR).toBeGreaterThan(m.singleR + 0.01)
    }
    expect(Math.max(...seamSteps)).toBeLessThan(0.6 * cut)
  }
  expect(Math.max(...steps)).toBeLessThan(0.6 * cut)
}

// ---------------------------------------------------------------- the app

interface SlideInfo {
  id: string
  start: number
  duration: number
  transIn: number
  transOut: number
  n: number
  live?: { duration: number; effect?: LiveEffect }
  media: string[]
}

const slides = (page: Page): Promise<SlideInfo[]> =>
  state(page, `return d.player.current.tl.slides.map((x) => ({ id: x.id, start: x.start, duration: x.duration, transIn: x.transIn, transOut: x.transOut, n: x.entries.length, live: x.live, media: x.media.map((m) => m.name) }))`)

/**
 * Renders the preview engine at each time and reads back, from the frame it drew, RGB means of a grid
 * over a box (normalised to the canvas: 0..1), and optionally the detail inside a second box.
 */
async function render(page: Page, times: number[], box: Box, g: Grid, detailBox?: Box): Promise<{ sigs: Float64Array[]; details: number[] }> {
  const r = await page.evaluate(
    ({ times, box, gx, gy, detailBox }) => {
      const e = (window as any).__diashow.player.current.engine
      const W: number = e.c.W
      const H: number = e.c.H
      const buf = new Uint8Array(W * H * 4)
      // readPixels rows go bottom up
      const at = (x: number, y: number): number => (H - 1 - y) * W * 4 + x * 4
      const sigs: number[][] = []
      const details: number[] = []
      for (const t of times) {
        e.render(t)
        e.readPixels(buf)
        const sig: number[] = []
        for (let cy = 0; cy < gy; cy++) {
          const ya = Math.round((box.y + (cy * box.h) / gy) * H)
          const yb = Math.max(ya + 1, Math.round((box.y + ((cy + 1) * box.h) / gy) * H))
          for (let cx = 0; cx < gx; cx++) {
            const xa = Math.round((box.x + (cx * box.w) / gx) * W)
            const xb = Math.max(xa + 1, Math.round((box.x + ((cx + 1) * box.w) / gx) * W))
            const sum = [0, 0, 0]
            for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) for (let c = 0; c < 3; c++) sum[c] += buf[at(x, y) + c]
            const n = (yb - ya) * (xb - xa)
            sig.push(sum[0] / n, sum[1] / n, sum[2] / n)
          }
        }
        sigs.push(sig)
        if (detailBox) {
          const x0 = Math.round(detailBox.x * W)
          const x1 = Math.round((detailBox.x + detailBox.w) * W)
          const y0 = Math.round(detailBox.y * H)
          const y1 = Math.round((detailBox.y + detailBox.h) * H)
          const grey = (x: number, y: number): number => 0.299 * buf[at(x, y)] + 0.587 * buf[at(x, y) + 1] + 0.114 * buf[at(x, y) + 2]
          let s = 0
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1 - 1; x++) s += Math.abs(grey(x + 1, y) - grey(x, y))
          details.push(s / ((y1 - y0) * (x1 - x0 - 1)))
        }
      }
      return { sigs, details }
    },
    { times, box, gx: g.gx, gy: g.gy, detailBox }
  )
  return { sigs: r.sigs.map((s) => Float64Array.from(s)), details: r.details }
}

/** Shows time t in the preview once nothing is missing (photos loaded, motion decoded). */
async function settle(page: Page, t: number): Promise<void> {
  await page.evaluate((tt) => (window as any).__diashow.player.current.seek(tt), t)
  // rendered here, so `missing` is about this time and not the frame before the seek
  await page.waitForFunction(
    (tt) => {
      const e = (window as any).__diashow.player.current.engine
      e.render(tt)
      return e.missing === 0
    },
    t,
    { timeout: 60_000, polling: 100 }
  )
}

/** Waits until the engine has decoded a slide's motion part; what it holds. */
async function decoded(page: Page, slide: SlideInfo, path: string): Promise<{ frames: number; fps: number; bytes: number; width: number; height: number; format: string }> {
  await settle(page, slide.start + slide.duration / 2)
  await page.waitForFunction((p) => (window as any).__diashow.player.current.engine.stats().motions.some((m: any) => m.path === p), path, { timeout: 60_000 })
  return state(page, `return d.player.current.engine.stats().motions.find((m) => m.path === ${JSON.stringify(path)})`)
}

async function exportShow(page: Page, outPath: string): Promise<void> {
  await page.evaluate(
    async ({ outPath, size }) => {
      const d = (window as any).__diashow
      await d.exportShow(d.store.getState().project, { outPath, ...size, fps: 30, codec: 'h264', quality: 'high', hardware: true }, 'de-DE', () => {}, new AbortController().signal)
    },
    { outPath, size: EXPORT_SIZE }
  )
}

const ALL_THEMES = ['kenburns', 'classic', 'retro', 'shatter', 'reflections', 'origami', 'panels', 'magazine', 'vintage', 'scrapbook', 'snapshots']

test('Live Photos loop and bounce: Slide tab, preview, export, pixelation and themes', async () => {
  test.setTimeout((SOFTWARE_GL ? 30 : 12) * 60 * 1000)
  ensureTestMedia()
  const heic = existsSync(join(mediaDir, 'iphone/IMG_0001.HEIC'))
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-live-'))
  const order = ['PXL_0002.jpg', ...(heic ? ['IMG_0001.HEIC'] : []), 'IMG_0003.JPG', 'PXL_0003.MP.jpg', 'photo.webp']
  const files = copyMedia(['android/PXL_0002.jpg', ...(heic ? ['iphone/IMG_0001.HEIC', 'iphone/IMG_0001.MOV'] : []), 'iphone/IMG_0003.JPG', 'android/PXL_0003.MP.jpg', 'misc/photo.webp'], join(dataDir, 'media'))
  let s: Session | null = null
  try {
    s = await launch(dataDir)
    const { page } = s
    await page.evaluate(async (paths) => (window as any).__diashow.store.getState().createProject(paths, 'Live'), files)
    await page.waitForFunction(
      (n) => {
        const p = (window as any).__diashow.store.getState().project
        return p && p.media.length === n && p.media.every((m: any) => m.status === 'ready')
      },
      order.length,
      { timeout: 300_000, polling: 250 }
    )
    // in the order given, Classic (full frame, standing still), no title
    await state(page, `s.update((p) => { const order = ${JSON.stringify(order)}; const name = (e) => p.media.find((m) => m.id === e.mediaId).name; p.entries.sort((a, b) => order.indexOf(name(a)) - order.indexOf(name(b))) }); s.setTheme('classic'); s.setSettings({ showTitle: false })`)
    type Live = { name: string; entry: string; liveVideo: string; aspect: number; duration: number }
    const lives = await state<Live[]>(
      page,
      `return s.project.media.filter((m) => m.live).map((m) => ({ name: m.name, entry: s.project.entries.find((e) => e.mediaId === m.id).id, liveVideo: m.liveVideo, aspect: m.width / m.height, duration: m.live.duration }))`
    )
    expect(lives.map((l) => l.name).sort()).toEqual([...(heic ? ['IMG_0001.HEIC'] : []), 'PXL_0003.MP.jpg'])
    expect(lives.every((l) => !!l.liveVideo)).toBe(true)
    const iphone = lives.find((l) => l.name === 'IMG_0001.HEIC')
    const android = lives.find((l) => l.name === 'PXL_0003.MP.jpg')!
    const first = iphone ?? android
    const entryOf = (id: string): Promise<any> => state(page, `return s.project.entries.find((e) => e.id === ${JSON.stringify(id)})`)

    // ---- the Slide tab: one photo through every choice, then two at once
    const card = (entry: string) => page.locator(`.cards .card[data-entry="${entry}"]`)
    const mark = (entry: string) => card(entry).locator('.live-mark')
    const mode = page.locator('[data-testid="live-mode"]')
    await state(page, `s.set({ tab: 'slide' })`)
    await card(first.entry).scrollIntoViewIfNeeded()
    await card(first.entry).click()
    await expect(mode).toBeVisible()
    expect(await mode.locator('option').allInnerTexts()).toEqual(EN ? ['Default (Off)', 'Off (still)', 'Live (once)', 'Loop', 'Bounce'] : ['Standard (Aus)', 'Aus (Standbild)', 'Live (einmal)', 'Endlosschleife', 'Abpraller'])
    await expect(mode).toHaveValue('default')
    await expect(mark(first.entry)).toHaveAttribute('data-effect', 'off')
    await mode.selectOption('on')
    expect(await entryOf(first.entry)).toMatchObject({ playLive: true })
    await expect(mark(first.entry)).toHaveAttribute('data-effect', 'live')
    await expect(mark(first.entry).locator('svg')).toHaveCount(0)
    await mode.selectOption('loop')
    expect(await entryOf(first.entry)).toMatchObject({ playLive: true, liveEffect: 'loop' })
    await expect(mark(first.entry)).toHaveAttribute('data-effect', 'loop')
    await expect(mark(first.entry).locator('svg')).toHaveCount(1)
    await mode.selectOption('off')
    const off = await entryOf(first.entry)
    expect(off.playLive).toBe(false)
    expect(off.liveEffect).toBeUndefined()
    await mode.selectOption('default')
    expect((await entryOf(first.entry)).playLive).toBeUndefined()
    if (iphone) {
      // both selected: one control for both, "mixed" until one choice is made for both
      await mode.selectOption('loop')
      await card(android.entry).scrollIntoViewIfNeeded()
      await card(android.entry).click({ modifiers: ['Control'] })
      await expect(page.locator('[data-testid="live-mode"] option[value="mixed"]')).toHaveCount(1)
      await expect(mode).toHaveValue('mixed')
      await mode.selectOption('bounce')
      for (const l of lives) expect(await entryOf(l.entry)).toMatchObject({ playLive: true, liveEffect: 'bounce' })
      await expect(mark(android.entry)).toHaveAttribute('data-effect', 'bounce')
      await expect(mark(iphone.entry)).toHaveAttribute('data-effect', 'bounce')
      // a Loop and a Bounce take a slide of their own, also in a theme of several photos per slide
      await state(page, `s.setTheme('magazine')`)
      for (const l of lives) expect((await slides(page)).find((x) => x.media.includes(l.name))!.n).toBe(1)
      // and the slide menu doesn't offer to combine one with another slide (it would stay alone anyway)
      const k = (await slides(page)).findIndex((x) => x.media.includes(lives[0].name))
      const other = k > 0 ? k - 1 : k + 1
      await state(page, `const tl = d.player.current.tl; s.select([...tl.slides[${k}].entries, ...tl.slides[${other}].entries].map((e) => e.id))`)
      await page.locator(`.cards .card[data-index="${Math.max(k, other)}"]`).click({ button: 'right' })
      await expect(page.getByRole('menuitem', { name: /^(Textfolie hinzufügen|Add text slide)$/ })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: /^(Zu einer Folie zusammenfassen|Combine into one slide|Mit vorheriger Folie verbinden|Join with previous slide)$/ })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await state(page, `s.setTheme('classic')`)
    }
    await state(page, `s.select([])`)

    // ---- frame by frame: the preview between the transitions, then an export of just that slide
    // (8 s each, so a slide shows several cycles; without HEIC support the Motion Photo does both)
    const cases: { l: Live; effect: LiveEffect }[] = iphone ? [{ l: iphone, effect: 'loop' }, { l: android, effect: 'bounce' }] : [{ l: android, effect: 'loop' }, { l: android, effect: 'bounce' }]
    for (const { l, effect } of cases) {
      await state(page, `s.updateEntries([${JSON.stringify(l.entry)}], (e) => { e.playLive = true; e.liveEffect = ${JSON.stringify(effect)}; e.whole = true; e.duration = 8 })`)
      const sl = (await slides(page)).find((x) => x.media.includes(l.name))!
      expect(sl.live).toEqual({ duration: l.duration, effect })
      const clip = await decoded(page, sl, l.liveVideo)
      console.log(`${l.name}: ${clip.frames} frames at ${clip.fps.toFixed(2)} fps, kept as ${clip.width}x${clip.height} ${clip.format}, ${(clip.bytes / 1e6).toFixed(1)} MB`)
      expect(clip.format).not.toBe('RGBA')
      const n = clip.frames
      const g: Grid = l.aspect < 1 ? { gx: 24, gy: 32 } : { gx: 32, gy: 24 }
      // every frame slot between the transitions, at its middle
      const from = Math.ceil((sl.transIn + 0.05) * clip.fps)
      const to = Math.floor((sl.duration - sl.transOut - 0.05) * clip.fps)
      const locals = Array.from({ length: to - from }, (_, k) => (from + k + 0.5) / clip.fps)
      const [W, H] = await state<[number, number]>(page, `const c = d.player.current.engine.c; return [c.W, c.H]`)
      const pic = fitted(W, H, l.aspect)
      const box = norm(within(pic), W, H)
      const preview = await render(page, locals.map((x) => sl.start + x), box, g)
      const ref = reference(l.liveVideo, clip, g, preview.sigs)
      expect(ref.refs.length).toBe(n)
      const want = locals.map((x) => motionFrame(effect, x, n, clip.fps))
      check(`preview ${W}x${H}`, effect, n, want, preview.sigs, ref)

      await state(page, `const keep = ${JSON.stringify(l.entry)}; s.update((p) => p.entries.forEach((e) => { if (e.id !== keep) e.excluded = true }))`)
      expect((await slides(page)).map((x) => x.duration)).toEqual([8])
      const out = join(dataDir, `${effect}.mp4`)
      await exportShow(page, out)
      const { width: EW, height: EH } = EXPORT_SIZE
      const ex = videoSigs(out, EW, EH, within(fitted(EW, EH, l.aspect)), g)
      expect(ex.length).toBe(8 * FPS)
      // the export renders frame j at j / 30 s
      check(`export ${EW}x${EH}`, effect, n, ex.map((_, j) => motionFrame(effect, j / FPS, n, clip.fps)), ex, ref)

      // ---- a pixelated area stays pixelated while it loops, at the seam too (iPhone clip: its checkerboard)
      if (l === iphone) {
        const areaN = norm(inner(pic, PRIVATE), W, H)
        // (the slide alone now, as exported)
        const times = locals.filter((_, k) => k % 3 === 0 || want[k].b != null)
        await settle(page, times[0])
        const sharp = (await render(page, times, box, g, areaN)).details
        await state(page, `s.updateEntries([${JSON.stringify(l.entry)}], (e) => { e.privacy = [${JSON.stringify(PRIVATE)}] })`)
        await settle(page, times[0])
        const pixelated = (await render(page, times, box, g, areaN)).details
        console.log(`pixelated area, preview: ${median(pixelated).toFixed(1)} (up to ${Math.max(...pixelated).toFixed(1)}) against ${median(sharp).toFixed(1)} sharp`)
        expect(Math.max(...pixelated)).toBeLessThan(0.35 * Math.min(...sharp))
        // the export's first 4 s: the first pass and a seam
        await state(page, `s.updateEntries([${JSON.stringify(l.entry)}], (e) => { e.duration = 4 })`)
        const pixOut = join(dataDir, 'pixelated.mp4')
        await exportShow(page, pixOut)
        const exArea = inner(fitted(EW, EH, l.aspect), PRIVATE)
        const exPix = exportDetail(pixOut, exArea)
        const exSharp = exportDetail(out, exArea).slice(0, exPix.length)
        console.log(`pixelated area, export: ${median(exPix).toFixed(1)} (up to ${Math.max(...exPix).toFixed(1)}) against ${median(exSharp).toFixed(1)} sharp`)
        expect(exPix.length).toBe(4 * FPS)
        expect(Math.max(...exPix)).toBeLessThan(0.35 * Math.min(...exSharp))
        await state(page, `s.updateEntries([${JSON.stringify(l.entry)}], (e) => { delete e.privacy; e.duration = 8 })`)
      }
      await state(page, `s.update((p) => p.entries.forEach((e) => { delete e.excluded }))`)
    }

    // ---- every theme draws the motion: a Loop at 5 s against the still a Live Photo shows by then
    const l = first
    await state(page, `s.updateEntries([${JSON.stringify(l.entry)}], (e) => { e.liveEffect = 'loop'; delete e.whole })`)
    const frame: Box = { x: 0, y: 0, w: 1, h: 1 }
    const wide: Grid = { gx: 32, gy: 18 }
    const diffs: string[] = []
    for (const theme of ALL_THEMES) {
      await state(page, `s.setTheme(${JSON.stringify(theme)})`)
      const sl = (await slides(page)).find((x) => x.media.includes(l.name))!
      expect(sl.live?.effect).toBe('loop')
      expect(sl.n).toBe(1)
      const t = sl.start + 5
      await settle(page, t)
      const [looping] = (await render(page, [t], frame, wide)).sigs
      const asks = await state<string[]>(page, `return d.player.current.engine.stats().motions.map((m) => m.path)`)
      expect(asks).toContain(l.liveVideo)
      await state(page, `s.updateEntries([${JSON.stringify(l.entry)}], (e) => { delete e.liveEffect })`)
      await settle(page, t)
      const [still] = (await render(page, [t], frame, wide)).sigs
      await state(page, `s.updateEntries([${JSON.stringify(l.entry)}], (e) => { e.liveEffect = 'loop' })`)
      const d = dist(looping, still)
      diffs.push(`${theme} ${d.toFixed(1)}`)
      expect(d, theme).toBeGreaterThan(3)
    }
    console.log('loop against still, per theme:', diffs.join(' | '))

    // ---- Snapshots: a print on the pile shows the photo, so an export decodes each motion part once
    // (the pile asked for the motion on every frame, and the export started decoding it anew each time)
    await state(page, `s.setTheme('snapshots'); s.update((p) => p.entries.forEach((e) => { e.duration = 2 }))`)
    const parts = lives.map((x) => x.liveVideo.split(/[\\/]/).pop()!)
    let reads = 0
    const count = (r: { url(): string }): void => {
      if (parts.some((n) => decodeURIComponent(r.url()).includes(n))) reads++
    }
    page.on('request', count)
    await exportShow(page, join(dataDir, 'snapshots.mp4'))
    page.off('request', count)
    console.log(`Snapshots export: ${reads} reads of ${parts.length} motion parts`)
    expect(reads).toBeLessThanOrEqual(4 * parts.length)

    // ---- Magazine preview: a Loop on screen keeps its decoded motion part. Its cells fade in one after
    // another, so for a few frames nothing draws it; with three motion parts around, the sweep dropped it
    // then and decoded it again (the still showed meanwhile)
    if (iphone) {
      const third = copyMedia(['iphone/IMG_0001.HEIC', 'iphone/IMG_0001.MOV'], join(dataDir, 'third'), true)
      await page.evaluate(async (paths) => (window as any).__diashow.store.getState().importMedia(paths), third)
      await page.waitForFunction(() => {
        const p = (window as any).__diashow.store.getState().project
        return p.media.filter((m: any) => m.live && m.liveVideo && m.status === 'ready').length === 3
      }, null, { timeout: 300_000, polling: 250 })
      await state(page, `s.update((p) => { const live = p.entries.filter((e) => p.media.find((m) => m.id === e.mediaId).live); p.entries = [...live, ...p.entries.filter((e) => !live.includes(e))]; p.entries.forEach((e) => { e.duration = 3 }); live.forEach((e) => { e.playLive = true; e.liveEffect = 'loop' }) }); s.setTheme('magazine')`)
      const kept = await state<{ loops: number; released: boolean }>(
        page,
        `const e = d.player.current.engine; const loops = d.player.current.tl.slides.filter((x) => x.live && x.live.effect); const second = loops[1];
        const released = []; const release = e.motions.release.bind(e.motions); e.motions.release = (p) => { released.push(p); release(p) };
        try { for (let t = second.start - 1.5; t < second.start + 1; t += 1 / 60) e.render(t) } finally { e.motions.release = release }
        return { loops: loops.length, released: released.includes(second.media[0].liveVideo) }`
      )
      expect(kept).toEqual({ loops: 3, released: false })
    }

    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close()
    removeDir(dataDir)
  }
})
