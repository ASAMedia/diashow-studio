// Keyboard use and the light theme, end to end: a dialog opened with the keyboard keeps the focus
// inside (Tab wraps), Esc closes it and the focus goes back to its opener; the "⋯" menu works with the
// arrow keys; the filmstrip is one Tab stop whose arrow keys select slides; typing in a field doesn't
// trigger the shortcuts; Settings → Appearance switches the theme.
import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyMedia, ensureTestMedia, launch, removeDir, sampleFiles, waitProcessed, type Session } from './harness'

const active = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return el ? `${el.tagName.toLowerCase()}|${el.className}|${el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent?.trim().slice(0, 30) ?? ''}` : ''
  })
const inDialog = (page: Page): Promise<boolean> => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))

test('keyboard: dialogs, menu, filmstrip, fields; light theme', async () => {
  test.setTimeout(5 * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-keys-'))
  let s: Session | null = null
  try {
    s = await launch(dataDir, { DIASHOW_LOCALE: 'de-DE' })
    const { page } = s

    // ---- home: the settings gear by keyboard, a dialog that keeps the focus
    const gear = page.locator('.titlebar button[aria-label="Einstellungen"]')
    await gear.focus()
    await page.keyboard.press('Enter')
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(dialog).toHaveAccessibleName('Einstellungen')
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab')
      expect(await inDialog(page)).toBe(true)
    }
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+Tab')
    expect(await inDialog(page)).toBe(true)
    // the light theme, chosen with the keyboard
    await dialog.getByRole('button', { name: 'Hell' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(241, 241, 244)')
    // the preview stage stays dark (checked below in the editor)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await active(page)).toContain('Einstellungen')

    // ---- a show to work on
    const files = copyMedia(sampleFiles(), join(dataDir, 'media'))
    await page.evaluate(async (paths) => {
      await (window as any).__diashow.store.getState().createProject(paths, 'Tastatur')
    }, files)
    await waitProcessed(page)
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.stage')!).backgroundColor)).toBe('rgb(22, 22, 24)')

    // ---- the "⋯" menu: arrow keys, Esc gives the focus back
    const more = page.locator('.titlebar button[aria-label="Weitere Aktionen"]')
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('[role="menu"]')).toBeVisible()
    expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('menuitem')
    const first = await active(page)
    await page.keyboard.press('ArrowDown')
    expect(await active(page)).not.toBe(first)
    await page.keyboard.press('End')
    expect(await active(page)).toContain('Handbuch')
    await page.keyboard.press('Escape')
    await expect(page.locator('[role="menu"]')).toHaveCount(0)
    expect(await active(page)).toContain('Weitere Aktionen')

    // ---- the filmstrip: one Tab stop, arrows select the next slide, Shift+F10 opens its menu
    const slides = await page.evaluate(() => (window as any).__diashow.player.current.tl.slides.length as number)
    expect(slides).toBeGreaterThan(2)
    const tabbable = await page.locator('.cards .card[tabindex="0"]').count()
    expect(tabbable).toBe(1)
    await page.locator('.cards .card[tabindex="0"]').focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    expect(await active(page)).toContain('card')
    const selected = (): Promise<string[]> => page.evaluate(() => (window as any).__diashow.store.getState().selection)
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await selected()).length).toBeGreaterThan(0)
    const one = await selected()
    await page.keyboard.press('ArrowRight')
    await expect.poll(selected).not.toEqual(one)
    expect(await active(page)).toContain('card')
    await page.keyboard.press('Shift+F10')
    await expect(page.locator('[role="menu"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[role="menu"]')).toHaveCount(0)
    expect(await active(page)).toContain('card')

    // ---- typing in a field: Space types, it doesn't play the show
    await page.locator('.rail [role="tab"]').first().click()
    const title = page.locator('.inspector input[aria-label="Titeltext"]')
    await title.click()
    await page.keyboard.type('Ein Tag')
    expect(await page.evaluate(() => (window as any).__diashow.player.current.playing)).toBe(false)
    await expect(title).toHaveValue('Ein Tag')
    // the rail is a tab list: arrows change the tab
    await page.locator('.rail [role="tab"][aria-selected="true"]').focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('.rail [role="tab"][aria-selected="true"]')).toHaveAttribute('aria-label', 'Musik')
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
