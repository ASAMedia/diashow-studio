// The home screen end to end, with Chromium's own drag and drop (dragFiles and dropFiles in harness.ts):
// - files dropped onto a show's card go into that show: it opens, they are sorted into their day (a new
//   day title for a new day), photos it has already are skipped with the notice, and one undo step takes
//   it all back. The card's mark comes with the files and goes when they leave or on Esc; nothing moves
//   under the pointer and the card's name for screen readers stays. The drop box, a damaged show's row
//   and the rest of the home screen still make a new show; a show in the trash is no target;
// - while a dialog is open (Settings, the archive, the trash, sharing), files are refused: no "drop
//   here", nothing goes in, a calm "Close the dialog first" once per drag. The assistant takes them;
// - duplicating from the home screen and from the editor's "⋯" menu: names, an independent copy whose
//   undo history starts empty, the clean-up of one keeps the uploads the others use, and the trash of
//   one (also with the others' clean-up meanwhile) leaves them working.
// Runs in German and with DIASHOW_LOCALE=en-US DIASHOW_SOFTWARE_GL=1.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { copyMedia, dragFiles, dropFiles, ensureTestMedia, launch, menu, project, projectFile, readProject, removeDir, root, waitProcessed, waitSaved, type Session } from './harness'
import { SOFTWARE_GL } from './launch'

const locale = process.env.DIASHOW_LOCALE ?? 'de-DE'
const de = locale.toLowerCase().startsWith('de')
const COPY = de ? 'Kopie' : 'Copy'

const state = <T,>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const d = window.__diashow; const s = d.store.getState(); ${fn} })()`) as Promise<T>
const centre = (b: { x: number; y: number; width: number; height: number }): [number, number] => [b.x + b.width / 2, b.y + b.height / 2]
const card = (page: Page, id: string): Locator => page.locator(`.home .project[data-id="${id}"]`)
const backButton = (page: Page): Locator => page.locator('.titlebar button[title="Zurück"], .titlebar button[title="Back"]')
const undoButton = (page: Page): Locator => page.locator('.titlebar button[aria-label^="Rückgängig"], .titlebar button[aria-label^="Undo"]')

/** The open show's entries: a day title as 'day', a photo or video as its file. */
const entries = (page: Page): Promise<string[]> =>
  state(page, `const m = new Map(s.project.media.map((x) => [x.id, x.path])); return s.project.entries.map((e) => (e.type === 'text' ? 'day' : m.get(e.mediaId)))`)

/** A new show of `paths`, saved with every photo ready, back on the home screen; returns its id. */
async function makeShow(page: Page, dataDir: string, name: string, paths: string[], edit = ''): Promise<string> {
  const id = await page.evaluate(
    async ({ paths, name }) => {
      const st = (window as any).__diashow.store
      await st.getState().createProject(paths, name)
      return st.getState().project.id as string
    },
    { paths, name }
  )
  if (paths.length) await waitProcessed(page)
  if (edit) await state(page, edit)
  await waitSaved(dataDir, id, (p) => p.name === name && p.media.length === paths.length && p.media.every((m: any) => m.status === 'ready'))
  await state(page, `s.closeProject()`)
  await expect(card(page, id)).toBeVisible()
  // closing saves at once; the file settles before the test reads it
  await page.waitForTimeout(800)
  return id
}

/** Undo steps of the stored history when it belongs to the saved show; else null. */
function storedUndo(dataDir: string, id: string): number | null {
  try {
    const h = JSON.parse(gunzipSync(readFileSync(join(dataDir, 'userData', 'history', `${id}.json.gz`))).toString('utf8'))
    const anchor = createHash('sha256').update(readFileSync(projectFile(dataDir, id), 'utf8'), 'utf8').digest('hex')
    return h.anchor === anchor ? h.undo.length : null
  } catch {
    return null
  }
}

/** Counts how often the "Close the dialog first" hint appears. */
async function countHints(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    w.__hints = 0
    if (w.__hintWatch) return
    w.__hintWatch = new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if ((n as Element).classList?.contains('drop-refused')) w.__hints++
    })
    w.__hintWatch.observe(document.body, { childList: true, subtree: true })
  })
}

/**
 * With a dialog open: files over the dialog, beside it and over a field in it are refused (the drag
 * gets no drop effect, Chromium sends no drop), there is no "drop here", nothing goes in, and the hint
 * comes once.
 */
async function refusedWhile(page: Page, dialog: Locator, file: string, shot?: string): Promise<void> {
  await expect(dialog).toBeVisible()
  const hint = page.getByTestId('drop-refused')
  await expect(hint).toHaveCount(0, { timeout: 10_000 })
  const before = { project: (await project(page))?.entries.length ?? null, shows: (await page.evaluate(() => (window as any).api.listProjects())).length }
  await countHints(page)
  const box = (await dialog.boundingBox())!
  const inside = centre(box)
  // a text field or list in view, if the dialog has one
  const field = dialog.locator('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea').first()
  const fieldAt = (await field.count())
    ? await field.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight ? ([r.left + r.width / 2, r.top + r.height / 2] as [number, number]) : null
      })
    : null
  const drag = await dragFiles(page, [file])
  await drag.to(...inside)
  await expect(hint).toBeVisible()
  await expect(hint).toHaveText(/Erst den Dialog schließen|Close the dialog first/)
  await expect(page.locator('.window-drop')).toHaveCount(0)
  if (shot) await page.screenshot({ path: join(root, 'test-results', 'home', `${shot}.png`) })
  await drag.to(Math.max(4, box.x - 10), inside[1])
  if (fieldAt) await drag.to(...fieldAt)
  await drag.to(...inside)
  await page.waitForTimeout(200)
  expect(await drag.drop(...inside)).toBe('refused')
  await expect(page.locator('.window-drop')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__hints)).toBe(1)
  // nothing went in anywhere
  await page.waitForTimeout(500)
  expect({ project: (await project(page))?.entries.length ?? null, shows: (await page.evaluate(() => (window as any).api.listProjects())).length }).toEqual(before)
  // the hint goes a moment later
  await expect(hint).toHaveCount(0, { timeout: 10_000 })
  if (fieldAt) expect(await field.evaluate((el) => (el as HTMLInputElement).value)).not.toContain(file)
}

test('files dropped on the home screen: onto a show, the drop box; refused while a dialog is open', async () => {
  test.setTimeout((SOFTWARE_GL ? 12 : 6) * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-home-'))
  const docs = join(dataDir, 'Diashow Studio')
  let s: Session | null = null
  try {
    s = await launch(dataDir, { DIASHOW_LOCALE: locale })
    const { page } = s
    // 14 July and 10 September 2025; 1 August comes later
    const [jul, sep] = copyMedia(['iphone/IMG_0003.JPG', 'sony/DCIM/100MSDCF/DSC00001.JPG'], join(dataDir, 'media'))
    const [aug] = copyMedia(['android/PXL_0002.jpg'], join(dataDir, 'more'))
    const [hike] = copyMedia(['misc/photo.webp'], join(dataDir, 'hike'))
    const [fresh, fresh2, fresh3, fresh4] = ['a', 'b', 'c', 'd'].map((n) => copyMedia(['misc/pano.png'], join(dataDir, `new-${n}`), true)[0])
    const tripId = await makeShow(page, dataDir, 'Klassenfahrt', [jul, sep], `s.insertDayTitles('date')`)
    const hikeId = await makeShow(page, dataDir, 'Wandertag', [hike])
    // a show in the trash, and one that can't be read
    const goneId = await makeShow(page, dataDir, 'Gelöscht', [])
    expect(await page.evaluate((id) => (window as any).api.deleteProject(id), goneId)).toHaveProperty('entry')
    mkdirSync(docs, { recursive: true })
    const damagedText = '{"version":1,"id":"kaputt","name":"Kaputt","entries":['
    writeFileSync(join(docs, 'kaputt.dshow'), damagedText)
    await state(page, `s.loadProjects()`)
    await expect(page.getByTestId('trash-open')).toBeVisible()
    await expect(page.getByTestId('damaged-projects')).toContainText('Kaputt')
    await expect(page.locator('.home .project')).toHaveCount(2)
    const hikeText = readFileSync(projectFile(dataDir, hikeId), 'utf8')

    const trip = card(page, tripId)
    const hikeCard = card(page, hikeId)
    const overlay = page.locator('.window-drop')
    const dropBox = centre((await page.locator('.home .drop').boundingBox())!)
    const box = (await trip.boundingBox())!
    const [cx, cy] = centre(box)
    const name = await trip.locator('button.open').ariaSnapshot()
    const under = (): Promise<string> => page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y)
      return el ? `${el.nodeName}.${el.className}` : ''
    }, [cx, cy])
    const unmarked = await under()

    // ---- the mark: over a card it shows; nothing moves under the pointer and the card keeps its name
    let drag = await dragFiles(page, [aug, jul])
    await drag.to(...centre((await hikeCard.boundingBox())!))
    await expect(hikeCard).toHaveClass(/files-over/)
    await drag.to(cx, cy)
    await expect(trip).toHaveClass(/files-over/)
    await expect(hikeCard).not.toHaveClass(/files-over/)
    await expect(overlay).toBeHidden()
    await drag.hover(async () => {
      await expect(trip).toHaveAttribute('data-drop-label', /Zu dieser Diashow hinzufügen|Add to this slideshow/)
      expect(await trip.locator('button.open').ariaSnapshot()).toBe(name)
      expect(await trip.boundingBox()).toEqual(box)
      expect(await under()).toBe(unmarked)
      await page.screenshot({ path: join(root, 'test-results', 'home', 'drop-mark.png') })
    })
    // it goes when the files leave the window, and comes back with them; Esc takes it away
    await drag.out()
    await expect(trip).not.toHaveClass(/files-over/)
    await expect(overlay).toHaveCount(0)
    await drag.to(cx, cy)
    await expect(trip).toHaveClass(/files-over/)
    await drag.esc()
    await expect(trip).not.toHaveClass(/files-over/)
    await expect(overlay).toHaveCount(0)
    expect(await project(page)).toBeNull()

    // ---- dropped onto the card (over the drop box first, released at once on the card): into that show
    drag = await dragFiles(page, [aug, jul])
    await drag.to(...dropBox)
    await expect(overlay).toBeVisible()
    expect(await drag.drop(cx, cy)).toBe('drop')
    await expect.poll(async () => (await project(page))?.id, { timeout: 30_000 }).toBe(tripId)
    // 1 August between its neighbours with a new day title; the photo it had already is skipped
    await expect.poll(() => entries(page), { timeout: 30_000 }).toEqual(['day', jul, 'day', aug, 'day', sep])
    const notice = page.getByTestId('repeat-notice')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText(/übersprungen|skipped/)
    await waitProcessed(page)
    await expect(overlay).toHaveCount(0)
    // one undo step takes it all back
    await undoButton(page).click()
    await expect.poll(() => entries(page)).toEqual(['day', jul, 'day', sep])
    await page.keyboard.press('Control+y')
    await expect.poll(() => entries(page)).toEqual(['day', jul, 'day', aug, 'day', sep])
    await waitSaved(dataDir, tripId, (p) => p.entries.length === 6)
    // the other show is untouched
    expect(readFileSync(projectFile(dataDir, hikeId), 'utf8')).toBe(hikeText)
    await backButton(page).click()
    await expect(trip).toBeVisible()

    // ---- the drop box makes a new show, and so does a damaged show's row (it is no target)
    const newShow = async (at: [number, number], file: string): Promise<string> => {
      const shows = (await page.evaluate(() => (window as any).api.listProjects())).length
      await dropFiles(page, [file], ...at)
      await expect.poll(async () => (await project(page))?.media.map((m: any) => m.path), { timeout: 30_000 }).toEqual([file])
      const id = (await project(page)).id as string
      expect([tripId, hikeId, goneId, 'kaputt']).not.toContain(id)
      await waitSaved(dataDir, id, () => true)
      expect((await page.evaluate(() => (window as any).api.listProjects())).length).toBe(shows + 1)
      await backButton(page).click()
      await expect(page.locator('.home')).toBeVisible()
      return id
    }
    await newShow(dropBox, fresh)
    const damagedRow = page.getByTestId('damaged-projects').locator('.damaged-project').first()
    await damagedRow.scrollIntoViewIfNeeded()
    await newShow(centre((await damagedRow.boundingBox())!), fresh2)
    expect(readFileSync(join(docs, 'kaputt.dshow'), 'utf8')).toBe(damagedText)
    // the show in the trash has no card and got nothing
    await expect(page.locator(`.home .project[data-id="${goneId}"]`)).toHaveCount(0)
    expect(existsSync(projectFile(dataDir, goneId))).toBe(false)

    // ---- a dialog is open: files are refused, on the home screen and in the editor
    await page.locator('.titlebar button[title="Einstellungen"], .titlebar button[title="Settings"]').click()
    const settings = page.getByRole('dialog', { name: /Einstellungen|Settings/ })
    await refusedWhile(page, settings, fresh3, 'refused')
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)

    await trip.hover()
    await trip.locator('button.archive').click()
    const archive = page.getByTestId('archive-dialog')
    await expect(page.getByTestId('archive-run')).toBeEnabled({ timeout: 30_000 })
    await refusedWhile(page, archive, fresh3)
    await page.keyboard.press('Escape')
    await expect(archive).toHaveCount(0)

    await page.getByTestId('trash-open').click()
    const trashDialog = page.getByTestId('trash-dialog')
    await expect(trashDialog.locator(`[data-testid="trash-entry"][data-id="${goneId}"]`)).toBeVisible()
    await refusedWhile(page, trashDialog, fresh3)
    await trashDialog.locator('.actions .btn.primary').click()
    await expect(trashDialog).toHaveCount(0)

    await hikeCard.locator('.open').click()
    await expect.poll(async () => (await project(page))?.id, { timeout: 30_000 }).toBe(hikeId)
    await waitProcessed(page)
    await menu(page, /^(Im WLAN teilen…|Share over Wi-Fi…)$/)
    const share = page.getByRole('dialog', { name: /Im WLAN teilen|Share over Wi-Fi/ })
    await refusedWhile(page, share, fresh3)
    await page.keyboard.press('Escape')
    await expect(share).toHaveCount(0)
    // closed again, the window takes files as before
    await dropFiles(page, [fresh3], ...centre((await page.locator('.stage').boundingBox())!))
    await expect.poll(async () => (await project(page))?.media.map((m: any) => m.path), { timeout: 30_000 }).toEqual([hike, fresh3])
    await waitProcessed(page)
    await backButton(page).click()
    await expect(page.locator('.home')).toBeVisible()

    // ---- the assistant takes photos as before: "drop here", no hint, and they go in
    await page.locator('.home .hero button').filter({ hasText: /Assistent|assistant/ }).click()
    const wizard = page.getByTestId('wizard')
    await expect(wizard).toBeVisible()
    drag = await dragFiles(page, [fresh4])
    await drag.to(...centre((await wizard.boundingBox())!))
    await expect(overlay).toBeVisible()
    await expect(page.getByTestId('drop-refused')).toHaveCount(0)
    expect(await drag.drop(...centre((await wizard.boundingBox())!))).toBe('drop')
    await expect.poll(async () => (await project(page))?.media.map((m: any) => m.path), { timeout: 30_000 }).toEqual([fresh4])
    await waitProcessed(page)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})

test('duplicate: from the home screen and the editor, independent; uploads stay for the other shows', async () => {
  test.setTimeout((SOFTWARE_GL ? 12 : 6) * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-home-'))
  const docs = join(dataDir, 'Diashow Studio')
  let s: Session | null = null
  try {
    s = await launch(dataDir, { DIASHOW_LOCALE: locale })
    const { page } = s
    const own = copyMedia(['iphone/IMG_0003.JPG', 'android/PXL_0002.jpg'], join(dataDir, 'media'))
    // photos two pupils sent over the Wi-Fi (where the share dialog puts them)
    const [mia] = copyMedia(['misc/photo.webp'], join(docs, 'Uploads', 'Klassenfahrt', 'Mia'), true)
    const [ben] = copyMedia(['misc/pano.png'], join(docs, 'Uploads', 'Klassenfahrt', 'Ben'), true)
    const deleteAt = new Date(2027, 6, 1).getTime()
    // pixelation and a caption on the first photo, Ben's photo left out, a theme and a deletion date
    const id = await makeShow(
      page,
      dataDir,
      'Klassenfahrt',
      [...own, mia, ben],
      `const m = new Map(s.project.media.map((x) => [x.path, x.id]));
       const entry = (p) => s.project.entries.find((e) => e.mediaId === m.get(p)).id;
       const first = entry(${JSON.stringify(own[0])}), left = entry(${JSON.stringify(ben)});
       s.updateEntries([first], (e) => { e.privacy = [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]; e.caption = 'Am Brandenburger Tor' });
       s.updateEntries([left], (e) => { e.excluded = true });
       s.setTheme('magazine');
       s.update((p) => { p.deleteAt = ${deleteAt} })`
    )
    await expect.poll(() => storedUndo(dataDir, id), { timeout: 30_000 }).toBeGreaterThanOrEqual(3)
    const originalText = readFileSync(projectFile(dataDir, id), 'utf8')
    const original = JSON.parse(originalText)
    expect(original.deleteAt).toBe(deleteAt)

    // ---- from the home screen: the copy opens in the editor, with everything the show holds
    await card(page, id).hover()
    await card(page, id).locator('button.dup').click()
    await expect.poll(() => state<string>(page, `return s.project?.name`), { timeout: 30_000 }).toBe(`Klassenfahrt (${COPY})`)
    const copyId = (await project(page)).id as string
    expect(copyId).not.toBe(id)
    await expect(page.getByTestId('duplicate-notice')).toContainText(`Klassenfahrt (${COPY})`)
    await expect(page.locator('.titlebar .name')).toHaveText(`Klassenfahrt (${COPY})`)
    await waitProcessed(page)
    await page.screenshot({ path: join(root, 'test-results', 'home', 'duplicate.png') })
    // its undo history starts empty
    await page.waitForTimeout(1500)
    await expect(undoButton(page)).toBeDisabled()
    expect(storedUndo(dataDir, copyId) ?? 0).toBe(0)
    expect(existsSync(join(docs, '.backups', copyId))).toBe(false)
    await waitSaved(dataDir, copyId, (p) => p.media.every((m: any) => m.status === 'ready'))
    const copy = readProject(dataDir, copyId)
    for (const key of ['entries', 'music', 'deleteAt']) expect(copy[key], key).toEqual(original[key])
    expect(copy.media.map((m: any) => [m.id, m.path])).toEqual(original.media.map((m: any) => [m.id, m.path]))
    expect(copy.createdAt).toBeGreaterThan(original.createdAt)
    // the title slide still says "Klassenfahrt": the copy's video doesn't say "(Kopie)"
    expect(copy.settings).toEqual({ ...original.settings, titleText: 'Klassenfahrt' })
    expect(await state<string>(page, `return d.player.current.tl.slides.find((x) => x.kind === 'title' || x.titleOverlay)?.title?.text`)).toBe('Klassenfahrt')

    // changing the copy doesn't change the original: Mia's photo left out, more pixelation, another theme
    const miaEntry = await state<string>(page, `const m = s.project.media.find((x) => x.path === ${JSON.stringify(mia)}); return s.project.entries.find((e) => e.mediaId === m.id).id`)
    await state(page, `s.updateEntries([${JSON.stringify(miaEntry)}], (e) => { e.excluded = true; e.privacy = [{ x: 0.3, y: 0.3, w: 0.3, h: 0.3 }] }); s.setTheme('classic')`)
    await expect(undoButton(page)).toBeEnabled()
    await waitSaved(dataDir, copyId, (p) => p.settings.theme === 'classic' && p.entries.find((e: any) => e.id === miaEntry)?.excluded === true)
    expect(readFileSync(projectFile(dataDir, id), 'utf8')).toBe(originalText)

    // ---- from the editor's "⋯" menu: a copy of the copy, named after the original
    await menu(page, /^(Duplizieren|Duplicate)$/)
    await expect.poll(() => state<string>(page, `return s.project?.name`), { timeout: 30_000 }).toBe(`Klassenfahrt (${COPY} 2)`)
    const copy2Id = (await project(page)).id as string
    expect([id, copyId]).not.toContain(copy2Id)
    expect(await state<string>(page, `return s.project.settings.theme`)).toBe('classic')
    await expect(page.getByTestId('duplicate-notice')).toContainText(`Klassenfahrt (${COPY} 2)`)
    await page.waitForTimeout(1000)
    await expect(undoButton(page)).toBeDisabled()
    await waitProcessed(page)
    await backButton(page).click()
    await expect(page.getByTestId('duplicate-notice')).toHaveCount(0)
    await expect(page.locator('.home .project .meta b')).toHaveText([`Klassenfahrt (${COPY} 2)`, `Klassenfahrt (${COPY})`, 'Klassenfahrt'])
    await page.waitForTimeout(800)

    // ---- the copy's clean-up of what is not in its show: Mia's and Ben's photos are the others' too
    const cleanup = (pid: string, uploads: 'leftOut' | 'all'): Promise<any> =>
      page.evaluate(({ pid, uploads }) => (window as any).api.cleanupRun(pid, { faces: false, uploads, caches: false, backups: false, exports: false }), { pid, uploads })
    expect((await page.evaluate((pid) => (window as any).api.cleanupInventory(pid), copyId)).uploads).toMatchObject({ files: 0, shared: 2 })
    expect((await cleanup(copyId, 'leftOut')).removed.uploads.files).toBe(0)
    for (const f of [mia, ben]) expect(existsSync(f), f).toBe(true)
    expect(readFileSync(projectFile(dataDir, id), 'utf8')).toBe(originalText)

    // ---- the original into the trash: the copies keep working with the shared photos
    await card(page, id).hover()
    await card(page, id).locator('button.del').click()
    const deleteDialog = page.getByTestId('delete-dialog')
    // the uploads the copies use stay with them
    await expect(deleteDialog.locator('[data-category="history"]')).toBeVisible({ timeout: 30_000 })
    await expect(deleteDialog).toContainText(/Was auch eine andere Diashow nutzt, bleibt: 2|What another slideshow uses too stays: 2/)
    await expect(deleteDialog.locator('[data-category="uploads"]')).toHaveCount(0)
    await page.getByTestId('delete-run').click()
    await expect(deleteDialog).toHaveCount(0, { timeout: 30_000 })
    await expect(card(page, id)).toHaveCount(0)
    for (const f of [mia, ben]) expect(existsSync(f), f).toBe(true)
    await card(page, copyId).locator('.open').click()
    await expect.poll(async () => (await project(page))?.id, { timeout: 30_000 }).toBe(copyId)
    await waitProcessed(page)
    expect(await state<string[]>(page, `return s.project.media.map((m) => m.status)`)).toEqual(['ready', 'ready', 'ready', 'ready'])
    await backButton(page).click()
    await expect(card(page, copyId)).toBeVisible()
    await page.waitForTimeout(800)

    // the second copy into the trash too, then the first copy's clean-up of all its uploads: what the
    // shows in the trash use stays, so they come back as they were
    expect(await page.evaluate((pid) => (window as any).api.deleteProject(pid), copy2Id)).toHaveProperty('entry')
    expect((await cleanup(copyId, 'all')).removed.uploads.files).toBe(0)
    for (const f of [mia, ben]) expect(existsSync(f), f).toBe(true)
    await state(page, `s.loadProjects()`)
    await page.getByTestId('trash-open').click()
    const trashDialog = page.getByTestId('trash-dialog')
    await trashDialog.locator(`[data-testid="trash-entry"][data-id="${id}"]`).getByTestId('trash-restore').click()
    await expect(page.getByTestId('trash-notice')).toContainText(/wiederhergestellt|restored/)
    await trashDialog.locator('.actions .btn.primary').click()
    await expect(trashDialog).toHaveCount(0)
    await card(page, id).locator('.open').click()
    await expect.poll(async () => (await project(page))?.id, { timeout: 30_000 }).toBe(id)
    await waitProcessed(page)
    expect(await state<string[]>(page, `return s.project.media.map((m) => m.status)`)).toEqual(['ready', 'ready', 'ready', 'ready'])
    expect((await project(page)).entries).toEqual(original.entries)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
