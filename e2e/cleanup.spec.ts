// "Nach dem Projekt aufräumen" end to end:
// - a show with two synthetic "faces" on a photo (one a named person marked "everywhere"), an area
//   drawn by hand, a video in which the marked face moves, and a photo a pupil uploaded over the Wi-Fi;
// - an export before the clean-up; a deletion date in the past set in the dialog (⋯ menu);
// - after a restart the home screen shows the reminder (banner and card); the clean-up from there
//   removes face data, uploads, caches, older versions and the export job: the files are gone and
//   the sizes freed are the sizes listed;
// - the pixelation is still there, in the preview and in a second export, at the same places;
//   the background face search stays off.
// Face data is injected for the synthetic media (BlazeFace finds no faces in squares), as in
// privacy.spec.ts. Runs in German and with DIASHOW_LOCALE=en-US DIASHOW_SOFTWARE_GL=1.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { ensureTestMedia, launch, mediaDir, menu, project, projectFile, readProject, removeDir, root, seekDrawn, waitProcessed, waitSaved, type Session } from './harness'
import { EXPORT_SIZE, SOFTWARE_GL } from './launch'

const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')
const shots = join(root, 'test-results', 'cleanup')
const NAME = 'Klassenfahrt'

type R = { x: number; y: number; w: number; h: number }

const state = <T,>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const d = window.__diashow; const s = d.store.getState(); ${fn} })()`) as Promise<T>
/** Writes a picture for a look afterwards (the folder may have been cleared by another test run meanwhile). */
function save(path: string, data: Buffer): void {
  mkdirSync(shots, { recursive: true })
  writeFileSync(path, data)
}

const axis = (k: number): number[] => Array.from({ length: 128 }, (_, i) => (i === k ? 1 : 0))

/** Mean absolute horizontal gradient inside a box: high on a checkerboard, low once pixelated. */
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

/** Share of pixels that differ clearly between two pictures of the same size. */
async function difference(a: Buffer, b: Buffer): Promise<number> {
  const [ra, rb] = await Promise.all([a, b].map((x) => sharp(x).removeAlpha().raw().toBuffer({ resolveWithObject: true })))
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return 1
  let n = 0
  for (let i = 0; i < ra.data.length; i += 3) {
    const d = Math.abs(ra.data[i] - rb.data[i]) + Math.abs(ra.data[i + 1] - rb.data[i + 1]) + Math.abs(ra.data[i + 2] - rb.data[i + 2])
    if (d > 60) n++
  }
  return n / (ra.data.length / 3)
}

const checker = (size: number, cell: number): Promise<Buffer> => {
  const px = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 250 : 15
    px.fill(v, (y * size + x) * 3, (y * size + x) * 3 + 3)
  }
  return sharp(px, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer()
}

// 16:9 like the show: the picture fills the frame (Classic, whole picture)
const FACE_A: R = { x: 0.2, y: 0.3, w: 0.12, h: 0.2133 } // the marked person
const FACE_B: R = { x: 0.625, y: 0.3, w: 0.12, h: 0.2133 } // nobody: stays sharp
const TILE_C: R = { x: 0.4125, y: 0.6667, w: 0.12, h: 0.2133 } // pixelated by hand
const AREA_C: R = { x: 0.39, y: 0.63, w: 0.165, h: 0.29 }
const square = (t: number): R => ({ x: (100 + 200 * t) / 1280, y: 250 / 720, w: 120 / 1280, h: 120 / 720 })
const core = (r: R): R => ({ x: r.x + r.w * 0.2, y: r.y + r.h * 0.2, w: r.w * 0.6, h: r.h * 0.6 })

async function makeMedia(dir: string): Promise<{ photo: string; video: string }> {
  const photo = join(dir, 'faces.jpg')
  const video = join(dir, 'moving.mp4')
  const tile = await checker(192, 16)
  const bg = Buffer.alloc(1600 * 900 * 3)
  for (let y = 0; y < 900; y++) for (let x = 0; x < 1600; x++) bg.set([80 + (x * 60) / 1600, 110, 140 - (y * 40) / 900], (y * 1600 + x) * 3)
  await sharp(bg, { raw: { width: 1600, height: 900, channels: 3 } })
    .composite([{ input: tile, left: 320, top: 270 }, { input: tile, left: 1000, top: 270 }, { input: tile, left: 660, top: 600 }])
    .jpeg({ quality: 92 })
    .toFile(photo)
  const sq = join(dir, 'square.png')
  writeFileSync(sq, await checker(120, 12))
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x5a6e82:s=1280x720:r=25:d=5', '-i', sq, '-filter_complex', "[0][1]overlay=x='100+200*t':y=250", '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', video])
  return { photo, video }
}

/** Every item analysed (faces searched, hash and sharpness known), so nothing writes to the cache any more. */
async function waitSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const p = (window as any).__diashow.store.getState().project
    return p && p.media.length > 0 && p.media.every((m: any) => m.status === 'ready' && m.hash && (m.kind === 'video' ? m.videoFaces !== undefined && m.hash2 : m.faces !== undefined && m.sharpness !== undefined))
  }, null, { timeout: 300_000, polling: 250 })
}

/** Slide start times of the photo and the video slide in the open show. */
const slideTimes = (page: Page): Promise<{ photo: number; video: number; videoIn: number }> =>
  state(page, `const tl = d.player.current.tl; const p = tl.slides.find((x) => x.kind === 'photos'); const v = tl.slides.find((x) => x.kind === 'video'); return { photo: p.start + p.duration / 2, video: v.start, videoIn: v.transIn }`)

/** Preview pictures: the photo slide and two moments of the video. */
async function previewShots(page: Page): Promise<Buffer[]> {
  const frame = page.locator('.frame')
  const out: Buffer[] = []
  const t = await slideTimes(page)
  for (const at of [t.photo, t.video + t.videoIn + 0.4, t.video + t.videoIn + 2.4]) {
    await seekDrawn(page, at)
    out.push(await frame.screenshot())
  }
  return out
}

/** Exports the open show through the queue and returns frames of the photo and the video. */
async function exportFrames(page: Page, out: string): Promise<{ photo: Buffer; video: Buffer[] }> {
  const t = await slideTimes(page)
  const before = await state<number>(page, `return s.exportJobs.length`)
  await page.evaluate(({ file, size }) => {
    const d = (window as any).__diashow
    return d.queueExport(d.store.getState().project, { outPath: file, ...size, fps: 25, codec: 'h264', quality: 'standard', hardware: true, locale: 'de-DE' }, 'Aufräumen')
  }, { file: out, size: EXPORT_SIZE })
  await expect
    .poll(() => state<string[]>(page, `return s.exportJobs.map((j) => j.state)`), { timeout: 600_000, intervals: [250] })
    .toEqual([...Array(before).fill('done'), 'done'])
  const grab = (at: number): Buffer => execFileSync(ffmpeg, ['-v', 'error', '-ss', at.toFixed(3), '-i', out, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'])
  return { photo: grab(t.photo), video: [0.4, 2.4].map((x) => grab(t.video + t.videoIn + x)) }
}

/** Bytes of a file or folder on disk. */
function bytesOf(path: string): number {
  if (!existsSync(path)) return 0
  const st = statSync(path)
  if (!st.isDirectory()) return st.size
  return readdirSync(path).reduce((n, name) => n + bytesOf(join(path, name)), 0)
}

/** The pixelation is where it was: A and C (and the moving square) flat, B sharp. */
async function checkPixelated(label: string, photo: Buffer, video: Buffer[], times: number[]): Promise<void> {
  const [a, b, c] = await Promise.all([detail(photo, core(FACE_A)), detail(photo, core(FACE_B)), detail(photo, core(TILE_C))])
  console.log(`${label}: photo detail A ${a.toFixed(1)} B ${b.toFixed(1)} C ${c.toFixed(1)}`)
  expect(a, `${label}: marked person`).toBeLessThan(b * 0.35)
  expect(c, `${label}: area drawn by hand`).toBeLessThan(b * 0.35)
  for (const [i, t] of times.entries()) {
    const d = await detail(video[i], core(square(t)))
    console.log(`${label}: video at ${t} s, detail in the square ${d.toFixed(1)}`)
    expect(d, `${label}: video at ${t} s`).toBeLessThan(b * 0.35)
  }
}

test('clean-up after the project: reminder, removal with sizes, pixelation kept', async () => {
  test.setTimeout((SOFTWARE_GL ? 25 : 10) * 60 * 1000)
  ensureTestMedia()
  mkdirSync(shots, { recursive: true })
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-cleanup-'))
  const media = join(dataDir, 'media')
  mkdirSync(media)
  const { photo, video } = await makeMedia(media)
  const docs = join(dataDir, 'Diashow Studio')
  const cacheDir = join(dataDir, 'cache')
  const exportsDir = join(dataDir, 'userData', 'exports')
  const uploadDir = join(docs, 'Uploads', NAME)
  const export1 = join(dataDir, 'before.mp4')
  const export2 = join(dataDir, 'after.mp4')
  const env = { DIASHOW_SHARE_HOST: '127.0.0.1' }
  let s: Session | null = null
  try {
    // ---------------------------------------------------------------- session 1: the show
    s = await launch(dataDir, env)
    let page = s.page
    const id = await page.evaluate(async ({ files, name }) => {
      const d = (window as any).__diashow
      await d.store.getState().createProject(files, name)
      return d.store.getState().project.id as string
    }, { files: [photo, video], name: NAME })
    await waitSettled(page)
    await state(page, `s.setTheme('classic'); d.store.getState().setSettings({ showTitle: false, scaleToFill: false })`)
    const ids = await state<{ photo: string; video: string; photoEntry: string }>(page, `const m = (k) => s.project.media.find((x) => x.kind === k).id; return { photo: m('photo'), video: m('video'), photoEntry: s.project.entries.find((e) => e.type === 'photo').id }`)
    // face data as the analysis stores it, a named person marked "everywhere", an area drawn by hand
    const samples = Array.from({ length: 10 }, (_, i) => ({ t: 0.25 + i * 0.5, faces: [square(0.25 + i * 0.5)], desc: [axis(3)] }))
    await page.evaluate(async ({ ids, a, b, samples, faces }) => {
      await (window as any).api.setFaces(ids.photo, faces, [a, b])
      await (window as any).api.setVideoFaces(ids.video, samples)
    }, { ids, a: axis(3), b: axis(70), samples, faces: [FACE_A, FACE_B] })
    await page.waitForFunction(() => {
      const p = (window as any).__diashow.store.getState().project
      return p.media.some((m: any) => m.faceDesc?.length === 2) && p.media.some((m: any) => m.videoFaces?.length === 10)
    }, null, { polling: 250 })
    await state(page, `s.update((p) => { p.people = [{ id: 'lena', name: 'Lena', desc: [${JSON.stringify(axis(3))}] }] }); d.store.getState().setEntry(${JSON.stringify(ids.photoEntry)}, { privacy: [${JSON.stringify(AREA_C)}] })`)

    // a pupil uploads a photo over the Wi-Fi (the share server on loopback); it goes into the show
    const status = await page.evaluate(({ id, name }) => (window as any).api.shareControl({ type: 'start', projectId: id, projectName: name }), { id, name: NAME })
    expect(status.uploadUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
    const upload = readFileSync(join(mediaDir, 'android', 'PXL_0002.jpg'))
    const res = await fetch(new URL('upload', status.uploadUrl), { method: 'POST', headers: { 'X-File-Name': 'PXL_0002.jpg', 'X-Uploader': 'Mia', 'Content-Type': 'image/jpeg' }, body: upload })
    await res.arrayBuffer()
    expect(res.status).toBe(201)
    await page.evaluate(() => (window as any).api.shareControl({ type: 'stop' }))
    const uploaded = join(uploadDir, 'Mia', 'PXL_0002.jpg')
    expect(existsSync(uploaded)).toBe(true)
    await page.evaluate((file) => (window as any).__diashow.store.getState().importMedia([file]), uploaded)
    await waitProcessed(page)
    await waitSettled(page)
    const mediaIds = await state<string[]>(page, `return s.project.media.map((m) => m.id)`)
    expect(mediaIds).toHaveLength(3)
    for (const m of mediaIds) expect(existsSync(join(cacheDir, m)), `cache of ${m}`).toBe(true)

    // preview and export before the clean-up
    await state(page, `d.store.getState().select([])`)
    const preview1 = await previewShots(page)
    const t1 = await slideTimes(page)
    const T = [t1.videoIn + 0.4, t1.videoIn + 2.4]
    await checkPixelated('preview before', preview1[0], preview1.slice(1), T)
    const ex1 = await exportFrames(page, export1)
    await checkPixelated('export before', ex1.photo, ex1.video, T)
    preview1.forEach((b, i) => save(join(shots, `preview-before-${i}.png`), b))
    save(join(shots, 'export-before-photo.png'), ex1.photo)
    const jobDirs = readdirSync(exportsDir)
    expect(jobDirs).toHaveLength(1)

    // the deletion date, set in the dialog from the "⋯" menu: yesterday
    await menu(page, /Nach dem Projekt aufräumen|Clean up after the project/)
    const dialog = page.getByTestId('cleanup-dialog')
    await expect(dialog.locator('[data-category="faces"]')).toBeVisible({ timeout: 30_000 })
    await dialog.locator('[data-testid="deadline"] select').selectOption('6')
    const yesterday = new Date(Date.now() - 86_400_000)
    const iso = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
    await dialog.locator('[data-testid="deadline"] input[type="date"]').fill(iso)
    await expect(dialog.locator('[data-testid="deadline"] .chip.due')).toHaveText(/Löschfrist erreicht|Deletion date reached/)
    await page.screenshot({ path: join(shots, 'dialog.png') })
    await dialog.locator('.actions button').filter({ hasText: /Abbrechen|Cancel/ }).click()
    await expect(dialog).toHaveCount(0)
    await waitSaved(dataDir, id, (p) => typeof p.deleteAt === 'number' && p.deleteAt < Date.now() && p.people?.length === 1)
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null
    // what the session left is older than the backup interval: the next save keeps it as a backup
    const aged = new Date(Date.now() - 60 * 60_000)
    utimesSync(projectFile(dataDir, id), aged, aged)

    // ---------------------------------------------------------------- session 2: the reminder and the clean-up
    s = await launch(dataDir, env)
    page = s.page
    const banner = page.getByTestId('cleanup-banner')
    await expect(banner).toBeVisible({ timeout: 30_000 })
    await expect(banner).toContainText(/Löschfrist erreicht: aufräumen\?|Deletion date reached: clean up\?/)
    await expect(banner).toContainText(NAME)
    const card = page.locator('.home .project').filter({ hasText: NAME })
    await expect(card.getByTestId('deadline-due')).toBeVisible()
    await page.screenshot({ path: join(shots, 'reminder.png') })

    // open and close the show once: the first save of the session keeps the old version (with face data)
    await card.locator('.open').click()
    await expect.poll(async () => (await project(page))?.id, { timeout: 30_000 }).toBe(id)
    await waitProcessed(page)
    const backups = join(docs, '.backups', id)
    await expect.poll(() => (existsSync(backups) ? readdirSync(backups).length : 0), { timeout: 30_000 }).toBe(1)
    expect(readFileSync(join(backups, readdirSync(backups)[0]), 'utf8')).toContain('Lena')
    await page.locator('.titlebar button[title="Zurück"], .titlebar button[title="Back"]').click()
    await expect(page.locator('.home')).toBeVisible()
    await page.waitForTimeout(1000)

    // what the dialog lists is what is on disk
    const inv = await page.evaluate((pid) => (window as any).api.cleanupInventory(pid), id)
    console.log('inventory', JSON.stringify(inv))
    expect(inv.faces).toMatchObject({ media: 2, people: 1, named: 1 })
    expect(inv.uploads).toMatchObject({ files: 1, uploaders: 1, bytes: bytesOf(uploaded), inShow: { files: 1, slides: 1 } })
    expect(inv.caches).toMatchObject({ folders: 3, bytes: mediaIds.reduce((n, m) => n + bytesOf(join(cacheDir, m)), 0), shared: 0 })
    expect(inv.backups).toEqual({ files: 1, bytes: bytesOf(backups) })
    expect(inv.exports).toEqual({ jobs: 1, bytes: bytesOf(join(exportsDir, jobDirs[0])), unfinished: 0 })

    // the banner opens the clean-up; everything is chosen, the uploads too (all of them)
    await banner.locator('button').filter({ hasText: /Aufräumen…|Clean up…/ }).click()
    const dlg = page.getByTestId('cleanup-dialog')
    await expect(dlg.locator('[data-category="uploads"]')).toBeVisible({ timeout: 30_000 })
    for (const c of ['faces', 'caches', 'backups', 'exports']) await expect(dlg.locator(`[data-category="${c}"] > label input`)).toBeChecked()
    await expect(dlg.locator('[data-category="uploads"] > label input')).not.toBeChecked()
    await expect(dlg.locator('[data-category="faces"]')).toContainText(/bleibt verpixelt|stays pixelated/)
    await dlg.locator('[data-category="uploads"] > label input').check()
    await dlg.locator('[data-category="uploads"] input[type="radio"]').nth(1).check()
    await expect(dlg.locator('[data-category="uploads"] .callout')).toContainText(/entfernt \(1\)|slideshow \(1\)/)
    await page.screenshot({ path: join(shots, 'dialog-chosen.png') })
    await page.getByTestId('cleanup-run').click()
    const confirm = page.getByTestId('cleanup-confirm')
    await expect(confirm).toContainText(/sofort endgültig gelöscht, ohne Papierkorb|deleted for good at once, without going to the trash/)
    await page.getByTestId('cleanup-confirm-run').click()
    const summary = page.getByTestId('cleanup-summary')
    await expect(summary).toBeVisible({ timeout: 60_000 })
    await expect(summary).toContainText(/Freigegebener Speicher|Space freed/)
    await page.screenshot({ path: join(shots, 'summary.png') })
    const freed = Number(await summary.getAttribute('data-freed'))
    // the undo history (it holds the face data too) goes with the face data
    expect(inv.history.files).toBe(1)
    expect(freed).toBe(inv.uploads.bytes + inv.caches.bytes + inv.backups.bytes + inv.exports.bytes + inv.history.bytes)
    expect(existsSync(join(dataDir, 'userData', 'history', `${id}.json.gz`))).toBe(false)
    await dlg.locator('.actions .btn.primary').click()
    // the reminder is done
    await expect(page.getByTestId('cleanup-banner')).toHaveCount(0)
    await expect(card.getByTestId('deadline-due')).toHaveCount(0)

    // on disk: the app's copies are gone, the user's files are not
    expect(existsSync(uploadDir)).toBe(false)
    for (const m of mediaIds) expect(existsSync(join(cacheDir, m)), `cache of ${m}`).toBe(false)
    expect(readdirSync(backups)).toEqual([])
    expect(existsSync(join(exportsDir, jobDirs[0]))).toBe(false)
    for (const kept of [photo, video, export1, join(mediaDir, 'android', 'PXL_0002.jpg')]) expect(existsSync(kept), kept).toBe(true)
    const saved = readProject(dataDir, id)
    const text = JSON.stringify(saved)
    expect(text).not.toContain('Lena')
    expect(text).not.toMatch(/"faceDesc"|"videoFaces"|"people"|"faces"/)
    expect(saved.deleteAt).toBeUndefined()
    expect(saved.faceDataRemovedAt).toBeGreaterThan(0)
    expect(saved.media).toHaveLength(2)
    expect(saved.entries.find((e: any) => e.type === 'photo').privacy).toHaveLength(2)
    expect(saved.entries.find((e: any) => e.type === 'video').privacyTracks).toHaveLength(1)

    // ---------------------------------------------------------------- the pixelation stays
    await card.locator('.open').click()
    await expect.poll(async () => (await project(page))?.id, { timeout: 30_000 }).toBe(id)
    // the deleted copies are made again (the file said "pending" for them)
    await expect
      .poll(async () => (await project(page)).media.every((m: any) => m.status === 'ready' && !!m.thumb && existsSync(m.thumb) && (m.kind !== 'photo' || (!!m.display && existsSync(m.display)))), { timeout: 300_000, intervals: [250] })
      .toBe(true)
    await state(page, `d.store.getState().select([])`)
    const preview2 = await previewShots(page)
    preview2.forEach((b, i) => save(join(shots, `preview-after-${i}.png`), b))
    const t2 = await slideTimes(page)
    expect(t2.photo).toBeCloseTo(t1.photo, 3)
    await checkPixelated('preview after', preview2[0], preview2.slice(1), T)
    // the same picture as before the clean-up
    for (const [i, b] of preview2.entries()) {
      const d = await difference(preview1[i], b)
      console.log(`preview ${i}: ${(d * 100).toFixed(2)} % of the pixels differ`)
      expect(d).toBeLessThan(i === 0 ? 0.002 : 0.02)
    }
    const ex2 = await exportFrames(page, export2)
    save(join(shots, 'export-after-photo.png'), ex2.photo)
    await checkPixelated('export after', ex2.photo, ex2.video, T)
    const dPhoto = await difference(ex1.photo, ex2.photo)
    console.log(`export photo: ${(dPhoto * 100).toFixed(2)} % of the pixels differ`)
    expect(dPhoto).toBeLessThan(0.01)
    for (const [i, b] of ex2.video.entries()) expect(await difference(ex1.video[i], b)).toBeLessThan(0.02)

    // the background face search stays off: no face data comes back
    await page.waitForTimeout(3000)
    expect(await state<boolean>(page, `return s.project.media.some((m) => m.faces !== undefined || m.faceDesc !== undefined || m.videoFaces !== undefined)`)).toBe(false)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
