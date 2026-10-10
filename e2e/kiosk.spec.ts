// Kiosk mode end to end: a show chosen in Settings opens fullscreen on the next start and plays in a
// loop; Esc ends it into the editor without forgetting the setting; "Off" starts normally again.
import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyMedia, ensureTestMedia, isFullScreen, launch, removeDir, sampleFiles, waitProcessed, waitSaved, type Session } from './harness'
import { SOFTWARE_GL } from './launch'

/** Seconds shown by the fullscreen player's clock ("0:04 / 0:08"). */
async function clock(page: Page): Promise<{ t: number; total: number } | null> {
  const text = (await page.locator('.fullscreen .fs-controls .time').textContent().catch(() => null)) ?? ''
  const m = /(\d+):(\d\d)\s*\/\s*(\d+):(\d\d)/.exec(text)
  return m ? { t: Number(m[1]) * 60 + Number(m[2]), total: Number(m[3]) * 60 + Number(m[4]) } : null
}

async function openSettings(page: Page): Promise<void> {
  // the home screen has its own button; the editor has it in the "⋯" menu
  if (await page.locator('.home').count()) await page.locator('.titlebar button[title="Einstellungen"], .titlebar button[title="Settings"]').click()
  else {
    await page.locator('.titlebar button[title="Weitere Aktionen"], .titlebar button[title="More actions"]').click()
    await page.locator('.menu button').filter({ hasText: /Einstellungen|Settings/ }).click()
  }
  await expect(page.locator('.dialog h2').filter({ hasText: /Einstellungen|Settings/ })).toBeVisible()
}

/** The "Play on start" select of the kiosk section. */
const kioskSelect = (page: Page) => page.locator('.dialog .section').filter({ hasText: /Kioskmodus|Kiosk mode/ }).locator('select')

test('kiosk mode: starts fullscreen in a loop, Esc ends it, Off starts normally', async () => {
  test.setTimeout((SOFTWARE_GL ? 10 : 5) * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-kiosk-'))
  let s: Session | null = null
  try {
    // ---- a short show, chosen as the kiosk show in Settings
    const files = copyMedia(sampleFiles(), join(dataDir, 'media'))
    s = await launch(dataDir)
    const id = await s.page.evaluate(async (paths) => {
      const d = (window as any).__diashow
      await d.store.getState().createProject(paths, 'Kiosk Show')
      return d.store.getState().project.id as string
    }, files)
    await waitProcessed(s.page)
    await s.page.evaluate(() => {
      const st = (window as any).__diashow.store.getState()
      st.setTheme('classic')
      st.setSettings({ timing: { mode: 'custom', customTotal: 8 }, loop: false })
    })
    const duration = await s.page.evaluate(() => (window as any).__diashow.player.current.tl.duration as number)
    await waitSaved(dataDir, id, (p) => p.settings.timing.customTotal === 8 && p.media.every((m: any) => m.status === 'ready'))
    // back to the home screen (saves), then Settings
    await s.page.locator('.titlebar button[title="Zurück"], .titlebar button[title="Back"]').first().click()
    await expect(s.page.locator('.home')).toBeVisible()
    await openSettings(s.page)
    await expect(kioskSelect(s.page).locator('option')).toHaveCount(2)
    await kioskSelect(s.page).selectOption({ label: 'Kiosk Show' })
    await expect.poll(() => s!.page.evaluate(() => (window as any).api.getAppSettings().then((x: any) => x.kioskProjectId))).toBe(id)
    await s.page.locator('.dialog .actions .btn.primary').click()
    await s.app.close()
    s = null

    // ---- next start: straight into the show, fullscreen, looping
    s = await launch(dataDir)
    await expect(s.page.locator('.fullscreen')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => isFullScreen(s!.app), { timeout: 20_000 }).toBe(true)
    expect(await s.page.evaluate(() => (window as any).__diashow.store.getState().kiosk)).toBe(true)
    expect(await s.page.evaluate(() => (window as any).__diashow.store.getState().project?.id)).toBe(id)
    // the clock runs to the end and starts over (the project itself does not loop)
    const seen: number[] = []
    let nearEnd = false
    let looped = false
    const until = Date.now() + (duration * 3 + 30) * 1000
    while (!looped && Date.now() < until) {
      const c = await clock(s.page)
      if (c) {
        seen.push(c.t)
        if (c.t >= Math.floor(duration) - 1) nearEnd = true
        else if (nearEnd && c.t <= 2) looped = true
      }
      await s.page.waitForTimeout(200)
    }
    console.log(`kiosk clock samples (show ${duration.toFixed(1)} s):`, seen.join(' '))
    expect(looped).toBe(true)
    await expect(s.page.locator('.fullscreen')).toBeVisible()

    // ---- Esc ends the kiosk show: the editor with the project, no longer fullscreen
    await s.page.keyboard.press('Escape')
    await expect(s.page.locator('.fullscreen')).toHaveCount(0)
    await expect.poll(() => isFullScreen(s!.app), { timeout: 20_000 }).toBe(false)
    expect(await s.page.evaluate(() => {
      const st = (window as any).__diashow.store.getState()
      return { view: st.view, kiosk: st.kiosk, id: st.project?.id }
    })).toEqual({ view: 'editor', kiosk: false, id })
    // the setting stays: Esc is not a way to switch kiosk mode off by accident
    expect(await s.page.evaluate(() => (window as any).api.getAppSettings().then((x: any) => x.kioskProjectId))).toBe(id)
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null

    // ---- so the next start is a kiosk show again; switched off in Settings it starts normally
    s = await launch(dataDir)
    await expect(s.page.locator('.fullscreen')).toBeVisible({ timeout: 60_000 })
    await s.page.keyboard.press('Escape')
    await expect(s.page.locator('.fullscreen')).toHaveCount(0)
    await openSettings(s.page)
    await expect(kioskSelect(s.page)).toHaveValue(id)
    await kioskSelect(s.page).selectOption('')
    await expect.poll(() => s!.page.evaluate(() => (window as any).api.getAppSettings().then((x: any) => x.kioskProjectId ?? null))).toBeNull()
    await s.page.locator('.dialog .actions .btn.primary').click()
    await s.app.close()
    s = null

    s = await launch(dataDir)
    await expect(s.page.locator('.home')).toBeVisible({ timeout: 30_000 })
    await s.page.waitForTimeout(1500)
    await expect(s.page.locator('.fullscreen')).toHaveCount(0)
    expect(await isFullScreen(s.app)).toBe(false)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
