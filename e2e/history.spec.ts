// Undo and redo survive closing the app (src/main/history.ts):
// - several edits (theme, a text box, rotate and crop, the order of the slides), the app quits; started
//   again on the same data folder, the show opens with its history: the undo button works right away,
//   step by step back to the original, and redo forward again; redo steps survive a restart too;
// - the .dshow changed on disk while the app was closed: the history is discarded (and logged);
// - the clean-up removes the history when chosen;
// - an edit right before the window is closed is saved with its undo step.
// Runs in German and with DIASHOW_LOCALE=en-US DIASHOW_SOFTWARE_GL=1.
import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { ensureTestMedia, launch, mediaDir, menu, project, projectFile, readProject, removeDir, sampleFiles, waitProcessed, waitSaved, type Session } from './harness'
import { SOFTWARE_GL } from './launch'

const NAME = 'Verlauf'

const state = <T,>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const d = window.__diashow; const s = d.store.getState(); ${fn} })()`) as Promise<T>

interface Look {
  theme: string
  order: string[]
  texts: string[]
  edits: string[]
}

/** What the edits change: theme, order of the slides, text boxes, photo edits. */
const look = (page: Page): Promise<Look> =>
  state(page, `const p = s.project; return { theme: p.settings.theme, order: p.entries.map((e) => e.id), texts: p.entries.flatMap((e) => (e.texts ?? []).map((t) => e.id + ':' + t.text)), edits: p.media.map((m) => m.id + ':' + JSON.stringify(m.edit ?? null)).sort() }`)

const historyFile = (dataDir: string, id: string): string => join(dataDir, 'userData', 'history', `${id}.json.gz`)

/** The steps of the stored history, when it belongs to the saved show (anchored to the .dshow's text); else null. */
function storedSteps(dataDir: string, id: string): { undo: number; redo: number } | null {
  try {
    const h = JSON.parse(gunzipSync(readFileSync(historyFile(dataDir, id))).toString('utf8'))
    const anchor = createHash('sha256').update(readFileSync(projectFile(dataDir, id), 'utf8'), 'utf8').digest('hex')
    return h.anchor === anchor ? { undo: h.undo.length, redo: h.redo.length } : null
  } catch {
    return null
  }
}

/** Waits until the show and its history are on disk as `steps` says. */
async function waitStored(dataDir: string, id: string, steps: { undo: number; redo: number }): Promise<void> {
  await expect.poll(() => storedSteps(dataDir, id), { timeout: 30_000, intervals: [250] }).toEqual(steps)
}

const undoButton = (page: Page) => page.locator('.titlebar button[aria-label^="Rückgängig"], .titlebar button[aria-label^="Undo"]')
const redoButton = (page: Page) => page.locator('.titlebar button[aria-label^="Wiederholen"], .titlebar button[aria-label^="Redo"]')

async function openFromHome(page: Page, id: string): Promise<void> {
  await page.locator('.home .project').filter({ hasText: NAME }).locator('.open').click()
  await expect.poll(async () => (await project(page))?.id, { timeout: 30_000 }).toBe(id)
  await waitProcessed(page)
}

const logText = (dataDir: string): string => {
  try {
    return readFileSync(join(dataDir, 'userData', 'logs', 'diashow.log'), 'utf8')
  } catch {
    return ''
  }
}

test('undo and redo survive closing the app; a changed file discards the history; the clean-up removes it', async () => {
  test.setTimeout((SOFTWARE_GL ? 12 : 6) * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-history-'))
  let s: Session | null = null
  try {
    // ---------------------------------------------------------------- session 1: a show and five edits
    s = await launch(dataDir)
    let page = s.page
    const id = await page.evaluate(async ({ paths, name }) => {
      const d = (window as any).__diashow
      await d.store.getState().createProject(paths, name)
      return d.store.getState().project.id as string
    }, { paths: sampleFiles().map((f) => join(mediaDir, ...f.split('/'))), name: NAME })
    await waitProcessed(page)
    // and analysed (faces, likeness, sharpness): a result coming in later saves the show again, and one
    // that lands while the app closes would leave the stored history behind the file (a slow, busy PC)
    await page.waitForFunction(() => (window as any).__diashow.store.getState().project.media.every((m: any) => m.hash && m.faces !== undefined && m.sharpness !== undefined), null, { timeout: 300_000, polling: 250 })
    const looks: Look[] = [await look(page)]
    const entry = await state<string>(page, `return s.project.entries.find((e) => e.type === 'photo').id`)
    // the theme
    await state(page, `s.setTheme(s.project.settings.theme === 'origami' ? 'classic' : 'origami')`)
    looks.push(await look(page))
    // a text box, then its text
    await state(page, `s.addFreeText(${JSON.stringify(entry)})`)
    looks.push(await look(page))
    await state(page, `const e = s.project.entries.find((x) => x.id === ${JSON.stringify(entry)}); s.setFreeText(e.id, e.texts[0].id, { text: 'Hallo Berlin' })`)
    looks.push(await look(page))
    // rotate, straighten and crop the first photo (as the edit view stores it)
    await state(page, `s.update((p) => { p.media = p.media.map((m, i) => (i === 0 ? { ...m, edit: { rotate: 90, straighten: 3, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } } } : m)) })`)
    looks.push(await look(page))
    // the first slide goes to the end (as dragging it in the filmstrip does)
    await state(page, `s.update((p) => { const [e] = p.entries.splice(0, 1); p.entries.push(e) })`)
    looks.push(await look(page))
    for (let k = 1; k < looks.length; k++) expect(looks[k], `edit ${k} changed something`).not.toEqual(looks[k - 1])
    // import + five edits, saved with the show
    await waitSaved(dataDir, id, (p) => p.entries.map((e: any) => e.id).join() === looks[5].order.join())
    await waitStored(dataDir, id, { undo: 6, redo: 0 })
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null

    // ---------------------------------------------------------------- session 2: undo step by step, redo again
    s = await launch(dataDir)
    page = s.page
    await openFromHome(page, id)
    expect(await look(page)).toEqual(looks[5])
    // the undo button works right away
    await expect(undoButton(page)).toBeEnabled({ timeout: 15_000 })
    await expect(redoButton(page)).toBeDisabled()
    for (let k = 4; k >= 0; k--) {
      await undoButton(page).click()
      await expect.poll(() => look(page), { message: `undo to state ${k}` }).toEqual(looks[k])
    }
    // the import is still there to undo; the original state is reached
    await expect(undoButton(page)).toBeEnabled()
    for (let k = 1; k <= 5; k++) {
      await redoButton(page).click()
      await expect.poll(() => look(page), { message: `redo to state ${k}` }).toEqual(looks[k])
    }
    await expect(redoButton(page)).toBeDisabled()
    // two steps back with the keyboard; the redo steps are stored too
    await page.locator('.stage').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect.poll(() => look(page)).toEqual(looks[3])
    await waitStored(dataDir, id, { undo: 4, redo: 2 })
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null

    // ---------------------------------------------------------------- session 3: redo after a restart
    s = await launch(dataDir)
    page = s.page
    await openFromHome(page, id)
    expect(await look(page)).toEqual(looks[3])
    await expect(redoButton(page)).toBeEnabled({ timeout: 15_000 })
    await redoButton(page).click()
    await redoButton(page).click()
    await expect.poll(() => look(page)).toEqual(looks[5])
    await expect(redoButton(page)).toBeDisabled()
    await waitStored(dataDir, id, { undo: 6, redo: 0 })
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null

    // ---------------------------------------------------------------- the .dshow changed elsewhere: the history goes
    const file = projectFile(dataDir, id)
    const changed = JSON.parse(readFileSync(file, 'utf8'))
    changed.settings.theme = 'vintage'
    writeFileSync(file, JSON.stringify(changed, null, 1), 'utf8')
    s = await launch(dataDir)
    page = s.page
    await openFromHome(page, id)
    await expect.poll(() => logText(dataDir), { timeout: 15_000 }).toContain(`history of ${id} discarded`)
    expect(await state<boolean>(page, `return s.canUndo || s.canRedo`)).toBe(false)
    await expect(undoButton(page)).toBeDisabled()
    expect(existsSync(historyFile(dataDir, id))).toBe(false)
    expect((await look(page)).theme).toBe('vintage')

    // ---------------------------------------------------------------- the clean-up removes it
    await state(page, `s.setTheme('classic')`)
    await waitStored(dataDir, id, { undo: 1, redo: 0 })
    await menu(page, /Nach dem Projekt aufräumen|Clean up after the project/)
    const dlg = page.getByTestId('cleanup-dialog')
    const history = dlg.locator('[data-category="history"]')
    await expect(history).toBeVisible({ timeout: 30_000 })
    await expect(history).toContainText(/Rückgängig-Verlauf|Undo history/)
    await expect(history.getByTestId('cleanup-size-history')).toHaveText(/\d/)
    // only the history
    for (const c of ['faces', 'uploads', 'caches', 'backups', 'exports']) {
      const box = dlg.locator(`[data-category="${c}"] > label input`)
      if ((await box.isEnabled()) && (await box.isChecked())) await box.uncheck()
    }
    const box = dlg.locator('[data-category="history"] > label input')
    await expect(box).toBeEnabled()
    if (!(await box.isChecked())) await box.check()
    await page.getByTestId('cleanup-run').click()
    await expect(page.getByTestId('cleanup-confirm')).toContainText(/Rückgängig-Verlauf|Undo history/)
    await page.getByTestId('cleanup-confirm-run').click()
    const summary = page.getByTestId('cleanup-summary')
    await expect(summary).toBeVisible({ timeout: 60_000 })
    await expect(summary.locator('[data-category="history"]')).toBeVisible()
    await dlg.locator('.actions .btn.primary').click()
    expect(existsSync(historyFile(dataDir, id))).toBe(false)
    expect(await state<boolean>(page, `return s.canUndo || s.canRedo`)).toBe(false)
    // nothing brings it back: the next edits start a new history
    await page.waitForTimeout(1500)
    expect(existsSync(historyFile(dataDir, id))).toBe(false)
    await state(page, `s.setTheme('origami')`)
    await waitStored(dataDir, id, { undo: 1, redo: 0 })
    expect(s.errors).toEqual([])

    // ---------------------------------------------------------------- an edit right before ✕
    // the window closes at once after an edit: the edit and its undo step are saved all the same
    await state(page, `s.setTheme('vintage')`)
    const app = s.app
    const exited = new Promise<void>((r) => app.process().once('exit', () => r()))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())?.close())
    await exited
    s = null
    expect(readProject(dataDir, id).settings.theme).toBe('vintage')
    expect(storedSteps(dataDir, id)).toEqual({ undo: 2, redo: 0 })
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
