// Diagnostics for flicker: builds a Magazine show from DIASHOW_ORIGINALS_DIR, then watches one
// cell of one slide (paused and playing) for brightness jumps, video seeks and texture reloads.
// DIASHOW_FLICKER_DATA keeps the cache between runs. Skipped without the folder.
import { _electron as electron, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

const root = resolve(__dirname, '..')
const dir = process.env.DIASHOW_ORIGINALS_DIR
const slideNo = Number(process.env.DIASHOW_SLIDE ?? 3)
const chapters = process.env.DIASHOW_CHAPTERS === '1'

test.setTimeout(60 * 60 * 1000)

test('flicker diagnostics', async () => {
  test.skip(!dir, 'DIASHOW_ORIGINALS_DIR not set')
  const dataDir = process.env.DIASHOW_FLICKER_DATA ?? join(root, 'test-results', 'flicker-data')
  mkdirSync(dataDir, { recursive: true })
  const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, DIASHOW_DATA_DIR: dataDir } })
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!(window as any).__diashow)
  await page.evaluate(async (d) => (window as any).__diashow.store.getState().createProject([d], 'Flicker'), dir!)
  await page.waitForFunction(() => {
    const p = (window as any).__diashow.store.getState().project
    return p && p.media.length && p.media.every((m: any) => m.status === 'ready' || m.status === 'error')
  }, null, { timeout: 40 * 60 * 1000, polling: 3000 })

  const info = await page.evaluate(async ({ n, ch, mk }) => {
    const d = (window as any).__diashow
    const st = d.store.getState()
    st.setTheme('magazine')
    if (ch) st.insertDayTitles('folder')
    if (mk) {
      // a six-cell slide with a short video in it (it holds its last frame for most of the slide)
      const es = d.store.getState().project.entries
      const video = es.find((e: any) => e.type === 'video')
      const photos = es.filter((e: any) => e.type === 'photo').slice(0, 5)
      d.store.getState().mergeEntries([photos[0].id, video.id, ...photos.slice(1).map((e: any) => e.id)])
      d.store.getState().setSettings({ playFullVideos: true })
    }
    await new Promise((r) => setTimeout(r, 800))
    const pl = d.player.current
    const s = mk ? pl.tl.slides.find((x: any) => x.entries.some((e: any) => e.type === 'video') && x.entries.length === 6) : pl.tl.slides[n - 1]
    const boxes = pl.engine.editBoxes(s)
    const W = pl.engine.c.W
    // the top cell whose centre is closest to the middle, or the video cell
    const top = Math.min(...boxes.map((b: any) => b.y))
    const cand = boxes.map((b: any, i: number) => ({ b, i })).filter((x: any) => Math.abs(x.b.y - top) < 2)
    const vi = s.entries.findIndex((e: any) => e.type === 'video')
    const mid = mk ? { b: boxes[vi], i: vi } : cand.sort((a: any, b: any) => Math.abs(a.b.x + a.b.w / 2 - W / 2) - Math.abs(b.b.x + b.b.w / 2 - W / 2))[0]
    d.store.getState().select(s.entries.map((e: any) => e.id))
    return {
      slide: { start: s.start, duration: s.duration, transIn: s.transIn, kind: s.kind, template: s.template?.id },
      cells: s.entries.map((e: any, i: number) => ({ i, type: e.type, name: s.media[i]?.name, format: s.media[i]?.format, duration: s.media[i]?.duration, whole: e.whole, faces: s.media[i]?.faces?.length, clip: s.clips?.[i] })),
      watch: mid?.i,
      box: mid?.b,
      canvas: [pl.engine.c.W, pl.engine.c.H]
    }
  }, { n: slideNo, ch: chapters, mk: process.env.DIASHOW_VIDEO_SLIDE === '1' })
  console.log(JSON.stringify(info, null, 1))

  const frame = page.locator('.stage .frame')
  const fb = (await frame.boundingBox())!
  const sx = fb.width / info.canvas[0]
  const clip = { x: fb.x + info.box.x * sx + 4, y: fb.y + info.box.y * sx + 4, width: info.box.w * sx - 8, height: info.box.h * sx - 8 }

  const sample = async (label: string, seconds: number): Promise<void> => {
    const lum: number[] = []
    const stats0 = await page.evaluate(() => (window as any).__diashow.player.current.engine.stats())
    for (let k = 0; k < seconds * 10; k++) {
      const { data, info: px } = await sharp(await page.screenshot({ clip })).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      let sum = 0
      const step = px.channels * 4
      for (let p = 0; p < data.length; p += step) sum += data[p] * 0.3 + data[p + 1] * 0.59 + data[p + 2] * 0.11
      lum.push(sum / (data.length / step))
      await page.waitForTimeout(60)
    }
    const stats1 = await page.evaluate(() => (window as any).__diashow.player.current.engine.stats())
    console.log(label, 'seeks before/after', JSON.stringify(stats0.videos), JSON.stringify(stats1.videos))
    const jumps = lum.slice(1).map((v, i) => Math.abs(v - lum[i]))
    console.log(label, JSON.stringify({ lum: lum.map((v) => Math.round(v)), maxJump: Math.round(Math.max(...jumps)), bigJumps: jumps.filter((j) => j > 8).length, imageLoads: stats1.imageLoads - stats0.imageLoads, imageEvictions: stats1.imageEvictions - stats0.imageEvictions, videos: stats1.videos }))
  }

  await page.evaluate(({ t }) => (window as any).__diashow.player.current.seek(t), { t: info.slide.start + info.slide.transIn + 0.3 })
  await page.waitForTimeout(1500)
  await sample('paused', 3)
  await page.evaluate(({ t }) => {
    const pl = (window as any).__diashow.player.current
    pl.seek(t)
    pl.play()
  }, { t: info.slide.start + info.slide.transIn })
  await sample('playing', 8)
  await page.evaluate(() => (window as any).__diashow.player.current.pause())
  await app.close()
})
