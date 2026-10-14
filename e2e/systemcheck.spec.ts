// System check end to end: opened from Settings, every item gets a verdict, the export benchmark
// runs through the real export path, and the report goes to the clipboard.
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchOptions } from './launch'

const root = resolve(__dirname, '..')

test('system check: verdicts, benchmark, report', { lock: 'clipboard' }, async () => {
  test.setTimeout(6 * 60 * 1000)
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-syscheck-'))
  const opts = launchOptions(root, dataDir)
  opts.env.DIASHOW_LOCALE = 'de-DE'
  const app = await electron.launch(opts)
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(e.message))
    await page.waitForFunction(() => !!(window as any).__diashow)
    await page.evaluate(() => (window as any).__diashow.store.getState().set({ dialog: 'settings' }))
    await page.getByRole('button', { name: 'Systemcheck' }).click()
    const list = page.getByTestId('systemcheck')
    await expect(list).toBeVisible()
    const t0 = Date.now()
    await expect(list.locator('[data-id=bench]')).not.toHaveAttribute('data-verdict', 'pending', { timeout: 240_000 })
    console.log(`system check took ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    const items = await list.locator('.sc-item').evaluateAll((els) => els.map((e) => [(e as HTMLElement).dataset.id, (e as HTMLElement).dataset.verdict, e.textContent]))
    for (const it of items) console.log(it.join(' | '))
    const ids = items.map((it) => it[0])
    expect(ids).toEqual(expect.arrayContaining(['gpu', 'features', 'webgl', 'encoders', 'webcodecs', 'hevc', 'tonemap', 'cpu', 'ram', 'disk', 'versions', 'bench']))
    expect(items.every((it) => it[1] !== 'pending')).toBe(true)
    // the benchmark exported through the real path and cleaned up
    expect(items.find((it) => it[0] === 'bench')![2]).toMatch(/Echtzeit/)
    await page.screenshot({ path: join(root, 'test-results', 'systemcheck.png') })

    await page.getByRole('button', { name: 'Bericht kopieren' }).click()
    await expect(page.getByRole('button', { name: 'Bericht kopiert' })).toBeVisible()
    const report = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(report).toContain('Systemcheck')
    expect(report).toContain('Export-Test (1080p): ')
    expect(report).toMatch(/FFmpeg n?\d/)
    expect(errors).toEqual([])
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
  }
})
