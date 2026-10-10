// End-to-end checks of "this person everywhere" and faces followed through videos:
// - a photo with two "faces" (high-contrast squares with known descriptors); the person button in
//   the pixelation editor marks one; the preview pixelates exactly that one;
// - a video in which the same face moves: it is pixelated where it is at each time (people match),
//   and a followed track (privacyTracks) does the same;
// - the export (queue worker) shows the same pixelation;
// - with DIASHOW_FACES_PHOTO / DIASHOW_FACES_VIDEO (local runs with real pictures), the real path:
//   detection, descriptors, a click on a real face; screenshots go to test-results/ for a look.
// Face data is injected for the synthetic media: BlazeFace finds no faces in squares.
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { EXPORT_SIZE, launchOptions, SOFTWARE_GL } from './launch'

const root = resolve(__dirname, '..')
const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')
const shots = join(root, 'test-results', 'privacy')

type R = { x: number; y: number; w: number; h: number }

const state = <T,>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const d = window.__diashow; const s = d.store.getState(); ${fn} })()`) as Promise<T>

/** Descriptor pointing along one axis: far (distance ~1.4) from any other axis. */
const axis = (k: number): number[] => Array.from({ length: 128 }, (_, i) => (i === k ? 1 : 0))

/** Mean absolute horizontal gradient inside a box (fractions of the image): high for the squares, low once pixelated. */
async function detail(png: Buffer, box: R): Promise<number> {
  const { data, info } = await sharp(png).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true })
  const x0 = Math.round(box.x * info.width), x1 = Math.round((box.x + box.w) * info.width)
  const y0 = Math.round(box.y * info.height), y1 = Math.round((box.y + box.h) * info.height)
  let s = 0, n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1 - 1; x++) {
    s += Math.abs(data[y * info.width + x + 1] - data[y * info.width + x])
    n++
  }
  return s / Math.max(1, n)
}

/** Bounding box (fractions) of the pixels that changed between two screenshots. */
async function changed(a: Buffer, b: Buffer): Promise<R | null> {
  const [ra, rb] = await Promise.all([a, b].map((x) => sharp(x).removeAlpha().raw().toBuffer({ resolveWithObject: true })))
  const { width: W, height: H } = ra.info
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3
    const d = Math.abs(ra.data[i] - rb.data[i]) + Math.abs(ra.data[i + 1] - rb.data[i + 1]) + Math.abs(ra.data[i + 2] - rb.data[i + 2])
    if (d > 60) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
    }
  }
  return x1 < 0 ? null : { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H }
}

const centre = (r: R): [number, number] => [r.x + r.w / 2, r.y + r.h / 2]
const inside = (p: [number, number], r: R, margin = 0.02): boolean => p[0] > r.x - margin && p[0] < r.x + r.w + margin && p[1] > r.y - margin && p[1] < r.y + r.h + margin

/** Checkerboard tile as PNG. */
const checker = (size: number, cell: number): Promise<Buffer> => {
  const px = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 250 : 15
    px.fill(v, (y * size + x) * 3, (y * size + x) * 3 + 3)
  }
  return sharp(px, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer()
}

// the synthetic media: 16:9 like the show, so the picture fills the frame (classic, whole picture)
const FACE_A: R = { x: 0.2, y: 0.3, w: 0.12, h: 0.2133 }
const FACE_B: R = { x: 0.625, y: 0.3, w: 0.12, h: 0.2133 }
/** The square in the video: 120 px at x = 100 + 200 t, y = 250 (1280 x 720). */
const square = (t: number): R => ({ x: (100 + 200 * t) / 1280, y: 250 / 720, w: 120 / 1280, h: 120 / 720 })
/** Its middle part (always inside the pixelated ellipse). */
const core = (r: R): R => ({ x: r.x + r.w * 0.2, y: r.y + r.h * 0.2, w: r.w * 0.6, h: r.h * 0.6 })

async function makeMedia(dir: string): Promise<{ photo: string; video: string }> {
  const photo = join(dir, 'faces.jpg')
  const video = join(dir, 'moving.mp4')
  const tile = await checker(192, 16)
  const bg = Buffer.alloc(1600 * 900 * 3)
  for (let y = 0; y < 900; y++) for (let x = 0; x < 1600; x++) bg.set([80 + (x * 60) / 1600, 110, 140 - (y * 40) / 900], (y * 1600 + x) * 3)
  await sharp(bg, { raw: { width: 1600, height: 900, channels: 3 } })
    .composite([{ input: tile, left: 320, top: 270 }, { input: tile, left: 1000, top: 270 }])
    .jpeg({ quality: 92 })
    .toFile(photo)
  const sq = join(dir, 'square.png')
  writeFileSync(sq, await checker(120, 12))
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x5a6e82:s=1280x720:r=25:d=5', '-i', sq, '-filter_complex', "[0][1]overlay=x='100+200*t':y=250", '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', video])
  return { photo, video }
}

async function waitAnalysed(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const p = (window as any).__diashow.store.getState().project
    return p && p.media.length > 0 && p.media.every((m: any) => m.status === 'error' || (m.status === 'ready' && (m.kind === 'video' ? m.videoFaces !== undefined : m.faces !== undefined)))
  }, null, { timeout: 300_000, polling: 500 })
}

/** Seeks the editor's preview to a slide-local time and lets the video frame arrive. */
async function seekTo(page: Page, kind: 'photos' | 'video', local: number): Promise<void> {
  await state(page, `const sl = d.player.current.tl.slides.find((x) => x.kind === ${JSON.stringify(kind)}); d.player.current.seek(sl.start + ${local})`)
  await page.waitForTimeout(kind === 'video' ? 1200 : 500)
}

test('marked person and followed faces are pixelated in preview and export', async () => {
  test.setTimeout((SOFTWARE_GL ? 20 : 8) * 60 * 1000)
  mkdirSync(shots, { recursive: true })
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-privacy-'))
  const mediaDir = join(dataDir, 'media')
  mkdirSync(mediaDir)
  const { photo, video } = await makeMedia(mediaDir)
  const app = await electron.launch(launchOptions(root, dataDir))
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(e.message))
    await page.waitForFunction(() => !!(window as any).__diashow)
    await page.evaluate(async (media) => {
      const s = (window as any).__diashow.store.getState()
      await s.createProject(media, 'Privacy')
    }, [photo, video])
    await waitAnalysed(page)
    await state(page, `s.setTheme('classic'); d.store.getState().setSettings({ showTitle: false, scaleToFill: false })`)

    // ---- face data for the synthetic media (stored through the main process like the real analysis)
    const ids = await state<{ photo: string; video: string }>(page, `return { photo: s.project.media.find((m) => m.kind === 'photo').id, video: s.project.media.find((m) => m.kind === 'video').id }`)
    const samples = Array.from({ length: 10 }, (_, i) => ({ t: 0.25 + i * 0.5, faces: [square(0.25 + i * 0.5)], desc: [axis(3)] }))
    await page.evaluate(async ({ ids, a, b, samples, faces }) => {
      await (window as any).api.setFaces(ids.photo, faces, [a, b])
      await (window as any).api.setVideoFaces(ids.video, samples)
    }, { ids, a: axis(3), b: axis(70), samples, faces: [FACE_A, FACE_B] })
    await page.waitForFunction(() => {
      const p = (window as any).__diashow.store.getState().project
      return p.media.some((m: any) => m.faceDesc?.length === 2) && p.media.some((m: any) => m.videoFaces?.length === 10)
    })

    // ---- photo: mark face A with the person button in the pixelation editor
    const frame = page.locator('.frame')
    const photoEntry = await state<string>(page, `const sl = d.player.current.tl.slides.find((x) => x.kind === 'photos'); s.select([sl.entries[0].id]); s.set({ tab: 'slide' }); return sl.entries[0].id`)
    await seekTo(page, 'photos', 1)
    const before = await frame.screenshot()
    await page.locator('.inspector button', { hasText: /Gesichter verpixeln|Pixelate faces/ }).first().click()
    await expect(page.locator('.privacy-edit')).toBeVisible()
    // both faces have descriptors: both get the person button (the close search keeps the injected faces)
    await expect(page.locator('.privacy-edit .person-badge')).toHaveCount(2, { timeout: 30_000 })
    await page.locator('.privacy-edit .person-badge').first().click()
    expect(await state<number>(page, `return s.project.people.length`)).toBe(1)
    // face A is now shown as the marked person, with "not this person"
    await expect(page.locator('.privacy-edit .privacy-face.person')).toHaveCount(1)
    await expect(page.locator('.privacy-edit .person-badge.on')).toHaveCount(1)
    await page.screenshot({ path: join(shots, 'editor-photo.png') })
    await page.locator('.privacy-edit .btn.primary').click()
    await expect(page.locator('.privacy-edit')).toHaveCount(0)
    await page.waitForTimeout(500)
    const after = await frame.screenshot()
    writeFileSync(join(shots, 'photo-before.png'), before)
    writeFileSync(join(shots, 'photo-after.png'), after)
    const box = await changed(before, after)
    console.log('photo: changed area', box, 'face A', FACE_A)
    expect(box).not.toBeNull()
    expect(inside(centre(box!), FACE_A)).toBe(true)
    const [dA0, dA1, dB0, dB1] = await Promise.all([detail(before, core(FACE_A)), detail(after, core(FACE_A)), detail(before, core(FACE_B)), detail(after, core(FACE_B))])
    console.log('photo detail A before/after', dA0.toFixed(1), dA1.toFixed(1), 'B before/after', dB0.toFixed(1), dB1.toFixed(1))
    expect(dA1).toBeLessThan(dA0 * 0.35)
    expect(dB1).toBeGreaterThan(dB0 * 0.8)
    // the slide tab counts it
    await expect(page.locator('.inspector .hint', { hasText: /markierter Personen|marked people/ })).toBeVisible()

    // ---- video: the same person moves; the pixelation follows it
    const videoEntry = await state<string>(page, `const sl = d.player.current.tl.slides.find((x) => x.kind === 'video'); s.select([sl.entries[0].id]); return sl.entries[0].id`)
    // two moments after the transition into the clip (slide-local time = source time: no trim, 1x)
    const transIn = await state<number>(page, `return d.player.current.tl.slides.find((x) => x.kind === 'video').transIn`)
    const T = [transIn + 0.4, transIn + 2.4]
    const shotsAt = async (): Promise<Buffer[]> => {
      const out: Buffer[] = []
      for (const t of T) {
        await seekTo(page, 'video', t)
        out.push(await frame.screenshot())
      }
      return out
    }
    const withPerson = await shotsAt()
    const people = await state<unknown>(page, `return s.project.people`)
    await state(page, `s.update((p) => { delete p.people })`)
    const plain = await shotsAt()
    for (const [i, t] of T.entries()) {
      writeFileSync(join(shots, `video-person-${i}.png`), withPerson[i])
      const d = await changed(plain[i], withPerson[i])
      console.log(`video person at ${t} s: changed`, d, 'square', square(t))
      expect(d).not.toBeNull()
      expect(inside(centre(d!), square(t), 0.04)).toBe(true)
      expect(await detail(withPerson[i], core(square(t)))).toBeLessThan((await detail(plain[i], core(square(t)))) * 0.35)
    }

    // ---- a followed face (privacyTracks), as a click on the still makes it
    await page.evaluate(({ videoEntry, still }) => {
      const d = (window as any).__diashow
      const s = d.store.getState()
      const m = s.project.media.find((x: any) => x.kind === 'video')
      const keys = d.faces.followFace(m.videoFaces, 2, still)
      s.setEntry(videoEntry, { privacyTracks: [keys] })
    }, { videoEntry, still: square(2) })
    const followed = await shotsAt()
    for (const [i, t] of T.entries()) {
      writeFileSync(join(shots, `video-track-${i}.png`), followed[i])
      const d = await changed(plain[i], followed[i])
      console.log(`video track at ${t} s: changed`, d)
      expect(d).not.toBeNull()
      expect(inside(centre(d!), square(t), 0.04)).toBe(true)
    }
    // the editor shows the followed face on its still (middle of the clip, 2 s)
    await page.locator('.inspector button', { hasText: /Gesichter verpixeln|Pixelate faces/ }).first().click()
    await expect(page.locator('.privacy-edit .privacy-face.on.track')).toHaveCount(1, { timeout: 20_000 })
    await expect(page.locator('.privacy-edit img')).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(shots, 'editor-video.png') })
    await page.locator('.privacy-edit .btn.primary').click()

    // ---- the export shows the same: person on the photo and in the video, the track too
    await state(page, `s.update((p) => { p.people = ${JSON.stringify(people)} })`)
    const times = await state<{ photo: number; video: number }>(page, `const tl = d.player.current.tl; const p = tl.slides.find((x) => x.kind === 'photos'); const v = tl.slides.find((x) => x.kind === 'video'); return { photo: p.start + p.duration / 2, video: v.start }`)
    const out = join(dataDir, 'privacy.mp4')
    await page.evaluate(({ file, size }) => {
      const d = (window as any).__diashow
      return d.queueExport(d.store.getState().project, { outPath: file, ...size, fps: 25, codec: 'h264', quality: 'standard', hardware: true, locale: 'de-DE' }, 'Privacy')
    }, { file: out, size: EXPORT_SIZE })
    await page.waitForFunction(() => {
      const jobs = (window as any).__diashow.store.getState().exportJobs
      return jobs.length > 0 && jobs.every((j: any) => j.state === 'done' || j.state === 'error')
    }, null, { timeout: 600_000, polling: 1000 })
    expect(await state<string[]>(page, `return s.exportJobs.map((j) => j.state)`)).toEqual(['done'])
    const grab = (t: number): Buffer => execFileSync(ffmpeg, ['-v', 'error', '-ss', t.toFixed(3), '-i', out, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'])
    const exPhoto = grab(times.photo)
    writeFileSync(join(shots, 'export-photo.png'), exPhoto)
    const [eA, eB] = await Promise.all([detail(exPhoto, core(FACE_A)), detail(exPhoto, core(FACE_B))])
    console.log('export photo detail A', eA.toFixed(1), 'B', eB.toFixed(1))
    expect(eA).toBeLessThan(eB * 0.35)
    for (const t of T) {
      const ex = grab(times.video + t)
      writeFileSync(join(shots, `export-video-${t.toFixed(1)}s.png`), ex)
      const inSquare = await detail(ex, core(square(t)))
      const ref = await detail(ex, core({ ...square(t), x: square(t).x + (t < 2 ? 0.45 : -0.45) }))
      console.log(`export video ${t} s: detail in square`, inSquare.toFixed(1), 'background', ref.toFixed(1))
      // pixelated: about as flat as the plain background next to it, far from a checkerboard
      expect(inSquare).toBeLessThan(eB * 0.35)
    }
    expect(errors).toEqual([])
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
  }
})

// Real faces (local runs only): DIASHOW_FACES_PHOTO and/or DIASHOW_FACES_VIDEO point at a photo / a
// video with faces. Nothing is written next to them; screenshots go to test-results/privacy.
test('real faces: person button and followed face (local)', async () => {
  const realPhoto = process.env.DIASHOW_FACES_PHOTO
  const realVideo = process.env.DIASHOW_FACES_VIDEO
  test.skip(!realPhoto && !realVideo, 'set DIASHOW_FACES_PHOTO / DIASHOW_FACES_VIDEO to run')
  test.setTimeout(10 * 60 * 1000)
  mkdirSync(shots, { recursive: true })
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-privacy-real-'))
  const app = await electron.launch(launchOptions(root, dataDir))
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => !!(window as any).__diashow)
    const media = [realPhoto, realVideo].filter((x): x is string => !!x && existsSync(x))
    await page.evaluate(async (media) => (window as any).__diashow.store.getState().createProject(media, 'Real faces'), media)
    await waitAnalysed(page)
    await state(page, `s.setTheme('classic'); d.store.getState().setSettings({ showTitle: false, scaleToFill: false })`)
    const frame = page.locator('.frame')
    const fb = (await frame.boundingBox())!
    if (realPhoto) {
      const info = await state<{ faces: R[]; desc: number; w: number; h: number }>(page, `const m = s.project.media.find((x) => x.kind === 'photo'); return { faces: m.faces, desc: (m.faceDesc ?? []).filter((x) => x.length).length, w: m.width, h: m.height }`)
      console.log('real photo:', info.faces.length, 'faces,', info.desc, 'with descriptors')
      await state(page, `const sl = d.player.current.tl.slides.find((x) => x.kind === 'photos'); s.select([sl.entries[0].id]); s.set({ tab: 'slide' })`)
      await seekTo(page, 'photos', 1)
      const before = await frame.screenshot()
      await page.locator('.inspector button', { hasText: /Gesichter verpixeln|Pixelate faces/ }).first().click()
      await expect(page.locator('.privacy-edit .person-badge').first()).toBeVisible({ timeout: 60_000 })
      await page.locator('.privacy-edit .person-badge').first().click()
      await page.screenshot({ path: join(shots, 'real-editor-photo.png') })
      await page.locator('.privacy-edit .btn.primary').click()
      await page.waitForTimeout(600)
      const after = await frame.screenshot()
      writeFileSync(join(shots, 'real-photo-before.png'), before)
      writeFileSync(join(shots, 'real-photo-after.png'), after)
      // where the photo sits in the frame (whole picture, centred)
      const a = info.w / info.h
      const fa = fb.width / fb.height
      const pic = a > fa ? { x: 0, y: (1 - fa / a) / 2, w: 1, h: fa / a } : { x: (1 - a / fa) / 2, y: 0, w: a / fa, h: 1 }
      const marked = await state<R[]>(page, `const m = s.project.media.find((x) => x.kind === 'photo'); const p = s.project.people[0]; const dist = (u, v) => Math.sqrt(u.reduce((q, x, i) => q + (x - v[i]) ** 2, 0)); return m.faces.filter((f, i) => m.faceDesc[i]?.length && Math.min(...p.desc.map((x) => dist(x, m.faceDesc[i]))) <= 0.5)`)
      const d = await changed(before, after)
      console.log('real photo: marked faces', marked.length, 'changed area', d)
      expect(marked.length).toBeGreaterThan(0)
      expect(d).not.toBeNull()
      const onFrame = (r: R): R => ({ x: pic.x + r.x * pic.w, y: pic.y + r.y * pic.h, w: r.w * pic.w, h: r.h * pic.h })
      expect(marked.some((f) => inside(centre(onFrame(f)), d!, 0.03))).toBe(true)
    }
    if (realVideo) {
      const vf = await state<{ samples: number; faces: number }>(page, `const m = s.project.media.find((x) => x.kind === 'video'); return { samples: m.videoFaces.length, faces: m.videoFaces.reduce((n, x) => n + x.faces.length, 0) }`)
      console.log('real video:', vf)
      // the check before export lists the clip with its open faces; a click opens the editor on that frame
      const name = await state<string>(page, `return s.project.media.find((x) => x.kind === 'video').name`)
      await state(page, `s.set({ exportOpen: true })`)
      await page.locator('.dialog button', { hasText: /Gesichter prüfen|Check faces/ }).click()
      await expect(page.locator('.review-tile').first()).toBeVisible({ timeout: 30_000 })
      await page.waitForTimeout(1500)
      await page.screenshot({ path: join(shots, 'real-review.png') })
      await page.locator(`.review-tile[title=${JSON.stringify(name)}]`).click()
      await expect(page.locator('.privacy-edit img')).toBeVisible({ timeout: 30_000 })
      await page.waitForTimeout(4000)
      const free = page.locator('.privacy-edit .privacy-face-wrap > .privacy-face')
      const n = await free.count()
      console.log('real video: faces on the still', n)
      if (n > 0) {
        await free.first().click()
        // followed through the sampled analysis, or frame by frame from the still
        await page.waitForTimeout(300)
        await expect(page.locator('.privacy-edit .privacy-face-wrap.waiting')).toHaveCount(0, { timeout: 180_000 })
        await page.screenshot({ path: join(shots, 'real-editor-video.png') })
        expect(await state<number>(page, `return (s.project.entries.find((x) => x.type === 'video').privacyTracks ?? []).length`)).toBeGreaterThan(0)
        console.log('real video: followed', await state<string>(page, `const e = s.project.entries.find((x) => x.type === 'video'); return JSON.stringify({ keys: (e.privacyTracks ?? []).map((k) => k.length), areas: (e.privacy ?? []).length })`))
        const tracks = await state<number>(page, `const e = s.project.entries.find((x) => x.type === 'video'); return (e.privacyTracks ?? []).length + (e.privacy ?? []).length`)
        expect(tracks).toBeGreaterThan(0)
        await page.locator('.privacy-edit .btn.primary').click()
        const dur = await state<number>(page, `return d.player.current.tl.slides.find((x) => x.kind === 'video').duration`)
        for (const f of [0.2, 0.4, 0.6, 0.8]) {
          await seekTo(page, 'video', dur * f)
          await frame.screenshot({ path: join(shots, `real-video-${Math.round(f * 100)}.png`) })
        }
      }
    }
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
  }
})
