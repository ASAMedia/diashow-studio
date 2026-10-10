// End-to-end checks of the editing tools: review grid, editing several slides, free text boxes,
// pixelated areas, clip speed and song sections, ending with an export of all of it.
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { EXPORT_SIZE, launchOptions, SOFTWARE_GL } from './launch'

const root = resolve(__dirname, '..')
const mediaDir = join(root, 'test-media')
const ffprobe = join(root, 'vendor/ffmpeg/bin/ffprobe.exe')

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? listFiles(p) : [p]
  })
}

const state = <T,>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const d = window.__diashow; const s = d.store.getState(); ${fn} })()`) as Promise<T>

/** Mean absolute difference of two PNG screenshots inside and outside a box (fractions of the image). */
async function diff(a: Buffer, b: Buffer, box: { x: number; y: number; w: number; h: number }): Promise<{ inside: number; outside: number }> {
  const [ra, rb] = await Promise.all([a, b].map((x) => sharp(x).removeAlpha().raw().toBuffer({ resolveWithObject: true })))
  const { width, height } = ra.info
  let inS = 0, inN = 0, outS = 0, outN = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      const d = Math.abs(ra.data[i] - rb.data[i]) + Math.abs(ra.data[i + 1] - rb.data[i + 1]) + Math.abs(ra.data[i + 2] - rb.data[i + 2])
      const inside = x >= box.x * width && x < (box.x + box.w) * width && y >= box.y * height && y < (box.y + box.h) * height
      if (inside) { inS += d; inN++ } else { outS += d; outN++ }
    }
  }
  return { inside: inS / Math.max(1, inN), outside: outS / Math.max(1, outN) }
}

test('review grid, batch edits, text boxes, pixelation, speed, song section, export', async () => {
  test.setTimeout((SOFTWARE_GL ? 30 : 15) * 60 * 1000)
  if (!existsSync(mediaDir)) execFileSync('node', ['scripts/make-test-media.mjs'], { cwd: root, stdio: 'inherit' })
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-feat-'))
  const app = await electron.launch(launchOptions(root, dataDir))
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForFunction(() => !!(window as any).__diashow)

  const music = listFiles(join(mediaDir, 'music'))
  await page.evaluate(async ({ media, music }) => {
    const s = (window as any).__diashow.store.getState()
    await s.createProject(media, 'Features')
    await (window as any).__diashow.store.getState().addMusic(music)
  }, { media: [mediaDir], music })
  await page.waitForFunction(() => {
    const p = (window as any).__diashow.store.getState().project
    const done = (x: { status: string }) => x.status === 'ready' || x.status === 'error'
    return p && p.media.length > 0 && p.media.every(done) && p.music.every(done)
  }, null, { timeout: 480_000 })
  await state(page, `s.setTheme('classic')`)
  const slides0 = await state<number>(page, `return d.player.current.tl.slides.length`)

  // ---- review grid: leave the first item out, give it stars, come back
  await page.locator('.titlebar button', { hasText: /Sichten|Review/ }).click()
  await expect(page.locator('.cull-tile').first()).toBeVisible()
  const tiles = await page.locator('.cull-tile').count()
  const items = await state<number>(page, `return s.project.entries.filter((e) => e.type !== 'text').length`)
  expect(tiles).toBe(Math.min(items, tiles))
  await page.locator('.cull-tile').first().click()
  await page.keyboard.press('x')
  await page.keyboard.press('3')
  const first = await state<{ excluded: boolean; rating: number }>(page, `const e = s.project.entries.find((x) => x.type !== 'text'); return { excluded: !!e.excluded, rating: e.rating ?? 0 }`)
  expect(first).toEqual({ excluded: true, rating: 3 })
  await page.keyboard.press('Space')
  await expect(page.locator('.cull-large')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.locator('.cull')).toHaveCount(0)
  expect(await state<number>(page, `return d.player.current.tl.slides.length`)).toBe(slides0 - 1)
  await expect(page.locator('.excluded-chip')).toBeVisible()

  // ---- several slides at once: Ctrl+A, then slow all videos down
  const before = await state<number[]>(page, `return d.player.current.tl.slides.filter((x) => x.kind === 'video').map((x) => x.duration)`)
  await page.locator('.viewer').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+a')
  await expect(page.locator('.inspector h3', { hasText: /Folien ausgewählt|slides selected/ })).toBeVisible()
  const speedSelect = page.locator('.inspector .row', { hasText: /Tempo|Speed/ }).locator('select')
  await speedSelect.selectOption('0.5')
  const after = await state<number[]>(page, `return d.player.current.tl.slides.filter((x) => x.kind === 'video').map((x) => x.duration)`)
  console.log('video slides before/after 0.5x', before.map((x) => x.toFixed(1)).join(' '), '|', after.map((x) => x.toFixed(1)).join(' '))
  expect(after.length).toBe(before.length)
  after.forEach((d, i) => expect(d).toBeGreaterThan(before[i] * 1.5))

  // ---- a free text box on the first photo slide, dragged in the preview
  const photoSlide = await state<{ ids: string[]; start: number; transIn: number }>(page, `const sl = d.player.current.tl.slides.find((x) => x.kind === 'photos'); return { ids: sl.entries.map((e) => e.id), start: sl.start, transIn: sl.transIn }`)
  await state(page, `s.select(${JSON.stringify(photoSlide.ids)}); s.set({ tab: 'slide' })`)
  await page.waitForTimeout(400)
  const frame = page.locator('.frame')
  const plain = await frame.screenshot()
  await page.locator('.inspector button', { hasText: /Textfeld hinzufügen|Add text box/ }).click()
  await expect(page.locator('.free-text')).toHaveCount(1)
  const fbox = (await page.locator('.free-text').boundingBox())!
  await page.mouse.move(fbox.x + fbox.width / 2, fbox.y + fbox.height / 2)
  await page.mouse.down()
  await page.mouse.move(fbox.x + fbox.width / 2 - 120, fbox.y + fbox.height / 2 + 60, { steps: 6 })
  await page.mouse.up()
  const ft = await state<{ x: number; y: number }>(page, `const ft = s.project.entries.flatMap((e) => e.texts ?? [])[0]; return { x: ft.x, y: ft.y }`)
  expect(ft.x).toBeLessThan(0.45)
  expect(ft.y).toBeGreaterThan(0.55)
  await page.waitForTimeout(300)
  const withText = await frame.screenshot()
  const textDiff = await diff(plain, withText, { x: ft.x - 0.12, y: ft.y - 0.08, w: 0.24, h: 0.16 })
  console.log('text box: change inside/outside', textDiff)
  expect(textDiff.inside).toBeGreaterThan(8)

  // ---- pixelate an area of that photo (set directly), editor opens and closes
  await state(page, `s.set({ textSel: null }); s.updateEntries([${JSON.stringify(photoSlide.ids[0])}], (e) => (e.privacy = [{ x: 0.55, y: 0.15, w: 0.3, h: 0.35 }]))`)
  await page.waitForTimeout(400)
  const pixelated = await frame.screenshot()
  const privDiff = await diff(withText, pixelated, { x: 0.55, y: 0.15, w: 0.3, h: 0.35 })
  console.log('pixelation: change inside/outside', privDiff)
  expect(privDiff.inside).toBeGreaterThan(5)
  expect(privDiff.outside).toBeLessThan(privDiff.inside / 5)
  await page.locator('.inspector button', { hasText: /Gesichter verpixeln|Pixelate faces/ }).first().click()
  await expect(page.locator('.privacy-edit')).toBeVisible()
  await expect(page.locator('.privacy-face.on')).toHaveCount(1)
  await page.locator('.privacy-edit .btn.primary').click()
  await expect(page.locator('.privacy-edit')).toHaveCount(0)

  // ---- song section: only 1 s..4 s of the first song
  await page.locator('.rail button').nth(1).click()
  await page.locator('.track button[title]').first().click()
  await expect(page.locator('.music-trim .bars span').first()).toBeVisible()
  await state(page, `s.update((p) => { p.music[0].trimIn = 1; p.music[0].trimOut = 4 })`)
  const plan = await state<{ offset: number; duration: number }>(page, `const c = d.player.current.plan.clips.find((x) => x.kind === 'music'); return { offset: c.offset, duration: c.duration }`)
  expect(plan.offset).toBe(1)
  expect(plan.duration).toBeLessThanOrEqual(3.001)

  // ---- music per chapter: a chapter slide gets the second song, picked in the music tab
  const chapterId = await state<string>(page, `const at = s.project.entries.filter((e) => e.type !== 'text' && !e.excluded)[3].id; s.select([at]); s.addText(); const st = d.store.getState(); st.setEntry(st.selection[0], { title: 'Montag', titleStyle: 'bigDate' }); return st.selection[0]`)
  await page.locator('.rail button').nth(1).click()
  await page.locator('.track').nth(1).locator('select.chapter-pick').selectOption(chapterId)
  const segs = await state<{ tracks: string[]; chapterId?: string }[]>(page, `return d.player.current.tl.musicSegments.map((x) => ({ tracks: x.tracks, chapterId: x.chapterId }))`)
  const songIds = await state<string[]>(page, `return s.project.music.map((m) => m.id)`)
  expect(segs.length).toBe(2)
  expect(segs[1]).toEqual({ tracks: [songIds[1]], chapterId })
  expect(segs[0].tracks).not.toContain(songIds[1])

  // ---- free collage: three photos on one slide, one dragged by hand
  const collage = await state<string[]>(page, `s.setTheme('magazine'); const ids = s.project.entries.filter((e) => e.type === 'photo' && !e.excluded).slice(0, 3).map((e) => e.id); s.mergeEntries(ids); d.store.getState().setEntry(ids[0], { layout: 'free' }); d.store.getState().select(ids); return ids`)
  await page.waitForTimeout(500)
  await expect(page.locator('.collage-item')).toHaveCount(3)
  const start = await state<{ x: number; y: number }>(page, `return d.player.current.tl.slides.find((x) => x.template?.id === 'free').places[0]`)
  const item = (await page.locator('.collage-item').first().boundingBox())!
  await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2)
  await page.mouse.down()
  await page.mouse.move(item.x + item.width / 2 + 80, item.y + item.height / 2 + 40, { steps: 5 })
  await page.mouse.up()
  const moved = await state<{ x: number; y: number } | undefined>(page, `return s.project.entries.find((e) => e.id === ${JSON.stringify(collage[0])}).place`)
  expect(moved).toBeDefined()
  expect(moved!.x).toBeGreaterThan(start.x + 0.02)
  expect(moved!.y).toBeGreaterThan(start.y + 0.01)

  // ---- export everything (text box, pixelation, slowed videos)
  const out = join(dataDir, 'features.mp4')
  const duration = await state<number>(page, `return d.player.current.tl.duration`)
  await page.evaluate(async ({ outPath, size }) => {
    const d = (window as any).__diashow
    await d.exportShow(d.store.getState().project, { outPath, ...size, fps: 30, codec: 'h264', quality: 'standard', hardware: true }, 'de-DE', () => {}, new AbortController().signal)
  }, { outPath: out, size: EXPORT_SIZE })
  const probe = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString().trim()
  console.log('export', probe, 's for a', duration.toFixed(2), 's show')
  expect(Math.abs(Number(probe) - duration)).toBeLessThan(0.2)

  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
  expect(errors).toEqual([])
})
