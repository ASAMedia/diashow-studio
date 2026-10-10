// Diagnostics, project repair and hardening, end to end: a cut-off project is listed on the home screen
// and rescued, the error log records the start and the windows' errors, the diagnostics package shows its
// files and is saved without project names, the share dialog warns on a public address, and the app's
// page can neither read other files through dsmedia:// nor navigate away.
import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dismissFirstRun } from './harness'
import { launchOptions } from './launch'

const root = resolve(__dirname, '..')

function sampleProject(id: string, name: string): Record<string, unknown> {
  const media = Array.from({ length: 6 }, (_, i) => ({
    id: `m${i}`,
    path: `C:\\Fotos\\Lisa_${i}.jpg`,
    name: `Lisa_${i}.jpg`,
    kind: 'photo',
    format: 'JPEG',
    width: 4000,
    height: 3000,
    captureTime: i,
    status: 'error',
    error: 'missing'
  }))
  return {
    version: 1,
    id,
    name,
    createdAt: 1,
    updatedAt: 2,
    entries: media.map((m, i) => ({ id: `e${i}`, type: 'photo', mediaId: m.id, caption: `Lisa ${i}` })),
    media,
    music: [],
    settings: { theme: 'kenburns', look: 'natural', aspect: '16:9', timing: { mode: 'fitToMusic', customTotal: 120 }, transition: { type: 'dissolve', speed: 0.5, direction: 'left' }, scaleToFill: true, playFullVideos: true, playLivePhotos: false, loop: false, showTitle: true, audio: { musicVolume: 0.8, videoSound: true, duck: true, duckLevel: 0.2, duckFade: 0.6, fadeIn: 1, fadeOut: 3, repeatMusic: true, crossfade: 2 } }
  }
}

test('diagnostics: repair a cut-off project, error log, diagnostics package, public share address, hardening', async () => {
  test.setTimeout(4 * 60 * 1000)
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-diag-'))
  const projects = join(dataDir, 'Diashow Studio')
  mkdirSync(join(projects, '.backups', 'cut'), { recursive: true })
  const full = JSON.stringify(sampleProject('cut', 'Abschied Klasse 7b'), null, 1)
  // power loss while saving: the file ends in the middle of the media list
  writeFileSync(join(projects, 'cut.dshow'), full.slice(0, Math.floor(full.length * 0.7)))
  writeFileSync(join(projects, '.backups', 'cut', '20260101-120000.dshow'), JSON.stringify({ ...sampleProject('cut', 'Abschied Klasse 7b'), entries: [] }))
  writeFileSync(join(projects, '.backups', 'cut', '20260101-110000.dshow'), '{"version":1,"id":"cut","entries":[{"id"')
  writeFileSync(join(projects, 'future.dshow'), JSON.stringify({ ...sampleProject('future', 'Zukunft'), version: 99 }))
  const secret = join(dataDir, 'secret.txt')
  writeFileSync(secret, 'not for the renderer')

  const opts = launchOptions(root, dataDir)
  opts.env.DIASHOW_LOCALE = 'de-DE'
  opts.env.DIASHOW_SHARE_HOST = '127.0.0.1'
  opts.env.DIASHOW_SHARE_PUBLIC = '1'
  const app = await electron.launch(opts)
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.waitForFunction(() => !!(window as any).__diashow)
    // no valid project yet: the first-run assistant opens
    await dismissFirstRun(page)

    // the start is in the log
    const logFile = join(dataDir, 'userData', 'logs', 'diashow.log')
    await expect.poll(() => existsSync(logFile) && readFileSync(logFile, 'utf8')).toContain('starts')

    // home: the cut-off file and the too-new file are listed, not hidden
    const damaged = page.getByTestId('damaged-projects')
    await expect(damaged).toContainText('Abschied Klasse 7b')
    await expect(damaged).toContainText('neueren Version')
    await damaged.getByRole('button', { name: 'Reparieren…' }).click()
    const dialog = page.getByTestId('repair-dialog')
    await expect(dialog).toContainText('abgeschnitten')
    await expect(dialog).toContainText('auch beschädigt')
    await page.screenshot({ path: join(root, 'test-results', 'repair-dialog.png') })
    await dialog.getByTestId('repair-salvage').click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => (window as any).__diashow.store.getState().project?.name)).toBe('Abschied Klasse 7b')
    const slides: number = await page.evaluate(() => (window as any).__diashow.store.getState().project.entries.length)
    expect(slides).toBeGreaterThan(0)
    expect(readFileSync(join(projects, 'cut.dshow'), 'utf8').length).toBeGreaterThan(100)
    // the damaged original is kept
    expect(JSON.stringify(await page.evaluate(() => (window as any).api.listBackups('cut')))).toContain('20260101-120000')

    // a renderer error reaches the log, cleaned
    await page.evaluate(() => console.error('test failure in C:\\Users\\Someone Else\\Pictures\\x.jpg'))
    await expect.poll(() => readFileSync(logFile, 'utf8')).toContain('test failure in C:\\Users\\<user>\\Pictures\\x.jpg')

    // diagnostics package: shown before saving, no project names
    await page.evaluate(() => (window as any).__diashow.store.getState().set({ dialog: 'settings' }))
    await page.getByTestId('diagnostics-open').click()
    const files = page.getByTestId('diagnostics-files')
    await expect(files).toContainText('project-summary.json', { timeout: 60_000 })
    await expect(files).toContainText('logs/diashow.log')
    await files.getByText('project-summary.json').click()
    await expect(page.locator('.diag-preview')).toContainText('"slides"')
    await page.screenshot({ path: join(root, 'test-results', 'diagnostics.png') })
    const zip = join(dataDir, 'diag.zip')
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
    }, zip)
    await page.getByTestId('diagnostics-save').click()
    await expect(page.getByTestId('diagnostics-dialog')).toContainText('Gespeichert')
    const bytes = readFileSync(zip)
    expect(bytes.subarray(0, 2).toString()).toBe('PK')
    expect(bytes.includes(Buffer.from('logs/diashow.log'))).toBe(true)
    const preview = await page.evaluate(() => (window as any).api.diagnosticsPreview({ projectId: 'cut' }))
    // (the log may name files: paths are allowed there, shortened to %USERPROFILE%)
    const text = preview.files
      .filter((f: { about: string }) => f.about !== 'log')
      .map((f: { preview: string }) => f.preview)
      .join('\n')
    for (const name of ['Abschied', 'Klasse 7b', 'Lisa']) expect([name, text.includes(name)]).toEqual([name, false])
    await page.keyboard.press('Escape')

    // share dialog on a public address: the warning
    await page.evaluate(() => (window as any).__diashow.store.getState().set({ dialog: 'share' }))
    await page.locator('.share-start').click()
    await expect(page.getByTestId('share-upload-url')).toContainText('http://127.0.0.1:')
    await expect(page.getByTestId('share-public-warning')).toBeVisible()
    await page.screenshot({ path: join(root, 'test-results', 'share-public.png') })
    await page.keyboard.press('Escape')

    // hardening: other files are not served, the page stays on the app, no popups
    const status = await page.evaluate(async (p) => (await fetch(`dsmedia://f/${encodeURIComponent(p)}`)).status, secret)
    expect(status).toBe(404)
    const before = page.url()
    await page.evaluate(() => {
      location.href = 'https://example.com/'
    })
    await page.waitForTimeout(1000)
    expect(page.url()).toBe(before)
    // (not an http link: those would open in the real browser)
    expect(await page.evaluate(() => window.open('file:///C:/') === null)).toBe(true)
    expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined')
    expect(errors).toEqual([])
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
  }
})
