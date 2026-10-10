// "Pack project" end to end: the project is packed with copies of its photos, videos and music
// (the folder dialog answers from the test), the originals go away, the pack folder moves (USB stick),
// and a fresh installation ("another PC": new data folder, empty cache) opens the packed .dshow with
// "Open project…": every photo, video and song is there and ready.
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { answerOpenDialog, copyMedia, ensureTestMedia, launch, menu, project, projectFile, removeDir, sampleFiles, waitProcessed, type Session } from './harness'
import { SOFTWARE_GL } from './launch'

const NAME = 'Klassenfahrt'

test('pack project, open it on another PC with media and music', async () => {
  test.setTimeout((SOFTWARE_GL ? 10 : 5) * 60 * 1000)
  ensureTestMedia()
  const work = mkdtempSync(join(tmpdir(), 'diashow-pack-'))
  const dataA = join(work, 'pc-a')
  const dataB = join(work, 'pc-b')
  const originals = join(work, 'Fotos')
  const packTarget = join(work, 'Packed')
  const usb = join(work, 'USB')
  mkdirSync(packTarget, { recursive: true })
  mkdirSync(usb, { recursive: true })
  let s: Session | null = null
  try {
    // ---- PC A: a project with photos, a video, a Live Photo and two songs
    const media = copyMedia(sampleFiles({ video: true, live: true }), originals)
    const music = copyMedia(['music/track1.mp3', 'music/track2.m4a'], originals)
    s = await launch(dataA)
    await s.page.evaluate(async ({ media, music, name }) => {
      const st = () => (window as any).__diashow.store.getState()
      await st().createProject(media, name)
      await st().addMusic(music)
      st().insertDayTitles('date')
    }, { media, music, name: NAME })
    await waitProcessed(s.page)
    const a = await project(s.page)
    const slidesA = await s.page.evaluate(() => (window as any).__diashow.player.current.tl.slides.length)
    expect(a.music).toHaveLength(2)
    expect(a.media.every((m: any) => m.status === 'ready')).toBe(true)

    // ---- "Pack project…" into the folder the dialog answers with
    await answerOpenDialog(s.app, [packTarget])
    await menu(s.page, /Projekt packen|Pack project/)
    const done = s.page.locator('.dialog').filter({ hasText: /gepackt|packed/ })
    await expect(done).toBeVisible({ timeout: 120_000 })
    const file = ((await done.locator('.hint').textContent()) ?? '').trim()
    expect(file.startsWith(packTarget + sep)).toBe(true)
    expect(file).toMatch(/\.dshow$/)
    await done.locator('.actions .btn.primary').click()
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null

    // the pack: copies of every original and a project with relative paths, without cache paths
    const packRoot = join(file, '..')
    const packed = JSON.parse(readFileSync(file, 'utf8'))
    const copied = [...readdirSync(join(packRoot, 'media')), ...readdirSync(join(packRoot, 'music'))].sort()
    expect(copied).toEqual([...media, ...music].map((f) => basename(f)).sort())
    for (const m of packed.media) {
      expect(m.path).toMatch(/^media\//)
      expect(m.thumb ?? m.display ?? m.playback).toBeUndefined()
    }
    for (const t of packed.music) expect(t.path).toMatch(/^music\//)

    // ---- to another PC: the originals are not there, the pack comes on a USB stick
    renameSync(originals, `${originals}-gone`)
    const moved = join(usb, basename(packRoot))
    renameSync(packRoot, moved)
    const movedFile = join(moved, basename(file))

    s = await launch(dataB)
    const { page } = s
    await expect(page.locator('.home')).toBeVisible()
    await answerOpenDialog(s.app, [movedFile])
    await page.locator('.home .hero button').filter({ hasText: /Projekt öffnen|Open project/ }).click()
    await expect.poll(async () => (await project(page))?.name, { timeout: 30_000 }).toBe(NAME)
    await waitProcessed(page)
    const b = await project(page)
    expect(b.media.filter((m: any) => m.status !== 'ready').map((m: any) => `${m.name}: ${m.status} ${m.error ?? ''}`)).toEqual([])
    expect(b.music.filter((m: any) => m.status !== 'ready').map((m: any) => `${m.title}: ${m.status} ${m.error ?? ''}`)).toEqual([])
    expect(b.media).toHaveLength(a.media.length)
    expect(b.music.map((m: any) => m.title)).toEqual(a.music.map((m: any) => m.title))
    // everything comes from the pack on the stick
    for (const m of b.media) {
      expect(m.path.startsWith(join(moved, 'media') + sep)).toBe(true)
      if (m.live) expect(m.live.source.startsWith(join(moved, 'media') + sep)).toBe(true)
    }
    for (const t of b.music) expect(t.path.startsWith(join(moved, 'music') + sep)).toBe(true)
    expect(b.media.some((m: any) => m.live)).toBe(a.media.some((m: any) => m.live))
    expect(b.media.some((m: any) => m.kind === 'video')).toBe(true)
    // same show: entries point to the media here, same slides, songs in the audio plan
    const ids = new Set(b.media.map((m: any) => m.id))
    expect(b.entries.filter((e: any) => e.type !== 'text' && !ids.has(e.mediaId))).toEqual([])
    expect(b.entries.map((e: any) => e.type)).toEqual(a.entries.map((e: any) => e.type))
    expect(await page.evaluate(() => (window as any).__diashow.player.current.tl.slides.length)).toBe(slidesA)
    const songs = await page.evaluate(() => (window as any).__diashow.player.current.plan.clips.filter((c: any) => c.kind === 'music').length)
    expect(songs).toBeGreaterThanOrEqual(2)
    // it was saved into this PC's projects
    expect(existsSync(projectFile(dataB, b.id))).toBe(true)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(work)
  }
})
