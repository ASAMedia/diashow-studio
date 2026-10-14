// Export queue end to end: two exports run one after another in the hidden worker window while
// the editor stays usable, and a job survives a crash of the worker (it continues from the last
// finished segment).
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

const probe = (file: string): { frames: number; duration: number; audio: boolean } => {
  const out = execFileSync(ffprobe, ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_type,nb_read_packets:format=duration', '-of', 'json', file]).toString()
  const j = JSON.parse(out)
  const v = j.streams.find((s: any) => s.codec_type === 'video')
  return { frames: Number(v.nb_read_packets), duration: Number(j.format.duration), audio: j.streams.some((s: any) => s.codec_type === 'audio') }
}

const jobs = (page: Page): Promise<any[]> => page.evaluate(() => (window as any).__diashow.store.getState().exportJobs)

test('export queue: background jobs one after another, resume after a worker crash', async () => {
  test.setTimeout((SOFTWARE_GL ? 40 : 20) * 60 * 1000)
  if (!existsSync(mediaDir)) execFileSync('node', ['scripts/make-test-media.mjs'], { cwd: root, stdio: 'inherit' })
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-queue-'))
  const app = await electron.launch(launchOptions(root, dataDir))
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForFunction(() => !!(window as any).__diashow)
  await page.evaluate(async ({ media, music }) => {
    const s = (window as any).__diashow.store.getState()
    await s.createProject(media, 'Queue')
    await (window as any).__diashow.store.getState().addMusic(music)
  }, { media: [mediaDir], music: listFiles(join(mediaDir, 'music')) })
  await page.waitForFunction(() => {
    const p = (window as any).__diashow.store.getState().project
    const done = (x: { status: string }) => x.status === 'ready' || x.status === 'error'
    return p && p.media.length > 0 && p.media.every(done) && p.music.every(done)
  }, null, { timeout: 480_000 })

  // a 45 s show: two segments of 30 s each
  const show = await page.evaluate(() => {
    const d = (window as any).__diashow
    d.store.getState().setTheme('classic')
    d.store.getState().setSettings({ timing: { mode: 'custom', customTotal: 45 } })
    return new Promise<number>((r) => setTimeout(() => r(d.player.current.tl.duration), 200))
  })
  const add = (name: string, w: number, h: number, file: string) =>
    page.evaluate(
      ({ name, w, h, file }) => {
        const d = (window as any).__diashow
        return d.queueExport(d.store.getState().project, { outPath: file, width: w, height: h, fps: 30, codec: 'h264', quality: 'standard', hardware: true, locale: 'de-DE' }, name)
      },
      { name, w, h, file }
    )
  const a = join(dataDir, 'a-large.mp4')
  const b = join(dataDir, 'b-small.mp4')
  // what the editor's taskbar button shows (export/feedback.ts)
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as { __bars: [number, string | undefined][] }
    g.__bars = []
    const set = BrowserWindow.prototype.setProgressBar
    BrowserWindow.prototype.setProgressBar = function (progress: number, options?: { mode?: string }) {
      g.__bars.push([progress, options?.mode])
      return set.call(this, progress, options as never)
    }
  })
  const bars = (): Promise<[number, string | undefined][]> => app.evaluate(() => (globalThis as unknown as { __bars: [number, string | undefined][] }).__bars)
  const t0 = Date.now()
  await add('A', EXPORT_SIZE.width, EXPORT_SIZE.height, a)
  await add('B', EXPORT_SIZE.width / 2, EXPORT_SIZE.height / 2, b)

  // the editor stays usable meanwhile: the chip shows progress, the preview plays
  await expect(page.locator('.queue-chip')).toBeVisible({ timeout: 30_000 })
  await page.evaluate(() => {
    const pl = (window as any).__diashow.player.current
    pl.seek(0)
    pl.play()
  })
  // a busy machine without a GPU draws few frames, but the clock must keep going
  await expect.poll(() => page.evaluate(() => (window as any).__diashow.player.current.t), { timeout: 8_000 }).toBeGreaterThan(1)
  await page.evaluate(() => (window as any).__diashow.player.current.pause())
  // small exports can be done before a click lands on the chip: open the list directly
  await page.evaluate(() => (window as any).__diashow.store.getState().set({ dialog: 'queue' }))
  await expect(page.locator('.job')).toHaveCount(2)
  await page.keyboard.press('Escape')

  await expect.poll(async () => (await jobs(page)).map((j) => j.state).join(','), { timeout: 600_000, intervals: [250] }).toBe('done,done')
  console.log(`two jobs in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  // the taskbar button followed the jobs and is empty again
  await expect.poll(async () => (await bars()).at(-1)).toEqual([-1, 'none'])
  expect((await bars()).some(([p, mode]) => mode === 'normal' && p > 0 && p < 1)).toBe(true)
  for (const f of [a, b]) {
    const p = probe(f)
    console.log(f, JSON.stringify(p))
    expect(p.audio).toBe(true)
    expect(p.frames).toBe(Math.ceil(show * 30 - 1e-6))
  }

  // crash the worker after the first segment: the job comes back and finishes
  const c = join(dataDir, 'c-crash.mp4')
  await add('C', EXPORT_SIZE.width, EXPORT_SIZE.height, c)
  await expect.poll(async () => (await jobs(page)).find((j) => j.name === 'C')?.frame ?? 0, { timeout: 300_000, intervals: [250] }).toBeGreaterThan(30 * 30 + 20)
  const crashed = await app.evaluate(({ BrowserWindow }) => {
    const worker = BrowserWindow.getAllWindows().find((w) => !w.isVisible())
    worker?.webContents.forcefullyCrashRenderer()
    return !!worker
  })
  expect(crashed).toBe(true)
  await expect.poll(async () => (await jobs(page)).find((j) => j.name === 'C')?.state, { timeout: 600_000, intervals: [250] }).toBe('done')
  const pc = probe(c)
  console.log(c, JSON.stringify(pc))
  expect(pc.frames).toBe(Math.ceil(show * 30 - 1e-6))

  // finished jobs can be removed from the list
  for (const j of await jobs(page)) await page.evaluate((id) => (window as any).api.queueRemove(id), j.id)
  await expect.poll(async () => (await jobs(page)).length).toBe(0)
  await expect(page.locator('.queue-chip')).toHaveCount(0)

  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
  expect(errors).toEqual([])
})
