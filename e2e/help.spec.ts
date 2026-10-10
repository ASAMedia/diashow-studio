// First-run assistant, handbook, About dialog and update hint, end to end:
// - first start: the assistant opens; a folder (native dialog stubbed in the main process), a theme
//   and a song make a show; it is remembered as done;
// - F1 opens the handbook, its search filters the chapters; About shows versions, the FFmpeg
//   licence and the notices; "Check for updates" and the start-up hint ask a local fake GitHub
//   (DIASHOW_UPDATE_URL); switched off in Settings, the next start asks nothing;
// - a show created through the store (as every other spec does) closes the assistant at once.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchOptions } from './launch'

const root = resolve(__dirname, '..')
const mediaDir = join(root, 'test-media')

interface FakeGitHub {
  server: Server
  url: string
  requests: { ua: string }[]
}

/** A fake "releases/latest" endpoint answering with `tag`. */
async function fakeGitHub(tag: string): Promise<FakeGitHub> {
  const requests: { ua: string }[] = []
  const server = createServer((req, res) => {
    requests.push({ ua: String(req.headers['user-agent'] ?? '') })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ tag_name: tag, html_url: `https://github.com/ASAMedia/diashow-studio/releases/tag/${tag}`, draft: false, prerelease: false }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases/latest`, requests }
}

async function launch(dataDir: string, env: Record<string, string>): Promise<{ app: ElectronApplication; page: Page; errors: string[] }> {
  const opts = launchOptions(root, dataDir)
  Object.assign(opts.env, { DIASHOW_LOCALE: 'de-DE' }, env)
  const app = await electron.launch(opts)
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForFunction(() => !!(window as any).__diashow)
  return { app, page, errors }
}

/** The next native open dialog answers with `paths` (the app's IPC handlers call dialog.showOpenDialog). */
async function stubOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    ;(dialog as unknown as { showOpenDialog: () => Promise<unknown> }).showOpenDialog = async () => ({ canceled: false, filePaths: p })
  }, paths)
}

test('assistant, handbook, about and update hint', async () => {
  test.setTimeout(5 * 60 * 1000)
  if (!existsSync(mediaDir)) execFileSync('node', ['scripts/make-test-media.mjs'], { cwd: root, stdio: 'inherit' })
  const gh = await fakeGitHub('v99.1.0')
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-help-'))
  let app: ElectronApplication | null = null
  try {
    const run = await launch(dataDir, { DIASHOW_UPDATE_URL: gh.url })
    app = run.app
    const { page, errors } = run

    // ---- first start: the assistant
    const wizard = page.getByTestId('wizard')
    await expect(wizard).toBeVisible()
    await expect(wizard).toHaveAttribute('data-step', '1')
    // the start-up update check found the newer release
    await expect(page.getByTestId('update-chip')).toContainText('99.1.0')
    expect(gh.requests.length).toBe(1)
    expect(gh.requests[0].ua).toMatch(/^DiashowStudio\/\d+\.\d+\.\d+/)

    await stubOpenDialog(app, [join(mediaDir, 'iphone')])
    await wizard.getByRole('button', { name: 'Ordner auswählen…' }).click()
    await expect(wizard).toHaveAttribute('data-step', '2', { timeout: 60_000 })
    const project = () => page.evaluate(() => (window as any).__diashow.store.getState().project)
    expect((await project()).name).toBe('iphone')
    expect((await project()).media.length).toBeGreaterThan(1)

    await wizard.locator('.theme-card', { hasText: 'Magazin' }).click()
    expect((await project()).settings.theme).toBe('magazine')
    await stubOpenDialog(app, [join(mediaDir, 'music', 'track1.mp3')])
    await wizard.getByRole('button', { name: 'Musik hinzufügen' }).click()
    await expect(wizard.locator('.wizard-music li')).toHaveCount(1)
    await wizard.getByRole('button', { name: 'Weiter' }).click()
    await expect(wizard).toHaveAttribute('data-step', '3')
    await expect(wizard.locator('.wizard-summary')).toContainText('Magazin')
    await page.screenshot({ path: join(root, 'test-results', 'wizard-step3.png') })
    await wizard.getByRole('button', { name: 'Im Editor weiterarbeiten' }).click()
    await expect(wizard).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('wizard:done'))).toBe('1')
    expect(await page.evaluate(() => (window as any).__diashow.store.getState().view)).toBe('editor')

    // ---- F1: the handbook with its search
    await page.locator('.stage').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('F1')
    const hb = page.getByTestId('handbook')
    await expect(hb).toBeVisible()
    const all = await hb.locator('.hb-toc button').count()
    expect(all).toBeGreaterThanOrEqual(10)
    await hb.getByPlaceholder('Im Handbuch suchen…').fill('verpixeln')
    const hits = await hb.locator('.hb-toc button').allInnerTexts()
    console.log('search "verpixeln":', hits.join(' | '))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThan(all)
    expect(hits.some((h) => /Datenschutz/.test(h))).toBe(true)
    await expect(hb.locator('.hb-body mark').first()).toBeVisible()
    await hb.getByPlaceholder('Im Handbuch suchen…').fill('xyzzy')
    await expect(hb.locator('.hb-toc .empty')).toBeVisible()
    await hb.getByPlaceholder('Im Handbuch suchen…').fill('')
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(root, 'test-results', 'handbook.png') })
    // a chapter link jumps there
    await hb.locator('.hb-toc button', { hasText: 'Tastenkürzel' }).click()
    await expect(hb.locator('.hb-toc button.on')).toContainText('Tastenkürzel')

    // ---- About: versions, licences, update check
    await hb.getByRole('button', { name: 'Über Diashow Studio' }).click()
    const about = page.getByTestId('about')
    await expect(about).toBeVisible()
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
    await expect(about.getByTestId('about-version')).toHaveText(pkg.version)
    await expect(about.getByTestId('about-ffmpeg')).toContainText(/FFmpeg n?\d/)
    await expect(about.getByTestId('about-ffmpeg').getByRole('link', { name: 'Quellcode' })).toHaveAttribute('href', /^https:\/\/github\.com\/FFmpeg\/FFmpeg\/tree\/[0-9a-f]{7,}/)
    await about.getByRole('button', { name: 'Alle Lizenzhinweise anzeigen' }).click()
    if (existsSync(join(root, 'vendor', 'THIRD_PARTY_NOTICES.txt'))) {
      await expect(about.getByTestId('notices')).toContainText('GNU General Public License')
      await expect(about.getByTestId('notices')).toContainText('react')
    }
    await about.getByRole('button', { name: 'Nach Updates suchen' }).click()
    await expect(about.getByTestId('update-result')).toContainText('99.1.0')
    expect(gh.requests.length).toBe(2)
    await page.screenshot({ path: join(root, 'test-results', 'about.png') })
    await page.keyboard.press('Escape')
    await expect(about).toHaveCount(0)

    // ---- the hint can be hidden, and the check switched off
    await page.getByTestId('update-chip').getByRole('button').click()
    await expect(page.getByTestId('update-chip')).toHaveCount(0)
    await page.evaluate(() => (window as any).__diashow.store.getState().set({ dialog: 'settings' }))
    await page.getByTestId('update-setting').uncheck()
    await expect.poll(() => JSON.parse(readFileSync(join(dataDir, 'userData', 'settings.json'), 'utf8')).updateCheck).toBe(false)
    expect(errors).toEqual([])
    await app.close()
    app = null

    // ---- next start: no assistant (a show exists), no request to GitHub
    const again = await launch(dataDir, { DIASHOW_UPDATE_URL: gh.url })
    app = again.app
    await again.page.waitForTimeout(2500)
    await expect(again.page.getByTestId('wizard')).toHaveCount(0)
    expect(gh.requests.length).toBe(2)
    await expect(again.page.getByTestId('update-chip')).toHaveCount(0)
    expect(again.errors).toEqual([])
  } finally {
    await app?.close()
    gh.server.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('a show created through the store closes the assistant at once', async () => {
  test.setTimeout(3 * 60 * 1000)
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-help2-'))
  // no DIASHOW_UPDATE_URL: a development build never asks GitHub by itself
  const { app, page, errors } = await launch(dataDir, {})
  try {
    await expect(page.getByTestId('wizard')).toBeVisible()
    await page.evaluate(async (dir) => {
      await (window as any).__diashow.store.getState().createProject([dir], 'E2E')
    }, join(mediaDir, 'misc'))
    await expect(page.getByTestId('wizard')).toHaveCount(0)
    // the editor takes clicks and keys again
    await page.locator('.stage').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('F1')
    await expect(page.getByTestId('handbook')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('handbook')).toHaveCount(0)
    await expect(page.getByTestId('update-chip')).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
  }
})
