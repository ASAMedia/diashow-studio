// Automatic backups end to end, with the real timing rules: a session backs up the version a previous
// session left once it is older than the backup interval (10 minutes), so the test ages the saved file
// between sessions instead of waiting. The dialog lists the versions; restoring one brings its entries
// back, and restoring the newest backup (the state before) undoes that.
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureTestMedia, launch, mediaDir, menu, project, projectFile, removeDir, sampleFiles, waitProcessed, waitSaved, type Session } from './harness'
import { SOFTWARE_GL } from './launch'

const NAME = 'Sicherungen'

/** The saved file looks as if it was last saved `minutes` ago (what an earlier session left). */
function age(file: string, minutes: number): void {
  const t = new Date(Date.now() - minutes * 60_000)
  utimesSync(file, t, t)
}

const backupsOnDisk = (dataDir: string, id: string): string[] => {
  const dir = join(dataDir, 'Diashow Studio', '.backups', id)
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.dshow')) : []
}

const entryIds = async (page: Page): Promise<string[]> => (await project(page)).entries.map((e: any) => e.id)

/** Opens the project from the home screen. */
async function openFromHome(page: Page, id: string): Promise<void> {
  await page.locator('.home .project').filter({ hasText: NAME }).click()
  await expect.poll(async () => (await project(page))?.id, { timeout: 30_000 }).toBe(id)
  await waitProcessed(page)
}

/** Deletes the slide of an entry in the filmstrip: click it, press Delete. */
async function deleteSlide(page: Page, entryId: string): Promise<void> {
  const index = await page.evaluate((id) => (window as any).__diashow.player.current.tl.slides.findIndex((s: any) => s.entries.some((e: any) => e.id === id)), entryId)
  expect(index).toBeGreaterThanOrEqual(0)
  await page.locator('.cards .card:not(.add)').nth(index).click()
  await expect.poll(() => page.evaluate(() => (window as any).__diashow.store.getState().selection)).toContain(entryId)
  await page.keyboard.press('Delete')
  await expect.poll(() => entryIds(page)).not.toContain(entryId)
}

/** Opens "Restore an older version…" and returns its rows (newest first). */
async function backupRows(page: Page) {
  await menu(page, /Ältere Version wiederherstellen|Restore an older version/)
  await expect(page.locator('.dialog h2').filter({ hasText: /Ältere Versionen|Older versions/ })).toBeVisible()
  return page.locator('.dialog .backup')
}

test('backups: versions over time are listed, restoring one brings it back, restoring the newest undoes that', async () => {
  test.setTimeout((SOFTWARE_GL ? 10 : 5) * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-backups-'))
  let s: Session | null = null
  try {
    // ---- session 1: a new project; quick saves of a new project make no backups
    s = await launch(dataDir)
    const id = await s.page.evaluate(async ({ paths, name }) => {
      const d = (window as any).__diashow
      await d.store.getState().createProject(paths, name)
      return d.store.getState().project.id as string
    }, { paths: sampleFiles().map((f) => join(mediaDir, ...f.split('/'))), name: NAME })
    await waitProcessed(s.page)
    const v1 = await entryIds(s.page)
    expect(v1).toHaveLength(4)
    await waitSaved(dataDir, id, (p) => p.entries.length === 4 && p.media.every((m: any) => m.status === 'ready'))
    expect(backupsOnDisk(dataDir, id)).toEqual([])
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null
    age(projectFile(dataDir, id), 60)

    // ---- session 2: the first save backs up what session 1 left; then a slide is deleted
    s = await launch(dataDir)
    await openFromHome(s.page, id)
    await deleteSlide(s.page, v1[0])
    const v2 = v1.slice(1)
    await waitSaved(dataDir, id, (p) => p.entries.length === 3)
    expect(backupsOnDisk(dataDir, id)).toHaveLength(1)
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null
    age(projectFile(dataDir, id), 30)

    // ---- session 3: another backup (session 2's state), another slide deleted
    s = await launch(dataDir)
    const { page } = s
    await openFromHome(page, id)
    await deleteSlide(page, v2[0])
    const v3 = v2.slice(1)
    await waitSaved(dataDir, id, (p) => p.entries.length === 2)
    expect(backupsOnDisk(dataDir, id)).toHaveLength(2)
    // backups are named by the second they were saved in: keep the restore in another second
    await page.waitForTimeout(1100)

    // the dialog lists both versions, newest first, with their number of items
    let rows = await backupRows(page)
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).locator('.val')).toHaveText(/^3 /)
    await expect(rows.nth(1).locator('.val')).toHaveText(/^4 /)
    // restoring the oldest brings its entries back
    await rows.nth(1).locator('button').click()
    await expect(page.locator('.dialog .backup')).toHaveCount(0)
    await expect.poll(() => entryIds(page)).toEqual(v1)
    await waitProcessed(page)
    await expect(page.locator('.cards .card:not(.add)')).toHaveCount(await page.evaluate(() => (window as any).__diashow.player.current.tl.slides.length))
    await waitSaved(dataDir, id, (p) => p.entries.map((e: any) => e.id).join() === v1.join())
    await page.waitForTimeout(1100)

    // the state before the restore became the newest backup: restoring it undoes the restore
    rows = await backupRows(page)
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0).locator('.val')).toHaveText(/^2 /)
    await rows.nth(0).locator('button').click()
    await expect.poll(() => entryIds(page)).toEqual(v3)
    await waitSaved(dataDir, id, (p) => p.entries.map((e: any) => e.id).join() === v3.join())
    // and the restored version was kept too
    rows = await backupRows(page)
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(0).locator('.val')).toHaveText(/^4 /)
    await page.locator('.dialog .actions .btn.primary').click()
    await expect(page.locator('.dialog')).toHaveCount(0)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
