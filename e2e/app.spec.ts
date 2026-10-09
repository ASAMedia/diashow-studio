// End-to-end: drives the built Electron app with generated test media, renders every
// theme into screenshots (test-results/themes) and exports a short MP4.
import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
  if (!existsSync(mediaDir)) execFileSync('node', ['scripts/make-test-media.mjs'], { cwd: root, stdio: 'inherit' })
  mkdirSync(shots, { recursive: true })
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-e2e-'))
  const exe = process.env.DIASHOW_EXE
  const app = await electron.launch(
    exe ? { executablePath: exe, env: { ...process.env, DIASHOW_DATA_DIR: dataDir } } : { args: ['.'], cwd: root, env: { ...process.env, DIASHOW_DATA_DIR: dataDir } }
  )
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
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

  const out = join(dataDir, 'export.mp4')
  await page.evaluate(
    async (outPath) => {
      const d = (window as any).__diashow
      d.store.getState().setTheme('classic')
      d.store.getState().setSettings({ timing: { mode: 'custom', customTotal: 16 } })
      await new Promise((r) => setTimeout(r, 100))
      const project = d.store.getState().project
      return d.exportShow(project, { outPath, width: 1280, height: 720, fps: 30, codec: 'h264', quality: 'standard', hardware: true }, 'de-DE', () => {}, new AbortController().signal)
    },
    out
  )
  const probe = execFileSync(join(root, 'vendor/ffmpeg/bin/ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'compact', out]).toString()
  console.log(probe)
  expect(probe).toContain('codec_name=h264')
  expect(probe).toContain('codec_type=audio')
  await app.close()
  console.log(errors.length ? `renderer errors:\n${errors.join('\n')}` : 'no renderer errors')
  expect(errors).toEqual([])
})
