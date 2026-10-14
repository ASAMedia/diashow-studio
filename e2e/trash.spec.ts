// The trash for slideshows end to end (src/main/trash.ts, components/Trash.tsx):
// - a show with edits (undo history), an older version and a pupil's upload is deleted on the home
//   screen: it is in the trash with its dates, its files moved there on disk (no .dshow, nothing left
//   in the projects folder, the history in userData's trash), not listed as a show or as damaged;
// - after a restart it is restored: it opens with its slides, its older version, its upload and its
//   undo history (undo works at once);
// - what a move cut off before it began left in the trash (a temp file) is gone after the start;
// - deleted again while another pupil's file takes its upload's place: restored, the upload comes back
//   under another name, the show follows it, and the notice says that its undo history was deleted;
// - deleted again and deleted permanently: everything is gone from disk, the originals stay;
// - a show in the trash whose deletion date has come gets "delete permanently" on the home screen;
//   Settings → Privacy shows the trash's size and empties it after a confirmation;
// - "Papierkorb (n)" counts shows only: an unreadable entry is named as such (Settings, emptying), and
//   a trash that holds nothing else shows "Papierkorb" without a number;
// - a show in the trash is not opened by kiosk mode and only counted in the diagnostics package; with
//   the trash's clock 29 days ahead it stays, 31 days ahead it is deleted for good at the start
//   (DIASHOW_TRASH_CLOCK_DAYS).
// Runs in German and with DIASHOW_LOCALE=en-US DIASHOW_SOFTWARE_GL=1.
import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { copyMedia, ensureTestMedia, isFullScreen, launch, project, projectFile, removeDir, root, sampleFiles, waitProcessed, waitSaved, type Session } from './harness'
import { SOFTWARE_GL } from './launch'

const NAME = 'Wandertag'
const DAY = 86_400_000

const state = <T,>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const d = window.__diashow; const s = d.store.getState(); ${fn} })()`) as Promise<T>

const historyFile = (dataDir: string, id: string): string => join(dataDir, 'userData', 'history', `${id}.json.gz`)

/** Undo steps of the stored history when it belongs to the saved show; else null. */
function storedUndo(dataDir: string, id: string): number | null {
  try {
    const h = JSON.parse(gunzipSync(readFileSync(historyFile(dataDir, id))).toString('utf8'))
    const anchor = createHash('sha256').update(readFileSync(projectFile(dataDir, id), 'utf8'), 'utf8').digest('hex')
    return h.anchor === anchor ? h.undo.length : null
  } catch {
    return null
  }
}

/** Every file below a folder, with sizes. */
function filesBelow(dir: string): { path: string; bytes: number }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const path = join(e.parentPath, e.name)
      return { path, bytes: statSync(path).size }
    })
}

const card = (page: Page, name: string) => page.locator('.home .project').filter({ hasText: name })
const trashButton = (page: Page) => page.getByTestId('trash-open')
const undoButton = (page: Page) => page.locator('.titlebar button[aria-label^="Rückgängig"], .titlebar button[aria-label^="Undo"]')

/** Deletes a show from its card on the home screen: the dialog lists what goes into the trash. */
async function deleteFromHome(page: Page, name: string, parts = ['backups', 'history', 'uploads']): Promise<void> {
  const c = card(page, name)
  await c.hover()
  await c.locator('button.del').click()
  const dialog = page.getByTestId('delete-dialog')
  await expect(dialog).toContainText(/Papierkorb|trash/)
  for (const part of parts) await expect(dialog.locator(`[data-category="${part}"]`)).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('delete-run').click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  await expect(card(page, name)).toHaveCount(0)
}

/** A show without media, saved, back on the home screen; returns its id. */
async function emptyShow(page: Page, dataDir: string, name: string): Promise<string> {
  const id = await page.evaluate(async (n) => {
    const d = (window as any).__diashow
    await d.store.getState().createProject([], n)
    return d.store.getState().project.id as string
  }, name)
  await waitSaved(dataDir, id, (p) => p.name === name)
  await state(page, `s.closeProject()`)
  await expect(page.locator('.home')).toBeVisible()
  return id
}

test('trash: delete, restore with versions, upload and undo history, delete for good, empty, expiry', async () => {
  test.setTimeout((SOFTWARE_GL ? 14 : 7) * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-trash-'))
  const docs = join(dataDir, 'Diashow Studio')
  const trashDocs = join(docs, '.trash')
  const trashData = join(dataDir, 'userData', 'trash')
  let s: Session | null = null
  try {
    // ---------------------------------------------------------------- session 1: a show with history, a version, an upload
    const originals = copyMedia(sampleFiles().slice(0, 3), join(dataDir, 'media'))
    s = await launch(dataDir)
    let page = s.page
    const id = await page.evaluate(async ({ paths, name }) => {
      const d = (window as any).__diashow
      await d.store.getState().createProject(paths, name)
      return d.store.getState().project.id as string
    }, { paths: originals, name: NAME })
    await waitProcessed(page)
    // a photo a pupil sent over the Wi-Fi (where the share dialog puts it)
    const [upload] = copyMedia(['misc/pano.png'], join(docs, 'Uploads', NAME, 'Mia'), true)
    await page.evaluate((file) => (window as any).__diashow.store.getState().importMedia([file]), upload)
    await waitProcessed(page)
    await state(page, `s.setTheme('classic')`)
    await state(page, `s.setTheme('origami')`)
    const slides = await state<number>(page, `return s.project.entries.length`)
    const mediaIds = await state<string[]>(page, `return s.project.media.map((m) => m.id)`)
    expect(mediaIds).toHaveLength(4)
    await waitSaved(dataDir, id, (p) => p.settings.theme === 'origami' && p.media.length === 4 && p.media.every((m: any) => m.status === 'ready'))
    await expect.poll(() => storedUndo(dataDir, id), { timeout: 30_000 }).toBeGreaterThanOrEqual(3)
    // an older version (as an earlier save made it)
    const version = join(docs, '.backups', id, '20260101-120000.dshow')
    mkdirSync(join(docs, '.backups', id), { recursive: true })
    writeFileSync(version, readFileSync(projectFile(dataDir, id)))
    await state(page, `s.closeProject()`)
    await expect(card(page, NAME)).toBeVisible()
    await page.waitForTimeout(1000)
    const savedText = readFileSync(projectFile(dataDir, id), 'utf8')
    const undoSteps = storedUndo(dataDir, id)
    expect(undoSteps).toBeGreaterThanOrEqual(3)

    // ---------------------------------------------------------------- delete: into the trash
    await expect(trashButton(page)).toHaveCount(0)
    await deleteFromHome(page, NAME)
    await expect(trashButton(page)).toHaveText(/Papierkorb \(1\)|Trash \(1\)/)
    // on disk: moved, not copied; nothing a window could open as a show
    expect(existsSync(projectFile(dataDir, id))).toBe(false)
    expect(existsSync(join(docs, '.backups', id))).toBe(false)
    expect(existsSync(upload)).toBe(false)
    expect(existsSync(historyFile(dataDir, id))).toBe(false)
    // the show as it was, only no longer pointing at its deleted cache (made again when it is opened)
    const trashedText = readFileSync(join(trashDocs, id, 'show.json'), 'utf8')
    const saved = JSON.parse(savedText)
    const trashed = JSON.parse(trashedText)
    expect(trashed).toMatchObject({ id, name: NAME, entries: saved.entries, settings: saved.settings })
    expect(trashed.media.map((m: any) => m.path)).toEqual(saved.media.map((m: any) => m.path))
    expect(trashed.media.some((m: any) => m.thumb)).toBe(false)
    expect(readdirSync(join(trashDocs, id)).some((n) => n.endsWith('.dshow'))).toBe(false)
    expect(existsSync(join(trashDocs, id, 'backups', '20260101-120000.dshow'))).toBe(true)
    expect(existsSync(join(trashData, id, 'history.json.gz'))).toBe(true)
    expect(filesBelow(join(trashDocs, id, 'files')).map((f) => f.path)).toEqual([join(trashDocs, id, 'files', 'Uploads', NAME, 'Mia', 'misc', 'pano.png')])
    // its cache went right away (made again after a restore)
    for (const m of mediaIds) expect(existsSync(join(dataDir, 'cache', m)), `cache of ${m}`).toBe(false)
    expect(await page.evaluate(() => (window as any).api.damagedProjects())).toEqual([])
    expect((await page.evaluate(() => (window as any).api.listProjects())).map((p: any) => p.id)).not.toContain(id)

    // the trash lists it with its dates
    await trashButton(page).click()
    let dialog = page.getByTestId('trash-dialog')
    const entry = dialog.locator(`[data-testid="trash-entry"][data-id="${id}"]`)
    await expect(entry).toContainText(NAME)
    await expect(entry).toContainText(/Gelöscht am|Deleted on/)
    await expect(entry).toContainText(/endgültig gelöscht|deleted permanently/)
    const deletedAt = Number(await entry.getAttribute('data-deleted-at'))
    const purgeAt = Number(await entry.getAttribute('data-purge-at'))
    expect(Math.abs(deletedAt - Date.now())).toBeLessThan(10 * 60_000)
    expect(purgeAt - deletedAt).toBe(30 * DAY)
    await expect(entry).toContainText(String(new Date(purgeAt).getFullYear()))
    await page.screenshot({ path: join(root, 'test-results', 'trash', 'dialog.png') })
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null

    // ---------------------------------------------------------------- session 2: restore after a restart
    // a move the power cut off before it began: a folder with nothing but a temp file of its description
    const scratch = join(trashDocs, 'cutoff-1', 'trash.json.4711.1760000000000.tmp')
    mkdirSync(join(trashDocs, 'cutoff-1'), { recursive: true })
    writeFileSync(scratch, '{"format":"diashow-trash","ver')
    s = await launch(dataDir)
    page = s.page
    dialog = page.getByTestId('trash-dialog')
    await expect(trashButton(page)).toHaveText(/\(1\)/, { timeout: 30_000 })
    expect(readdirSync(trashDocs)).toEqual([id])
    await expect(card(page, NAME)).toHaveCount(0)
    await trashButton(page).click()
    await expect(page.getByTestId('trash-problem')).toHaveCount(0)
    await dialog.locator(`[data-testid="trash-entry"][data-id="${id}"]`).getByTestId('trash-restore').click()
    await expect(page.getByTestId('trash-notice')).toContainText(/wiederhergestellt|restored/)
    // it came back with its undo history: nothing to say about it
    await expect(page.getByTestId('trash-notice')).not.toContainText(/Rückgängig-Verlauf|undo history/)
    await expect(page.getByTestId('trash-none')).toBeVisible()
    await dialog.locator('.actions .btn.primary').click()
    await expect(trashButton(page)).toHaveCount(0)
    // back as it was; the undo history still fits it
    expect(readFileSync(projectFile(dataDir, id), 'utf8')).toBe(trashedText)
    expect(existsSync(upload)).toBe(true)
    expect(existsSync(version)).toBe(true)
    expect(storedUndo(dataDir, id)).toBe(undoSteps)
    expect(readdirSync(trashDocs)).toEqual([])
    expect(readdirSync(trashData)).toEqual([])
    // it opens with its slides, versions, upload and undo history
    await card(page, NAME).locator('.open').click()
    await expect.poll(async () => (await project(page))?.id, { timeout: 30_000 }).toBe(id)
    await waitProcessed(page)
    expect(await state<number>(page, `return s.project.entries.length`)).toBe(slides)
    expect(await state<boolean>(page, `return s.project.media.every((m) => m.status === 'ready')`)).toBe(true)
    expect((await page.evaluate((pid) => (window as any).api.listBackups(pid), id)).map((b: any) => b.file)).toContain(version)
    await expect(undoButton(page)).toBeEnabled({ timeout: 15_000 })
    await undoButton(page).click()
    await expect.poll(() => state<string>(page, `return s.project.settings.theme`)).toBe('classic')
    await page.locator('.titlebar button[title="Zurück"], .titlebar button[title="Back"]').click()
    await expect(card(page, NAME)).toBeVisible()
    await page.waitForTimeout(1000)

    // ---------------------------------------------------------------- deleted again; its upload's place is taken meanwhile
    await deleteFromHome(page, NAME)
    expect(storedUndo(dataDir, id)).toBeNull()
    // (the deletion removed the empty upload folders)
    mkdirSync(dirname(upload), { recursive: true })
    writeFileSync(upload, 'another pupil’s photo, sent with the same name')
    await trashButton(page).click()
    await dialog.locator(`[data-testid="trash-entry"][data-id="${id}"]`).getByTestId('trash-restore').click()
    const notice = page.getByTestId('trash-notice')
    await expect(notice).toContainText(/wiederhergestellt|restored/)
    await expect(notice).toContainText(/1 hochgeladene Datei|1 uploaded file/)
    // its undo history no longer fits the show that follows the new name: the notice says it is gone
    await expect(notice).toContainText(/Der Rückgängig-Verlauf passte nicht mehr zur Diashow und ist gelöscht|The undo history no longer fitted the slideshow and was deleted/)
    await expect(page.getByTestId('trash-none')).toBeVisible()
    await dialog.locator('.actions .btn.primary').click()
    const renamedUpload = join(dirname(upload), 'pano (2).png')
    expect(readFileSync(upload, 'utf8')).toBe('another pupil’s photo, sent with the same name')
    const followed = JSON.parse(readFileSync(projectFile(dataDir, id), 'utf8'))
    expect(followed.media.map((m: any) => m.path)).toContain(renamedUpload)
    expect(followed.media.map((m: any) => m.path)).not.toContain(upload)
    expect(existsSync(historyFile(dataDir, id))).toBe(false)
    expect(readdirSync(trashDocs)).toEqual([])
    expect(readdirSync(trashData)).toEqual([])
    await expect(card(page, NAME)).toBeVisible()

    // ---------------------------------------------------------------- deleted again (no undo history now), and permanently
    await deleteFromHome(page, NAME, ['backups', 'uploads'])
    await trashButton(page).click()
    await dialog.locator(`[data-testid="trash-entry"][data-id="${id}"]`).getByTestId('trash-purge').click()
    const confirm = page.getByTestId('trash-confirm')
    await expect(confirm).toContainText(NAME)
    await expect(confirm).toContainText(/nicht rückgängig|cannot be undone/)
    await page.getByTestId('trash-confirm-run').click()
    await expect(page.getByTestId('trash-none')).toBeVisible({ timeout: 30_000 })
    await dialog.locator('.actions .btn.primary').click()
    await expect(trashButton(page)).toHaveCount(0)
    for (const gone of [projectFile(dataDir, id), join(docs, '.backups', id), upload, historyFile(dataDir, id), join(trashDocs, id), join(trashData, id)]) expect(existsSync(gone), gone).toBe(false)
    expect(filesBelow(join(docs, 'Uploads'))).toEqual([])
    // the teacher's own photos stay
    for (const f of originals) expect(existsSync(f), f).toBe(true)

    // ---------------------------------------------------------------- the deletion reminder, Settings → Privacy
    const due = await emptyShow(page, dataDir, 'Elternabend')
    const other = await emptyShow(page, dataDir, 'Sportfest')
    await page.evaluate(({ pid, at }) => (window as any).api.setDeleteAt(pid, at), { pid: due, at: Date.now() - DAY })
    for (const pid of [due, other]) expect(await page.evaluate((x) => (window as any).api.deleteProject(x), pid)).toHaveProperty('entry')
    // and something the app can't read (another program, a damaged disk): no show, so not counted as one
    const unreadable = join(trashDocs, 'kaputt', 'trash.json')
    mkdirSync(dirname(unreadable), { recursive: true })
    writeFileSync(unreadable, '{"format":"diashow-trash", kaputt')
    await state(page, `s.loadProjects()`)
    await expect(trashButton(page)).toHaveText(/Papierkorb \(2\)|Trash \(2\)/)
    const banner = page.getByTestId('trash-due-banner')
    await expect(banner).toContainText('Elternabend')
    await expect(banner).not.toContainText('Sportfest')
    await page.getByTestId('trash-due-purge').click()
    await expect(dialog.getByTestId('trash-problem')).toHaveCount(1)
    await expect(confirm).toContainText('Elternabend')
    await expect(confirm).not.toContainText('Sportfest')
    await page.getByTestId('trash-confirm-run').click()
    await expect(dialog.locator('[data-testid="trash-entry"]')).toHaveCount(1)
    await expect(dialog.locator(`[data-testid="trash-entry"][data-id="${other}"]`)).toBeVisible()
    await dialog.locator('.actions .btn.primary').click()
    await expect(trashButton(page)).toHaveText(/Papierkorb \(1\)|Trash \(1\)/)
    await expect(banner).toHaveCount(0)

    await state(page, `s.set({ dialog: 'settings' })`)
    const size = page.getByTestId('trash-setting-size')
    await expect(size).toContainText(/Papierkorb: 1 Diashow und 1 unlesbarer Eintrag, |Trash: 1 slideshow and 1 unreadable entry, /)
    const onDisk = [...filesBelow(trashDocs), ...filesBelow(trashData)].reduce((n, f) => n + f.bytes, 0)
    expect(onDisk).toBeGreaterThan(0)
    expect(Number(await size.getAttribute('data-bytes'))).toBe(onDisk)
    await page.getByTestId('trash-setting-empty').click()
    await expect(confirm).toContainText(/Alles im Papierkorb: 1 Diashow und 1 unlesbarer Eintrag, |Everything in the trash: 1 slideshow and 1 unreadable entry, /)
    await expect(confirm).toContainText(/nicht rückgängig|cannot be undone/)
    await page.getByTestId('trash-confirm-run').click()
    await expect(page.getByTestId('trash-none')).toBeVisible({ timeout: 30_000 })
    await dialog.locator('.actions .btn.primary').click()
    await expect(size).toContainText(/Papierkorb ist leer|trash is empty/)
    expect(readdirSync(trashDocs)).toEqual([])
    expect(readdirSync(trashData)).toEqual([])
    await page.keyboard.press('Escape')
    await expect(page.locator('.dialog')).toHaveCount(0)

    // only something unreadable in the trash: "Papierkorb" without a number, and it can be deleted
    mkdirSync(dirname(unreadable), { recursive: true })
    writeFileSync(unreadable, '{"format":"diashow-trash", kaputt')
    await state(page, `s.loadProjects()`)
    await expect(trashButton(page)).toHaveText(/^\s*(Papierkorb|Trash)\s*$/)
    await expect(trashButton(page)).toHaveAttribute('data-shows', '0')
    await state(page, `s.set({ dialog: 'settings' })`)
    await expect(size).toContainText(/Papierkorb: 1 unlesbarer Eintrag, |Trash: 1 unreadable entry, /)
    await page.keyboard.press('Escape')
    await expect(page.locator('.dialog')).toHaveCount(0)
    await trashButton(page).click()
    await expect(dialog.locator('[data-testid="trash-entry"]')).toHaveCount(0)
    await dialog.getByTestId('trash-problem').locator('button').click()
    await expect(confirm).toContainText(/Unlesbarer Eintrag|Unreadable entry/)
    await page.getByTestId('trash-confirm-run').click()
    await expect(page.getByTestId('trash-none')).toBeVisible({ timeout: 30_000 })
    await dialog.locator('.actions .btn.primary').click()
    await expect(trashButton(page)).toHaveCount(0)
    expect(readdirSync(trashDocs)).toEqual([])

    // ---------------------------------------------------------------- kiosk, diagnostics, expiry after 30 days
    const kiosk = await emptyShow(page, dataDir, 'Tag der offenen Tür')
    await page.evaluate((pid) => (window as any).api.setAppSettings({ kioskProjectId: pid }), kiosk)
    expect(await page.evaluate((x) => (window as any).api.deleteProject(x), kiosk)).toHaveProperty('entry')
    const preview = await page.evaluate(() => (window as any).api.diagnosticsPreview({}))
    const summary = preview.files.find((f: any) => f.name === 'project-summary.json').preview as string
    expect(JSON.parse(summary).trash).toEqual({ shows: 1, damaged: 0 })
    const notLogs = preview.files.filter((f: any) => f.about !== 'log').map((f: any) => f.preview).join('\n')
    expect(notLogs).not.toContain('offenen Tür')
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null

    // 29 days later: still in the trash; kiosk mode doesn't open it
    s = await launch(dataDir, { DIASHOW_TRASH_CLOCK_DAYS: '29' })
    page = s.page
    await expect(page.locator('.home')).toBeVisible({ timeout: 30_000 })
    await expect(trashButton(page)).toHaveText(/\(1\)/, { timeout: 30_000 })
    await page.waitForTimeout(1500)
    await expect(page.locator('.fullscreen')).toHaveCount(0)
    expect(await isFullScreen(s.app)).toBe(false)
    expect(await state<unknown>(page, `return s.project`)).toBeNull()
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null

    // 31 days later: deleted for good when the app starts
    s = await launch(dataDir, { DIASHOW_TRASH_CLOCK_DAYS: '31' })
    page = s.page
    await expect(page.locator('.home')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => readdirSync(trashDocs).length, { timeout: 30_000 }).toBe(0)
    expect(readdirSync(trashData)).toEqual([])
    await page.waitForTimeout(1000)
    await expect(trashButton(page)).toHaveCount(0)
    expect(readFileSync(join(dataDir, 'userData', 'logs', 'diashow.log'), 'utf8')).toContain(`trash entry ${kiosk} deleted for good`)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
