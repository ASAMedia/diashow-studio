// Moved originals end to end: a project imported from a folder that is renamed later shows the
// missing-files banner; "Search a folder…" with the new folder (the native folder dialog answers from
// the test) finds every file again, the items are ready again and the entries point to the new ids. A
// photo turned with Ctrl+R stays turned: its edit belongs to the project, not to the moved file.
import { expect, test } from '@playwright/test'
import { mkdtempSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { answerOpenDialog, copyMedia, ensureTestMedia, launch, project, removeDir, sampleFiles, waitProcessed, waitSaved, type Session } from './harness'
import { SOFTWARE_GL } from './launch'

const NAME = 'Umzug'

test('relink: a renamed media folder is found again with "Search a folder…"', async () => {
  test.setTimeout((SOFTWARE_GL ? 10 : 5) * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-relink-'))
  const before = join(dataDir, 'Urlaub 2025')
  const after = join(dataDir, 'Urlaub 2025 (Archiv)')
  let s: Session | null = null
  try {
    // ---- imported from a folder, saved
    copyMedia(sampleFiles({ video: true, live: true }), before)
    s = await launch(dataDir)
    const id = await s.page.evaluate(async ({ folder, name }) => {
      const d = (window as any).__diashow
      await d.store.getState().createProject([folder], name)
      return d.store.getState().project.id as string
    }, { folder: before, name: NAME })
    await waitProcessed(s.page)
    const old = await project(s.page)
    expect(old.media.every((m: any) => m.status === 'ready')).toBe(true)
    expect(old.media.length).toBeGreaterThanOrEqual(5)
    const live = old.media.find((m: any) => m.live)
    // a photo turned left with Ctrl+R
    const turned = old.media.find((m: any) => m.kind === 'photo' && !m.live)
    const left = { rotate: 270, straighten: 0 }
    await s.page.evaluate((mediaId) => {
      const st = (window as any).__diashow.store.getState()
      st.select(st.project.entries.filter((e: any) => e.mediaId === mediaId).map((e: any) => e.id))
    }, turned.id)
    await s.page.locator('.cards .card').first().focus()
    await s.page.keyboard.press('Control+r')
    const page0 = s.page
    await expect.poll(async () => (await project(page0)).media.find((m: any) => m.id === turned.id)?.edit).toEqual(left)
    await waitSaved(dataDir, id, (p) => p.media.length === old.media.length && p.media.every((m: any) => m.status === 'ready') && p.media.some((m: any) => m.edit?.rotate === 270))
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null

    // ---- the folder gets another name; the project shows what is missing
    renameSync(before, after)
    s = await launch(dataDir)
    const { app, page } = s
    await page.locator('.home .project').filter({ hasText: NAME }).click()
    const banner = page.locator('.banner').filter({ hasText: /nicht gefunden|not found/ })
    await expect(banner).toBeVisible({ timeout: 30_000 })
    await expect(banner).toContainText(String(old.media.length))
    const missing = await project(page)
    expect(missing.media.every((m: any) => m.status === 'error' && m.error === 'missing')).toBe(true)

    // ---- "Search a folder…": the folder dialog answers with the renamed folder
    await answerOpenDialog(app, [after])
    await banner.locator('button').filter({ hasText: /Ordner durchsuchen|Search a folder/ }).click()
    await expect(page.locator('.banner')).toHaveCount(0, { timeout: 60_000 })
    await waitProcessed(page)
    const now = await project(page)
    expect(now.media).toHaveLength(old.media.length)
    expect(now.media.filter((m: any) => m.status !== 'ready').map((m: any) => `${m.name}: ${m.status} ${m.error ?? ''}`)).toEqual([])
    // every original is the one in the renamed folder, under a new id
    for (const m of now.media) expect(m.path.startsWith(after + sep)).toBe(true)
    const oldIds = new Set(old.media.map((m: any) => m.id))
    expect(now.media.filter((m: any) => oldIds.has(m.id))).toEqual([])
    expect(now.media.map((m: any) => m.name).sort()).toEqual(old.media.map((m: any) => m.name).sort())
    // the same entries in the same order, pointing to the new ids
    expect(now.entries.map((e: any) => e.id)).toEqual(old.entries.map((e: any) => e.id))
    const byId = new Map(now.media.map((m: any) => [m.id, m]))
    const oldById = new Map(old.media.map((m: any) => [m.id, m]))
    now.entries.forEach((e: any, i: number) => {
      if (e.type === 'text') return
      expect(byId.has(e.mediaId)).toBe(true)
      expect((byId.get(e.mediaId) as any).name).toBe((oldById.get(old.entries[i].mediaId) as any).name)
    })
    // the turned photo is still turned (and only that one)
    expect(now.media.filter((m: any) => m.edit).map((m: any) => [m.name, m.edit])).toEqual([[turned.name, left]])
    // a Live Photo keeps its motion part, from the new folder too
    if (live) {
      const relinked = now.media.find((m: any) => m.name === live.name)
      expect(relinked.live?.source.startsWith(after + sep)).toBe(true)
    }
    // the show plays from the new files
    expect(await page.evaluate(() => (window as any).__diashow.player.current.tl.slides.length)).toBeGreaterThanOrEqual(old.media.length - 1)
    await waitSaved(dataDir, id, (p) => p.media.every((m: any) => m.status === 'ready' && m.path.startsWith(after + sep)) && p.media.find((m: any) => m.name === turned.name)?.edit?.rotate === 270)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
