// Screenshots for the in-app handbook (src/renderer/src/handbook/*.md), in German and English.
// Drives the app with the generated test media (never real photos) and writes JPEGs to
// src/renderer/public/handbook/<de|en>/, which are bundled with the app. Only runs on request:
//
//   npx electron-vite build && DIASHOW_HANDBOOK_SHOTS=1 npx playwright test e2e/handbook-shots.spec.ts
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { launchOptions } from './launch'

const root = resolve(__dirname, '..')
const mediaDir = join(root, 'test-media')
const outRoot = join(root, 'src', 'renderer', 'public', 'handbook')
const WIDTH = 1280
const HEIGHT = 800

const state = <T,>(page: Page, body: string): Promise<T> =>
  page.evaluate(`(async () => { const d = window.__diashow; const s = d.store.getState(); ${body} })()`) as Promise<T>

async function shot(page: Page, lang: string, name: string): Promise<void> {
  await page.waitForTimeout(600)
  const layout = await page.evaluate(() => {
    const strip = document.querySelector('.strip')?.getBoundingClientRect()
    return { w: innerWidth, h: innerHeight, strip: strip ? [Math.round(strip.top), Math.round(strip.bottom)] : null }
  })
  console.log(lang, name, JSON.stringify(layout))
  const png = await page.screenshot()
  const jpg = await sharp(png).resize({ width: 1100 }).jpeg({ quality: 80, mozjpeg: true }).toBuffer()
  writeFileSync(join(outRoot, lang, `${name}.jpg`), jpg)
}

async function stubOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    ;(dialog as unknown as { showOpenDialog: () => Promise<unknown> }).showOpenDialog = async () => ({ canceled: false, filePaths: p })
  }, paths)
}

for (const lang of ['de', 'en'] as const) {
  test(`handbook screenshots (${lang})`, async () => {
    test.skip(!process.env.DIASHOW_HANDBOOK_SHOTS, 'set DIASHOW_HANDBOOK_SHOTS=1 to renew the handbook screenshots')
    test.setTimeout(12 * 60 * 1000)
    if (!existsSync(mediaDir)) execFileSync('node', ['scripts/make-test-media.mjs'], { cwd: root, stdio: 'inherit' })
    mkdirSync(join(outRoot, lang), { recursive: true })
    const de = lang === 'de'
    const dataDir = mkdtempSync(join(tmpdir(), 'diashow-shots-'))
    const opts = launchOptions(root, dataDir)
    opts.env.DIASHOW_LOCALE = de ? 'de-DE' : 'en-US'
    delete opts.env.DIASHOW_UPDATE_URL
    const app = await electron.launch(opts)
    try {
      const page = await app.firstWindow()
      await page.waitForFunction(() => !!(window as any).__diashow)
      await app.evaluate(({ BrowserWindow }, [w, h]) => {
        const win = BrowserWindow.getAllWindows().find((x) => x.isVisible()) ?? BrowserWindow.getAllWindows()[0]
        win.setContentSize(w, h)
        win.center()
      }, [WIDTH, HEIGHT])
      // one-time tips would cover parts of the pictures
      await page.evaluate(() => ['home', 'editor'].forEach((id) => localStorage.setItem(`tip:${id}`, '1')))
      // the pictures show the dark theme, whatever Windows uses on this PC
      await page.evaluate(() => {
        localStorage.setItem('appearance', 'dark')
        window.dispatchEvent(new Event('appearance'))
      })

      // ---- assistant: a folder, then theme and music
      const wizard = page.getByTestId('wizard')
      await expect(wizard).toBeVisible()
      await stubOpenDialog(app, [mediaDir])
      await wizard.locator('.wizard-pick button').nth(1).click()
      await expect(wizard).toHaveAttribute('data-step', '2', { timeout: 120_000 })
      await state(page, `s.update((p) => (p.name = ${JSON.stringify(de ? 'Klassenfahrt' : 'Class trip')}))`)
      await stubOpenDialog(app, [join(mediaDir, 'music', 'track1.mp3'), join(mediaDir, 'music', 'track2.m4a')])
      await wizard.locator('.wizard-music .btn').click()
      await wizard.locator('.theme-card').nth(6).click()
      await page.waitForFunction(() => {
        const p = (window as any).__diashow.store.getState().project
        return p.media.filter((m: any) => m.kind === 'photo' && m.thumb).length >= 3 && p.music.every((m: any) => m.status === 'ready')
      }, null, { timeout: 180_000 })
      await shot(page, lang, 'wizard')
      await wizard.locator('.wizard-foot .btn.primary').click()
      await wizard.locator('.wizard-finish button').nth(2).click()
      await expect(wizard).toHaveCount(0)

      await page.waitForFunction(
        () => {
          const p = (window as any).__diashow.store.getState().project
          const done = (x: { status: string }) => x.status === 'ready' || x.status === 'error'
          return p.media.length > 0 && p.media.every(done) && p.music.every(done)
        },
        null,
        { timeout: 480_000 }
      )

      // ---- editor, music
      const photoSlide = await state<{ id: string; t: number }>(
        page,
        `const tl = d.player.current.tl; const sl = tl.slides.find((x, i) => i > 0 && x.kind !== 'text' && x.entries.length >= 2) ?? tl.slides[1]; s.select(sl.entries.map((e) => e.id)); d.player.current.seek(sl.start + sl.duration * 0.6); return { id: sl.entries[0].id, t: sl.start + sl.duration * 0.6 }`
      )
      await state(page, `s.set({ tab: 'themes' })`)
      await shot(page, lang, 'editor')
      await state(page, `s.set({ tab: 'music' })`)
      await shot(page, lang, 'music')

      // ---- privacy: an area pixelated on a single photo, its editor open
      await state(
        page,
        `const tl = d.player.current.tl; const sl = tl.slides.find((x) => x.kind !== 'text' && x.entries.length === 1 && x.entries[0].type === 'photo') ?? tl.slides.find((x) => x.entries[0]?.type === 'photo'); const e = sl.entries[0]; s.updateEntries([e.id], (x) => (x.privacy = [{ x: 0.38, y: 0.22, w: 0.22, h: 0.3 }])); s.select([e.id]); s.set({ tab: 'slide', privacyEdit: e.id }); d.player.current.seek(sl.start + sl.duration * 0.5)`
      )
      await expect(page.locator('.privacy-edit')).toBeVisible()
      await page.waitForTimeout(1500)
      await shot(page, lang, 'privacy')
      await state(page, `s.set({ privacyEdit: null })`)

      // ---- review grid
      await state(page, `s.set({ view: 'cull' })`)
      await expect(page.locator('.cull-tile').first()).toBeVisible()
      await page.locator('.cull-tile').nth(1).click()
      await page.keyboard.press('4')
      await page.locator('.cull-tile').nth(2).click()
      await page.keyboard.press('x')
      await page.locator('.cull-tile').nth(0).click()
      await page.keyboard.press('5')
      await shot(page, lang, 'cull')
      await state(page, `s.set({ view: 'editor' })`)

      // ---- export dialog, then a short export in the queue
      await state(page, `s.select([${JSON.stringify(photoSlide.id)}]); s.set({ exportOpen: true })`)
      await expect(page.locator('.dialog').first()).toBeVisible()
      await shot(page, lang, 'export')
      await state(page, `s.set({ exportOpen: false })`)
      const file = join(dataDir, de ? 'Klassenfahrt.mp4' : 'Class trip.mp4')
      await page.evaluate(
        ({ file, name, locale }) => {
          const d = (window as any).__diashow
          const p = structuredClone(d.store.getState().project)
          p.settings.timing = { mode: 'custom', customTotal: 12 }
          return d.queueExport(p, { outPath: file, width: 640, height: 360, fps: 30, codec: 'h264', quality: 'standard', hardware: true, locale }, name)
        },
        { file, name: de ? 'Klassenfahrt' : 'Class trip', locale: de ? 'de-DE' : 'en-US' }
      )
      await page.waitForFunction(() => (window as any).__diashow.store.getState().exportJobs.some((j: any) => j.state === 'done'), null, { timeout: 300_000 })
      await state(page, `s.set({ dialog: 'queue' })`)
      await shot(page, lang, 'queue')

      // ---- share over Wi-Fi (not started: no address in the picture), settings
      await state(page, `s.set({ dialog: 'share' })`)
      await shot(page, lang, 'share')
      await state(page, `s.set({ dialog: 'settings' })`)
      await page.waitForTimeout(1500)
      await shot(page, lang, 'settings')
      await state(page, `s.set({ dialog: null })`)

      // ---- home with the show
      await state(page, `s.closeProject()`)
      await expect(page.locator('.project').first()).toBeVisible()
      await page.waitForTimeout(800)
      await shot(page, lang, 'home')

      const made = readdirSync(join(outRoot, lang)).filter((f) => f.endsWith('.jpg'))
      console.log(lang, made.join(', '))
      // every picture the handbook names exists
      const md = readFileSync(join(root, 'src', 'renderer', 'src', 'handbook', `${lang}.md`), 'utf8')
      for (const m of md.matchAll(/!\[[^\]]*\]\(([\w.-]+)\)/g)) expect(made).toContain(m[1])
    } finally {
      await app.close()
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
}
