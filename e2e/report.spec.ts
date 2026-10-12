// "Problem melden" end to end, from Settings and from About: the dialog lists exactly the fields that go
// into the link (version, Windows, graphics card), offers the diagnostics package, and the main process
// opens the bug form on GitHub with those fields and nothing else. shell.openExternal is replaced in
// the main process, so no browser opens; other URLs are refused by the channel.
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { dismissFirstRun, removeDir } from './harness'
import { launchOptions } from './launch'

const root = resolve(__dirname, '..')
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version

test('report a problem: what is sent, diagnostics first, the bug form on GitHub', async () => {
  test.setTimeout(3 * 60 * 1000)
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-report-'))
  const opts = launchOptions(root, dataDir)
  opts.env.DIASHOW_LOCALE ||= 'de-DE'
  const de = opts.env.DIASHOW_LOCALE.toLowerCase().startsWith('de')
  const app = await electron.launch(opts)
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(e.message))
    await page.waitForFunction(() => !!(window as any).__diashow, null, { timeout: 60_000 })
    await dismissFirstRun(page)

    // no browser: the main process records what it would open
    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      ;(globalThis as any).__opened = opened
      shell.openExternal = (async (url: string) => {
        opened.push(url)
      }) as typeof shell.openExternal
    })
    const opened = (): Promise<string[]> => app.evaluate(() => (globalThis as any).__opened.slice())

    // ---- from Settings → Troubleshooting
    await page.evaluate(() => (window as any).__diashow.store.getState().set({ dialog: 'settings' }))
    await page.getByTestId('report-open').click()
    const dialog = page.getByTestId('report-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: de ? 'Problem melden' : 'Report a problem' })).toBeVisible()
    await expect(dialog).toContainText('GitHub')
    await expect(dialog).toContainText(de ? 'GitHub-Konto' : 'GitHub account')
    await expect(dialog).toContainText(de ? 'Schülerinnen und Schülern' : 'pupils')
    // exactly these three fields
    const fields = dialog.getByTestId('report-fields')
    await expect(fields.locator('dt')).toHaveText(de ? ['App-Version', 'Windows', 'Grafikkarte'] : ['App version', 'Windows', 'Graphics card'])
    await expect(fields.locator('[data-field=version]')).toHaveText(version, { timeout: 20_000 })
    const windows = (await fields.locator('[data-field=windows]').textContent()) ?? ''
    expect(windows).toMatch(/Windows|\d+\.\d+/)
    const gpu = (await fields.locator('[data-field=gpu]').textContent()) ?? ''
    expect(gpu.length).toBeGreaterThan(0)
    await page.screenshot({ path: join(root, 'test-results', `report-dialog-${de ? 'de' : 'en'}.png`) })

    // the diagnostics package first, then back to this dialog
    await dialog.getByTestId('report-diagnostics').click()
    await expect(page.getByTestId('diagnostics-files')).toContainText('logs/diashow.log', { timeout: 60_000 })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('diagnostics-dialog')).toHaveCount(0)
    await expect(dialog).toBeVisible()

    // "Open on GitHub": the bug form with version, Windows and graphics card, nothing else
    await dialog.getByTestId('report-open-github').click()
    await expect(dialog.getByRole('status')).toContainText(de ? 'Browser' : 'browser')
    await expect.poll(opened).toHaveLength(1)
    const [url] = await opened()
    expect(url.startsWith('https://github.com/ASAMedia/diashow-studio/issues/new?template=bug.yml&')).toBe(true)
    expect(url.length).toBeLessThan(8000)
    const q = new URL(url).searchParams
    expect([...q.keys()].filter((k) => k !== 'template').sort()).toEqual(['gpu', 'version', 'windows'].filter((k) => q.has(k)).sort())
    expect(q.get('version')).toBe(version)
    if (!/unknown|unbekannt/.test(windows)) expect(q.get('windows')).toBe(windows)
    if (!/unknown|unbekannt/.test(gpu)) expect(q.get('gpu')).toBe(gpu)
    for (const secret of [dataDir, userInfo().username, root]) expect([secret, url.includes(secret) || decodeURIComponent(url).includes(secret)]).toEqual([secret, false])
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.keyboard.press('Escape')

    // ---- from About
    await page.evaluate(() => (window as any).__diashow.store.getState().set({ dialog: 'about' }))
    await page.getByTestId('about').getByTestId('report-open').click()
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-field=version]')).toHaveText(version, { timeout: 20_000 })
    await dialog.getByTestId('report-open-github').click()
    await expect.poll(opened).toHaveLength(2)
    expect((await opened())[1]).toBe(url)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('about')).toBeVisible()

    // the channel opens pages of the project only
    const refused = await page.evaluate(async () => {
      const out: string[] = []
      for (const u of ['https://example.com/', 'https://github.com/ASAMedia/diashow-studio/../../evil/x', 'file:///C:/Windows/notepad.exe']) {
        out.push(await (window as any).api.openGithub(u).then(() => 'opened', () => 'refused'))
      }
      return out
    })
    expect(refused).toEqual(['refused', 'refused', 'refused'])
    expect(await opened()).toHaveLength(2)
    expect(errors.filter((e) => !/only pages of the project/.test(e))).toEqual([])
  } finally {
    await app.close()
    removeDir(dataDir)
  }
})
