// Rotate, straighten and crop, end to end: the edit view over the preview (buttons, slider, crop handles,
// aspect preset, keyboard), one undo step per gesture, Cancel and Done, Ctrl+R on several selected
// slides (and that it doesn't reload the window), the edited thumbnails, and a pixelated face that is
// partly cropped away: still covered where it shows, in the preview and in an exported MP4.
// The test photo has four coloured quadrants (to see where the picture's corners went) and two
// checkerboards: F (pixelated) and C (a control that stays sharp).
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { apply, editedAspect, rectToEdit, sourceToEdit } from '../src/shared/mediaEdit'
import { faceArea } from '../src/shared/people'
import type { MediaEdit, Rect } from '../src/shared/types'
import { launch, readProject, removeDir, root, type Session } from './harness'
import { EXPORT_SIZE, SOFTWARE_GL } from './launch'

const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')
const shots = join(root, 'test-results', 'edit')
/** Keeps a picture for a look (the folder is made again: a parallel run may have cleared test-results). */
const keep = (name: string, png: Buffer): void => {
  mkdirSync(shots, { recursive: true })
  writeFileSync(join(shots, name), png)
}

const W = 1600
const H = 1200
const ASPECT = W / H
/** The checkerboards, normalised to the photo: F gets pixelated, C stays sharp. */
const F: Rect = { x: 200 / W, y: 360 / H, w: 480 / W, h: 480 / H }
const C: Rect = { x: 920 / W, y: 360 / H, w: 480 / W, h: 480 / H }
/** A point in each quadrant of the original, clear of the checkerboards, and the colour it has. */
const QUADRANTS: { at: [number, number]; colour: 'red' | 'green' | 'blue' | 'yellow' }[] = [
  { at: [0.4, 0.1], colour: 'red' },
  { at: [0.8, 0.1], colour: 'green' },
  { at: [0.4, 0.9], colour: 'blue' },
  { at: [0.8, 0.9], colour: 'yellow' }
]

const state = <T,>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const d = window.__diashow; const s = d.store.getState(); ${fn} })()`) as Promise<T>
const editOf = (page: Page, name: string): Promise<MediaEdit | null> => state(page, `return s.project.media.find((m) => m.name === ${JSON.stringify(name)})?.edit ?? null`)

async function checker(size: number, cell: number): Promise<Buffer> {
  const px = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) px.fill((Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 245 : 20, (y * size + x) * 3, (y * size + x) * 3 + 3)
  return sharp(px, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer()
}

/** Four quadrants (red, green / blue, yellow) of the given size, with optional checkerboards on top. */
async function quadrants(file: string, w: number, h: number, boards: Rect[] = []): Promise<void> {
  const px = Buffer.alloc(w * h * 3)
  const colours = [[200, 40, 40], [40, 170, 60], [40, 70, 200], [220, 200, 40]]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(colours[(y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)], (y * w + x) * 3)
  const tile = await checker(Math.round(boards[0]?.w * w || 1), 30)
  await sharp(px, { raw: { width: w, height: h, channels: 3 } })
    .composite(boards.map((r) => ({ input: tile, left: Math.round(r.x * w), top: Math.round(r.y * h) })))
    .jpeg({ quality: 94 })
    .toFile(file)
}

type Pixels = { data: Buffer; width: number; height: number }
async function pixels(png: Buffer): Promise<Pixels> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Mean colour around a point (fractions of the picture). */
function colourAt(p: Pixels, x: number, y: number): [number, number, number] {
  const cx = Math.round(x * p.width)
  const cy = Math.round(y * p.height)
  const sum = [0, 0, 0]
  let n = 0
  for (let yy = cy - 2; yy <= cy + 2; yy++) for (let xx = cx - 2; xx <= cx + 2; xx++) {
    const i = (Math.min(p.height - 1, Math.max(0, yy)) * p.width + Math.min(p.width - 1, Math.max(0, xx))) * 3
    for (let k = 0; k < 3; k++) sum[k] += p.data[i + k]
    n++
  }
  return sum.map((v) => v / n) as [number, number, number]
}

function colourName([r, g, b]: [number, number, number]): string {
  if (r > 140 && g > 140 && b < 110) return 'yellow'
  if (r > g + 60 && r > b + 60) return 'red'
  if (g > r + 50 && g > b + 40) return 'green'
  if (b > r + 60 && b > g + 50) return 'blue'
  return `rgb(${r.toFixed(0)}, ${g.toFixed(0)}, ${b.toFixed(0)})`
}

/**
 * Mean absolute horizontal step of the grey value inside a box (fractions): a checkerboard scores about
 * 220 / (cell width in px), a pixelated one next to nothing.
 */
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

const clip = (r: Rect): Rect => {
  const x = Math.max(0, r.x)
  const y = Math.max(0, r.y)
  return { x, y, w: Math.max(0, Math.min(1, r.x + r.w) - x), h: Math.max(0, Math.min(1, r.y + r.h) - y) }
}
const inner = (r: Rect, k = 0.2): Rect => ({ x: r.x + r.w * k, y: r.y + r.h * k, w: r.w * (1 - 2 * k), h: r.h * (1 - 2 * k) })

/**
 * What the frame (16:9, whole picture centred) should show of the edited photo: where the quadrant
 * points land, and the visible part of F and of C.
 */
function expectations(edit: MediaEdit) {
  const a = editedAspect(ASPECT, edit)
  const fa = 16 / 9
  const pic = a > fa ? { x: 0, y: (1 - fa / a) / 2, w: 1, h: fa / a } : { x: (1 - a / fa) / 2, y: 0, w: a / fa, h: 1 }
  const onFrame = (r: Rect): Rect => ({ x: pic.x + r.x * pic.w, y: pic.y + r.y * pic.h, w: r.w * pic.w, h: r.h * pic.h })
  const back = sourceToEdit(edit, ASPECT)
  const points = QUADRANTS.map((q) => {
    const [u, v] = apply(back, ...q.at)
    return { ...q, u, v, frame: [pic.x + u * pic.w, pic.y + v * pic.h] as [number, number] }
  })
  const f = rectToEdit(F, edit, ASPECT)
  const fShown = clip(f)
  return { pic, points, f, fShown, fCore: onFrame(inner(fShown)), cCore: onFrame(inner(clip(rectToEdit(C, edit, ASPECT)))) }
}

async function checkPicture(png: Buffer, edit: MediaEdit, label: string): Promise<{ colours: string[]; f: number; c: number }> {
  const p = await pixels(png)
  const ex = expectations(edit)
  const colours = ex.points.map((q) => colourName(colourAt(p, ...q.frame)))
  const result = { colours, f: detail(p, ex.fCore), c: detail(p, ex.cCore) }
  console.log(`${label}: quadrants ${colours.join(', ')}; detail in F (pixelated) ${result.f.toFixed(1)}, in C ${result.c.toFixed(1)}`)
  return result
}

test('rotate, straighten and crop: edit view, undo, Ctrl+R, pixelation and export', async () => {
  test.setTimeout((SOFTWARE_GL ? 15 : 6) * 60 * 1000)
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-edit-'))
  const media = join(dataDir, 'media')
  mkdirSync(media)
  const photo = join(media, 'edit.jpg')
  await quadrants(photo, W, H, [F, C])
  await quadrants(join(media, 'wide.jpg'), 1200, 800)
  await quadrants(join(media, 'tall.jpg'), 900, 1200)
  let s: Session | null = null
  try {
    s = await launch(dataDir)
    const { page } = s
    await page.evaluate(async (files) => (window as any).__diashow.store.getState().createProject(files, 'Edit'), [photo, join(media, 'wide.jpg'), join(media, 'tall.jpg')])
    await page.waitForFunction(() => {
      const p = (window as any).__diashow.store.getState().project
      return p && p.media.length === 3 && p.media.every((m: any) => m.status === 'ready')
    }, null, { timeout: 180_000, polling: 250 })
    // whole pictures on a plain theme, so the frame shows the edited photo as it is
    await state(page, `s.setTheme('classic'); d.store.getState().setSettings({ showTitle: false, scaleToFill: false, timing: { mode: 'custom', customTotal: 9 } })`)
    const entry = await state<string>(page, `const m = s.project.media.find((x) => x.name === 'edit.jpg'); const e = s.project.entries.find((x) => x.mediaId === m.id); s.select([e.id]); s.set({ tab: 'slide' }); return e.id`)
    const frame = page.locator('.frame')

    // ---- the edit view from the Slide tab: a labelled view, the keys go to the crop frame
    await page.locator('.inspector').getByRole('button', { name: /^(Bearbeiten|Edit)$/ }).click()
    const view = page.getByRole('dialog', { name: /Foto bearbeiten|Edit photo/ })
    await expect(view).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('pe-crop'))).toBe(true)

    // rotate right (button), straighten 3° with the arrow keys (one undo step for the run of presses)
    await view.getByRole('button', { name: /Nach rechts drehen|Rotate right/ }).click()
    await expect.poll(() => editOf(page, 'edit.jpg')).toEqual({ rotate: 90, straighten: 0 })
    const slider = view.getByRole('slider', { name: /Begradigen|Straighten/ })
    await slider.focus()
    for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await editOf(page, 'edit.jpg'))?.straighten).toBe(3)
    await expect(slider).toHaveAttribute('aria-valuetext', /^3[.,]0°$/)

    // crop: drag the top edge down by a quarter of the frame (a draft while dragging, one step at the end)
    const crop = view.locator('.pe-crop')
    const handle = view.locator('.pe-handle.n')
    // the frame follows the size of the preview: wait until it stays put, then grab the edge's handle
    let hb = (await handle.boundingBox())!
    await expect
      .poll(async () => {
        const b = (await handle.boundingBox())!
        const still = Math.abs(b.x - hb.x) < 0.5 && Math.abs(b.y - hb.y) < 0.5
        hb = b
        return still
      }, { intervals: [250] })
      .toBe(true)
    const cb = (await crop.boundingBox())!
    const sx = hb.x + hb.width / 2
    const sy = hb.y + hb.height / 2
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    for (let k = 1; k <= 8; k++) {
      await page.mouse.move(sx, sy + (cb.height * 0.25 * k) / 8)
      if (k === 4) {
        // the thirds grid shows while dragging, and nothing is stored yet
        await expect(crop).toHaveClass(/guides/)
        expect((await editOf(page, 'edit.jpg'))?.crop).toBeUndefined()
      }
    }
    await page.mouse.up()
    await expect.poll(async () => (await editOf(page, 'edit.jpg'))?.crop?.y ?? 0).toBeGreaterThan(0.2)
    const dragged = (await editOf(page, 'edit.jpg'))!
    expect(dragged.crop!.y).toBeLessThan(0.3)
    expect(dragged.crop!.x).toBe(0)
    expect(dragged.crop!.w).toBe(1)
    keep('edit-view.png', await page.screenshot())

    // keyboard: Shift+← narrows the frame, Ctrl+Z takes it back
    await crop.focus()
    await page.keyboard.press('Shift+ArrowLeft')
    await expect.poll(async () => (await editOf(page, 'edit.jpg'))?.crop?.w).toBeCloseTo(0.99, 6)
    await page.keyboard.press('Control+z')
    await expect.poll(() => editOf(page, 'edit.jpg')).toEqual(dragged)

    // aspect preset 16:9 (the dragged crop happens to be square already): undo, redo, undo
    await view.getByRole('combobox', { name: /Format|Aspect/ }).selectOption('16:9')
    await expect.poll(async () => {
      const c = (await editOf(page, 'edit.jpg'))?.crop
      // the frame is turned: it is H wide and W high
      return c ? +(((c.w * H) / (c.h * W))).toFixed(3) : 0
    }).toBe(1.778)
    const square = (await editOf(page, 'edit.jpg'))!
    await page.keyboard.press('Control+z')
    await expect.poll(() => editOf(page, 'edit.jpg')).toEqual(dragged)
    await page.keyboard.press('Control+y')
    await expect.poll(() => editOf(page, 'edit.jpg')).toEqual(square)
    await page.keyboard.press('Control+z')
    await expect.poll(() => editOf(page, 'edit.jpg')).toEqual(dragged)
    // and before the drag there were the straightening and the turn: every gesture one step
    await page.keyboard.press('Control+z')
    await expect.poll(() => editOf(page, 'edit.jpg')).toEqual({ rotate: 90, straighten: 3 })
    await page.keyboard.press('Control+z')
    await expect.poll(() => editOf(page, 'edit.jpg')).toEqual({ rotate: 90, straighten: 0 })
    await page.keyboard.press('Control+y')
    await page.keyboard.press('Control+y')
    await expect.poll(() => editOf(page, 'edit.jpg')).toEqual(dragged)

    // Enter applies (Done)
    await crop.focus()
    await page.keyboard.press('Enter')
    await expect(view).toHaveCount(0)
    expect(await state<unknown>(page, `return s.photoEdit`)).toBeNull()

    // Esc cancels: Ctrl+R in the view turns left, Esc puts the edit back
    await page.locator('.inspector').getByRole('button', { name: /^(Bearbeiten|Edit)$/ }).click()
    await expect(view).toBeVisible()
    await page.keyboard.press('Control+r')
    await expect.poll(async () => (await editOf(page, 'edit.jpg'))?.rotate).toBe(0)
    await page.keyboard.press('Escape')
    await expect(view).toHaveCount(0)
    await expect.poll(() => editOf(page, 'edit.jpg')).toEqual(dragged)
    const edit = dragged

    // ---- the pixelated face (original coordinates, as face detection stores it), partly cropped away
    const ex = expectations(edit)
    console.log('F on the edited picture', ex.f, 'shown part', ex.fShown)
    expect(ex.fShown.h).toBeLessThan(ex.f.h * 0.9)
    expect(ex.fShown.h).toBeGreaterThan(ex.f.h * 0.2)
    await state(page, `s.setEntry(${JSON.stringify(entry)}, { privacy: [${JSON.stringify(faceArea(F))}] })`)
    const slide = await state<{ start: number; duration: number }>(page, `const sl = d.player.current.tl.slides.find((x) => x.entries[0].id === ${JSON.stringify(entry)}); return { start: sl.start, duration: sl.duration }`)
    await state(page, `d.player.current.seek(${slide.start + slide.duration / 2})`)
    // the preview: corners where the turn put them, F flat where it shows, C sharp
    let preview: Buffer = Buffer.alloc(0)
    await expect
      .poll(
        async () => {
          preview = await frame.screenshot()
          const r = await checkPicture(preview, edit, 'preview')
          return r.colours.join(',') === ex.points.map((q) => q.colour).join(',') && r.c > 4 && r.f < r.c * 0.35
        },
        { timeout: 30_000, intervals: [250] }
      )
      .toBe(true)
    keep('preview.png', preview)

    // ---- Ctrl+R on every slide: one undo step, and the window is not reloaded
    await page.evaluate(() => ((window as any).__editMarker = 1))
    const ids = await state<string[]>(page, `const ids = d.player.current.tl.slides.flatMap((x) => x.entries.map((e) => e.id)); s.select(ids); return ids`)
    expect(ids.length).toBe(3)
    await page.locator('.cards .card').first().focus()
    await page.keyboard.press('Control+r')
    const rotations = (): Promise<Record<string, number>> => state(page, `return Object.fromEntries(s.project.media.map((m) => [m.name, m.edit?.rotate ?? 0]))`)
    await expect.poll(rotations).toEqual({ 'edit.jpg': 0, 'wide.jpg': 270, 'tall.jpg': 270 })
    expect(await page.evaluate(() => (window as any).__editMarker)).toBe(1)
    // the thumbnails show the turned pictures: the wide one is now upright
    const thumbShape = (): Promise<string> =>
      page.evaluate(() => {
        const p = (window as any).__diashow.store.getState().project
        const wide = p.media.find((m: any) => m.name === 'wide.jpg')
        const card = (window as any).__diashow.player.current.tl.slides.findIndex((x: any) => x.media[0]?.id === wide.id)
        const img = document.querySelector<HTMLImageElement>(`.card[data-index="${card}"] img`)
        return img && img.naturalWidth ? (img.naturalWidth < img.naturalHeight ? 'portrait' : 'landscape') : 'none'
      })
    await expect.poll(thumbShape, { timeout: 15_000 }).toBe('portrait')
    await page.keyboard.press('Control+z')
    await expect.poll(rotations).toEqual({ 'edit.jpg': 90, 'wide.jpg': 0, 'tall.jpg': 0 })
    await expect.poll(() => editOf(page, 'edit.jpg')).toEqual(edit)
    await expect.poll(thumbShape, { timeout: 15_000 }).toBe('landscape')
    // the edit is saved with the project
    const id = await state<string>(page, `return s.project.id`)
    await expect
      .poll(() => readProject(dataDir, id)?.media.find((m: any) => m.name === 'edit.jpg')?.edit, { timeout: 15_000, intervals: [300] })
      .toEqual(edit)

    // ---- export: the same picture, F still pixelated where it shows
    const out = join(dataDir, 'edit.mp4')
    await page.evaluate(({ file, size }) => {
      const d = (window as any).__diashow
      return d.queueExport(d.store.getState().project, { outPath: file, ...size, fps: 25, codec: 'h264', quality: 'standard', hardware: true, locale: 'de-DE' }, 'Edit')
    }, { file: out, size: EXPORT_SIZE })
    await page.waitForFunction(() => {
      const jobs = (window as any).__diashow.store.getState().exportJobs
      return jobs.length > 0 && jobs.every((j: any) => j.state === 'done' || j.state === 'error')
    }, null, { timeout: 600_000, polling: 250 })
    expect(await state<string[]>(page, `return s.exportJobs.map((j) => j.state)`)).toEqual(['done'])
    const still = execFileSync(ffmpeg, ['-v', 'error', '-ss', (slide.start + slide.duration / 2).toFixed(3), '-i', out, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'])
    keep('export.png', still)
    const r = await checkPicture(still, edit, 'export')
    expect(r.colours).toEqual(ex.points.map((q) => q.colour))
    expect(r.c).toBeGreaterThan(4)
    expect(r.f).toBeLessThan(r.c * 0.35)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})

// Videos go through the same texture map: a clip turned in the Slide tab and cropped plays turned in the
// preview and in the export, and an area pixelated on it (original coordinates) stays on its square.
test('a turned and cropped video: preview and export, pixelation kept', async () => {
  test.setTimeout((SOFTWARE_GL ? 10 : 5) * 60 * 1000)
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-edit-video-'))
  const media = join(dataDir, 'media')
  mkdirSync(media)
  // 1280 x 720, red left half, blue right half, a checkerboard on each (Fv pixelated, Cv sharp)
  const VW = 1280
  const VH = 720
  const Fv: Rect = { x: 160 / VW, y: 240 / VH, w: 240 / VW, h: 240 / VH }
  const Cv: Rect = { x: 880 / VW, y: 240 / VH, w: 240 / VW, h: 240 / VH }
  const board = join(media, 'board.png')
  writeFileSync(board, await checker(240, 20))
  const clipFile = join(media, 'clip.mp4')
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0xc82828:s=640x720:r=25:d=3',
    '-f', 'lavfi', '-i', 'color=c=0x2846c8:s=640x720:r=25:d=3',
    '-i', board,
    '-filter_complex', '[0][1]hstack[bg];[bg][2]overlay=160:240[a];[a][2]overlay=880:240',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', clipFile
  ])
  let s: Session | null = null
  try {
    s = await launch(dataDir)
    const { page } = s
    await page.evaluate(async (files) => (window as any).__diashow.store.getState().createProject(files, 'Video'), [clipFile])
    await page.waitForFunction(() => {
      const p = (window as any).__diashow.store.getState().project
      return p && p.media.length === 1 && p.media[0].status === 'ready'
    }, null, { timeout: 180_000, polling: 250 })
    await state(page, `s.setTheme('classic'); d.store.getState().setSettings({ showTitle: false, scaleToFill: false })`)
    const entry = await state<string>(page, `const e = s.project.entries[0]; s.select([e.id]); s.set({ tab: 'slide' }); return e.id`)
    // turned right in the Slide tab, then the lower 85 % kept
    await page.locator('.inspector').getByRole('button', { name: /^(Nach rechts drehen|Rotate right)$/ }).click()
    await expect.poll(() => editOf(page, 'clip.mp4')).toEqual({ rotate: 90, straighten: 0 })
    await state(page, `s.update((p) => { p.media = p.media.map((m) => ({ ...m, edit: { rotate: 90, straighten: 0, crop: { x: 0, y: 0.15, w: 1, h: 0.85 } } })) })`)
    const edit = (await editOf(page, 'clip.mp4'))!
    await state(page, `s.setEntry(${JSON.stringify(entry)}, { privacy: [${JSON.stringify(faceArea(Fv))}] })`)
    // where things land on the edited clip (16:9 frame, whole picture centred)
    const a = editedAspect(VW / VH, edit)
    const pic = a > 16 / 9 ? { x: 0, y: (1 - 16 / 9 / a) / 2, w: 1, h: 16 / 9 / a } : { x: (1 - a / (16 / 9)) / 2, y: 0, w: a / (16 / 9), h: 1 }
    const onFrame = (r: Rect): Rect => ({ x: pic.x + r.x * pic.w, y: pic.y + r.y * pic.h, w: r.w * pic.w, h: r.h * pic.h })
    const back = sourceToEdit(edit, VW / VH)
    // a red point (left half, clear of Fv and its area) and a blue one (right edge)
    const red = apply(back, 0.45, 0.2)
    const blue = apply(back, 0.95, 0.5)
    const fCore = onFrame(inner(clip(rectToEdit(Fv, edit, VW / VH))))
    const cCore = onFrame(inner(clip(rectToEdit(Cv, edit, VW / VH))))
    // turned right: the left half is on top now; both points are on the cropped picture
    for (const [u, v] of [red, blue]) expect(Math.min(u, v, 1 - u, 1 - v)).toBeGreaterThan(0.03)
    expect(red[1]).toBeLessThan(0.5)
    expect(blue[1]).toBeGreaterThan(0.85)
    const look = async (png: Buffer, label: string): Promise<{ colours: string[]; f: number; c: number }> => {
      const p = await pixels(png)
      const out = {
        colours: [red, blue].map(([u, v]) => colourName(colourAt(p, pic.x + u * pic.w, pic.y + v * pic.h))),
        f: detail(p, fCore),
        c: detail(p, cCore)
      }
      console.log(`${label}: ${out.colours.join(', ')}; detail in Fv ${out.f.toFixed(1)}, in Cv ${out.c.toFixed(1)}`)
      return out
    }
    const slide = await state<{ start: number }>(page, `const sl = d.player.current.tl.slides.find((x) => x.kind === 'video'); return { start: sl.start }`)
    await state(page, `d.player.current.seek(${slide.start + 1.2})`)
    let shot: Buffer = Buffer.alloc(0)
    await expect
      .poll(
        async () => {
          shot = await page.locator('.frame').screenshot()
          const r = await look(shot, 'video preview')
          return r.colours.join(',') === 'red,blue' && r.c > 4 && r.f < r.c * 0.35
        },
        { timeout: 30_000, intervals: [300] }
      )
      .toBe(true)
    keep('video-preview.png', shot)

    const out = join(dataDir, 'video.mp4')
    await page.evaluate(({ file, size }) => {
      const d = (window as any).__diashow
      return d.queueExport(d.store.getState().project, { outPath: file, ...size, fps: 25, codec: 'h264', quality: 'standard', hardware: true, locale: 'de-DE' }, 'Video')
    }, { file: out, size: EXPORT_SIZE })
    await page.waitForFunction(() => {
      const jobs = (window as any).__diashow.store.getState().exportJobs
      return jobs.length > 0 && jobs.every((j: any) => j.state === 'done' || j.state === 'error')
    }, null, { timeout: 600_000, polling: 250 })
    expect(await state<string[]>(page, `return s.exportJobs.map((j) => j.state)`)).toEqual(['done'])
    const still = execFileSync(ffmpeg, ['-v', 'error', '-ss', (slide.start + 1.2).toFixed(3), '-i', out, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'])
    keep('video-export.png', still)
    const r = await look(still, 'video export')
    expect(r.colours).toEqual(['red', 'blue'])
    expect(r.c).toBeGreaterThan(4)
    expect(r.f).toBeLessThan(r.c * 0.35)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
