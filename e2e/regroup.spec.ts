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

type Shown = { index: number; ids: string[]; start: number; duration: number; transIn: number }
const shownSlides = (page: Page): Promise<Shown[]> =>
  page.evaluate(() =>
    (window as any).__diashow.player.current.tl.slides
      .filter((s: any) => s.kind !== 'title')
      .map((s: any) => ({ index: s.index, ids: s.entries.map((e: any) => e.id), start: s.start, duration: s.duration, transIn: s.transIn }))
  )
const selection = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__diashow.store.getState().selection)
const playhead = (page: Page): Promise<number> => page.evaluate(() => (window as any).__diashow.player.current.t)
/** The slide on screen: the last one whose time has begun (the later one during a transition). */
const onScreen = (slides: Shown[], t: number): Shown => slides.filter((s) => s.start <= t + 1e-3 && t < s.start + s.duration).pop()!

test('a click on the slide in the preview selects that slide, also after playing and pausing elsewhere', async () => {
  test.setTimeout(4 * 60 * 1000)
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-preview-click-'))
  let s: Session | null = null
  try {
    s = await launch(dataDir, { DIASHOW_LOCALE: process.env.DIASHOW_LOCALE ?? 'de-DE' })
    const { page } = s
    const files = await photos(join(dataDir, 'media'))
    await page.evaluate(async (paths) => {
      await (window as any).__diashow.store.getState().createProject(paths, 'Vorschau')
    }, files)
    await waitProcessed(page)
    await store(page, 'setTheme', 'magazine')
    await expect.poll(async () => (await shownSlides(page)).length).toBeGreaterThan(3)
    const slides = await shownSlides(page)
    const first = slides[0]
    const later = slides[3]

    // the first slide is selected; the show plays and stops on a later one
    await store(page, 'select', first.ids)
    await page.evaluate(() => (window as any).__diashow.player.current.play())
    await expect.poll(() => playhead(page), { timeout: 60_000 }).toBeGreaterThan(later.start + later.transIn + 0.3)
    await page.evaluate(() => (window as any).__diashow.player.current.pause())
    const t0 = await playhead(page)
    const shown = onScreen(slides, t0)
    expect(shown.index).not.toBe(first.index)
    expect(await selection(page)).toEqual(first.ids)

    // the crop cells belong to the slide on screen, not to the selected one
    const cells = page.locator('.frame .crop-cell')
    await expect(cells).toHaveCount(shown.ids.length)
    const box = (await cells.first().boundingBox())!
    // a click on a picture of it selects that slide (as a click on its card does), where it is
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect.poll(() => selection(page)).toEqual(shown.ids)
    expect(await page.evaluate(() => (window as any).__diashow.store.getState().tab)).toBe('slide')
    await expect(page.locator(`.cards .card[data-index="${shown.index}"]`)).toHaveClass(/selected/)
    expect(Math.abs((await playhead(page)) - t0)).toBeLessThan(0.05)

    // dragging a picture moves the framing of a photo on the slide on screen, never one of the first slide
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 10, { steps: 5 })
    await page.mouse.up()
    const crops = (): Promise<Record<string, unknown>> =>
      page.evaluate(() => Object.fromEntries((window as any).__diashow.store.getState().project.entries.filter((e: any) => e.crop).map((e: any) => [e.id, e.crop])))
    await expect.poll(async () => Object.keys(await crops()).length).toBeGreaterThan(0)
    for (const id of Object.keys(await crops())) expect(shown.ids, `cropped ${id}`).toContain(id)

    // a theme without crop cells (Ken Burns): a click on the picture selects the slide on screen too
    await store(page, 'setTheme', 'kenburns')
    const kb = await shownSlides(page)
    await store(page, 'select', kb[1].ids)
    const target = kb[6]
    await page.evaluate((t) => (window as any).__diashow.player.current.seek(t), target.start + target.duration / 2)
    const frame = (await page.locator('.frame canvas').boundingBox())!
    await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2)
    await expect.poll(() => selection(page)).toEqual(target.ids)
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
