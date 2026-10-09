// Visual check of the Magazine theme with real photos: set DIASHOW_VISUAL_DIR to a folder of
// photos. Exports a 1080p show and writes still frames (rest and mid-transition) plus an
// editor screenshot to test-results/magazine. Skipped when the variable is not set.
import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(__dirname, '..')
const dir = process.env.DIASHOW_VISUAL_DIR
const theme = process.env.DIASHOW_THEME ?? 'magazine'
const out = join(root, 'test-results', theme)
const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')

test(`${theme} theme with real photos`, async () => {
  test.skip(!dir, 'DIASHOW_VISUAL_DIR not set')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const files = readdirSync(dir!).filter((f) => /\.(jpe?g|heic|png|mp4|mov|webm)$/i.test(f)).sort().map((f) => join(dir!, f))
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-mag-'))
  const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, DIASHOW_DATA_DIR: dataDir } })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForFunction(() => !!(window as any).__diashow)
  await page.evaluate(async (paths) => {
    const d = (window as any).__diashow
    await d.store.getState().createProject(paths, 'Skicamp 2026')
  }, files)
  await page.waitForFunction(() => {
    const p = (window as any).__diashow.store.getState().project
    return p && p.media.length > 0 && p.media.every((m: any) => m.status === 'ready' || m.status === 'error')
  }, null, { timeout: 300_000 })

  // face detection runs in the background on every photo
  const faces = await page.waitForFunction(
    () => {
      const p = (window as any).__diashow.store.getState().project
      const photos = p.media.filter((m: any) => m.kind === 'photo' && m.status === 'ready')
      const done = photos.filter((m: any) => m.faces !== undefined)
      return done.length === photos.length ? { photos: photos.length, withFaces: done.filter((m: any) => m.faces.length).length, faces: done.reduce((n: number, m: any) => n + m.faces.length, 0) } : null
    },
    null,
    { timeout: 180_000, polling: 1000 }
  )
  const fr = (await faces.jsonValue())!
  console.log('faces', JSON.stringify(fr))
  expect(fr.withFaces).toBeGreaterThan(0)

  // Magazine, project title, a text slide in front of the 5th photo (becomes its caption)
  const slides = await page.evaluate((th) => {
    const d = (window as any).__diashow
    const s = d.store.getState()
    s.setTheme(th)
    s.setSettings({ timing: { mode: 'custom', customTotal: 70 }, subtitleText: '' })
    s.update((p: any) => {
      p.entries.splice(4, 0, { id: 'txt1', type: 'text', title: 'Sonntag', subtitle: 'Unser erster Tag im Skilager' })
    })
    // several videos on one slide, if the folder has videos
    const videos = d.store.getState().project.entries.filter((e: any) => e.type === 'video').map((e: any) => e.id)
    if (videos.length > 1) d.store.getState().mergeEntries(videos.slice(0, 3))
    return new Promise((r) =>
      setTimeout(() => {
        const tl = d.player.current.tl
        r(tl.slides.map((x: any) => ({ start: x.start, dur: x.duration, transIn: x.transIn, transOut: x.transOut, n: x.entries.length, videos: x.entries.filter((e: any) => e.type === 'video').length, tpl: x.template?.id, caption: x.caption?.text })))
      }, 300)
    )
  }, theme)
  console.log(JSON.stringify(slides))

  // editor with a multi-photo slide selected (crop cells visible on hover)
  await page.evaluate(() => {
    const d = (window as any).__diashow
    const tl = d.player.current.tl
    const multi = tl.slides.find((x: any) => x.entries.length >= 3) ?? tl.slides.find((x: any) => x.kind === 'photos')
    d.store.getState().select(multi.entries.map((e: any) => e.id))
    d.store.getState().set({ tab: 'slide' })
  })
  await page.waitForTimeout(800)
  // crop editing: only themes with movable cells (Magazine, Origami, …)
  const cells = await page.locator('.crop-cell').count()
  let box = { x: 400, y: 300, width: 10, height: 10 }
  if (cells > 0) {
    const cell = page.locator('.crop-cell').first()
    box = (await cell.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 6 })
    await page.mouse.up()
    await page.mouse.wheel(0, -300)
    await page.waitForTimeout(300)
    const crop = await page.evaluate(() => {
      const d = (window as any).__diashow
      const tl = d.player.current.tl
      const multi = tl.slides.find((x: any) => x.entries.length >= 3) ?? tl.slides.find((x: any) => x.kind === 'photos')
      const id = multi.entries[0].id
      return d.store.getState().project.entries.find((e: any) => e.id === id).crop
    })
    console.log('crop after drag', JSON.stringify(crop))
    expect(crop).toBeTruthy()
    expect(crop.zoom).toBeGreaterThan(1)
    if (cells > 1) {
      // switch the second cell to "whole picture" with its toggle button
      const second = page.locator('.crop-cell').nth(1)
      await second.hover()
      await second.locator('.cell-toggle').click()
      await page.waitForTimeout(300)
      const whole = await page.evaluate(() => {
        const d = (window as any).__diashow
        const tl = d.player.current.tl
        const multi = tl.slides.find((x: any) => x.entries.length >= 3) ?? tl.slides.find((x: any) => x.kind === 'photos')
        const id = multi.entries[1]?.id
        return d.store.getState().project.entries.find((e: any) => e.id === id)?.whole
      })
      console.log('whole after toggle', whole)
      expect(whole).toBe(true)
    }

  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.screenshot({ path: join(out, '_editor.png') })

  const video = join(dataDir, 'magazine.mp4')
  await page.evaluate(async (outPath) => {
    const d = (window as any).__diashow
    await d.exportShow(d.store.getState().project, { outPath, width: 1920, height: 1080, fps: 30, codec: 'h264', quality: 'standard', hardware: true }, 'de-DE', () => {}, new AbortController().signal)
  }, video)
  await app.close()

  const times: [string, number][] = []
  ;(slides as any[]).slice(0, 10).forEach((s, i) => {
    times.push([`${String(i).padStart(2, '0')}-rest`, s.start + s.dur / 2])
    if (s.transIn > 0) {
      times.push([`${String(i).padStart(2, '0')}-in25`, s.start + s.transIn * 0.25])
      times.push([`${String(i).padStart(2, '0')}-in60`, s.start + s.transIn * 0.6])
    }
  })
  for (const [name, t] of times) execFileSync(ffmpeg, ['-v', 'error', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1', '-y', join(out, `${name}.jpg`)])
  expect(errors).toEqual([])
})
