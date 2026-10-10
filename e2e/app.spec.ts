// End-to-end: drives the built Electron app with generated test media, renders every
// theme into screenshots (test-results/themes) and exports a short MP4.
import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appArgs, EXPORT_SIZE, SOFTWARE_GL } from './launch'

const root = resolve(__dirname, '..')
const mediaDir = join(root, 'test-media')
const shots = join(root, 'test-results', 'themes')
const THEMES = ['kenburns', 'origami', 'reflections', 'panels', 'vintage', 'classic', 'magazine', 'retro']

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? listFiles(p) : [p]
  })
}

test('import, preview every theme, export', async () => {
  test.setTimeout((SOFTWARE_GL ? 30 : 10) * 60 * 1000)
  if (!existsSync(mediaDir)) execFileSync('node', ['scripts/make-test-media.mjs'], { cwd: root, stdio: 'inherit' })
  mkdirSync(shots, { recursive: true })
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-e2e-'))
  const exe = process.env.DIASHOW_EXE
  const app = await electron.launch(
    exe ? { executablePath: exe, env: { ...process.env, DIASHOW_DATA_DIR: dataDir } } : { args: appArgs(), cwd: root, env: { ...process.env, DIASHOW_DATA_DIR: dataDir } }
  )
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('console', (m) => {
    // MediaPipe prints its TFLite delegate info through console.error
    if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForFunction(() => !!(window as any).__diashow)

  const music = listFiles(join(mediaDir, 'music'))
  await page.evaluate(
    async ({ media, music }) => {
      const s = (window as any).__diashow.store.getState()
      await s.createProject(media, 'E2E Test')
      await (window as any).__diashow.store.getState().addMusic(music)
    },
    { media: [mediaDir].filter(Boolean), music }
  )
  // the music folder is part of test-media; drop audio entries the folder import ignores anyway
  await page.waitForFunction(
    () => {
      const p = (window as any).__diashow.store.getState().project
      const done = (x: { status: string }) => x.status === 'ready' || x.status === 'error'
      return p && p.media.length > 0 && p.media.every(done) && p.music.every(done)
    },
    null,
    { timeout: 480_000 }
  )
  const summary = await page.evaluate(() => {
    const p = (window as any).__diashow.store.getState().project
    return {
      media: p.media.map((m: any) => `${m.status.padEnd(6)} ${m.name.padEnd(22)} ${m.format} ${m.width}x${m.height}${m.proxied ? ' proxy' : ''}${m.live ? ' live' : ''}${m.error ? ' ' + m.error : ''}`),
      music: p.music.map((m: any) => `${m.status} ${m.title} ${m.duration.toFixed(1)}s`)
    }
  })
  console.log(summary.media.join('\n'))
  console.log(summary.music.join('\n'))
  expect(summary.media.filter((l: string) => l.startsWith('error')).length).toBe(0)

  // real-time preview with audio: the clock must advance and media elements must not error
  const played = await page.evaluate(async () => {
    const pl = (window as any).__diashow.player.current
    pl.seek(0)
    pl.play()
    await new Promise((r) => setTimeout(r, 3000))
    const t = pl.t
    pl.pause()
    return t
  })
  expect(played).toBeGreaterThan(2)

  const frame = page.locator('.stage .frame')
  for (const theme of THEMES) {
    await page.evaluate((th) => (window as any).__diashow.store.getState().setTheme(th), theme)
    const times: number[] = await page.evaluate(() => {
      const st = (window as any).__diashow
      const tl = st.player.current.tl
      const out: number[] = []
      for (const s of tl.slides.slice(0, 7)) {
        out.push(s.start + s.duration * 0.5)
        if (s.transOut > 0) out.push(s.start + s.duration - s.transOut / 2)
      }
      return out
    })
    for (const [i, time] of times.slice(0, 8).entries()) {
      await page.evaluate((tt) => (window as any).__diashow.player.current.seek(tt), time)
      await page.waitForTimeout(450)
      await frame.screenshot({ path: join(shots, `${theme}-${String(i).padStart(2, '0')}.png`) })
    }
  }
  await page.screenshot({ path: join(shots, '_editor.png') })

  // autoscroll: while playing, the playhead stays inside the visible part of the filmstrip
  await page.evaluate(() => (window as any).__diashow.store.getState().setTheme('kenburns'))
  await page.evaluate(() => {
    const pl = (window as any).__diashow.player.current
    pl.seek(Math.max(0, pl.tl.duration - 14))
    pl.play()
  })
  const samples: number[][] = []
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000)
    samples.push(
      await page.evaluate(() => {
        const ph = document.querySelector('.playhead')!.getBoundingClientRect()
        const sc = document.querySelector('.strip-scroll')!.getBoundingClientRect()
        return [ph.left, sc.left, sc.right]
      })
    )
  }
  await page.evaluate(() => (window as any).__diashow.player.current.pause())
  console.log('playhead vs filmstrip', JSON.stringify(samples.map((x) => x.map(Math.round))))
  expect(samples.every(([x, l, r]) => x >= l && x <= r)).toBe(true)

  // slide grouping in Magazine: drag a slide onto another, and Ctrl+click + context menu
  const slideIds = (): Promise<string[][]> =>
    page.evaluate(() => (window as any).__diashow.player.current.tl.slides.map((s: any) => s.entries.map((e: any) => e.id)))
  await page.evaluate(() => (window as any).__diashow.store.getState().setTheme('magazine'))
  await page.waitForTimeout(300)
  let before = await slideIds()
  // two photo slides that fit together (at most 6 items)
  const kinds: string[] = await page.evaluate(() => (window as any).__diashow.player.current.tl.slides.map((s: any) => s.kind))
  const pairs: [number, number][] = []
  for (let a = 0; a < before.length; a++) for (let b = a + 2; b < before.length; b++) {
    if (kinds[a] !== 'text' && kinds[b] !== 'text' && before[a].length + before[b].length <= 6) pairs.push([a, b])
  }
  const [from, to] = pairs[0]
  const cards = page.locator('.cards .card:not(.add)')
  await cards.nth(from).scrollIntoViewIfNeeded()
  await cards.nth(from).dragTo(cards.nth(to))
  await page.waitForTimeout(300)
  let after = await slideIds()
  const wanted = [...before[from], ...before[to]]
  expect(after.some((s) => wanted.every((id) => s.includes(id)))).toBe(true)
  before = after
  const pairs2: [number, number][] = []
  for (let a = 0; a < before.length; a++) for (let b = a + 1; b < before.length; b++) if (before[a].length + before[b].length <= 6) pairs2.push([a, b])
  const [x, y] = pairs2[0]
  await cards.nth(x).scrollIntoViewIfNeeded()
  await cards.nth(x).click()
  await cards.nth(y).click({ modifiers: ['Control'] })
  await cards.nth(y).click({ button: 'right' })
  await page.locator('.menu').getByText(/Zu einer Folie zusammenfassen|Combine into one slide/).click()
  await page.waitForTimeout(300)
  after = await slideIds()
  const wanted2 = [...before[x], ...before[y]]
  expect(after.some((s) => wanted2.every((id) => s.includes(id)))).toBe(true)

  // Ctrl+Z restores the slides from before the merge, Ctrl+Y does it again
  await page.locator('.stage').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(300)
  expect(await slideIds()).toEqual(before)
  await page.keyboard.press('Control+y')
  await page.waitForTimeout(300)
  expect(await slideIds()).toEqual(after)

  // presentation: a second window plays the show, Esc in the editor ends it
  await page.evaluate(() => (window as any).__diashow.store.getState().set({ presenting: true }))
  // the show window by its address (other windows, e.g. the export worker, may open too); slow without a GPU
  await expect.poll(() => app.windows().some((w) => w.url().includes('#present')), { timeout: 60_000 }).toBe(true)
  const pw = app.windows().find((w) => w.url().includes('#present'))!
  await pw.waitForFunction(() => !!document.querySelector('canvas'), null, { timeout: 60_000 })
  await page.waitForTimeout(2500)
  const presenterTime = await page.locator('.presenter .val').innerText()
  console.log('presenter shows', presenterTime)
  expect(presenterTime).not.toBe('0:00 / 0:00')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  expect(app.windows().length).toBe(1)

  // pack the project into a folder and open the packed file again
  const packDir = join(dataDir, 'pack')
  mkdirSync(packDir, { recursive: true })
  const packed = await page.evaluate(async (dir) => {
    const d = (window as any).__diashow
    const file = await (window as any).api.packProject(d.store.getState().project, dir)
    const p = await (window as any).api.importProjectFile(file)
    return { file, entries: p.entries.length, media: p.media.length }
  }, packDir)
  console.log('packed', JSON.stringify(packed))
  expect(packed.file).toMatch(/\.dshow$/)
  expect(packed.media).toBeGreaterThan(10)

  // day titles from the project menu
  await page.locator('.titlebar button[title="Weitere Aktionen"], .titlebar button[title="More actions"]').click()
  await page.getByText(/Tagestitel aus Aufnahmedatum|Day titles from capture date/).click()
  await page.waitForTimeout(300)
  const autoTitles = await page.evaluate(() => (window as any).__diashow.store.getState().project.entries.filter((e: any) => e.auto === 'day').length)
  console.log('day titles', autoTitles)
  expect(autoTitles).toBeGreaterThan(0)

  const out = join(dataDir, 'export.mp4')
  await page.evaluate(
    async ({ outPath, size }) => {
      const d = (window as any).__diashow
      d.store.getState().setTheme('classic')
      d.store.getState().setSettings({ timing: { mode: 'custom', customTotal: 16 } })
      await new Promise((r) => setTimeout(r, 100))
      const project = d.store.getState().project
      return d.exportShow(project, { outPath, ...size, fps: 30, codec: 'h264', quality: 'standard', hardware: true }, 'de-DE', () => {}, new AbortController().signal)
    },
    { outPath: out, size: EXPORT_SIZE }
  )
  const probe = execFileSync(join(root, 'vendor/ffmpeg/bin/ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'compact', out]).toString()
  console.log(probe)
  expect(probe).toContain('codec_name=h264')
  expect(probe).toContain('codec_type=audio')
  await app.close()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
  console.log(errors.length ? `renderer errors:\n${errors.join('\n')}` : 'no renderer errors')
  expect(errors).toEqual([])
})
