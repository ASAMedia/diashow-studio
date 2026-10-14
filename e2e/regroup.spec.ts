// "Group automatically": slides fixed by hand (split here) are counted on a chip in the filmstrip
// bar; "Group automatically" in a slide's menu regroups the selected slides among themselves and
// leaves the others alone; the chip brings back the theme's own grouping for the whole show; undo
// takes each back; sorting by date groups again; the menu item is not offered for slides that aren't
// fixed. Selectors work in German and English.
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { launch, removeDir, waitProcessed, type Session } from './harness'

const groups = (page: Page): Promise<string[][]> =>
  page.evaluate(() => (window as any).__diashow.player.current.tl.slides.filter((s: any) => s.kind !== 'title').map((s: any) => s.entries.map((e: any) => e.id)))
const store = (page: Page, fn: string, ...args: unknown[]): Promise<void> =>
  page.evaluate(([f, a]) => (window as any).__diashow.store.getState()[f as string](...(a as unknown[])), [fn, args] as const)

/** Twelve different landscape photos, a minute apart. */
async function photos(dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true })
  const out: string[] = []
  for (let i = 0; i < 12; i++) {
    const file = join(dir, `Foto ${String(i + 1).padStart(2, '0')}.jpg`)
    await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: (i * 53) % 256, g: (i * 97) % 256, b: (i * 151) % 256 } } })
      .composite([{ input: Buffer.from(`<svg width="1600" height="1200"><text x="200" y="700" font-size="400" fill="white">${i + 1}</text></svg>`) }])
      .jpeg({ quality: 80 })
      .withExif({ IFD0: { DateTime: `2026:05:12 10:${String(i).padStart(2, '0')}:00` } })
      .toFile(file)
    out.push(file)
  }
  return out
}

test('group automatically: per slide from its menu, all from the filmstrip bar, undo', async () => {
  test.setTimeout(4 * 60 * 1000)
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-regroup-'))
  const locale = process.env.DIASHOW_LOCALE ?? 'de-DE'
  let s: Session | null = null
  try {
    s = await launch(dataDir, { DIASHOW_LOCALE: locale })
    const { page } = s
    const files = await photos(join(dataDir, 'media'))
    await page.evaluate(async (paths) => {
      await (window as any).__diashow.store.getState().createProject(paths, 'Gruppen')
    }, files)
    await waitProcessed(page)
    await store(page, 'setTheme', 'magazine')
        const auto = await groups(page)
    expect(auto.flat()).toHaveLength(12)
    expect(auto.length).toBeLessThan(12)
    const chip = page.locator('.strip-bar .fixed-chip')
    await expect(chip).toHaveCount(0)

    // a slide that isn't fixed: no "Group automatically" in its menu
    await page.locator('.cards .card[data-index="1"]').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: /^(Textfolie hinzufügen|Add text slide)$/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /^(Automatisch gruppieren|Group automatically)$/ })).toHaveCount(0)
    await page.keyboard.press('Escape')

    // every photo on a slide of its own, fixed by hand: the filmstrip bar counts them
    const all = auto.flat()
    await store(page, 'splitSlide', all)
    await expect.poll(async () => (await groups(page)).length).toBe(12)
    await expect(chip).toHaveText(/^12 (feste Folien · Automatisch gruppieren|fixed slides · Group automatically)$/)
    await page.screenshot({ path: join(__dirname, '..', 'test-results', 'regroup', `chip-${locale}.png`) })

    // slides 4 to 9 selected, "Group automatically" from the menu of one of them
    const inner = all.slice(3, 9)
    await store(page, 'select', inner)
    await page.locator('.cards .card[data-index="5"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^(Automatisch gruppieren|Group automatically)$/ }).click()
    await expect.poll(async () => (await groups(page)).length).toBeLessThan(12)
    const g = await groups(page)
    expect(g.slice(0, 3)).toEqual(all.slice(0, 3).map((id) => [id]))
    expect(g.slice(-3)).toEqual(all.slice(-3).map((id) => [id]))
    expect(g.slice(3, -3).flat()).toEqual(inner)

    // undo, then the whole show from the filmstrip bar
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await groups(page)).length).toBe(12)
    await chip.click()
    await expect.poll(() => groups(page)).toEqual(auto)
    await expect(chip).toHaveCount(0)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await groups(page)).length).toBe(12)
    await expect(chip).toBeVisible()

    // sorting by capture date groups again
    await store(page, 'sortByDate')
    await expect.poll(() => groups(page)).toEqual(auto)
    await expect(chip).toHaveCount(0)
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
