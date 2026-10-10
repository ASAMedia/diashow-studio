// UI review: opens every screen and dialog with the generated test media and saves a screenshot of
// each, for looking through the whole UI at once (spacing, long German texts, small and large windows,
// light and dark). Only runs on request; by default in both languages and themes and one large window:
//
//   npx electron-vite build && DIASHOW_UI_REVIEW=1 [UI_REVIEW_RUNS=de-dark-1024x700,en-light-1024x700] \
//     npx playwright test e2e/ui-review.spec.ts
//
// Pictures go to test-results/ui-review/<lang>-<theme>-<size>/, with a11y.txt (contrast, names, labels).
// Sizes wider than 1600 px are laid out at that size, zoomed out so they fit on any screen.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { answerOpenDialog, answerSaveDialog, ensureTestMedia, launch, mediaDir, removeDir, root } from './harness'

interface Run {
  lang: 'de' | 'en'
  theme: 'light' | 'dark'
  w: number
  h: number
}
/** UI_REVIEW_RUNS=de-dark-1024x700,en-light-1024x700,…; by default both languages and themes, and one large window. */
const RUNS: Run[] = (process.env.UI_REVIEW_RUNS ?? 'de-dark-1024x700,en-dark-1024x700,de-light-1024x700,en-light-1024x700,de-dark-2560x1440')
  .split(',')
  .map((x) => {
    const [lang, theme, size] = x.trim().split('-')
    const [w, h] = size.split('x').map(Number)
    return { lang: lang === 'en' ? 'en' : 'de', theme: theme === 'light' ? 'light' : 'dark', w, h }
  })
let W = 1024
let H = 700
let out = ''
let de = true

const state = <T,>(page: Page, body: string): Promise<T> =>
  page.evaluate(`(async () => { const d = window.__diashow; const s = d.store.getState(); ${body} })()`) as Promise<T>

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? listFiles(p) : [p]
  })
}

let n = 0
async function snap(page: Page, name: string, wait = 400): Promise<void> {
  await page.waitForTimeout(wait)
  const file = join(out, `${String(++n).padStart(2, '0')}-${name}.png`)
  const png = await page.screenshot()
  // zoomed out (large sizes): the capture is bigger than the page; keep the page
  const view = await page.evaluate(() => ({ w: Math.round(innerWidth * devicePixelRatio), h: Math.round(innerHeight * devicePixelRatio) }))
  const meta = await sharp(png).metadata()
  if (meta.width && meta.height && (view.w < meta.width - 2 || view.h < meta.height - 2)) {
    await sharp(png).extract({ left: 0, top: 0, width: Math.min(view.w, meta.width), height: Math.min(view.h, meta.height) }).toFile(file)
  } else writeFileSync(file, png)
  // elements that overflow the window or the page sideways are worth a look
  const overflow = await page.evaluate(() => {
    const found: string[] = []
    const vw = document.documentElement.clientWidth
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.dialog, .menu, .titlebar > *, .inspector, .hero > *'))) {
      const r = el.getBoundingClientRect()
      if (r.width && (r.right > vw + 1 || r.left < -1)) found.push(`${el.className} ${Math.round(r.left)}..${Math.round(r.right)}`)
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.dialog'))) {
      if (el.scrollWidth > el.clientWidth + 1) found.push(`${el.className} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`)
      const r = el.getBoundingClientRect()
      if (r.bottom > innerHeight + 1 || r.top < -1) found.push(`${el.className} taller than the window (${Math.round(r.top)}..${Math.round(r.bottom)})`)
    }
    return found
  })
  console.log(`${name}${overflow.length ? `  !! ${overflow.join(' | ')}` : ''}`)
  for (const issue of await audit(page)) {
    const key = issue.replace(/\s+\(.*$/, '')
    if (!issues.has(key)) issues.set(key, `${name}: ${issue}`)
  }
}

/** Accessibility findings of all screens, first occurrence of each (written to a11y.txt at the end). */
const issues = new Map<string, string>()

/**
 * Checks the visible page: text contrast against its actual background (WCAG AA: 4.5:1, large text
 * 3:1), buttons without an accessible name, form fields without a label, dialogs without a name.
 * Text over photos (thumbnails, the preview) is skipped: its background is the picture.
 */
function audit(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    const parse = (c: string): number[] | null => {
      const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
      return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null
    }
    const lum = ([r, g, b]: number[]): number => {
      const f = (v: number): number => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const over = (top: number[], bottom: number[]): number[] => {
      const a = top[3]
      return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]
    }
    /** The colour behind an element (stacked backgrounds), or null over a picture. */
    const background = (el: Element): number[] | null => {
      const layers: number[][] = []
      for (let e: Element | null = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e)
        if (cs.backgroundImage !== 'none' && !cs.backgroundImage.startsWith('linear-gradient(90deg, transparent')) return null
        if (e.matches('img, video, canvas, .tiles, .pic, .trim, .stage .frame, .thumb, .share-qr')) return null
        const c = parse(cs.backgroundColor)
        if (c && c[3] > 0) {
          layers.push(c)
          if (c[3] >= 1) break
        }
      }
      // pictures under the element (absolutely positioned over a thumbnail)
      let bg = [0, 0, 0, 1]
      for (const c of layers.reverse()) bg = over(c, bg)
      return bg
    }
    const seen = new Set<string>()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? '').trim()
      const el = node.parentElement
      if (!text || !el) continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0 || el.closest('[aria-hidden="true"], .sr-only, svg, option, .overlay ~ * .overlay')) continue
      // behind an open dialog: not readable anyway
      const dialogs = document.querySelectorAll('[role="dialog"]')
      if (dialogs.length && !el.closest('[role="dialog"]') && !el.closest('.menu, .notice-stack')) continue
      if (el.closest('button:disabled, :disabled')) continue
      const fg = parse(cs.color)
      const bg = background(el)
      if (!fg || !bg) continue
      let opacity = 1
      for (let e: Element | null = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity)
      const color = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg)
      const ratio = (Math.max(lum(color), lum(bg)) + 0.05) / (Math.min(lum(color), lum(bg)) + 0.05)
      const size = parseFloat(cs.fontSize)
      const bold = Number(cs.fontWeight) >= 700
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5
      if (ratio < need) {
        const key = `${el.className}|${cs.color}|${bg.join(',')}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(`contrast ${ratio.toFixed(2)} < ${need}: "${text.slice(0, 40)}" (.${String(el.className).split(' ').join('.')} ${cs.color} on rgb(${bg.slice(0, 3).map(Math.round).join(',')}))`)
      }
    }
    for (const b of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], [role="tab"], [role="menuitem"]'))) {
      if (!b.getClientRects().length) continue
      const name = (b.getAttribute('aria-label') ?? '').trim() || (b.textContent ?? '').trim() || (b.getAttribute('title') ?? '').trim()
      if (!name) out.push(`button without a name (${b.outerHTML.slice(0, 90)})`)
    }
    for (const f of Array.from(document.querySelectorAll<HTMLInputElement>('input:not([type="hidden"]), select, textarea'))) {
      if (!f.getClientRects().length) continue
      const named = f.labels?.length || f.getAttribute('aria-label') || f.getAttribute('aria-labelledby') || f.title
      if (!named) out.push(`field without a label (${f.outerHTML.slice(0, 90)})`)
    }
    for (const d of Array.from(document.querySelectorAll('[role="dialog"]'))) {
      const id = d.getAttribute('aria-labelledby')
      if (!(id && document.getElementById(id)?.textContent?.trim()) && !d.getAttribute('aria-label')) out.push(`dialog without a name (${d.className})`)
    }
    return out
  })
}

async function setSize(app: ElectronApplication, page: Page): Promise<void> {
  // larger than this screen: lay out at W×H, zoomed to fit
  const zoom = W > 1600 ? 0.5 : 1
  await app.evaluate(
    ({ BrowserWindow }, [w, h, z]) => {
      const win = BrowserWindow.getAllWindows().find((x) => x.isVisible()) ?? BrowserWindow.getAllWindows()[0]
      win.setMinimumSize(320, 240)
      win.setContentSize(Math.round(w * z), Math.round(h * z))
      win.webContents.setZoomFactor(z)
      win.center()
    },
    [W, H, zoom]
  )
  await page.waitForTimeout(300)
}

async function esc(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
}

for (const run of RUNS) test(`ui review (${run.lang}, ${run.theme}, ${run.w}x${run.h})`, async () => {
  test.skip(!process.env.DIASHOW_UI_REVIEW, 'set DIASHOW_UI_REVIEW=1 to take the UI review screenshots')
  W = run.w
  H = run.h
  de = run.lang === 'de'
  out = join(root, 'test-results', 'ui-review', `${run.lang}-${run.theme}-${W}x${H}`)
  n = 0
  issues.clear()
  const THEME = run.theme
  test.setTimeout(20 * 60 * 1000)
  ensureTestMedia()
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-ui-'))
  // a project cut off by a power loss and one from a newer version: listed on the home screen
  const projects = join(dataDir, 'Diashow Studio')
  mkdirSync(projects, { recursive: true })
  const broken = JSON.stringify({ version: 1, id: 'cut', name: de ? 'Abschlussfahrt der Klasse 10b nach Berlin' : 'Class 10b leavers’ trip to Berlin', createdAt: 1, updatedAt: 2, entries: [{ id: 'e1', type: 'photo', mediaId: 'm1' }], media: [{ id: 'm1', path: 'C:\\x.jpg' }] })
  writeFileSync(join(projects, 'cut.dshow'), broken.slice(0, Math.floor(broken.length * 0.6)))
  const { app, page, errors } = await launch(dataDir, { DIASHOW_SHARE_HOST: '127.0.0.1', DIASHOW_LOCALE: de ? 'de-DE' : 'en-US' })
  try {
    await setSize(app, page)
    await page.evaluate((theme) => {
      localStorage.setItem('appearance', theme)
      window.dispatchEvent(new Event('appearance'))
    }, THEME)

    // ---- first run: the assistant
    await page.waitForTimeout(1500)
    const wizard = page.getByTestId('wizard')
    if (!(await wizard.isVisible())) await page.locator('.home .hero button').filter({ hasText: /Assistent|assistant/ }).click()
    await expect(page.getByTestId('wizard')).toBeVisible()
    await snap(page, 'wizard-1')
    await page.getByTestId('wizard').locator('.wizard-foot .btn').first().click()

    // ---- home, with the damaged project
    await snap(page, 'home-empty')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await snap(page, 'home-focus')
    await page.getByRole('button', { name: /Reparieren|Repair/ }).click()
    await expect(page.getByTestId('repair-dialog')).toBeVisible()
    await snap(page, 'repair')
    await esc(page)

    // ---- dialogs without a project
    await page.keyboard.press('F1')
    await expect(page.getByTestId('handbook')).toBeVisible()
    await snap(page, 'handbook')
    await page.getByTestId('handbook').locator('input').fill(de ? 'verpixeln' : 'pixelate')
    await snap(page, 'handbook-search')
    await esc(page)
    await esc(page)
    await state(page, `s.set({ dialog: 'settings' })`)
    await snap(page, 'settings', 1200)
    await page.locator('.dialog-body').last().evaluate((el) => (el.scrollTop = el.scrollHeight))
    await snap(page, 'settings-bottom')
    await page.getByTestId('diagnostics-open').click()
    await expect(page.getByTestId('diagnostics-files')).toBeVisible({ timeout: 30_000 })
    await snap(page, 'diagnostics')
    await page.getByTestId('diagnostics-files').locator('button').first().click()
    await snap(page, 'diagnostics-open')
    await esc(page)
    await state(page, `s.set({ dialog: 'help' })`)
    await snap(page, 'shortcuts')
    await state(page, `s.set({ dialog: 'about' })`)
    await snap(page, 'about', 800)
    await state(page, `s.set({ dialog: 'queue' })`)
    await snap(page, 'queue-empty')
    await state(page, `s.set({ dialog: null })`)

    // ---- a show with every kind of media; a long name for the title bar and the cards
    const music = listFiles(join(mediaDir, 'music'))
    const name = de ? 'Klassenfahrt nach Berlin 2026 – Jahrgang 10 mit einem sehr langen Namen' : 'Class trip to Berlin 2026 – year 10 with a really long project name'
    await page.evaluate(
      async ({ media, music, name }) => {
        const s = (window as any).__diashow.store.getState()
        await s.createProject(media, name)
        await (window as any).__diashow.store.getState().addMusic(music)
      },
      { media: [mediaDir], music, name }
    )
    await snap(page, 'editor-importing', 1500)
    await page.waitForFunction(
      () => {
        const p = (window as any).__diashow.store.getState().project
        const done = (x: { status: string }) => x.status === 'ready' || x.status === 'error'
        return p && p.media.length > 0 && p.media.every(done) && p.music.every(done)
      },
      null,
      { timeout: 480_000, polling: 500 }
    )
    await state(page, `s.insertDayTitles('folder'); s.setTheme('magazine')`)
    await state(page, `const sl = d.player.current.tl.slides.find((x) => x.kind === 'photos' && x.entries.length > 1); s.select(sl.entries.map((e) => e.id)); s.set({ tab: 'themes' })`)
    await snap(page, 'editor-themes', 1500)
    await page.locator('.inspector').evaluate((el) => (el.scrollTop = el.scrollHeight))
    await snap(page, 'editor-themes-bottom')
    await state(page, `s.set({ tab: 'music' })`)
    await page.locator('.track button[aria-expanded]').first().click()
    await snap(page, 'editor-music', 800)
    await state(page, `s.set({ tab: 'timing' })`)
    await snap(page, 'editor-timing')
    await state(page, `s.setTheme('classic'); s.set({ tab: 'timing' })`)
    await snap(page, 'editor-timing-classic')
    await state(page, `s.setTheme('magazine'); s.set({ tab: 'slide' })`)
    await snap(page, 'editor-slide-group')
    await state(page, `const sl = d.player.current.tl.slides.find((x) => x.kind === 'video'); s.setTheme('kenburns'); s.select(sl.entries.map((e) => e.id)); s.set({ tab: 'slide' })`)
    await snap(page, 'editor-slide-video', 1500)
    await page.locator('.inspector').evaluate((el) => (el.scrollTop = el.scrollHeight))
    await snap(page, 'editor-slide-video-bottom')
    await state(page, `const sl = d.player.current.tl.slides.find((x) => x.kind === 'photos'); s.select(sl.entries.map((e) => e.id)); s.set({ tab: 'slide' }); d.player.current.seek(sl.start + sl.duration / 2)`)
    await snap(page, 'editor-slide-photo', 1000)
    await page.locator('.inspector button', { hasText: /Textfeld hinzufügen|Add text box/ }).click()
    await snap(page, 'editor-slide-textbox')
    await state(page, `const sl = d.player.current.tl.slides.find((x) => x.kind === 'text'); s.select(sl.entries.map((e) => e.id)); s.set({ tab: 'slide' })`)
    await snap(page, 'editor-slide-text')
    await page.locator('.viewer').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Control+a')
    await snap(page, 'editor-batch')
    await state(page, `s.select([])`)
    await snap(page, 'editor-no-selection')

    // ---- editing layers over the preview
    await state(page, `const sl = d.player.current.tl.slides.find((x) => x.kind === 'photos' && x.entries.length === 1); s.select(sl.entries.map((e) => e.id)); s.set({ tab: 'slide', kbEdit: 'start' }); d.player.current.seek(sl.start + 0.5)`)
    await snap(page, 'kenburns', 1000)
    await state(page, `const e = s.selection[0]; s.set({ kbEdit: null, privacyEdit: e })`)
    await snap(page, 'privacy-editor', 2500)
    await state(page, `s.set({ privacyEdit: null })`)

    // ---- menus
    await page.locator('.titlebar button[title="Weitere Aktionen"], .titlebar button[title="More actions"]').click()
    await snap(page, 'menu-more')
    await esc(page)
    await page.mouse.click(5, H - 5)
    const cards = page.locator('.cards .card:not(.add)')
    await cards.nth(2).click({ button: 'right' })
    await snap(page, 'menu-slide')
    await esc(page)
    await page.mouse.click(W / 2, 60)
    await page.locator('.card.add').click()
    await snap(page, 'menu-add')
    await esc(page)

    // ---- keyboard focus on the title bar
    await page.locator('.stage').click({ position: { x: 5, y: 5 } })
    for (let i = 0; i < 4; i++) await page.keyboard.press('Tab')
    await snap(page, 'editor-focus')

    // ---- review grid
    await page.locator('.titlebar button', { hasText: /Sichten|Review/ }).click()
    await expect(page.locator('.cull-tile').first()).toBeVisible()
    await page.locator('.cull-tile').nth(1).click()
    await page.keyboard.press('4')
    await page.locator('.cull-tile').nth(2).click()
    await page.keyboard.press('x')
    await snap(page, 'cull', 800)
    await page.keyboard.press('Space')
    await snap(page, 'cull-large', 800)
    await esc(page)
    await page.locator('.cull-bar .seg button').nth(3).click()
    await snap(page, 'cull-stars')
    await page.locator('.cull-bar .seg button').nth(2).click()
    await page.locator('.cull-bar .seg button').nth(3).click()
    await page.locator('.cull-bar .seg button').nth(0).click()
    await esc(page)

    // ---- export, its face check, the queue
    await state(page, `s.set({ exportOpen: true })`)
    await snap(page, 'export', 800)
    const check = page.locator('.dialog button', { hasText: /Gesichter prüfen|Check faces/ })
    if (await check.count()) {
      await check.click()
      await snap(page, 'export-faces', 1000)
    }
    await state(page, `s.set({ exportOpen: false })`)
    const file = join(dataDir, de ? 'Klassenfahrt.mp4' : 'Class trip.mp4')
    await page.evaluate(
      ({ file, locale }) => {
        const d = (window as any).__diashow
        const p = structuredClone(d.store.getState().project)
        p.settings.timing = { mode: 'custom', customTotal: 8 }
        return d.queueExport(p, { outPath: file, width: 320, height: 180, fps: 30, codec: 'h264', quality: 'standard', hardware: true, locale }, p.name)
      },
      { file, locale: de ? 'de-DE' : 'en-US' }
    )
    await state(page, `s.set({ dialog: 'queue' })`)
    await snap(page, 'queue-running', 1500)
    await page.waitForFunction(() => (window as any).__diashow.store.getState().exportJobs.some((j: any) => j.state === 'done' || j.state === 'error'), null, { timeout: 300_000 })
    await snap(page, 'queue-done')
    await state(page, `s.set({ dialog: null })`)

    // ---- share over Wi-Fi
    await state(page, `s.set({ dialog: 'share' })`)
    await snap(page, 'share')
    await page.locator('.share-start').click()
    await expect(page.getByTestId('share-upload-url')).toBeVisible({ timeout: 30_000 })
    await snap(page, 'share-running', 800)
    await page.locator('.share-dialog .seg button').nth(1).click()
    await snap(page, 'share-distribute', 800)
    await state(page, `s.set({ dialog: null })`)

    // ---- other dialogs of the "⋯" menu
    await state(page, `s.set({ dialog: 'privacyReview' })`)
    await snap(page, 'privacy-review', 1500)
    await state(page, `s.set({ dialog: 'rejects' })`)
    await snap(page, 'rejects', 800)
    await state(page, `s.set({ dialog: 'backups' })`)
    await snap(page, 'backups', 800)
    await state(page, `s.set({ dialog: null })`)
    const packDir = join(dataDir, 'pack')
    mkdirSync(packDir, { recursive: true })
    await answerOpenDialog(app, [packDir])
    await answerSaveDialog(app, join(dataDir, 'x.zip'))
    await state(page, `s.set({ dialog: 'pack' })`)
    await expect(page.locator('.dialog .actions .btn.primary')).toBeEnabled({ timeout: 120_000 })
    await snap(page, 'pack-done')
    await state(page, `s.set({ dialog: null })`)

    // ---- presenter view, fullscreen player
    await state(page, `s.set({ presenting: true })`)
    await expect(page.locator('.presenter')).toBeVisible()
    await snap(page, 'presenter', 2500)
    await page.keyboard.press('Escape')
    await expect(page.locator('.presenter')).toHaveCount(0)
    await page.waitForTimeout(800)
    await state(page, `s.set({ fullscreen: true })`)
    await expect(page.locator('.fullscreen')).toBeVisible()
    await page.mouse.move(300, 300)
    await page.mouse.move(320, 320)
    await snap(page, 'fullscreen', 1200)
    await page.keyboard.press('Escape')
    await expect(page.locator('.fullscreen')).toHaveCount(0)
    await page.waitForTimeout(1000)
    await setSize(app, page)

    // ---- system check (runs a short export test)
    await state(page, `s.set({ dialog: 'systemcheck' })`)
    await expect(page.getByTestId('systemcheck').locator('[data-id=bench]')).not.toHaveAttribute('data-verdict', 'pending', { timeout: 240_000 })
    await snap(page, 'systemcheck')
    await state(page, `s.set({ dialog: null })`)

    // ---- home with the show
    await state(page, `s.closeProject()`)
    await expect(page.locator('.home .project').first()).toBeVisible()
    await snap(page, 'home', 1000)
    console.log(errors.length ? `renderer errors:\n${errors.join('\n')}` : 'no renderer errors')
    const report = [...issues.values()]
    writeFileSync(join(out, 'a11y.txt'), report.join('\n') + '\n')
    console.log(report.length ? `accessibility findings:\n${report.join('\n')}` : 'no accessibility findings')
  } finally {
    await app.close()
    removeDir(dataDir)
  }
})
