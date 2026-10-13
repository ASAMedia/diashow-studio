// Drag and drop end to end, through Chromium's own drag and drop (CDP Input.dispatchDragEvent, see
// dragFiles and dragElement in harness.ts): files from Explorer onto the home screen, the filmstrip
// (between and onto cards), the audio lane and the song list; slides and songs moved by hand. Each
// target is checked where drops used to get lost or marks used to stay: a drop right after the
// element under the pointer changed (Chromium then decides by the dragenter alone), a drop exactly on
// an edge, the pointer leaving the window and coming back, Esc, an element removed under the pointer,
// and drags of one kind over a target of another. The pointer drags (a card's time, a text box, Ken
// Burns framing, video trim, the edit view's crop, crop cells, the free collage) are dragged with the
// mouse and a finger and must end when the window never sees the button go up, when a touch is
// cancelled, and when the button goes up outside the window. Selectors work in German and English.
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyMedia, dragElement, dragFiles, dragLog, dropFiles, ensureTestMedia, launch, removeDir, sampleFiles, waitProcessed, type Session } from './harness'

const locale = process.env.DIASHOW_LOCALE ?? 'de-DE'

type Slide = { kind: string; ids: string[]; paths: string[] }
const slides = (page: Page): Promise<Slide[]> =>
  page.evaluate(() => (window as any).__diashow.player.current.tl.slides.map((s: any) => ({ kind: s.kind, ids: s.entries.map((e: any) => e.id), paths: s.media.map((m: any) => m.path) })))
/** The slides in order, each by its first entry. */
const order = async (page: Page): Promise<string[]> => (await slides(page)).map((x) => x.ids[0])
const songs = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__diashow.store.getState().project.music.map((m: any) => m.path))
const entryCount = (page: Page): Promise<number> => page.evaluate(() => (window as any).__diashow.store.getState().project.entries.length)
type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number }
/** The boxes of the filmstrip's cards in the page, by slide index. */
const cards = (page: Page): Promise<Box[]> =>
  page.evaluate(() => {
    const out: Box[] = []
    for (const el of document.querySelectorAll<HTMLElement>('.cards .card[data-index]')) {
      const r = el.getBoundingClientRect()
      out[Number(el.dataset.index)] = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }
    return out
  })
const centre = (b: { x: number; y: number; width: number; height: number }): [number, number] => [b.x + b.width / 2, b.y + b.height / 2]
/** Slide `from` moved to slide boundary `to` (in front of the slide that was at `to`). */
function moved(list: string[], from: number, to: number): string[] {
  const out = [...list]
  const [x] = out.splice(from, 1)
  out.splice(to > from ? to - 1 : to, 0, x)
  return out
}

/** Makes a show 300 slides longer, so the filmstrip renders only part of its cards; returns the undo. */
async function longShow(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const st = (window as any).__diashow.store.getState()
    const photos = st.project.entries.filter((e: any) => e.type === 'photo')
    st.update((p: any) => p.entries.push(...Array.from({ length: 300 }, (_, i) => ({ id: `many-${i}`, type: 'photo', mediaId: photos[i % photos.length].mediaId }))))
  })
  await expect(page.locator('.cards .card[data-index="250"]')).toHaveCount(0)
  return async () => {
    await page.evaluate(() => (window as any).__diashow.store.getState().update((p: any) => (p.entries = p.entries.filter((e: any) => !e.id.startsWith('many-')))))
    await page.locator('.strip-scroll').evaluate((el) => (el.scrollLeft = 0))
  }
}

test('files from Explorer: home screen, filmstrip, audio lane, song list', async () => {
  test.setTimeout(8 * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-dnd-'))
  let s: Session | null = null
  try {
    s = await launch(dataDir, { DIASHOW_LOCALE: locale })
    const { page } = s
    const files = copyMedia(sampleFiles({ video: true }), join(dataDir, 'media'))
    const overlay = page.locator('.window-drop')
    const strip = page.locator('section.strip')
    const indicator = page.locator('.drop-indicator')

    // ---- the home screen: "drop here" comes with the files and goes when they leave the window, or on Esc
    const box = (await page.locator('.home .drop').boundingBox())!
    const [hx, hy] = centre(box)
    let drag = await dragFiles(page, files)
    await drag.to(hx, hy)
    await expect(overlay).toBeVisible()
    await drag.out()
    await expect(overlay).toHaveCount(0)
    await drag.to(hx, hy)
    await expect(overlay).toBeVisible()
    await drag.esc()
    await expect(overlay).toHaveCount(0)
    // above the drop box, released at once on its top edge: a new show of all the files
    drag = await dragFiles(page, files)
    await drag.to(hx, box.y - 12)
    expect(await drag.drop(hx, box.y)).toBe('drop')
    // dropped as a copy: a move would tell Explorer that the files went away
    expect((await dragLog(page)).filter((l) => l.startsWith('drop')).pop()).toContain('effect=copy')
    await page.waitForFunction(() => !!(window as any).__diashow.store.getState().project, null, { timeout: 60_000 })
    await waitProcessed(page)
    await expect(overlay).toHaveCount(0)
    expect((await slides(page)).length).toBe(5)

    // ---- the filmstrip: its mark while files hover goes as soon as they leave the window
    const more = copyMedia(['misc/photo.webp', 'iphone/IMG_0003.JPG'], join(dataDir, 'more'), true)
    let c = await cards(page)
    const y = c[1].top + 20
    const stage = centre((await page.locator('.stage').boundingBox())!)
    drag = await dragFiles(page, [more[0]])
    await drag.to((c[1].right + c[2].left) / 2, y)
    await expect(indicator).toHaveCount(1)
    await expect(strip).toHaveClass(/files-over/)
    await expect(overlay).toBeHidden()
    await drag.out()
    await expect(indicator).toHaveCount(0)
    await expect(strip).not.toHaveClass(/files-over/)
    await expect(overlay).toHaveCount(0)
    // back in over the preview, then released at once exactly on the left edge of the third card: in front of it
    await drag.to(...stage)
    await expect(overlay).toBeVisible()
    let before = await slides(page)
    expect(await drag.drop(c[2].left, y)).toBe('drop')
    await expect.poll(async () => (await slides(page)).length, { timeout: 20_000 }).toBe(before.length + 1)
    let after = await slides(page)
    expect(after[2].paths).toEqual([more[0]])
    expect(after.slice(3).map((x) => x.ids)).toEqual(before.slice(2).map((x) => x.ids))
    await expect(indicator).toHaveCount(0)
    await expect(overlay).toHaveCount(0)
    await waitProcessed(page)
    // Esc while files hover over a card: no mark stays, nothing goes in
    c = await cards(page)
    drag = await dragFiles(page, [more[1]])
    await drag.to(c[1].left + c[1].width / 2, y)
    await expect(strip).toHaveClass(/files-over/)
    await drag.esc()
    await expect(strip).not.toHaveClass(/files-over/)
    await expect(indicator).toHaveCount(0)
    await expect(overlay).toHaveCount(0)
    expect((await slides(page)).length).toBe(after.length)

    // ---- the card under the files is removed (the filmstrip scrolled meanwhile): leaving the window
    // still takes every mark away (a count of dragenter and dragleave missed the removed card's leave)
    const restore = await longShow(page)
    c = await cards(page)
    drag = await dragFiles(page, [more[1]])
    await drag.to(c[1].left + c[1].width / 2, y)
    await expect(strip).toHaveClass(/files-over/)
    await page.locator('.strip-scroll').evaluate((el) => (el.scrollLeft = el.scrollWidth / 2))
    await expect(page.locator('.cards .card[data-index="1"]')).toHaveCount(0)
    await drag.to(c[1].left + c[1].width / 2, y)
    await drag.out()
    await expect(strip).not.toHaveClass(/files-over/)
    await expect(indicator).toHaveCount(0)
    await expect(overlay).toHaveCount(0)
    await drag.esc()
    await restore()
    expect((await slides(page)).length).toBe(after.length)

    // ---- Magazine: files over the middle of a card mark it for joining. The mark changes nothing under
    // the pointer (a card that shrank moved its edges and the mark flickered), it stays while they
    // hover, and the drop right on the edge between two of its pictures joins that slide
    await page.evaluate(() => (window as any).__diashow.store.getState().setTheme('magazine'))
    await expect.poll(async () => (await slides(page)).findIndex((x) => x.kind === 'photos' && x.ids.length >= 2 && x.ids.length < 6)).toBeGreaterThanOrEqual(0)
    before = await slides(page)
    const target = before.findIndex((x) => x.kind === 'photos' && x.ids.length >= 2 && x.ids.length < 6)
    const card = page.locator(`.cards .card[data-index="${target}"]`)
    const geo = await card.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const tiles = [...el.querySelectorAll('.tiles > *')].map((t) => t.getBoundingClientRect())
      const mid = r.left + r.width / 2
      const edges = tiles.slice(1).map((t, i) => (tiles[i].right + t.left) / 2).filter((x) => Math.abs(x - mid) < r.width * 0.2)
      return { left: r.left, right: r.right, y: r.top + r.height / 2, edge: edges.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0] ?? mid }
    })
    const under = (): Promise<string> =>
      page.evaluate(([l, r, py]) => {
        const hit: string[] = []
        for (let x = Math.floor(l) - 3; x <= Math.ceil(r) + 3; x++) {
          const el = document.elementFromPoint(x, py)
          hit.push(el ? `${el.nodeName}.${el.className}`.replace(/ ?merge-target/, '') : '')
        }
        return hit.join('|')
      }, [geo.left, geo.right, geo.y])
    const unmarked = await under()
    await card.evaluate((el) => {
      const w = window as any
      w.__marks = []
      new MutationObserver(() => {
        const on = el.classList.contains('merge-target')
        if (w.__marks[w.__marks.length - 1] !== on) w.__marks.push(on)
      }).observe(el, { attributes: true, attributeFilter: ['class'] })
    })
    const onto = copyMedia(['misc/photo.webp'], join(dataDir, 'onto'), true)
    drag = await dragFiles(page, onto)
    await drag.to(geo.edge, geo.y)
    await drag.hover(async () => {
      await expect(card).toHaveClass(/merge-target/)
      expect(await under()).toBe(unmarked)
      await page.waitForTimeout(600)
    })
    expect(await page.evaluate(() => (window as any).__marks)).toEqual([true])
    expect(await drag.drop(geo.edge, geo.y)).toBe('drop')
    const joined = before[target].ids[0]
    await expect.poll(async () => (await slides(page)).find((x) => x.ids.includes(joined))?.paths.includes(onto[0]), { timeout: 20_000 }).toBe(true)
    expect((await slides(page)).length).toBe(before.length)
    await expect(card).not.toHaveClass(/merge-target/)
    await waitProcessed(page)

    // ---- a song dropped onto the audio lane goes into the music, not into the show
    const music = copyMedia(['music/track1.mp3', 'music/track2.m4a'], join(dataDir, 'music'))
    const lane = (await page.locator('.lane').boundingBox())!
    const entries = await entryCount(page)
    await dropFiles(page, [music[0]], lane.x + 40, lane.y + lane.height / 2)
    await expect.poll(() => songs(page), { timeout: 20_000 }).toEqual([music[0]])
    expect(await entryCount(page)).toBe(entries)
    await expect(indicator).toHaveCount(0)
    await expect(overlay).toHaveCount(0)

    // ---- the song list: files over a song don't mark it for a move; dropped there, they join the end
    await page.locator('.rail button').nth(1).click()
    const track = page.locator('.track').first()
    await expect(track).toBeVisible()
    await waitProcessed(page)
    await track.scrollIntoViewIfNeeded()
    const t0 = centre((await track.boundingBox())!)
    drag = await dragFiles(page, [music[1]])
    await drag.to(...t0)
    await drag.hover(async () => {
      await expect(overlay).toBeVisible()
      await page.waitForTimeout(300)
      await expect(page.locator('.track.drag-over')).toHaveCount(0)
    })
    expect(await drag.drop(...t0)).toBe('drop')
    await expect.poll(() => songs(page), { timeout: 20_000 }).toEqual(music)
    await expect(page.locator('.track.drag-over')).toHaveCount(0)
    await expect(overlay).toHaveCount(0)
    expect(await entryCount(page)).toBe(entries)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})

test('slides and songs moved by hand', async () => {
  test.setTimeout(8 * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-dnd-'))
  let s: Session | null = null
  try {
    s = await launch(dataDir, { DIASHOW_LOCALE: locale })
    const { page } = s
    const files = copyMedia(sampleFiles({ video: true }), join(dataDir, 'media'))
    const music = copyMedia(['music/track1.mp3', 'music/track2.m4a'], join(dataDir, 'music'))
    await page.evaluate(async ([paths, tracks]) => {
      await (window as any).__diashow.store.getState().createProject(paths, 'Ziehen')
      await (window as any).__diashow.store.getState().addMusic(tracks)
    }, [files, music])
    await waitProcessed(page)
    const indicator = page.locator('.drop-indicator')
    const dragged = page.locator('.cards .card.dragging')
    expect((await slides(page)).every((x) => x.kind !== 'title')).toBe(true)

    // ---- a slide grabbed on the second card, over the left part of the third, then released at once in the
    // gap behind the fourth (a quick move between two drag events): it goes where it was released
    let o = await order(page)
    let c = await cards(page)
    const y = c[0].top + 20
    let drag = await dragElement(page, c[1].left + c[1].width / 2, y)
    await drag.to(c[2].left + c[2].width * 0.3, y)
    await expect(indicator).toHaveCount(1)
    await expect(dragged).toHaveCount(1)
    expect(await drag.drop((c[3].right + c[4].left) / 2, y)).toBe('drop')
    await expect.poll(() => order(page)).toEqual(moved(o, 1, 4))
    await expect(indicator).toHaveCount(0)
    await expect(dragged).toHaveCount(0)

    // released exactly on the right edge of a card: behind it
    o = await order(page)
    c = await cards(page)
    drag = await dragElement(page, c[0].left + c[0].width / 2, y)
    await drag.to(c[2].left + c[2].width / 2, y)
    expect(await drag.drop(c[2].right, y)).toBe('drop')
    await expect.poll(() => order(page)).toEqual(moved(o, 0, 3))

    // out of the window and back: the mark goes and comes again, and the drop still works
    o = await order(page)
    c = await cards(page)
    const gap01 = (c[0].right + c[1].left) / 2
    drag = await dragElement(page, c[3].left + c[3].width / 2, y)
    await drag.to(gap01, y)
    await expect(indicator).toHaveCount(1)
    await drag.out()
    await expect(indicator).toHaveCount(0)
    await expect(dragged).toHaveCount(1)
    await drag.to(gap01, y)
    await expect(indicator).toHaveCount(1)
    expect(await drag.drop(gap01, y)).toBe('drop')
    await expect.poll(() => order(page)).toEqual(moved(o, 3, 1))

    // Esc: nothing moves and no mark stays
    o = await order(page)
    c = await cards(page)
    drag = await dragElement(page, c[1].left + c[1].width / 2, y)
    await drag.to((c[2].right + c[3].left) / 2, y)
    await expect(indicator).toHaveCount(1)
    await drag.esc()
    await expect(indicator).toHaveCount(0)
    await expect(dragged).toHaveCount(0)
    expect(await order(page)).toEqual(o)

    // ---- a slide doesn't land in the song list or a text field, a song not in the filmstrip
    await page.locator('.rail button').nth(1).click()
    const tracks = page.locator('.track')
    await expect(tracks).toHaveCount(2)
    await tracks.last().scrollIntoViewIfNeeded()
    const songBoxes = async (): Promise<{ x: number; y: number; width: number; height: number }[]> => [(await tracks.nth(0).boundingBox())!, (await tracks.nth(1).boundingBox())!]
    let so = await songs(page)
    let t = await songBoxes()
    drag = await dragElement(page, c[1].left + c[1].width / 2, y)
    await drag.to(...centre(t[1]))
    await page.waitForTimeout(200)
    await expect(page.locator('.track.drag-over')).toHaveCount(0)
    expect(await drag.drop(...centre(t[1]))).toBe('refused')
    await expect(dragged).toHaveCount(0)
    expect(await songs(page)).toEqual(so)
    expect(await order(page)).toEqual(o)
    await page.locator('.stage').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Control+f')
    const field = page.getByRole('combobox', { name: /Folien suchen|Search slides/ })
    await expect(field).toBeFocused()
    const fieldAt = centre((await field.boundingBox())!)
    drag = await dragElement(page, c[2].left + c[2].width / 2, y)
    expect(await drag.drop(...fieldAt)).toBe('refused')
    await expect(field).toHaveValue('')
    await field.focus()
    await page.keyboard.press('Escape')
    await expect(field).toHaveCount(0)
    drag = await dragElement(page, ...centre(t[0]))
    await drag.to((c[1].right + c[2].left) / 2, y)
    await page.waitForTimeout(200)
    await expect(indicator).toHaveCount(0)
    expect(await drag.drop((c[1].right + c[2].left) / 2, y)).toBe('refused')
    expect(await order(page)).toEqual(o)
    expect(await songs(page)).toEqual(so)

    // ---- songs: from the first song, released at once on the second (decided by the dragenter): swapped
    drag = await dragElement(page, ...centre(t[0]))
    await drag.to(t[0].x + t[0].width / 2, t[0].y + t[0].height - 4)
    expect(await drag.drop(...centre(t[1]))).toBe('drop')
    await expect.poll(() => songs(page)).toEqual([so[1], so[0]])
    await expect(page.locator('.track.drag-over')).toHaveCount(0)
    // over the second song, released at once in the gap between the two: no song, nothing moves, no mark stays
    so = await songs(page)
    t = await songBoxes()
    const gapY = (t[0].y + t[0].height + t[1].y) / 2
    drag = await dragElement(page, ...centre(t[0]))
    await drag.to(...centre(t[1]))
    await expect(page.locator('.track.drag-over')).toHaveCount(1)
    expect(await drag.drop(t[1].x + t[1].width / 2, gapY)).toBe('refused')
    await expect(page.locator('.track.drag-over')).toHaveCount(0)
    expect(await songs(page)).toEqual(so)
    // from that gap, released at once exactly on the second song's top edge: moved
    drag = await dragElement(page, ...centre(t[0]))
    await drag.to(t[1].x + t[1].width / 2, gapY)
    expect(await drag.drop(t[1].x + t[1].width / 2, t[1].y + 0.5)).toBe('drop')
    await expect.poll(() => songs(page)).toEqual([so[1], so[0]])
    // out of the window and back, then Esc: the mark follows, nothing moves
    so = await songs(page)
    drag = await dragElement(page, ...centre(t[0]))
    await drag.to(...centre(t[1]))
    await expect(page.locator('.track.drag-over')).toHaveCount(1)
    await drag.out()
    await expect(page.locator('.track.drag-over')).toHaveCount(0)
    await drag.to(...centre(t[1]))
    await expect(page.locator('.track.drag-over')).toHaveCount(1)
    await drag.esc()
    await expect(page.locator('.track.drag-over')).toHaveCount(0)
    expect(await songs(page)).toEqual(so)

    // ---- a slide whose card scrolled out of the filmstrip while it was dragged, dropped where nothing
    // takes it: the drag still ends (the card isn't left dragged), and files dropped afterwards go in as
    // files (they were taken for that slide being moved)
    const restore = await longShow(page)
    o = await order(page)
    c = await cards(page)
    drag = await dragElement(page, c[1].left + c[1].width / 2, y)
    await drag.to((c[2].right + c[3].left) / 2, y)
    await expect(dragged).toHaveCount(1)
    await page.locator('.strip-scroll').evaluate((el) => (el.scrollLeft = el.scrollWidth))
    await expect(page.locator('.cards .card[data-index="1"]')).toHaveCount(0)
    expect(await drag.drop(...centre((await page.locator('.stage').boundingBox())!))).toBe('refused')
    await page.locator('.strip-scroll').evaluate((el) => (el.scrollLeft = 0))
    await expect(page.locator('.cards .card[data-index="1"]')).toHaveCount(1)
    await expect(dragged).toHaveCount(0)
    expect(await order(page)).toEqual(o)
    const late = copyMedia(['misc/photo.webp'], join(dataDir, 'late'), true)
    c = await cards(page)
    await dropFiles(page, late, (c[1].right + c[2].left) / 2, y)
    await expect.poll(async () => (await slides(page))[2]?.paths, { timeout: 20_000 }).toEqual(late)
    expect((await order(page)).filter((id) => o.includes(id))).toEqual(o)
    await restore()
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})

/**
 * A pointer drag on `target`: the mouse and a finger change what `read` returns, and the drag ends in
 * each way it can end without the button going up over the window: the window never sees it go up
 * (it went up while another window had the mouse, so the next move comes without a button), a touch
 * is cancelled, and the button goes up outside the window. After each, moving the mouse over it
 * changes nothing, and `active` (the drag's mark) is gone.
 */
async function pointerDrag(page: Page, cdp: CDPSession, label: string, target: Locator, read: () => Promise<unknown>, active?: Locator): Promise<void> {
  const value = async (): Promise<string> => JSON.stringify((await read()) ?? null)
  // what it reads once it stopped changing (saves wait for an animation frame)
  const settled = async (): Promise<string> => {
    let v = await value()
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(120)
      const w = await value()
      if (w === v) return w
      v = w
    }
    return v
  }
  const at = async (): Promise<[number, number]> => centre((await target.boundingBox())!)
  const noButton = (x: number, y: number): Promise<unknown> => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  const ended = async (how: string, x: number, y: number): Promise<void> => {
    const v = await settled()
    if (active) await expect(active, `${label}, ${how}: still marked as dragged`).toHaveCount(0)
    // the mouse moves on, and slowly across it again, with no button pressed
    await noButton(x + 20, y + 10)
    const [tx, ty] = await at()
    for (let i = 0; i <= 10; i++) await noButton(tx + i * 3, ty + i)
    expect(await settled(), `${label}, ${how}: it still follows the mouse`).toBe(v)
  }
  const touch = (type: string, x?: number, y?: number): Promise<unknown> => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: x == null ? [] : [{ x, y }] } as any)

  // the mouse drags it; the button goes up where the window doesn't see it
  let [x, y] = await at()
  const v0 = await settled()
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 24, y + 12, { steps: 4 })
  expect(await settled(), `${label}: the mouse doesn't drag it`).not.toBe(v0)
  await noButton(x + 30, y + 15)
  await ended('a button-up the window never saw', x + 30, y + 15)
  await page.mouse.up()

  // a finger drags it too (it doesn't scroll the page instead); then the touch is cancelled
  ;[x, y] = await at()
  const v1 = await settled()
  await touch('touchStart', x, y)
  for (let i = 1; i <= 4; i++) await touch('touchMove', x - i * 6, y + i * 3)
  expect(await settled(), `${label}: a finger doesn't drag it`).not.toBe(v1)
  await touch('touchCancel')
  await ended('a cancelled touch', x, y)

  // the button held while the pointer leaves the window, let go outside: the drag ends there
  ;[x, y] = await at()
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 10, y + 5, { steps: 2 })
  await page.mouse.move(-30, y + 5, { steps: 4 })
  await page.mouse.up()
  const v2 = await settled()
  ;[x, y] = await at()
  await page.mouse.move(x, y, { steps: 3 })
  await page.mouse.move(x + 30, y + 15, { steps: 3 })
  expect(await settled(), `${label}: let go outside the window, it still follows the mouse`).toBe(v2)
  if (active) await expect(active).toHaveCount(0)
}

test('pointer drags end however the button goes up', async () => {
  test.setTimeout(8 * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-dnd-'))
  let s: Session | null = null
  try {
    s = await launch(dataDir, { DIASHOW_LOCALE: locale })
    const { page } = s
    const files = copyMedia(sampleFiles({ video: true }), join(dataDir, 'media'))
    await page.evaluate(async (paths) => (window as any).__diashow.store.getState().createProject(paths, 'Zeiger'), files)
    await waitProcessed(page)
    const cdp = await page.context().newCDPSession(page)
    const state = <T,>(fn: string): Promise<T> => page.evaluate(`(() => { const d = window.__diashow; const s = d.store.getState(); ${fn} })()`) as Promise<T>
    const entry = (id: string): Promise<any> => state(`return s.project.entries.find((e) => e.id === ${JSON.stringify(id)})`)
    const all = await slides(page)
    const photo = all.findIndex((x) => x.kind === 'photos' && !/pano/.test(x.paths[0]))
    const photoId = all[photo].ids[0]
    const videoId = all.find((x) => x.kind === 'video')!.ids[0]

    // ---- a card's time: the handle on its right edge
    await pointerDrag(
      page,
      cdp,
      "a card's time",
      page.locator(`.cards .card[data-index="${photo}"] .dur-handle`),
      () => state(`return d.player.current.tl.slides[${photo}].duration`),
      page.locator('.dur-handle.active')
    )

    // ---- a text box in the preview
    await state(`s.select([${JSON.stringify(photoId)}]); s.set({ tab: 'slide' })`)
    await page.locator('.inspector button', { hasText: /Textfeld hinzufügen|Add text box/ }).click()
    await expect(page.locator('.free-text')).toHaveCount(1)
    await pointerDrag(page, cdp, 'a text box', page.locator('.free-text'), async () => {
      const ft = (await entry(photoId)).texts[0]
      return [ft.x, ft.y]
    })
    await state(`s.set({ textSel: null }); s.removeFreeText(${JSON.stringify(photoId)}, s.project.entries.find((e) => e.id === ${JSON.stringify(photoId)}).texts[0].id)`)

    // ---- Ken Burns framing: the start frame, made smaller first so it can move
    await state(`s.select([${JSON.stringify(photoId)}]); s.set({ tab: 'slide', kbEdit: 'start' })`)
    const kb = page.locator('.kb .rect.start:not(.inactive)')
    await expect(kb).toBeVisible()
    await page.mouse.move(...centre((await kb.boundingBox())!))
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100)
    await expect.poll(async () => (await entry(photoId)).kenBurns?.start?.w ?? 1).toBeLessThan(0.8)
    await pointerDrag(page, cdp, 'Ken Burns framing', kb, async () => (await entry(photoId)).kenBurns?.start)
    await state(`s.set({ kbEdit: null })`)

    // ---- video trim: the start handle, moved in by the keys first (at 0 it sits half outside the strip)
    await state(`s.select([${JSON.stringify(videoId)}]); s.set({ tab: 'slide' })`)
    const trimIn = page.locator('.inspector .trim-handle').first()
    await expect(trimIn).toBeVisible()
    await trimIn.focus()
    await page.keyboard.press('Shift+ArrowRight')
    await expect.poll(async () => (await entry(videoId)).trimIn).toBe(1)
    await pointerDrag(page, cdp, 'video trim', trimIn, async () => (await entry(videoId)).trimIn)

    // ---- the edit view's crop: a draft while it moves, stored when the drag ends
    await state(`s.select([${JSON.stringify(photoId)}]); s.set({ tab: 'slide' })`)
    await page.locator('.inspector').getByRole('button', { name: /^(Bearbeiten|Edit)$/ }).click()
    const view = page.getByRole('dialog', { name: /Foto bearbeiten|Edit photo/ })
    await expect(view).toBeVisible()
    const handle = view.locator('.pe-handle.s')
    // the frame follows the size of the preview: wait until it stays put
    let hb = (await handle.boundingBox())!
    await expect
      .poll(async () => {
        const b = (await handle.boundingBox())!
        const still = Math.abs(b.x - hb.x) < 0.5 && Math.abs(b.y - hb.y) < 0.5
        hb = b
        return still
      }, { intervals: [250] })
      .toBe(true)
    // the bottom edge up by a quarter first, so it has room both ways
    const cb = (await view.locator('.pe-crop').boundingBox())!
    await page.mouse.move(...centre(hb))
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - cb.height / 4, { steps: 4 })
    await page.mouse.up()
    await pointerDrag(page, cdp, "the edit view's crop", handle, () => view.locator('.pe-crop').getAttribute('data-crop'))
    await view.locator('.pe-crop').focus()
    await page.keyboard.press('Escape')
    await expect(view).toHaveCount(0)

    // ---- Magazine: moving a photo inside its cell, and the free collage
    await state(`s.setTheme('magazine')`)
    await expect.poll(async () => (await slides(page)).some((x) => x.kind === 'photos' && x.ids.length >= 2)).toBe(true)
    const multi = (await slides(page)).find((x) => x.kind === 'photos' && x.ids.length >= 2)!
    await state(`s.select(${JSON.stringify(multi.ids)}); s.set({ tab: 'slide' })`)
    const cell = page.locator('.crop-cell:not(.whole)').first()
    await expect(cell).toBeVisible()
    const cellEntry = await cell.evaluate((el) => [...el.parentElement!.querySelectorAll('.crop-cell')].indexOf(el))
    await pointerDrag(page, cdp, 'a photo in its cell', cell, async () => (await entry(multi.ids[cellEntry])).crop, page.locator('.crop-cell.active'))
    await state(`d.store.getState().setEntry(${JSON.stringify(multi.ids[0])}, { layout: 'free' }); d.store.getState().select(${JSON.stringify(multi.ids)})`)
    const item = page.locator('.collage-item').first()
    await expect(item).toBeVisible()
    await pointerDrag(page, cdp, 'the free collage', item, async () => (await entry(multi.ids[0])).place, page.locator('.collage-item.active'))
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
