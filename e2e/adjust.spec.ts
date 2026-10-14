// Light and colour (brightness, contrast, warmth, saturation), end to end: the sliders in the Slide tab
// (a live preview while dragging, nothing stored before the pointer lets go, one undo step per drag or
// run of key presses, Shift for steps of 10), the edited thumbnail and its mark, undo and redo, several
// slides at once, the edit view's "Light and colour" tool with Cancel, a pixelated face that stays flat
// when the picture is brightened, and an exported MP4 whose frame matches the preview. A turned and
// brightened video is checked in the preview and the export too.
// The test photo is a dark grey with two checkerboards: F (pixelated) and C (a control that stays sharp).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import type { MediaAdjust, MediaEdit, Rect } from '../src/shared/types'
import { launch, removeDir, root, type Session } from './harness'
import { EXPORT_SIZE, SOFTWARE_GL } from './launch'

const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')
const shots = join(root, 'test-results', 'adjust')
const keep = (name: string, png: Buffer): void => {
  mkdirSync(shots, { recursive: true })
  writeFileSync(join(shots, name), png)
}

const W = 1600
const H = 1200
const GREY = 96
/** The checkerboards, normalised to the photo: F gets pixelated, C stays sharp. */
const F: Rect = { x: 900 / W, y: 360 / H, w: 480 / W, h: 480 / H }
const C: Rect = { x: 160 / W, y: 600 / H, w: 480 / W, h: 480 / H }
/** A point on the plain grey, clear of both boards. */
const P: [number, number] = [0.25, 0.22]

type RGB = [number, number, number]
const state = <T,>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const d = window.__diashow; const s = d.store.getState(); ${fn} })()`) as Promise<T>
const editOf = (page: Page, name: string): Promise<MediaEdit | null> => state(page, `return s.project.media.find((m) => m.name === ${JSON.stringify(name)})?.edit ?? null`)
const adjustOf = async (page: Page, name: string): Promise<MediaAdjust> => (await editOf(page, name))?.adjust ?? {}

async function checker(size: number, cell: number): Promise<Buffer> {
  const px = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) px.fill((Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 235 : 25, (y * size + x) * 3, (y * size + x) * 3 + 3)
  return sharp(px, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer()
}

/** A plain grey photo with the checkerboards on it. */
async function photo(file: string, w: number, h: number, boards: Rect[] = []): Promise<void> {
  const tile = boards.length ? await checker(Math.round(boards[0].w * w), 30) : null
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: GREY, g: GREY, b: GREY } } })
    .composite(boards.map((r) => ({ input: tile!, left: Math.round(r.x * w), top: Math.round(r.y * h) })))
    .jpeg({ quality: 94 })
    .toFile(file)
}

type Pixels = { data: Buffer; width: number; height: number }
async function pixels(png: Buffer): Promise<Pixels> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Mean colour around a point (fractions of the picture). */
function colourAt(p: Pixels, x: number, y: number): RGB {
  const cx = Math.round(x * p.width)
  const cy = Math.round(y * p.height)
  const sum = [0, 0, 0]
  let n = 0
  for (let yy = cy - 2; yy <= cy + 2; yy++) for (let xx = cx - 2; xx <= cx + 2; xx++) {
    const i = (Math.min(p.height - 1, Math.max(0, yy)) * p.width + Math.min(p.width - 1, Math.max(0, xx))) * 3
    for (let k = 0; k < 3; k++) sum[k] += p.data[i + k]
    n++
  }
  return sum.map((v) => v / n) as RGB
}

const luma = (c: RGB): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
const warmth = (c: RGB): number => c[0] - c[2]
const fmt = (c: RGB): string => `rgb(${c.map((v) => v.toFixed(0)).join(', ')})`

/** Mean absolute horizontal step of the grey value inside a box: a checkerboard scores high, a pixelated one next to nothing. */
function detail(p: Pixels, box: Rect): number {
  const x0 = Math.round(box.x * p.width)
  const x1 = Math.round((box.x + box.w) * p.width)
  const y0 = Math.round(box.y * p.height)
  const y1 = Math.round((box.y + box.h) * p.height)
  const grey = (i: number): number => 0.3 * p.data[i] + 0.59 * p.data[i + 1] + 0.11 * p.data[i + 2]
  let s = 0
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1 - 1; x++) {
    s += Math.abs(grey((y * p.width + x + 1) * 3) - grey((y * p.width + x) * 3))
    n++
  }
  return s / Math.max(1, n)
}

/** Mean luma inside a box. */
function meanLuma(p: Pixels, box: Rect): number {
  let s = 0
  let n = 0
  for (let y = Math.round(box.y * p.height); y < Math.round((box.y + box.h) * p.height); y++) for (let x = Math.round(box.x * p.width); x < Math.round((box.x + box.w) * p.width); x++) {
    const i = (y * p.width + x) * 3
    s += luma([p.data[i], p.data[i + 1], p.data[i + 2]])
    n++
  }
  return s / Math.max(1, n)
}

const inner = (r: Rect, k = 0.3): Rect => ({ x: r.x + r.w * k, y: r.y + r.h * k, w: r.w * (1 - 2 * k), h: r.h * (1 - 2 * k) })

/** Where the whole 4:3 photo sits on the 16:9 frame, and a box of the photo on the frame. */
const PIC = { x: (1 - 4 / 3 / (16 / 9)) / 2, y: 0, w: 4 / 3 / (16 / 9), h: 1 }
const onFrame = (r: Rect): Rect => ({ x: PIC.x + r.x * PIC.w, y: PIC.y + r.y * PIC.h, w: r.w * PIC.w, h: r.h * PIC.h })
const pointOnFrame = (p: [number, number]): [number, number] => [PIC.x + p[0] * PIC.w, PIC.y + p[1] * PIC.h]

async function look(png: Buffer, label: string): Promise<{ p: RGB; f: number; c: number; fLuma: number }> {
  const px = await pixels(png)
  const out = { p: colourAt(px, ...pointOnFrame(P)), f: detail(px, onFrame(inner(F))), c: detail(px, onFrame(inner(C))), fLuma: meanLuma(px, onFrame(inner(F))) }
  console.log(`${label}: grey ${fmt(out.p)} (luma ${luma(out.p).toFixed(1)}, R-B ${warmth(out.p).toFixed(1)}); detail in F ${out.f.toFixed(1)} (luma ${out.fLuma.toFixed(1)}), in C ${out.c.toFixed(1)}`)
  return out
}

const slider = (scope: Locator, name: RegExp): Locator => scope.getByRole('slider', { name })
const BRIGHTNESS = /^(Helligkeit|Brightness)$/
const CONTRAST = /^(Kontrast|Contrast)$/
const WARMTH = /^(Wärme|Warmth)$/
const SATURATION = /^(Sättigung|Saturation)$/

async function exportFrame(page: Page, dir: string, name: string, at: number): Promise<Buffer> {
  const out = join(dir, `${name}.mp4`)
  const before = await state<number>(page, `return s.exportJobs.length`)
  await page.evaluate(({ file, size, title }) => {
    const d = (window as any).__diashow
    return d.queueExport(d.store.getState().project, { outPath: file, ...size, fps: 25, codec: 'h264', quality: 'standard', hardware: true, locale: 'de-DE' }, title)
  }, { file: out, size: EXPORT_SIZE, title: name })
  await page.waitForFunction((n) => {
    const jobs = (window as any).__diashow.store.getState().exportJobs
    return jobs.length > n && jobs.every((j: any) => j.state === 'done' || j.state === 'error')
  }, before, { timeout: 600_000, polling: 250 })
  expect(await state<string[]>(page, `return s.exportJobs.map((j) => j.state)`)).not.toContain('error')
  const still = execFileSync(ffmpeg, ['-v', 'error', '-ss', at.toFixed(3), '-i', out, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'])
  keep(`${name}.png`, still)
  return still
}

test('light and colour: sliders, live preview, undo, several slides, pixelation and export', async () => {
  test.setTimeout((SOFTWARE_GL ? 15 : 6) * 60 * 1000)
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-adjust-'))
  const media = join(dataDir, 'media')
  mkdirSync(media)
  const file = join(media, 'light.jpg')
  await photo(file, W, H, [F, C])
  const second = join(media, 'second.jpg')
  await photo(second, 1200, 900)
  let s: Session | null = null
  try {
    s = await launch(dataDir)
    const { page } = s
    await page.evaluate(async (files) => (window as any).__diashow.store.getState().createProject(files, 'Light'), [file, second])
    await page.waitForFunction(() => {
      const p = (window as any).__diashow.store.getState().project
      return p && p.media.length === 2 && p.media.every((m: any) => m.status === 'ready')
    }, null, { timeout: 180_000, polling: 250 })
    // whole pictures on a plain theme, with the plain look: the frame shows the photo as it is
    await state(page, `s.setTheme('classic'); d.store.getState().setSettings({ look: 'natural', showTitle: false, scaleToFill: false, timing: { mode: 'custom', customTotal: 8 } })`)
    const entry = await state<string>(page, `const m = s.project.media.find((x) => x.name === 'light.jpg'); const e = s.project.entries.find((x) => x.mediaId === m.id); s.select([e.id]); s.set({ tab: 'slide' }); return e.id`)
    const slide = await state<{ start: number; duration: number; index: number }>(page, `const sl = d.player.current.tl.slides.find((x) => x.entries[0].id === ${JSON.stringify(entry)}); return { start: sl.start, duration: sl.duration, index: sl.index }`)
    const mid = slide.start + slide.duration / 2
    await state(page, `d.player.current.seek(${mid})`)
    const frame = page.locator('.frame')
    const inspector = page.locator('.inspector')

    // the plain picture: a dark neutral grey
    let base = await look(await frame.screenshot(), 'before')
    await expect.poll(async () => {
      base = await look(await frame.screenshot(), 'before')
      return Math.abs(luma(base.p) - GREY) < 12 && Math.abs(warmth(base.p)) < 6
    }, { timeout: 30_000, intervals: [300] }).toBe(true)

    // ---- the sliders: labelled, at 0, no "Auto"
    for (const name of [BRIGHTNESS, CONTRAST, WARMTH, SATURATION]) await expect(slider(inspector, name)).toHaveValue('0')
    await expect(inspector.locator('.adjust').getByRole('button', { name: /^Auto/ })).toHaveCount(0)
    await expect(inspector.getByRole('button', { name: /Helligkeit zurücksetzen|Reset brightness/ })).toBeDisabled()

    // ---- brightness by dragging: the preview follows live, the project only when the pointer lets go
    const bright = slider(inspector, BRIGHTNESS)
    const box = (await bright.boundingBox())!
    const sx = box.x + box.width / 2
    const sy = box.y + box.height / 2
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    for (let k = 1; k <= 8; k++) {
      await page.mouse.move(sx + (box.width * 0.22 * k) / 8, sy)
      if (k === 6) {
        expect(await editOf(page, 'light.jpg')).toBeNull()
        await expect.poll(async () => luma((await look(await frame.screenshot(), 'while dragging')).p), { timeout: 10_000, intervals: [200] }).toBeGreaterThan(luma(base.p) + 10)
        expect(await editOf(page, 'light.jpg')).toBeNull()
      }
    }
    await page.mouse.up()
    await expect.poll(async () => (await adjustOf(page, 'light.jpg')).brightness ?? 0).toBeGreaterThan(25)
    const level = (await adjustOf(page, 'light.jpg')).brightness
    expect(level).toBeLessThan(70)
    await expect(bright).toHaveValue(String(level))
    expect(await state<boolean>(page, `return s.canUndo`)).toBe(true)

    // ---- warmth with the keys: Shift moves by 10, a run of presses is one undo step
    const warm = slider(inspector, WARMTH)
    await warm.focus()
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => adjustOf(page, 'light.jpg')).toEqual({ brightness: level, warmth: 31 })
    await expect(warm).toHaveAttribute('aria-valuetext', '+31')
    // the focused slider keeps its arrow keys, not Ctrl+Z / Ctrl+Y
    await page.keyboard.press('Control+z')
    await expect.poll(() => adjustOf(page, 'light.jpg')).toEqual({ brightness: level })
    await page.keyboard.press('Control+y')
    await expect.poll(() => adjustOf(page, 'light.jpg')).toEqual({ brightness: level, warmth: 31 })
    const adjusted = (await editOf(page, 'light.jpg'))!

    // the preview: brighter and warmer
    let after = base
    await expect.poll(async () => {
      after = await look(await frame.screenshot(), 'brighter and warmer')
      return luma(after.p) > luma(base.p) + 15 && warmth(after.p) > warmth(base.p) + 12
    }, { timeout: 15_000, intervals: [250] }).toBe(true)
    keep('preview.png', await frame.screenshot())

    // ---- the thumbnail: the same math on the CPU, and the "edited" mark on the card
    const card = page.locator(`.card[data-index="${slide.index}"]`)
    await expect(card.locator('.edited-mark')).toHaveCount(1)
    const thumbAt = (): Promise<RGB | null> =>
      page.evaluate(({ idx, x, y }) => {
        const img = document.querySelector<HTMLImageElement>(`.card[data-index="${idx}"] img`)
        if (!img || !img.complete || !img.naturalWidth || !img.src.startsWith('blob:')) return null
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const g = c.getContext('2d')!
        g.drawImage(img, 0, 0)
        const d = g.getImageData(Math.round(x * c.width), Math.round(y * c.height), 1, 1).data
        return [d[0], d[1], d[2]] as [number, number, number]
      }, { idx: slide.index, x: P[0], y: P[1] })
    let thumb: RGB | null = null
    await expect.poll(async () => {
      thumb = await thumbAt()
      return !!thumb && Math.abs(luma(thumb) - luma(after.p)) < 8 && Math.abs(warmth(thumb) - warmth(after.p)) < 8
    }, { timeout: 15_000, intervals: [300] }).toBe(true)
    console.log(`thumbnail: ${fmt(thumb!)} against the preview's ${fmt(after.p)}`)

    // ---- undo and redo: the warmth run, then the drag; and back
    await card.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => adjustOf(page, 'light.jpg')).toEqual({ brightness: level })
    await page.keyboard.press('Control+z')
    await expect.poll(() => editOf(page, 'light.jpg')).toBeNull()
    await expect(slider(inspector, BRIGHTNESS)).toHaveValue('0')
    await expect(card.locator('.edited-mark')).toHaveCount(0)
    await page.keyboard.press('Control+y')
    await page.keyboard.press('Control+y')
    await expect.poll(() => editOf(page, 'light.jpg')).toEqual(adjusted)
    await expect(slider(inspector, BRIGHTNESS)).toHaveValue(String(level))

    // ---- the reset button sets one slider back (one step)
    await inspector.getByRole('button', { name: /Wärme zurücksetzen|Reset warmth/ }).click()
    await expect.poll(() => adjustOf(page, 'light.jpg')).toEqual({ brightness: level })
    await card.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => editOf(page, 'light.jpg')).toEqual(adjusted)

    // ---- several slides: the sliders set their value on every selected picture, in one step
    await card.focus()
    await page.keyboard.press('Control+a')
    await expect(page.locator('.inspector').getByText(/Ein Regler setzt seinen Wert|A slider sets its value/)).toBeVisible()
    const batchBright = slider(inspector, BRIGHTNESS)
    await expect(batchBright).toHaveAttribute('aria-valuetext', /unterschiedlich|mixed/)
    const batchContrast = slider(inspector, CONTRAST)
    await batchContrast.focus()
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await expect.poll(async () => [await adjustOf(page, 'light.jpg'), await adjustOf(page, 'second.jpg')]).toEqual([{ brightness: level, warmth: 31, contrast: 20 }, { contrast: 20 }])
    await batchBright.focus()
    await page.keyboard.press('End')
    await expect.poll(async () => [(await adjustOf(page, 'light.jpg')).brightness, (await adjustOf(page, 'second.jpg')).brightness]).toEqual([100, 100])
    await card.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(async () => [await adjustOf(page, 'light.jpg'), await adjustOf(page, 'second.jpg')]).toEqual([{ brightness: level, warmth: 31, contrast: 20 }, { contrast: 20 }])
    await page.keyboard.press('Control+z')
    await expect.poll(async () => [await editOf(page, 'light.jpg'), await editOf(page, 'second.jpg')]).toEqual([adjusted, null])
    await state(page, `s.select([${JSON.stringify(entry)}]); s.set({ tab: 'slide' })`)

    // ---- the edit view's "Light and colour" tool: the same sliders, live on its own picture, Cancel puts the edit back
    await inspector.getByRole('button', { name: /^(Bearbeiten|Edit)$/ }).click()
    const view = page.getByRole('dialog', { name: /Foto bearbeiten|Edit photo/ })
    await expect(view).toBeVisible()
    await view.getByRole('button', { name: /^(Licht und Farbe|Light and colour)$/ }).click()
    await expect(view.getByRole('button', { name: /^(Licht und Farbe|Light and colour)$/ })).toHaveAttribute('aria-pressed', 'true')
    for (const name of [BRIGHTNESS, CONTRAST, WARMTH, SATURATION]) await expect(slider(view, name)).toBeVisible()
    await expect(view.locator('canvas[data-adjusted]')).toBeVisible()
    // its picture follows a drag before anything is stored
    const pic = view.locator('.pe-picture')
    const viewLuma = async (): Promise<number> => luma(colourAt(await pixels(await pic.screenshot()), ...P))
    let viewBefore = 0
    await expect.poll(async () => (viewBefore = await viewLuma()), { timeout: 10_000, intervals: [200] }).toBeGreaterThan(luma(base.p) + 15)
    const vb = (await slider(view, BRIGHTNESS).boundingBox())!
    const vx = vb.x + (vb.width * (level! + 100)) / 200
    await page.mouse.move(vx, vb.y + vb.height / 2)
    await page.mouse.down()
    for (let k = 1; k <= 6; k++) await page.mouse.move(vx - (vb.width * 0.3 * k) / 6, vb.y + vb.height / 2)
    await expect.poll(viewLuma, { timeout: 10_000, intervals: [200] }).toBeLessThan(viewBefore - 15)
    expect(await editOf(page, 'light.jpg')).toEqual(adjusted)
    await page.mouse.up()
    await expect.poll(async () => (await adjustOf(page, 'light.jpg')).brightness ?? 0).toBeLessThan(level! - 30)
    const viewContrast = slider(view, CONTRAST)
    await viewContrast.focus()
    await page.keyboard.press('Shift+ArrowLeft')
    await expect.poll(async () => (await adjustOf(page, 'light.jpg')).contrast).toBe(-10)
    keep('edit-view.png', await page.screenshot())
    await page.keyboard.press('Escape')
    await expect(view).toHaveCount(0)
    await expect.poll(() => editOf(page, 'light.jpg')).toEqual(adjusted)

    // ---- the pixelated face stays flat however bright the picture gets
    await state(page, `s.setEntry(${JSON.stringify(entry)}, { privacy: [${JSON.stringify(F)}] })`)
    await state(page, `d.player.current.seek(${mid})`)
    let flat = after
    await expect.poll(async () => {
      flat = await look(await frame.screenshot(), 'pixelated')
      return flat.c > 4 && flat.f < flat.c * 0.25
    }, { timeout: 30_000, intervals: [300] }).toBe(true)
    // all the way up: brighter and harder, still one colour per block
    const full = slider(inspector, BRIGHTNESS)
    await full.focus()
    await page.keyboard.press('End')
    await slider(inspector, CONTRAST).focus()
    await page.keyboard.press('End')
    await expect.poll(async () => adjustOf(page, 'light.jpg')).toEqual({ brightness: 100, contrast: 100, warmth: 31 })
    let brightest = flat
    await expect.poll(async () => {
      brightest = await look(await frame.screenshot(), 'pixelated, brightness and contrast 100')
      return brightest.fLuma > flat.fLuma + 8 && brightest.c > 4 && brightest.f < brightest.c * 0.25
    }, { timeout: 15_000, intervals: [300] }).toBe(true)
    keep('pixelated.png', await frame.screenshot())
    // back to the adjusted picture for the export (one step for the run of End presses on each slider)
    await card.focus()
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect.poll(() => editOf(page, 'light.jpg')).toEqual(adjusted)
    await state(page, `d.player.current.seek(${mid})`)
    let preview = after
    await expect.poll(async () => {
      preview = await look(await frame.screenshot(), 'preview for the export')
      return Math.abs(luma(preview.p) - luma(after.p)) < 3 && preview.f < preview.c * 0.25
    }, { timeout: 15_000, intervals: [300] }).toBe(true)

    // ---- export: the same colours as the preview, F still flat
    const r = await look(await exportFrame(page, dataDir, 'light', mid), 'export')
    for (let k = 0; k < 3; k++) expect(Math.abs(r.p[k] - preview.p[k]), `channel ${k}: export ${fmt(r.p)}, preview ${fmt(preview.p)}`).toBeLessThan(8)
    expect(warmth(r.p)).toBeGreaterThan(warmth(base.p) + 12)
    expect(r.c).toBeGreaterThan(4)
    expect(r.f).toBeLessThan(r.c * 0.25)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})

// Videos go through the same step per frame: a clip made brighter and cooler plays so in the preview and the export.
test('a video with light and colour: preview and export', async () => {
  test.setTimeout((SOFTWARE_GL ? 10 : 5) * 60 * 1000)
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-adjust-video-'))
  const media = join(dataDir, 'media')
  mkdirSync(media)
  const clipFile = join(media, 'clip.mp4')
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x806040:s=640x360:r=25:d=3', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', clipFile])
  let s: Session | null = null
  try {
    s = await launch(dataDir)
    const { page } = s
    await page.evaluate(async (files) => (window as any).__diashow.store.getState().createProject(files, 'Video light'), [clipFile])
    await page.waitForFunction(() => {
      const p = (window as any).__diashow.store.getState().project
      return p && p.media.length === 1 && p.media[0].status === 'ready'
    }, null, { timeout: 180_000, polling: 250 })
    await state(page, `s.setTheme('classic'); d.store.getState().setSettings({ look: 'natural', showTitle: false, scaleToFill: false })`)
    await state(page, `const e = s.project.entries[0]; s.select([e.id]); s.set({ tab: 'slide' })`)
    const start = await state<number>(page, `return d.player.current.tl.slides.find((x) => x.kind === 'video').start`)
    const at = start + 1.2
    await state(page, `d.player.current.seek(${at})`)
    const frame = page.locator('.frame')
    const centre = async (png: Buffer): Promise<RGB> => colourAt(await pixels(png), 0.5, 0.5)
    let before: RGB = [0, 0, 0]
    await expect.poll(async () => {
      before = await centre(await frame.screenshot())
      return before[0] > 100 && before[0] - before[2] > 40
    }, { timeout: 30_000, intervals: [300] }).toBe(true)
    // brighter and cooler from the Slide tab, with the keys
    const inspector = page.locator('.inspector')
    await slider(inspector, BRIGHTNESS).focus()
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
    await slider(inspector, WARMTH).focus()
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft')
    await expect.poll(() => adjustOf(page, 'clip.mp4')).toEqual({ brightness: 30, warmth: -50 })
    await state(page, `d.player.current.seek(${at})`)
    let shown: RGB = before
    await expect.poll(async () => {
      shown = await centre(await frame.screenshot())
      return luma(shown) > luma(before) + 10 && warmth(shown) < warmth(before) - 15
    }, { timeout: 15_000, intervals: [300] }).toBe(true)
    console.log(`video preview: ${fmt(before)} -> ${fmt(shown)}`)
    const exported = await centre(await exportFrame(page, dataDir, 'video', at))
    console.log(`video export: ${fmt(exported)}`)
    for (let k = 0; k < 3; k++) expect(Math.abs(exported[k] - shown[k]), `channel ${k}: export ${fmt(exported)}, preview ${fmt(shown)}`).toBeLessThan(8)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
