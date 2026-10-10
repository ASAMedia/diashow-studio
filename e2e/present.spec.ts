// Presentation mode end to end: the show plays in its own window while the editor shows the presenter
// controls; pause, next, previous (buttons and keys) and play drive the show window's player, whose
// state is read from the presentation channel; "Stop" closes the show window.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureTestMedia, launch, mediaDir, menu, removeDir, sampleFiles, waitProcessed, type Session } from './harness'
import { SOFTWARE_GL } from './launch'

interface ShowState {
  t: number
  playing: boolean
  duration: number
}

/**
 * Listens in the editor window to the state the show window reports (every 200 ms over the
 * presentation BroadcastChannel), so the test reads the show window's own player.
 */
const listen = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = window as any
    w.__showChannel?.close()
    w.__showStates = 0
    w.__showChannel = new BroadcastChannel('diashow-present')
    w.__showChannel.onmessage = (e: MessageEvent) => {
      if (e.data?.type !== 'state') return
      w.__showState = { t: e.data.t, playing: e.data.playing, duration: e.data.duration }
      w.__showStates++
    }
  })

/** The show window's state from a report that arrives after this call (a busy window reports late). */
async function showState(page: Page): Promise<ShowState> {
  const count = await page.evaluate(() => (window as any).__showStates as number)
  await page.waitForFunction((n) => (window as any).__showStates > n, count, { timeout: 30_000 })
  return page.evaluate(() => (window as any).__showState as ShowState)
}

/** Without a GPU the show window renders slowly and its reports come late. */
const SLOW = { timeout: 30_000 }

/** "Jetzt 2 / 5" / "Now 2 / 5" in the presenter panel. */
async function shownSlide(page: Page): Promise<number> {
  const text = (await page.locator('.presenter figure:not(.next) figcaption').textContent()) ?? ''
  return Number(/(\d+)\s*\/\s*\d+/.exec(text)?.[1] ?? NaN)
}

const showWindows = (app: ElectronApplication) => app.windows().filter((w) => w.url().includes('#present'))

test('presentation: presenter controls drive the show window', async () => {
  test.setTimeout((SOFTWARE_GL ? 10 : 5) * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-present-'))
  let s: Session | null = null
  const t0 = Date.now()
  const lap = (what: string): void => console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s: ${what}`)
  try {
    s = await launch(dataDir)
    const { app, page } = s
    await page.evaluate(async (paths) => {
      const d = (window as any).__diashow
      await d.store.getState().createProject(paths, 'Präsentation')
    }, sampleFiles().map((f) => join(mediaDir, ...f.split('/'))))
    await waitProcessed(page)
    lap('media ready')
    // five slides of about 6 s: time enough to see each command land
    const slides = await page.evaluate(() => {
      const d = (window as any).__diashow
      d.store.getState().setTheme('classic')
      d.store.getState().setSettings({ timing: { mode: 'custom', customTotal: 30 }, showTitle: true })
      return new Promise<{ start: number; transIn: number }[]>((r) =>
        setTimeout(() => r(d.player.current.tl.slides.map((x: any) => ({ start: x.start, transIn: x.transIn }))), 200)
      )
    })
    expect(slides.length).toBeGreaterThanOrEqual(4)
    // where "next" / "previous" put the show: the start of a slide, fully visible
    const target = (i: number): number => slides[i].start + slides[i].transIn

    await listen(page)
    await menu(page, /Präsentieren|Present/)
    await expect(page.locator('.presenter')).toBeVisible()
    await expect.poll(() => showWindows(app).length, { timeout: 60_000 }).toBe(1)
    const show = showWindows(app)[0]
    await show.waitForFunction(() => !!document.querySelector('canvas'), null, { timeout: 60_000 })
    lap('show window open')
    // the show starts by itself
    await expect.poll(async () => (await showState(page)).t, { timeout: 60_000 }).toBeGreaterThan(0.5)
    expect((await showState(page)).playing).toBe(true)
    lap('show playing')

    // ---- pause: the show window's clock stops
    const toggle = page.locator('.presenter .btn.primary')
    await toggle.click()
    await expect.poll(async () => (await showState(page)).playing, SLOW).toBe(false)
    await expect(toggle).toHaveText(/Abspielen|Play/, SLOW)
    const paused = (await showState(page)).t
    await page.waitForTimeout(1500)
    expect((await showState(page)).t).toBe(paused)
    lap('paused')

    // ---- next / previous buttons: the show jumps to the start of the next / previous slide, still paused
    const at = await shownSlide(page)
    const next = page.locator('.presenter button[title="Weiter"], .presenter button[title="Next"]')
    const prev = page.locator('.presenter button[title="Zurück"], .presenter button[title="Previous"]')
    await next.click()
    await expect.poll(async () => (await showState(page)).t, SLOW).toBeCloseTo(target(at), 2)
    await expect.poll(() => shownSlide(page), SLOW).toBe(at + 1)
    await next.click()
    await expect.poll(async () => (await showState(page)).t, SLOW).toBeCloseTo(target(at + 1), 2)
    await expect.poll(() => shownSlide(page), SLOW).toBe(at + 2)
    await prev.click()
    await expect.poll(async () => (await showState(page)).t, SLOW).toBeCloseTo(target(at), 2)
    await expect.poll(() => shownSlide(page), SLOW).toBe(at + 1)
    expect((await showState(page)).playing).toBe(false)
    lap('next / previous')

    // ---- the keyboard in the editor window: arrows and Space
    await page.locator('.presenter h2').click()
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await showState(page)).t, SLOW).toBeCloseTo(target(at + 1), 2)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await showState(page)).t, SLOW).toBeCloseTo(target(at), 2)
    await page.keyboard.press('Space')
    await expect.poll(async () => (await showState(page)).playing, SLOW).toBe(true)
    await page.keyboard.press('Space')
    await expect.poll(async () => (await showState(page)).playing, SLOW).toBe(false)
    lap('keys')

    // ---- play: the clock runs on from where it stood
    const before = (await showState(page)).t
    await toggle.click()
    await expect(toggle).toHaveText(/Pause/, SLOW)
    await expect.poll(async () => (await showState(page)).t, SLOW).toBeGreaterThan(before + 1)
    expect((await showState(page)).playing).toBe(true)
    // the presenter's time readout follows the show window
    await expect(page.locator('.presenter .val')).not.toHaveText(/^0:00 \//, SLOW)
    lap('playing again')

    // ---- stop: the show window closes, the editor is back
    await page.locator('.presenter .btn').filter({ hasText: /Beenden|Stop/ }).click()
    await expect(page.locator('.presenter')).toHaveCount(0)
    await expect.poll(() => showWindows(app).length, SLOW).toBe(0)

    // ---- Esc in the show window ends the presentation as well
    await menu(page, /Präsentieren|Present/)
    await expect(page.locator('.presenter')).toBeVisible()
    await expect.poll(() => showWindows(app).length, { timeout: 60_000 }).toBe(1)
    const again = showWindows(app)[0]
    await again.waitForFunction(() => !!document.querySelector('canvas'), null, { timeout: 60_000 })
    // it reports, so its keys are wired up
    await showState(page)
    // the window closes on the key down already, so there is no page left for the key up
    await again.keyboard.down('Escape').catch(() => {})
    await expect.poll(() => showWindows(app).length, SLOW).toBe(0)
    await expect(page.locator('.presenter')).toHaveCount(0, SLOW)
    lap('stopped')
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
