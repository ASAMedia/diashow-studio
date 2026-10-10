// "Reduce shake" end to end: the toggle in the Slide tab makes a stabilised copy of a 30 s 1080p
// hand-held clip in the background (timed), the preview switches to it, and an export renders it.
import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { EXPORT_SIZE, launchOptions } from './launch'

const root = resolve(__dirname, '..')
const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')
const ffprobe = join(root, 'vendor/ffmpeg/bin/ffprobe.exe')

async function shakyClip(dir: string): Promise<string> {
  let s = 3
  const r = (): number => ((s = (s * 16807) % 2147483647) / 2147483647)
  const shapes: string[] = []
  for (let i = 0; i < 900; i++) {
    const c = `hsl(${Math.floor(r() * 360)},${30 + Math.floor(r() * 50)}%,${20 + Math.floor(r() * 60)}%)`
    const x = r() * 2200
    const y = r() * 1300
    const w = 10 + r() * 120
    shapes.push(r() < 0.5 ? `<rect x="${x}" y="${y}" width="${w}" height="${10 + r() * 120}" fill="${c}"/>` : `<circle cx="${x}" cy="${y}" r="${w / 2}" fill="${c}"/>`)
  }
  const still = join(dir, 'still.png')
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2200" height="1300"><rect width="2200" height="1300" fill="#7a8f6a"/>${shapes.join('')}</svg>`)).png().toFile(still)
  const clip = join(dir, 'Wackelvideo.mp4')
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', '30', '-i', still, '-t', '30',
    '-vf', "crop=1920:1080:x='140+90*sin(0.2*t)+18*sin(9.1*t)+11*sin(13.7*t+1)':y='110+12*sin(7.3*t+0.5)+9*sin(11.9*t)',format=yuv420p",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '30', clip])
  return clip
}

test('reduce shake: toggle, background stabilisation, preview and export use it', async () => {
  test.setTimeout(10 * 60 * 1000)
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-stab-'))
  const app = await electron.launch(launchOptions(root, dataDir))
  try {
    const clip = await shakyClip(dataDir)
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(e.message))
    await page.waitForFunction(() => !!(window as any).__diashow)
    await page.evaluate(async (clip) => {
      await (window as any).__diashow.store.getState().createProject([clip], 'Wackel')
    }, clip)
    await page.waitForFunction(() => (window as any).__diashow.store.getState().project?.media[0]?.status === 'ready', null, { timeout: 120_000 })
    await page.evaluate(() => {
      const s = (window as any).__diashow.store.getState()
      s.select([s.project.entries[0].id])
      s.set({ tab: 'slide' })
    })

    const toggle = page.locator('.stabilize input[type=checkbox]')
    await expect(toggle).toBeVisible()
    await expect(toggle).not.toBeChecked()
    const t0 = Date.now()
    await toggle.check()
    await expect(page.locator('.stabilize .bar')).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: join(root, 'test-results', 'stabilize-progress.png') })
    await page.waitForFunction(() => !!(window as any).__diashow.store.getState().project.media[0].stabilized, null, { timeout: 300_000 })
    const seconds = (Date.now() - t0) / 1000
    console.log(`30 s 1080p clip stabilised in the app in ${seconds.toFixed(1)} s`)
    const state = await page.evaluate(() => {
      const p = (window as any).__diashow.store.getState().project
      return { entry: p.entries[0], media: p.media[0] }
    })
    expect(state.entry.stabilize).toBe(true)
    expect(state.media.stabilizing).toBeUndefined()
    expect(existsSync(state.media.stabilized)).toBe(true)
    const frames = (f: string): string =>
      execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets,width,height', '-of', 'csv=p=0', f]).toString().trim()
    expect(frames(state.media.stabilized)).toBe(frames(state.media.playback))

    // the preview plays the stabilised copy
    await page.evaluate(async () => {
      const pl = (window as any).__diashow.player.current
      pl.seek(6)
      pl.play()
      await new Promise((r) => setTimeout(r, 800))
      pl.pause()
    })
    const paths = await page.evaluate(() => (window as any).__diashow.player.current.engine.stats().videos.map((v: any) => v.path))
    expect(paths).toContain(state.media.stabilized)
    await page.screenshot({ path: join(root, 'test-results', 'stabilize-done.png') })

    // an export of the first 3 s renders it (same engine path as the preview)
    await page.evaluate(() => (window as any).__diashow.store.getState().setEntry((window as any).__diashow.store.getState().project.entries[0].id, { trimOut: 3 }))
    const out = join(dataDir, 'export.mp4')
    await page.evaluate(
      async ({ out, size }) => {
        const d = (window as any).__diashow
        const p = { ...d.store.getState().project, settings: { ...d.store.getState().project.settings, showTitle: false } }
        await d.exportShow(p, { outPath: out, width: size.width, height: size.height, fps: 30, codec: 'h264', quality: 'standard', hardware: true }, 'de-DE', () => {}, new AbortController().signal)
      },
      { out, size: EXPORT_SIZE }
    )
    expect(Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString())).toBeGreaterThan(2.5)
    expect(errors).toEqual([])
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
  }
})
