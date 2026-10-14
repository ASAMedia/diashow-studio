// The filmstrip end to end: zoom (slider, buttons, Ctrl+wheel around the mouse, "show the whole
// slideshow") with the audio lane and playhead staying on the cards; a 400-slide show at the smallest
// size; search by file name and date word with next/previous and the chapters menu; files from
// Explorer dropped between two cards and onto a card (a real drop through Chromium's drag pipeline,
// CDP Input.dispatchDragEvent with file paths); Ctrl+V of files copied like in Explorer (CF_HDROP via
// PowerShell's Set-Clipboard) and of a picture without a file (written by the main process); "Insert…"
// in a slide's menu; undo and redo of an insert. Selectors work in German and English. The inserted
// files are copies of photos the show has; a few extra bytes make them new files (duplicates.spec.ts
// checks that real copies are skipped).
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { answerOpenDialog, copyMedia, dropFiles, ensureTestMedia, launch, mediaDir, removeDir, sampleFiles, waitProcessed, type Session } from './harness'

const shots = join(__dirname, '..', 'test-results', 'filmstrip')

type Slide = { index: number; kind: string; ids: string[]; paths: string[]; start: number; chapter: boolean }
const slides = (page: Page): Promise<Slide[]> =>
  page.evaluate(() =>
    (window as any).__diashow.player.current.tl.slides.map((s: any) => ({
      index: s.index, kind: s.kind, ids: s.entries.map((e: any) => e.id), paths: s.media.map((m: any) => m.path), start: s.start,
      // what the chapters menu lists: the title, text slides and text slides shown as captions
      chapter: s.kind === 'title' || s.kind === 'text' || !!s.titleOverlay || !!s.captionEntryId
    }))
  )
const entryIds = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__diashow.store.getState().project.entries.map((e: any) => e.id))
const selection = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__diashow.store.getState().selection)
const cardWidth = (page: Page): Promise<number> => page.locator('.cards .card:not(.add)').first().evaluate((el) => Math.round(el.getBoundingClientRect().width))
const cardBox = (page: Page, index: number): Promise<{ left: number; right: number; top: number; bottom: number; width: number } | null> =>
  page.evaluate((i) => {
    const el = document.querySelector(`.cards .card[data-index="${i}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }
  }, index)
const playerTime = (page: Page): Promise<number> => page.evaluate(() => (window as any).__diashow.player.current.t)

/** The video's sound in the audio lane, and the playhead, sit where the cards say at this zoom. */
async function expectAligned(page: Page, videoIndex: number, label: string): Promise<void> {
  const card = await page.locator(`.cards .card[data-index="${videoIndex}"]`).evaluate((el) => el.getBoundingClientRect().left)
  const clip = await page.locator('.lane rect.clip').first().evaluate((el) => el.getBoundingClientRect().left)
  expect(Math.abs(clip - card), `${label}: lane clip ${clip} vs card ${card}`).toBeLessThan(1.5)
  // the playhead at the start of a slide sits on its card's left edge
  const s = (await slides(page))[videoIndex]
  await page.evaluate((t) => (window as any).__diashow.player.current.seek(t), s.start)
  await expect
    .poll(async () => {
      const ph = await page.locator('.playhead').evaluate((el) => el.getBoundingClientRect().left + 1)
      const c = await cardBox(page, videoIndex)
      return c ? Math.abs(ph - c.left) : 99
    }, { timeout: 5000 })
    .toBeLessThan(1.5)
}

/** Sets the Windows clipboard to a file list, as Ctrl+C in Explorer does (CF_HDROP). */
function copyFilesLikeExplorer(paths: string[]): void {
  const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', `Set-Clipboard -Path ${list}`], { stdio: 'ignore' })
}

function clipboardText(): string | null {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'Get-Clipboard -Raw -Format Text'], { encoding: 'utf8' })
  } catch {
    return null
  }
}

test('filmstrip: zoom, search, chapters, insert by drop and Ctrl+V, undo', { lock: 'clipboard' }, async () => {
  test.setTimeout(8 * 60 * 1000)
  ensureTestMedia()
  mkdirSync(shots, { recursive: true })
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-strip-'))
  const locale = process.env.DIASHOW_LOCALE ?? 'de-DE'
  const de = locale.startsWith('de')
  const savedClipboard = clipboardText()
  let s: Session | null = null
  try {
    s = await launch(dataDir, { DIASHOW_LOCALE: locale })
    const { app, page } = s
    const files = copyMedia(sampleFiles({ video: true }), join(dataDir, 'media'))
    await page.evaluate(async (paths) => {
      await (window as any).__diashow.store.getState().createProject(paths, 'Streifen')
    }, files)
    await waitProcessed(page)
    const n0 = (await slides(page)).length
    expect(n0).toBe(5)
    const videoIndex = (await slides(page)).findIndex((x) => x.kind === 'video')
    expect(videoIndex).toBeGreaterThanOrEqual(0)
    await expect(page.locator('.lane rect.clip')).toHaveCount(1)

    // ---- zoom: the classic size first, the slider down to the smallest and up to the largest
    expect(await cardWidth(page)).toBe(96)
    await expectAligned(page, videoIndex, 'classic')
    const slider = page.getByRole('slider', { name: /Größe der Folien|Size of the slides/ })
    await slider.focus()
    await page.keyboard.press('Home')
    await expect.poll(() => cardWidth(page)).toBe(6)
    // the arrow keys move it by a pixel at least, also where a step of the slider is less
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => cardWidth(page)).toBe(7)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => cardWidth(page)).toBe(6)
    await expect(page.locator('section.strip')).toHaveClass(/zoom-tiny/)
    // small cards: no badges, a mark at each chapter, numbers only every few slides
    expect(await page.locator('.cards .badges').count()).toBe(0)
    await expectAligned(page, videoIndex, 'smallest')
    await page.keyboard.press('End')
    await expect.poll(() => cardWidth(page)).toBe(144)
    await expectAligned(page, videoIndex, 'largest')
    // the buttons step the size
    await page.getByRole('button', { name: /^(Kleinere Folien|Smaller slides)$/ }).click()
    const afterOut = await cardWidth(page)
    expect(afterOut).toBeLessThan(144)
    await page.getByRole('button', { name: /^(Größere Folien|Larger slides)$/ }).click()
    expect(await cardWidth(page)).toBeGreaterThan(afterOut)
    // remembered per user
    expect(Number(await page.evaluate(() => localStorage.getItem('diashow.filmstripZoom')))).toBe(await cardWidth(page))

    // "show the whole slideshow": every card in view
    await page.getByRole('button', { name: /Ganze Diashow zeigen|Show the whole slideshow/ }).click()
    await expect
      .poll(async () => {
        const sc = await page.locator('.strip-scroll').evaluate((el) => ({ right: el.getBoundingClientRect().right, scroll: el.scrollWidth - el.clientWidth }))
        const last = await cardBox(page, n0 - 1)
        return !!last && last.right <= sc.right && sc.scroll <= 1
      }, { timeout: 5000 })
      .toBe(true)
    await expectAligned(page, videoIndex, 'fit all')
    await page.screenshot({ path: join(shots, 'fit-all.png') })

    // ---- a 400-slide show at the smallest size: virtualised and quick to scroll
    const big = await page.evaluate(() => {
      const st = (window as any).__diashow.store.getState()
      const photos = st.project.entries.filter((e: any) => e.type === 'photo')
      st.update((p: any) => {
        const extra = Array.from({ length: 395 }, (_, i) => ({ id: `big-${i}`, type: 'photo', mediaId: photos[i % photos.length].mediaId }))
        p.entries.push(...extra)
      })
      return (window as any).__diashow.store.getState().project.entries.length
    })
    expect(big).toBe(400)
    await page.getByRole('button', { name: /Ganze Diashow zeigen|Show the whole slideshow/ }).click()
    await expect.poll(() => cardWidth(page)).toBe(6)
    const perf = await page.evaluate(async () => {
      const el = document.querySelector<HTMLElement>('.strip-scroll')!
      const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
      const rendered: number[] = []
      const t0 = performance.now()
      for (let i = 0; i < 40; i++) {
        el.scrollLeft = (i % 2 ? el.scrollWidth : 0) * Math.random()
        await frame()
        rendered.push(document.querySelectorAll('.cards .card:not(.add)').length)
      }
      return { ms: (performance.now() - t0) / 40, max: Math.max(...rendered), visible: el.clientWidth, total: el.scrollWidth }
    })
    console.log('400 slides at the smallest size:', JSON.stringify(perf))
    expect(perf.total).toBeGreaterThan(perf.visible)
    // only the cards in view plus a margin (about 200 px on each side) are in the page
    expect(perf.max).toBeLessThan(perf.visible / 7 + 2 * Math.ceil(200 / 7) + 20)
    expect(perf.ms).toBeLessThan(250)
    await page.screenshot({ path: join(shots, 'big-tiny.png') })
    // the selected card scrolled out of the page: a card in view stays the filmstrip's one Tab stop
    await page.evaluate(() => {
      const st = (window as any).__diashow.store.getState()
      st.select([st.project.entries[0].id])
    })
    await page.locator('.strip-scroll').evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })
    await expect(page.locator('.cards .card[data-index="0"]')).toHaveCount(0)
    await expect.poll(() => page.locator('.cards .card[tabindex="0"]').count()).toBe(1)
    await page.evaluate(() => (window as any).__diashow.store.getState().select([]))

    // Ctrl+wheel zooms around the mouse: the slide under it stays under it; the page itself doesn't zoom
    const sc = await page.locator('.strip-scroll').evaluate((el) => {
      el.scrollLeft = el.scrollWidth / 3
      const r = el.getBoundingClientRect()
      return { left: r.left, width: r.width }
    })
    await page.waitForTimeout(200)
    const mx = Math.round(sc.left + sc.width * 0.4)
    const under = await page.evaluate((x) => {
      const card = [...document.querySelectorAll<HTMLElement>('.cards .card:not(.add)')].find((el) => {
        const r = el.getBoundingClientRect()
        return r.left <= x && x < r.right + 1
      })
      return card ? { index: Number(card.dataset.index), top: card.getBoundingClientRect().top } : null
    }, mx)
    expect(under).not.toBeNull()
    const titleBar = await page.locator('.titlebar').evaluate((el) => el.getBoundingClientRect().height)
    await page.mouse.move(mx, under!.top + 10)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -240)
    await page.keyboard.up('Control')
    await expect.poll(() => cardWidth(page)).toBeGreaterThan(8)
    const after1 = (await cardBox(page, under!.index))!
    expect(mx).toBeGreaterThanOrEqual(after1.left - 1.5)
    expect(mx).toBeLessThanOrEqual(after1.right + 1.5)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -480)
    await page.keyboard.up('Control')
    await expect.poll(() => cardWidth(page)).toBeGreaterThan(after1.width + 2)
    const after2 = (await cardBox(page, under!.index))!
    expect(mx).toBeGreaterThanOrEqual(after2.left - 1.5)
    expect(mx).toBeLessThanOrEqual(after2.right + 1.5)
    expect(await page.locator('.titlebar').evaluate((el) => el.getBoundingClientRect().height)).toBe(titleBar)
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1)
    await page.locator('.stage').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await entryIds(page)).length).toBe(5)
    await slider.focus()
    await page.keyboard.press('End')
    for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowLeft')
    await expect.poll(() => cardWidth(page)).toBeLessThan(110)
    await expectAligned(page, videoIndex, 'after the big show')

    // ---- search by file name: Ctrl+F, a list of results, Enter jumps (select, scroll, preview)
    await page.locator('.stage').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Control+f')
    const field = page.getByRole('combobox', { name: /Folien suchen|Search slides/ })
    await expect(field).toBeFocused()
    await field.fill('IMG_0003')
    const listbox = page.getByRole('listbox', { name: /Suchergebnisse|Search results/ })
    await expect(listbox.getByRole('option')).toHaveCount(1)
    await expect(field).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.strip-search [role="status"]')).toHaveText(/^(1 Treffer|1 match)$/)
    const img3 = (await slides(page)).find((x) => x.paths.some((p) => basename(p) === 'IMG_0003.JPG'))!
    await page.keyboard.press('ArrowDown')
    await expect(field).toHaveAttribute('aria-activedescendant', /opt-0$/)
    await page.keyboard.press('Enter')
    await expect.poll(() => selection(page)).toEqual(img3.ids)
    await expect(page.locator('.strip-search [role="status"]')).toHaveText(/^(1 von 1|1 of 1)$/)
    await expect.poll(async () => {
      const t = await playerTime(page)
      const all = await slides(page)
      const next = all[img3.index + 1]?.start ?? Infinity
      return t >= img3.start && t < next
    }).toBe(true)
    await expect(page.locator(`.cards .card[data-index="${img3.index}"]`)).toHaveClass(/match-current/)

    // by a date word: July (IMG_0003, 14 July 2025), not August (PXL_0002)
    const pxl2 = (await slides(page)).find((x) => x.paths.some((p) => basename(p) === 'PXL_0002.jpg'))!
    await field.fill(de ? 'Juli' : 'July')
    await expect(page.locator(`.cards .card[data-index="${img3.index}"]`)).toHaveClass(/\bmatch\b/)
    await expect(page.locator(`.cards .card[data-index="${pxl2.index}"]`)).not.toHaveClass(/\bmatch\b/)
    await field.fill('1.8.2025')
    await expect(listbox.getByRole('option')).toHaveCount(1)
    await expect(page.locator(`.cards .card[data-index="${pxl2.index}"]`)).toHaveClass(/\bmatch\b/)
    await page.keyboard.press('Enter')
    await expect.poll(() => selection(page)).toEqual(pxl2.ids)

    // next and previous: Enter / Shift+Enter, F3 / Shift+F3, the buttons
    await field.fill('.jp')
    await expect(listbox.getByRole('option')).toHaveCount(2)
    await expect(page.locator('.cards .card.match')).toHaveCount(2)
    const order = [img3, pxl2].sort((a, b) => a.index - b.index)
    const status = page.locator('.strip-search [role="status"]')
    await page.keyboard.press('Enter')
    await expect(status).toHaveText(/^(1 von 2|1 of 2)$/)
    await expect.poll(() => selection(page)).toEqual(order[0].ids)
    await page.keyboard.press('Enter')
    await expect(status).toHaveText(/^(2 von 2|2 of 2)$/)
    await expect.poll(() => selection(page)).toEqual(order[1].ids)
    await page.keyboard.press('Shift+Enter')
    await expect(status).toHaveText(/^(1 von 2|1 of 2)$/)
    await page.keyboard.press('F3')
    await expect(status).toHaveText(/^(2 von 2|2 of 2)$/)
    await page.keyboard.press('Shift+F3')
    await expect(status).toHaveText(/^(1 von 2|1 of 2)$/)
    await page.getByRole('button', { name: /Nächster Treffer|Next match/ }).click()
    await expect(status).toHaveText(/^(2 von 2|2 of 2)$/)
    await page.screenshot({ path: join(shots, 'search.png') })
    // the show changes while searching: a new match in front, then that one gone again; the count stays
    // with the match shown, and the next one is the one behind it
    await page.evaluate(() => (window as any).__diashow.store.getState().update((p: any) => p.entries.unshift({ id: 'search-new', type: 'text', title: 'Bilder.jp' })))
    await expect(status).toHaveText(/^(3 von 3|3 of 3)$/)
    await page.keyboard.press('F3')
    await expect(status).toHaveText(/^(1 von 3|1 of 3)$/)
    await page.evaluate(() => (window as any).__diashow.store.getState().update((p: any) => (p.entries = p.entries.filter((e: any) => e.id !== 'search-new'))))
    await expect(listbox.getByRole('option')).toHaveCount(2)
    await page.keyboard.press('F3')
    await expect(status).toHaveText(/^(1 von 2|1 of 2)$/)
    await expect.poll(() => selection(page)).toEqual(order[0].ids)
    // Esc closes the search and its marks
    await field.focus()
    await page.keyboard.press('Escape')
    await expect(field).toHaveCount(0)
    await expect(page.locator('.cards .card.match')).toHaveCount(0)

    // ---- the chapters menu: day titles from the capture dates, a click jumps there
    await page.evaluate(() => (window as any).__diashow.store.getState().insertDayTitles('date'))
    const all = await slides(page)
    const chapters = all.filter((x) => x.kind === 'text')
    expect(chapters.length).toBeGreaterThanOrEqual(2)
    const marks = all.filter((x) => x.chapter)
    await page.getByRole('button', { name: /^(Kapitel|Chapters)$/ }).click()
    const menu = page.getByRole('menu', { name: /^(Kapitel|Chapters)$/ })
    await expect(menu.getByRole('menuitem')).toHaveCount(marks.length)
    await menu.getByRole('menuitem').nth(marks.findIndex((x) => x.index === chapters[1].index)).click()
    await expect.poll(() => selection(page)).toEqual(chapters[1].ids)
    await expect.poll(() => playerTime(page)).toBeGreaterThanOrEqual(chapters[1].start)
    await page.locator('.stage').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await slides(page)).filter((x) => x.kind === 'text').length).toBe(0)

    // ---- drop files from Explorer between two cards (a real drop through Chromium)
    const dropped = copyMedia(['misc/photo.webp', 'android/PXL_0002.jpg'], join(dataDir, 'drop'), true)
    let before = await slides(page)
    let ids0 = await entryIds(page)
    const b1 = (await cardBox(page, 1))!
    const b2 = (await cardBox(page, 2))!
    const gapX = (b1.right + b2.left) / 2
    await dropFiles(page, dropped, gapX, b1.top + 20, async () => {
      // the marker between the cards while the files hover
      await expect(page.locator('.drop-indicator')).toHaveCount(1)
      const mark = await page.locator('.drop-indicator').evaluate((el) => el.getBoundingClientRect())
      expect(mark.left + mark.width / 2).toBeGreaterThan(b1.right - 2)
      expect(mark.left + mark.width / 2).toBeLessThan(b2.left + 2)
    })
    await expect.poll(async () => (await entryIds(page)).length, { timeout: 20_000 }).toBe(ids0.length + 2)
    let after = await slides(page)
    // in front of the old second slide, sorted by capture time like any import (PXL_0002: 1 Aug 2025)
    expect(after.slice(0, 2).map((x) => x.ids)).toEqual(before.slice(0, 2).map((x) => x.ids))
    expect(after.slice(2, 4).map((x) => basename(x.paths[0]))).toEqual(['PXL_0002.jpg', 'photo.webp'])
    expect(after.slice(2, 4).every((x) => x.paths[0].startsWith(join(dataDir, 'drop')))).toBe(true)
    expect(after.slice(4).map((x) => x.ids)).toEqual(before.slice(2).map((x) => x.ids))
    // the new slides are selected; the window's own drop handler didn't import them a second time
    await expect.poll(() => selection(page)).toEqual(after.slice(2, 4).flatMap((x) => x.ids))
    await page.waitForTimeout(500)
    expect((await entryIds(page)).length).toBe(ids0.length + 2)
    await expect(page.locator('.window-drop')).toHaveCount(0)
    // undo takes the whole drop back in one step, redo brings it again
    await page.locator('.stage').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Control+z')
    await expect.poll(() => entryIds(page)).toEqual(ids0)
    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await entryIds(page)).length, { timeout: 20_000 }).toBe(ids0.length + 2)
    await waitProcessed(page)

    // Magazine: dropped between two slides, the new photo gets its own slide and no other slide changes;
    // dropped onto the middle of a card, it joins that slide
    await page.evaluate(() => (window as any).__diashow.store.getState().setTheme('magazine'))
    await expect.poll(async () => (await slides(page)).length).toBeLessThan(ids0.length + 2)
    before = await slides(page)
    ids0 = await entryIds(page)
    const one = copyMedia(['iphone/IMG_0003.JPG'], join(dataDir, 'drop2'), true)
    const m0 = (await cardBox(page, 0))!
    const m1 = (await cardBox(page, 1))!
    // coming from the first card, released at once in the gap: the drop still arrives
    await dropFiles(page, one, (m0.right + m1.left) / 2, m0.top + 20, undefined, [m0.left + m0.width * 0.25, m0.top + 20])
    await expect.poll(async () => (await entryIds(page)).length, { timeout: 20_000 }).toBe(ids0.length + 1)
    after = await slides(page)
    expect(after[0].ids).toEqual(before[0].ids)
    expect(after[1].paths).toEqual([one[0]])
    expect(after.slice(2).map((x) => [...x.ids].sort())).toEqual(before.slice(1).map((x) => [...x.ids].sort()))
    before = after
    ids0 = await entryIds(page)
    const target = before.findIndex((x) => x.kind === 'photos' && x.ids.length < 6)
    // not pano.png: a panorama always has a slide of its own
    const onto = copyMedia(['misc/photo.webp'], join(dataDir, 'drop3'), true)
    const tb = (await cardBox(page, target))!
    await dropFiles(page, onto, tb.left + tb.width / 2, tb.top + 20, async () => {
      await expect(page.locator(`.cards .card[data-index="${target}"]`)).toHaveClass(/merge-target/)
    })
    await expect.poll(async () => (await entryIds(page)).length, { timeout: 20_000 }).toBe(ids0.length + 1)
    after = await slides(page)
    expect(after.length).toBe(before.length)
    expect(after[target].paths).toContain(onto[0])
    await page.evaluate(() => (window as any).__diashow.store.getState().setTheme('kenburns'))

    // ---- Ctrl+V with files copied in Explorer: behind the selected slide, selected, one undo step
    await waitProcessed(page)
    before = await slides(page)
    ids0 = await entryIds(page)
    await page.locator(`.cards .card[data-index="1"]`).click()
    const copied = copyMedia(['misc/photo.webp', 'iphone/IMG_0003.JPG'], join(dataDir, 'copied'), true)
    copyFilesLikeExplorer(copied)
    // in a text field Ctrl+V pastes text, it doesn't insert slides
    await page.keyboard.press('Control+f')
    await expect(field).toBeFocused()
    await page.keyboard.press('Control+v')
    await page.waitForTimeout(800)
    expect((await entryIds(page)).length).toBe(ids0.length)
    await page.keyboard.press('Escape')
    await page.locator(`.cards .card[data-index="1"]`).click()
    await page.keyboard.press('Control+v')
    await expect.poll(async () => (await entryIds(page)).length, { timeout: 20_000 }).toBe(ids0.length + 2)
    after = await slides(page)
    expect(after.slice(0, 2).map((x) => x.ids)).toEqual(before.slice(0, 2).map((x) => x.ids))
    expect(after.slice(2, 4).flatMap((x) => x.paths).sort()).toEqual([...copied].sort())
    await expect.poll(() => selection(page)).toEqual(after.slice(2, 4).flatMap((x) => x.ids))
    await page.keyboard.press('Control+z')
    await expect.poll(() => entryIds(page)).toEqual(ids0)
    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await entryIds(page)).length, { timeout: 20_000 }).toBe(ids0.length + 2)

    // ---- Ctrl+V with a picture without a file (a screenshot): saved as a PNG for the show, then inserted
    const png = readFileSync(join(mediaDir, 'misc', 'pano.png')).toString('base64')
    await app.evaluate(async ({ clipboard, ClipboardItem }, b64) => {
      const bytes = Buffer.from(b64, 'base64')
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
    }, png)
    ids0 = await entryIds(page)
    await page.keyboard.press('Escape')
    await page.locator('.stage').click({ position: { x: 5, y: 5 } })
    await page.evaluate(() => (window as any).__diashow.store.getState().select([]))
    await page.keyboard.press('Control+v')
    await expect.poll(async () => (await entryIds(page)).length, { timeout: 20_000 }).toBe(ids0.length + 1)
    after = await slides(page)
    const pasted = after[after.length - 1].paths[0]
    const folder = join(dataDir, 'Diashow Studio', de ? 'Eingefügt' : 'Pasted', 'Streifen')
    expect(pasted.startsWith(folder + '\\')).toBe(true)
    expect(basename(pasted)).toMatch(/^\d{4}-\d\d-\d\d \d\d-\d\d-\d\d( \(\d+\))?\.png$/)
    expect(existsSync(pasted)).toBe(true)
    await waitProcessed(page)
    // the clean-up knows the folder as the show's own data
    const projectId = await page.evaluate(() => (window as any).__diashow.store.getState().project.id)
    await page.waitForTimeout(800)
    const inv = await page.evaluate((id) => (window as any).api.cleanupInventory(id), projectId)
    expect(inv.uploads.pasted).toBe(1)
    expect(inv.uploads.files).toBeGreaterThanOrEqual(1)

    // ---- "Insert…" in a slide's menu: the file dialog, then in behind that slide
    ids0 = await entryIds(page)
    before = await slides(page)
    const picked = copyMedia(['misc/pano.png'], join(dataDir, 'picked'), true)
    await answerOpenDialog(app, picked)
    await page.locator(`.cards .card[data-index="0"]`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^(Einfügen…|Insert…)$/ }).click()
    await expect.poll(async () => (await entryIds(page)).length, { timeout: 20_000 }).toBe(ids0.length + 1)
    after = await slides(page)
    expect(after[0].ids).toEqual(before[0].ids)
    expect(after[1].paths).toEqual(picked)
    await page.screenshot({ path: join(shots, 'inserted.png') })
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
    // the user's clipboard text as it was before the test (pictures and files are not restored)
    if (savedClipboard) {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', '$input | Set-Clipboard'], { input: savedClipboard.replace(/\r?\n$/, '') })
      } catch {
        // clipboard busy
      }
    }
  }
})
