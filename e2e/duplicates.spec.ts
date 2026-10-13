// Photos that are already in the show are not added twice (src/shared/repeats.ts, src/main/media/repeats.ts),
// end to end with generated test media:
// - the same folder again through "Add folder": nothing is added, no undo step, a notice (also read out
//   through a live region) with "Show" (by keyboard) and "Add anyway" (one undo step);
// - a renamed copy of a photo is skipped, a different photo is added;
// - a file of the show dropped on the filmstrip, and a copy of a left-out photo pasted with Ctrl+V;
// - two pupils upload the same photo through the share page: one slide, the dialog counts the second
//   as "already there", and the clean-up lists it as not in the show.
// Runs in German and with DIASHOW_LOCALE=en-US DIASHOW_SOFTWARE_GL=1.
// DIASHOW_DUP_BENCH=1: the import time of 400 generated photos (1.5 to 4 MB) with the check and without it,
// the same folder again and a copy of it under another name.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import sharp from 'sharp'
import { answerOpenDialog, copyMedia, ensureTestMedia, launch, removeDir, sampleFiles, waitProcessed, type Session } from './harness'

const store = (page: Page, fn: string): Promise<any> => page.evaluate(`(async () => { const s = window.__diashow.store.getState(); ${fn} })()`)
const entryIds = (page: Page): Promise<string[]> => store(page, 'return s.project.entries.map((e) => e.id)')
const paths = (page: Page): Promise<string[]> => store(page, 'return s.project.entries.map((e) => s.project.media.find((m) => m.id === e.mediaId)?.path)')
const selection = (page: Page): Promise<string[]> => store(page, 'return s.selection')

/** Sets the Windows clipboard to a file list, as Ctrl+C in Explorer does (CF_HDROP). */
function copyFilesLikeExplorer(files: string[]): void {
  const list = files.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', `Set-Clipboard -Path ${list}`], { stdio: 'ignore' })
}

function clipboardText(): string | null {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'Get-Clipboard -Raw -Format Text'], { encoding: 'utf8' })
  } catch {
    return null
  }
}

/** A real drop of files through Chromium's drag and drop (CDP), at a point of the window. */
async function dropFiles(page: Page, files: string[], x: number, y: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  const data = { items: [], files, dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'dragOver', 'drop'] as const) {
    await cdp.send('Input.dispatchDragEvent', { type, x, y, data })
    await new Promise((r) => setTimeout(r, 60))
  }
  await cdp.detach()
}

async function upload(url: string, file: string, name: string, uploader: string): Promise<number> {
  const res = await fetch(new URL('upload', url), {
    method: 'POST',
    headers: { 'X-File-Name': encodeURIComponent(name), 'X-Uploader': encodeURIComponent(uploader), 'Content-Type': 'image/jpeg' },
    body: readFileSync(file)
  })
  await res.arrayBuffer()
  return res.status
}

test('duplicates: a folder twice, a renamed copy, drop, Ctrl+V, two pupils uploading the same photo', async () => {
  test.setTimeout(8 * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-dup-'))
  const locale = process.env.DIASHOW_LOCALE ?? 'de-DE'
  const de = locale.startsWith('de')
  const savedClipboard = clipboardText()
  let s: Session | null = null
  try {
    s = await launch(dataDir, { DIASHOW_LOCALE: locale, DIASHOW_SHARE_HOST: '127.0.0.1' })
    const { app, page } = s
    const trip = join(dataDir, 'Ausflug')
    const files = copyMedia(sampleFiles(), trip)
    await store(page, `await s.createProject([${JSON.stringify(trip)}], 'Doppelt')`)
    await waitProcessed(page)
    const ids0 = await entryIds(page)
    expect(ids0).toHaveLength(4)
    const notice = page.getByTestId('repeat-notice')
    const noticeText = notice.locator('.repeat-text')
    const announce = page.getByTestId('repeat-announce')

    // ---- the same folder again through "Add folder": nothing is added, and the notice says so
    const updatedAt = await store(page, 'return s.project.updatedAt')
    await answerOpenDialog(app, [trip])
    await page.getByRole('button', { name: /^(Fotos, Videos oder Text hinzufügen|Add photos, videos or text)$/ }).click()
    await page.getByRole('menuitem', { name: /^(Ordner hinzufügen|Add folder)$/ }).click()
    const all4 = de ? 'Alle 4 Fotos sind schon in der Diashow – es wurde nichts hinzugefügt.' : 'All 4 photos are already in the slideshow – nothing was added.'
    await expect(noticeText).toHaveText(all4)
    await expect(announce).toHaveText(all4)
    await expect(announce).toHaveAttribute('aria-live', 'polite')
    expect(await entryIds(page)).toEqual(ids0)
    // no undo step: the show is as it was, and Ctrl+Z takes back the first import itself
    expect(await store(page, 'return s.project.updatedAt')).toBe(updatedAt)
    await page.locator('.stage').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await entryIds(page)).length).toBe(0)
    await page.keyboard.press('Control+y')
    await expect.poll(() => entryIds(page)).toEqual(ids0)
    await waitProcessed(page)
    await page.screenshot({ path: join(__dirname, '..', 'test-results', 'duplicates-notice.png') })

    // "Show" with the keyboard: the four slides are selected
    await notice.getByRole('button', { name: /^(Zeigen|Show)$/ }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => selection(page)).toEqual(ids0)
    await expect(notice).toBeVisible()

    // "Add anyway": they come in where they would have gone (the end), in one undo step
    await notice.getByRole('button', { name: /^(Trotzdem einfügen|Add anyway)$/ }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await entryIds(page)).length).toBe(8)
    await expect(notice).toHaveCount(0)
    expect((await paths(page)).slice(4).sort()).toEqual([...files].sort())
    await page.locator('.stage').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Control+z')
    await expect.poll(() => entryIds(page)).toEqual(ids0)

    // ---- a renamed copy of a photo is skipped, a different photo comes in
    const renamed = join(dataDir, 'Mia', 'Urlaub am See.jpg')
    mkdirSync(join(dataDir, 'Mia'))
    copyFileSync(files[0], renamed)
    const [other] = copyMedia(['sony/DCIM/100MSDCF/DSC00001.JPG'], join(dataDir, 'Ben'))
    await store(page, `await s.importMedia(${JSON.stringify([renamed, other])})`)
    await expect.poll(async () => (await entryIds(page)).length).toBe(5)
    const one = de ? '1 Foto ist schon in der Diashow und wurde übersprungen.' : '1 photo is already in the slideshow and was skipped.'
    await expect(noticeText).toHaveText(one)
    const now = await paths(page)
    expect(now).toContain(other)
    expect(now).not.toContain(renamed)
    // "Show": the slide of the original
    await notice.getByRole('button', { name: /^(Zeigen|Show)$/ }).click()
    await expect.poll(() => selection(page)).toEqual([(await entryIds(page))[now.indexOf(files[0])]])
    await waitProcessed(page)

    // ---- a photo of the show dropped between two cards of the filmstrip
    await notice.getByRole('button', { name: /^(Schließen|Close)$/ }).click()
    await expect(notice).toHaveCount(0)
    const ids1 = await entryIds(page)
    const b1 = await page.locator('.cards .card[data-index="1"]').boundingBox()
    const b2 = await page.locator('.cards .card[data-index="2"]').boundingBox()
    await dropFiles(page, [files[2]], (b1!.x + b1!.width + b2!.x) / 2, b1!.y + 20)
    const onlyOne = de ? 'Das Foto ist schon in der Diashow und wurde nicht noch einmal hinzugefügt.' : 'The photo is already in the slideshow and was not added again.'
    await expect(noticeText).toHaveText(onlyOne)
    await page.waitForTimeout(500)
    // neither the filmstrip nor the window's own drop handler added it
    expect(await entryIds(page)).toEqual(ids1)

    // ---- Ctrl+V with a copy of a photo that is left out of the show: it is still "already there"
    const img3 = (await paths(page)).findIndex((p) => basename(p) === 'IMG_0003.JPG')
    await store(page, `s.updateEntries([${JSON.stringify(ids1[img3])}], (e) => { e.excluded = true })`)
    const copied = join(dataDir, 'Kopie', 'IMG_0003 (2).JPG')
    mkdirSync(join(dataDir, 'Kopie'))
    copyFileSync(files[1], copied)
    copyFilesLikeExplorer([copied])
    await page.locator('.cards .card[data-index="0"]').click()
    await page.keyboard.press('Control+v')
    await expect(noticeText).toHaveText(`${onlyOne} ${de ? 'Es ist herausgenommen (zu finden unter „Sichten“).' : 'It is left out (see “Review”).'}`)
    expect(await entryIds(page)).toEqual(ids1)
    // "Show" opens the review grid, where left-out photos are
    await notice.getByRole('button', { name: /^(Zeigen|Show)$/ }).click()
    await expect.poll(() => store(page, 'return s.view')).toBe('cull')
    await store(page, `s.set({ view: 'editor' }); s.updateEntries([${JSON.stringify(ids1[img3])}], (e) => { delete e.excluded })`)
    // Esc inside the notice closes it
    await notice.getByRole('button', { name: /^(Zeigen|Show)$/ }).focus()
    await page.keyboard.press('Escape')
    await expect(notice).toHaveCount(0)

    // ---- two pupils upload the same photo over the Wi-Fi: one slide
    const klasse = join(dataDir, 'Klassenfoto.jpg')
    await sharp(randomBytes(800 * 600 * 3), { raw: { width: 800, height: 600, channels: 3 } }).jpeg({ quality: 85 }).toFile(klasse)
    await store(page, `s.set({ dialog: 'share' })`)
    await page.locator('.share-start').click()
    const urlBox = page.getByTestId('share-upload-url')
    await expect(urlBox).toContainText('http://127.0.0.1:')
    const url = (await urlBox.textContent())!.trim()
    const n0 = (await entryIds(page)).length
    expect(await upload(url, klasse, 'IMG_2001.jpg', 'Mia')).toBe(201)
    await expect.poll(async () => (await entryIds(page)).length, { timeout: 60_000 }).toBe(n0 + 1)
    expect(await upload(url, klasse, 'Klassenfoto.jpg', 'Ben')).toBe(201)
    const received = page.getByTestId('share-received')
    await expect(received).toContainText(`Ben · 1 · ${de ? '1 schon vorhanden' : '1 already there'}`, { timeout: 60_000 })
    await expect(received).toContainText('Mia · 1')
    await expect(page.locator('.share-dialog')).toContainText(de ? 'Angekommen (2) · 1 schon vorhanden' : 'Received (2) · 1 already there')
    await page.screenshot({ path: join(__dirname, '..', 'test-results', 'duplicates-share.png') })
    expect((await entryIds(page)).length).toBe(n0 + 1)
    const uploads = join(dataDir, 'Diashow Studio', 'Uploads', 'Doppelt')
    expect(await paths(page)).toContain(join(uploads, 'Mia', 'IMG_2001.jpg'))
    // the dialog counts them itself: no notice
    await expect(notice).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('.share-dialog')).toHaveCount(0)
    // the clean-up's "only those not in the show" covers the copy that was not added
    const inventory = (): Promise<any> => store(page, 'return window.api.cleanupInventory(s.project.id)')
    await expect.poll(async () => (await inventory()).uploads.inShow.files).toBe(1)
    const inv = await inventory()
    expect(inv.uploads.files).toBe(2)
    expect(inv.uploads.leftOut.files).toBe(1)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
    // the user's clipboard text as it was before the test (files are not restored)
    if (savedClipboard) {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', '$input | Set-Clipboard'], { input: savedClipboard.replace(/\r?\n$/, '') })
      } catch {
        // clipboard busy
      }
    }
  }
})

/**
 * `n` phone-like photos: random pictures (1600 × 1200 to 2400 × 1800, 1.5 to 4 MB, sizes spread like a
 * phone's) with a camera and a capture time.
 */
async function makePhotos(dir: string, n: number): Promise<void> {
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < n; i++) {
    const w = 1600 + ((i * 37) % 800)
    const h = Math.round((w * 3) / 4)
    const s = String(i % 60).padStart(2, '0')
    const m = String(Math.floor(i / 60)).padStart(2, '0')
    await sharp(randomBytes(w * h * 3), { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 82 + (i % 12) })
      .withExif({ IFD0: { Make: 'Google', Model: 'Pixel 8' }, IFD2: { DateTimeOriginal: `2026:05:04 10:${m}:${s}`, OffsetTimeOriginal: '+02:00', SubSecTimeOriginal: String(100 + (i % 800)) } })
      .toFile(join(dir, `PXL_${String(i).padStart(4, '0')}.jpg`))
  }
}

test('duplicates: import time of 400 photos', async () => {
  test.skip(!process.env.DIASHOW_DUP_BENCH, 'DIASHOW_DUP_BENCH=1 measures the import time')
  test.setTimeout(20 * 60 * 1000)
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-dupbench-'))
  let s: Session | null = null
  try {
    const dir = join(dataDir, 'Ausflug')
    const t0 = Date.now()
    await makePhotos(dir, 400)
    console.log(`generated 400 photos in ${Date.now() - t0} ms`)
    s = await launch(dataDir, { DIASHOW_LOCALE: process.env.DIASHOW_LOCALE ?? 'de-DE' })
    const { page } = s
    const timed = (fn: string): Promise<number> =>
      page.evaluate(async (code) => {
        const st = (window as any).__diashow.store.getState()
        const t = performance.now()
        await new Function('st', `return (${code})(st)`)(st)
        return Math.round(performance.now() - t)
      }, fn)
    const count = (): Promise<number> => page.evaluate(() => (window as any).__diashow.store.getState().project.entries.length)
    await timed(`(st) => st.createProject([], 'Bench')`)
    const first = await timed(`(st) => st.importMedia([${JSON.stringify(dir)}])`)
    const t1 = Date.now()
    await page.waitForFunction(() => (window as any).__diashow.store.getState().project.media.every((m: any) => !!m.thumb), null, { timeout: 600_000, polling: 100 })
    const thumbs = Date.now() - t1 + first
    await waitProcessed(s.page, 900_000)
    const ready = Date.now() - t1 + first
    const n1 = await count()
    const again = await timed(`(st) => st.importMedia([${JSON.stringify(dir)}])`)
    const n2 = await count()
    // the folder copied under another name: 400 byte-identical copies
    const copy = join(dataDir, 'Ausflug Kopie')
    mkdirSync(copy)
    for (const f of readdirSync(dir)) copyFileSync(join(dir, f), join(copy, f))
    const copies = await timed(`(st) => st.importMedia([${JSON.stringify(copy)}])`)
    const n3 = await count()
    // the same in the import without the check (importPaths, as before): another 400 photos into a new show
    const plain = join(dataDir, 'Ohne Prüfung')
    await makePhotos(plain, 400)
    await timed(`(st) => st.createProject([], 'Plain')`)
    const unchecked = await timed(`async (st) => {
      const items = await window.api.importPaths([${JSON.stringify(plain)}])
      st.update((p) => { p.media.push(...items); p.entries.push(...items.map((m) => ({ id: crypto.randomUUID(), type: m.kind, mediaId: m.id }))) })
    }`)
    await waitProcessed(s.page, 900_000)
    // how many of the 400 share their size with another one (only those are read in a first import)
    const sizes = new Map<number, number>()
    for (const f of readdirSync(dir)) sizes.set(statSync(join(dir, f)).size, (sizes.get(statSync(join(dir, f)).size) ?? 0) + 1)
    const shared = [...sizes.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0)
    console.log(JSON.stringify({ first, unchecked, thumbs, ready, again, copies, entries: [n1, n2, n3], sharedSize: shared }))
    expect(n1).toBe(400)
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
