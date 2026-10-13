// "Diashow als ZIP archivieren" end to end:
// - a show with photos, a Live Photo, a video, a photo left out of the show, music of its own, a
//   deletion date and one finished export is archived from the "⋯" menu (the save dialog answers
//   from the test); the summary repeats the deletion date;
// - independent readers (tar.exe, Python's zipfile where installed) read the ZIP: the originals, the
//   song, the export, the read-me and the .dshow, without the left-out photo;
// - "another PC" (new data folder, the originals gone) opens the extracted .dshow with "Open
//   project…": every photo, video and song is there and ready, the show plays and exports;
// - a show with theme music is archived from the project card on the home screen: the theme song is
//   in the archive. Opened with this app it plays the app's own theme song; when the archived copy
//   differs (as with a later version that has other songs) that copy plays as the show's music.
// Runs in German and with DIASHOW_LOCALE=en-US DIASHOW_SOFTWARE_GL=1.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { answerOpenDialog, answerSaveDialog, copyMedia, ensureTestMedia, launch, menu, project, removeDir, root, sampleFiles, waitProcessed, type Session } from './harness'
import { EXPORT_SIZE, SOFTWARE_GL } from './launch'
import { hasTar, PYTHON, pythonRead, tarExtract } from '../tests/helpers/zipTools'

const ffprobe = join(root, 'vendor/ffmpeg/bin/ffprobe.exe')
const DELETE_AT = new Date(2027, 0, 12).getTime()
/** Screenshots of the dialog for a look afterwards. */
const shots = join(root, 'test-results', 'archive')
const LANG = process.env.DIASHOW_LOCALE?.startsWith('en') ? 'en' : 'de'
// the app's language as the test expects it, also on a runner whose Windows is English
const LOCALE = { DIASHOW_LOCALE: process.env.DIASHOW_LOCALE ?? 'de-DE' }

/** File names of the music in the preview's audio plan. */
const musicFiles = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...new Set<string>((window as any).__diashow.player.current.plan.clips.filter((c: any) => c.kind === 'music').map((c: any) => c.src.split(/[\\/]/).pop()))])

/** Queues an export of the open show and waits until it is done; returns its file. */
async function exportShow(page: Page, file: string, name: string): Promise<string> {
  const info = await page.evaluate(
    ({ outPath, size, name }) => {
      const d = (window as any).__diashow
      return d.queueExport(d.store.getState().project, { outPath, ...size, fps: 30, codec: 'h264', quality: 'standard', hardware: true, locale: 'de-DE' }, name)
    },
    { outPath: file, size: EXPORT_SIZE, name }
  )
  await expect
    .poll(() => page.evaluate((id) => (window as any).__diashow.store.getState().exportJobs.find((j: any) => j.id === id)?.state, info.id), { timeout: 600_000, intervals: [1000] })
    .toBe('done')
  return file
}

const duration = (file: string): number => Number(JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file]).toString()).format.duration)

/** Every photo, video and song of the open show is ready. */
async function expectReady(page: Page): Promise<any> {
  await waitProcessed(page)
  const p = await project(page)
  expect(p.media.filter((m: any) => m.status !== 'ready').map((m: any) => `${m.name}: ${m.status} ${m.error ?? ''}`)).toEqual([])
  expect(p.music.filter((m: any) => m.status !== 'ready').map((m: any) => `${m.title}: ${m.status} ${m.error ?? ''}`)).toEqual([])
  return p
}

/** Checks the ZIP with the independent readers there are and extracts it with tar.exe. */
function readAndExtract(zip: string, dest: string): string[] {
  let names: string[] = []
  if (PYTHON) {
    const py = pythonRead(zip)
    expect(py.bad).toBeNull()
    names = py.names
  }
  expect(hasTar).toBe(true)
  const files = [...tarExtract(zip, dest).keys()]
  if (names.length) expect([...files].sort()).toEqual([...names].sort())
  return files
}

test('archive a show as ZIP, open it extracted on another PC', async () => {
  test.setTimeout((SOFTWARE_GL ? 25 : 12) * 60 * 1000)
  ensureTestMedia()
  const work = mkdtempSync(join(tmpdir(), 'diashow-archive-'))
  const dataA = join(work, 'pc-a')
  const dataB = join(work, 'pc-b')
  const originals = join(work, 'Fotos')
  const zip = join(work, 'USB', 'Klassenfahrt Berlin.zip')
  mkdirSync(join(work, 'USB'), { recursive: true })
  mkdirSync(join(work, 'Videos'), { recursive: true })
  let s: Session | null = null
  try {
    // ---- PC A: photos, a Live Photo, a video, one photo left out, a song, a deletion date
    const media = copyMedia(sampleFiles({ video: true, live: true }), originals)
    const [song] = copyMedia(['music/track1.mp3'], originals)
    s = await launch(dataA, LOCALE)
    const { page } = s
    await page.evaluate(
      async ({ media, song, deleteAt }) => {
        const st = () => (window as any).__diashow.store.getState()
        await st().createProject(media, 'Klassenfahrt Berlin')
        await st().addMusic([song])
        st().setSettings({ timing: { mode: 'custom', customTotal: 6 } })
        st().update((p: any) => {
          p.deleteAt = deleteAt
        })
      },
      { media, song, deleteAt: DELETE_AT }
    )
    await waitProcessed(page)
    const leftOut = await page.evaluate(() => {
      const st = (window as any).__diashow.store.getState()
      const e = st.project.entries.find((x: any) => x.type === 'photo' && /pano/.test(st.project.media.find((m: any) => m.id === x.mediaId)?.name ?? ''))
      st.setEntry(e.id, { excluded: true })
      return st.project.media.find((m: any) => m.id === e.mediaId).name as string
    })
    const a = await expectReady(page)
    const slidesA = await page.evaluate(() => (window as any).__diashow.player.current.tl.slides.length)
    const exported = await exportShow(page, join(work, 'Videos', 'Klassenfahrt 720p.mp4'), 'Klassenfahrt · 720p')

    // ---- "⋯ → Als ZIP archivieren…": parts with sizes, the export ticked, the deletion date
    await menu(page, /Als ZIP archivieren|Archive as ZIP/)
    const dialog = page.getByTestId('archive-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('archive-media')).toContainText(/\d+ (Datei|file).* · [\d.,]+ (KB|MB)/)
    await expect(dialog.getByTestId('archive-music')).toContainText(/1 (Datei|file)/)
    const video = dialog.getByTestId('archive-video')
    await expect(video).toHaveCount(1)
    await expect(video).toBeChecked()
    await expect(dialog.getByTestId('archive-leftout')).not.toBeChecked()
    await expect(dialog.getByTestId('archive-total')).toHaveText(/[\d.,]+ (KB|MB)/)
    await expect(dialog.getByTestId('archive-free')).toBeVisible()
    await expect(dialog).toContainText(/2027/)
    await dialog.screenshot({ path: join(shots, `dialog-${LANG}.png`) })
    await answerSaveDialog(s.app, zip)
    await dialog.getByTestId('archive-run').click()
    const summary = dialog.getByTestId('archive-summary')
    await expect(summary).toBeVisible({ timeout: 120_000 })
    await expect(summary).toContainText(zip)
    // the deletion date again, and that the clean-up can't reach the copy
    await expect(dialog.getByTestId('archive-deadline')).toContainText(/2027/)
    await expect(dialog.getByTestId('archive-deadline')).toContainText(/Aufräumen|clean-up/)
    await expect(dialog.getByTestId('archive-reveal')).toBeVisible()
    await dialog.screenshot({ path: join(shots, `summary-${LANG}.png`) })
    await dialog.locator('.actions .btn.primary').click()
    await expect(dialog).toHaveCount(0)
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null
    expect(readdirSync(join(work, 'USB'))).toEqual(['Klassenfahrt Berlin.zip'])

    // ---- read by other tools: originals, song, export, read-me, project; not the left-out photo
    const extracted = join(work, 'Entpackt', 'Klassenfahrt Berlin')
    const files = readAndExtract(zip, extracted)
    const kept = media.map((m) => basename(m)).filter((n) => n !== leftOut)
    expect(files.filter((f) => f.startsWith('media/')).map((f) => f.slice(6)).sort()).toEqual(kept.sort())
    expect(files).toContain('music/track1.mp3')
    expect(files).toContain(`videos/${basename(exported)}`)
    expect(files).toContain('Klassenfahrt Berlin.dshow')
    const readmeName = files.find((f) => f === 'LIESMICH.txt' || f === 'README.txt')!
    expect(readmeName).toBe(LANG === 'en' ? 'README.txt' : 'LIESMICH.txt')
    const readme = readFileSync(join(extracted, readmeName), 'utf8')
    expect(readme).toMatch(/Klassenfahrt Berlin\.dshow/)
    expect(readme).toMatch(/2027/)
    expect(duration(join(extracted, 'videos', basename(exported)))).toBeGreaterThan(5)

    // ---- another PC: the originals are not there; "Open project…" on the extracted folder
    renameSync(originals, `${originals}-weg`)
    s = await launch(dataB, LOCALE)
    const pageB = s.page
    await answerOpenDialog(s.app, [join(extracted, 'Klassenfahrt Berlin.dshow')])
    await pageB.locator('.home .hero button').filter({ hasText: /Projekt öffnen|Open project/ }).click()
    await expect.poll(async () => (await project(pageB))?.name, { timeout: 30_000 }).toBe('Klassenfahrt Berlin')
    const b = await expectReady(pageB)
    expect(b.media).toHaveLength(a.media.length - 1)
    for (const m of b.media) {
      expect(m.path.startsWith(join(extracted, 'media') + sep)).toBe(true)
      if (m.live) expect(m.live.source.startsWith(join(extracted, 'media') + sep)).toBe(true)
    }
    expect(b.media.some((m: any) => m.live)).toBe(a.media.some((m: any) => m.live))
    expect(b.media.some((m: any) => m.kind === 'video')).toBe(true)
    expect(b.music.map((t: any) => t.path)).toEqual([join(extracted, 'music', 'track1.mp3')])
    expect(b.deleteAt).toBe(DELETE_AT)
    expect(b.entries.some((e: any) => e.excluded)).toBe(false)
    // the left-out photo was not in the show before either
    expect(await pageB.evaluate(() => (window as any).__diashow.player.current.tl.slides.length)).toBe(slidesA)
    await expect.poll(() => musicFiles(pageB)).toEqual(['track1.mp3'])

    // it plays and exports
    await pageB.evaluate(() => {
      const pl = (window as any).__diashow.player.current
      pl.seek(0)
      pl.play()
    })
    await expect.poll(() => pageB.evaluate(() => (window as any).__diashow.player.current.t), { timeout: 15_000 }).toBeGreaterThan(1)
    await pageB.evaluate(() => (window as any).__diashow.player.current.pause())
    const again = await exportShow(pageB, join(work, 'Videos', 'wieder.mp4'), 'wieder')
    expect(duration(again)).toBeGreaterThan(5)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(work)
  }
})

test('a show with theme music: the theme song goes into the archive and plays after opening', async () => {
  test.setTimeout((SOFTWARE_GL ? 15 : 8) * 60 * 1000)
  ensureTestMedia()
  const work = mkdtempSync(join(tmpdir(), 'diashow-archive-theme-'))
  const zip = join(work, 'Themenmusik.zip')
  let s: Session | null = null
  try {
    const media = copyMedia(sampleFiles(), join(work, 'Fotos'))
    s = await launch(join(work, 'pc-a'), LOCALE)
    await s.page.evaluate(async (paths) => {
      await (window as any).__diashow.store.getState().createProject(paths, 'Themenmusik')
    }, media)
    await waitProcessed(s.page)
    await expect.poll(() => musicFiles(s!.page), { timeout: 30_000 }).toEqual(['kenburns.m4a'])

    // ---- from the project card on the home screen
    await s.page.evaluate(() => (window as any).__diashow.store.getState().closeProject())
    const card = s.page.locator('.project').filter({ hasText: 'Themenmusik' })
    await card.hover()
    await card.screenshot({ path: join(shots, `card-${LANG}.png`) })
    await card.locator('button.archive').click()
    const dialog = s.page.getByTestId('archive-dialog')
    await expect(dialog.getByTestId('archive-theme')).toBeVisible()
    await expect(dialog.getByTestId('archive-video')).toHaveCount(0)
    await answerSaveDialog(s.app, zip)
    await dialog.getByTestId('archive-run').click()
    await expect(dialog.getByTestId('archive-summary')).toBeVisible({ timeout: 120_000 })
    await dialog.locator('.actions .btn.primary').click()
    expect(s.errors).toEqual([])
    await s.app.close()
    s = null

    const extracted = join(work, 'Entpackt')
    const files = readAndExtract(zip, extracted)
    expect(files).toContain('music/kenburns.m4a')
    expect(readFileSync(join(extracted, 'music', 'kenburns.m4a'))).toEqual(readFileSync(join(root, 'resources', 'theme-music', 'kenburns.m4a')))
    const dshow = join(extracted, 'Themenmusik.dshow')
    expect(JSON.parse(readFileSync(dshow, 'utf8')).archivedThemeSong).toMatchObject({ path: 'music/kenburns.m4a' })

    // ---- opened with this app: its own theme song plays, as before
    s = await launch(join(work, 'pc-b'), LOCALE)
    await answerOpenDialog(s.app, [dshow])
    await s.page.locator('.home .hero button').filter({ hasText: /Projekt öffnen|Open project/ }).click()
    await expect.poll(async () => (await project(s!.page))?.name, { timeout: 30_000 }).toBe('Themenmusik')
    const same = await expectReady(s.page)
    expect(same.music).toEqual([])
    expect(same.settings.themeMusic).toBe(true)
    expect(same.archivedThemeSong).toBeUndefined()
    await expect.poll(() => musicFiles(s!.page)).toEqual(['kenburns.m4a'])
    expect(await s.page.evaluate(() => !!(window as any).__diashow.player.current.tl.themeSong)).toBe(true)

    // ---- the archived copy differs from the app's song (a later version with other songs): it plays
    copyFileSync(join(root, 'resources', 'theme-music', 'origami.m4a'), join(extracted, 'music', 'kenburns.m4a'))
    await s.page.evaluate(() => (window as any).__diashow.store.getState().closeProject())
    await s.page.locator('.home .hero button').filter({ hasText: /Projekt öffnen|Open project/ }).click()
    await expect.poll(async () => (await project(s!.page))?.music?.length ?? 0, { timeout: 30_000 }).toBe(1)
    const other = await expectReady(s.page)
    expect(other.music[0].path).toBe(join(extracted, 'music', 'kenburns.m4a'))
    expect(other.settings.audio.repeatMusic).toBe(true)
    expect(existsSync(other.music[0].path)).toBe(true)
    await expect.poll(() => s!.page.evaluate(() => (window as any).__diashow.player.current.plan.clips.filter((c: any) => c.kind === 'music').map((c: any) => c.src))).toContain(join(extracted, 'music', 'kenburns.m4a'))
    expect(await s.page.evaluate(() => !!(window as any).__diashow.player.current.tl.themeSong)).toBe(false)
    expect(s.errors).toEqual([])
  } finally {
    await s?.app.close().catch(() => {})
    removeDir(work)
  }
})
