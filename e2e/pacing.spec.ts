// Diagnostics: plays the show in the editor preview and reports frame pacing and photos that
// were still loading, per transition. Uses DIASHOW_VISUAL_DIR photos; skipped without it.
import { _electron as electron, test } from '@playwright/test'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appArgs } from './launch'

const root = resolve(__dirname, '..')
const dir = process.env.DIASHOW_VISUAL_DIR
const theme = process.env.DIASHOW_THEME ?? 'magazine'

test('preview pacing', async () => {
  test.skip(!dir, 'DIASHOW_VISUAL_DIR not set')
  const files = readdirSync(dir!).filter((f) => /\.(jpe?g|png|heic|mp4|mov)$/i.test(f)).sort().map((f) => join(dir!, f))
  const app = await electron.launch({ args: appArgs(), cwd: root, env: { ...process.env, DIASHOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'diashow-pace-')) } })
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!(window as any).__diashow)
  await page.evaluate(async (paths) => (window as any).__diashow.store.getState().createProject(paths, 'Pacing'), files)
  await page.waitForFunction(() => {
    const p = (window as any).__diashow.store.getState().project
    return p && p.media.length > 0 && p.media.every((m: any) => m.status === 'ready' || m.status === 'error')
  }, null, { timeout: 300_000 })
  const report = await page.evaluate(async (th) => {
    const d = (window as any).__diashow
    d.store.getState().setTheme(th)
    d.store.getState().setSettings({ timing: { mode: 'custom', customTotal: 60 } })
    await new Promise((r) => setTimeout(r, 500))
    const pl = d.player.current
    pl.frameLog = []
    pl.seek(0)
    pl.play()
    await new Promise((r) => setTimeout(r, 40_000))
    pl.pause()
    const log = pl.frameLog as { t: number; dt: number; render: number; missing: number }[]
    const tl = pl.tl
    const rows = tl.slides.filter((s: any) => s.transIn > 0 && s.start < 40).map((s: any) => {
      const win = log.filter((f) => f.t >= s.start && f.t <= s.start + s.transIn)
      return {
        slide: s.index,
        trans: +s.transIn.toFixed(2),
        frames: win.length,
        maxDt: Math.round(Math.max(0, ...win.map((f) => f.dt))),
        maxRender: Math.round(Math.max(0, ...win.map((f) => f.render))),
        missingFrames: win.filter((f) => f.missing > 0).length
      }
    })
    const all = log.slice(1)
    const sorted = [...all.map((f) => f.dt)].sort((a, b) => a - b)
    return { rows, frames: all.length, p50: Math.round(sorted[Math.floor(sorted.length / 2)]), p99: Math.round(sorted[Math.floor(sorted.length * 0.99)]), max: Math.round(sorted[sorted.length - 1]) }
  }, theme)
  console.log(theme, JSON.stringify({ frames: report.frames, p50: report.p50, p99: report.p99, max: report.max }))
  console.table(report.rows)
  await app.close()
})
