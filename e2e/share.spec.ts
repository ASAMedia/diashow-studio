// Sharing over the local network, end to end: the share dialog starts the server, a "phone" (this
// Node process) uploads a photo and a video, and they land in the open project; the download page
// serves an offered file with ranges; closing the dialog stops the server.
// DIASHOW_SHARE_HOST=127.0.0.1 keeps the server on loopback, so Windows Firewall never asks.
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchOptions } from './launch'

const root = resolve(__dirname, '..')
const mediaDir = join(root, 'test-media')

const project = (page: Page): Promise<any> => page.evaluate(() => (window as any).__diashow.store.getState().project)

async function upload(url: string, file: string, name: string, uploader: string, type: string): Promise<number> {
  const body = readFileSync(file)
  const res = await fetch(new URL('upload', url), {
    method: 'POST',
    headers: { 'X-File-Name': encodeURIComponent(name), 'X-Uploader': encodeURIComponent(uploader), 'Content-Type': type },
    body
  })
  await res.arrayBuffer()
  return res.status
}

test('share dialog: phones upload into the project, download an offered video', async () => {
  test.setTimeout(5 * 60 * 1000)
  if (!existsSync(mediaDir)) execFileSync('node', ['scripts/make-test-media.mjs'], { cwd: root, stdio: 'inherit' })
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-share-'))
  const opts = launchOptions(root, dataDir)
  opts.env.DIASHOW_SHARE_HOST = '127.0.0.1'
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
    await page.evaluate(async () => {
      const s = (window as any).__diashow.store.getState()
      await s.createProject([], 'Klassenfahrt Berlin')
      ;(window as any).__diashow.store.getState().set({ dialog: 'share' })
    })

    // start: the QR code and the link appear
    await page.locator('.share-start').click()
    const urlBox = page.getByTestId('share-upload-url')
    await expect(urlBox).toContainText('http://127.0.0.1:')
    const uploadUrl = (await urlBox.textContent())!.trim()
    expect(uploadUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{32}\/$/)
    await expect(page.locator('.share-qr svg')).toBeVisible()

    // the phone's page; anything without the token is not found
    const pageRes = await fetch(uploadUrl, { headers: { 'Accept-Language': 'de-DE,de;q=0.9' } })
    expect(pageRes.status).toBe(200)
    expect(await pageRes.text()).toContain('Fotos &amp; Videos auswählen')
    const origin = new URL(uploadUrl).origin
    for (const path of ['/', '/upload', `/${'a'.repeat(32)}/`]) expect((await fetch(origin + path)).status).toBe(404)

    // a photo and a video from "Mia", a text file is refused
    expect(await upload(uploadUrl, join(mediaDir, 'android', 'PXL_0002.jpg'), 'PXL_0002.jpg', 'Mia', 'image/jpeg')).toBe(201)
    expect(await upload(uploadUrl, join(mediaDir, 'misc', 'plain.mp4'), 'plain.mp4', 'Mia', 'video/mp4')).toBe(201)
    expect(await upload(uploadUrl, join(mediaDir, 'misc', 'notes.txt'), 'notes.txt', 'Mia', 'text/plain')).toBe(415)

    // they arrive in the project (imported in one batch) and get processed
    const folder = join(dataDir, 'Diashow Studio', 'Uploads', 'Klassenfahrt Berlin', 'Mia')
    await expect
      .poll(async () => {
        const p = await project(page)
        return p.media.map((m: any) => `${m.path}|${m.status}`).sort()
      }, { timeout: 120_000 })
      .toEqual([`${join(folder, 'PXL_0002.jpg')}|ready`, `${join(folder, 'plain.mp4')}|ready`])
    const p = await project(page)
    expect(p.entries).toHaveLength(2)
    expect(existsSync(join(folder, 'PXL_0002.jpg'))).toBe(true)
    await expect(page.getByTestId('share-received')).toContainText('Mia · 2')

    // the real upload page in a browser window (phone-sized): name, file picker, progress
    await app.evaluate(({ BrowserWindow }, url) => {
      const win = new BrowserWindow({ width: 390, height: 844, show: false })
      void win.loadURL(url)
    }, uploadUrl)
    await expect.poll(() => app.windows().length).toBeGreaterThan(1)
    const phone = app.windows().find((w) => w.url().startsWith('http://127.0.0.1'))!
    await phone.waitForLoadState()
    // a hidden window never advances CSS transitions: switch them off for the screenshot
    await phone.addStyleTag({ content: '*{transition:none!important}' })
    await phone.fill('#name', 'Ben')
    await phone.setInputFiles('#files', [join(mediaDir, 'iphone', 'IMG_0003.JPG'), join(mediaDir, 'misc', 'notes.txt')])
    await expect(phone.locator('#sum')).toHaveText('1 von 1 hochgeladen', { timeout: 30_000 })
    await expect(phone.locator('li.ok')).toHaveCount(1)
    await expect(phone.locator('li.bad')).toContainText('Dateityp wird nicht unterstützt')
    await expect(phone.locator('#note')).toHaveText('Danke! Alles ist angekommen.')
    expect(await phone.locator('#bar').evaluate((b) => (b as HTMLElement).style.width)).toBe('100%')
    await phone.screenshot({ path: join(root, 'test-results', 'share-phone.png') })
    await expect
      .poll(async () => (await project(page)).media.some((m: any) => m.path === join(folder, '..', 'Ben', 'IMG_0003.JPG')), { timeout: 60_000 })
      .toBe(true)
    await expect(page.getByTestId('share-received')).toContainText('Ben · 1')
    await page.screenshot({ path: join(root, 'test-results', 'share-collect.png') })

    // hand out a video: offered files only, with byte ranges
    await page.locator('.share-dialog .seg button').nth(1).click()
    const offered = join(mediaDir, 'misc', 'plain.mp4')
    await page.evaluate((path) => (window as any).api.shareControl({ type: 'offer', paths: [path] }), offered)
    await expect(page.getByTestId('share-offered')).toContainText('plain.mp4')
    const downloadUrl = (await page.getByTestId('share-download-url').textContent())!.trim()
    expect(downloadUrl).not.toBe(uploadUrl)
    const list = await (await fetch(downloadUrl)).text()
    // the first link of the list (the head links the app icon)
    const href = /<a href="([^"?]+)"/.exec(list)![1]
    const size = readFileSync(offered).length
    const part = await fetch(new URL(href, downloadUrl), { headers: { Range: 'bytes=0-1' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 0-1/${size}`)
    expect(part.headers.get('content-type')).toBe('video/mp4')
    expect((await part.arrayBuffer()).byteLength).toBe(2)
    const save = await fetch(new URL(`${href}?dl=1`, downloadUrl))
    expect(save.headers.get('content-disposition')).toMatch(/^attachment; filename="plain\.mp4"/)
    expect((await save.arrayBuffer()).byteLength).toBe(size)
    await page.screenshot({ path: join(root, 'test-results', 'share-distribute.png') })

    // closing the dialog stops the server
    await page.keyboard.press('Escape')
    await expect(page.locator('.share-dialog')).toHaveCount(0)
    await expect.poll(async () => fetch(uploadUrl).then((r) => r.status, () => 'refused'), { timeout: 10_000 }).toBe('refused')
    expect(errors).toEqual([])
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
  }
})
