// The music library end to end: more bundled songs per theme and songs by mood. The assistant keeps
// the theme's song and offers "More music"; the Music tab chooses another song of the theme (mouse
// and keyboard), filters by mood and chooses a song of no theme; "Add to my music" makes a bundled
// song an own song of the playlist (trimmed like any other), which the export plays and "Pack
// project" copies. Works in German and English (DIASHOW_LOCALE).
import { expect, test, type Page } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answerOpenDialog, copyMedia, ensureTestMedia, launch, project, removeDir, root, sampleFiles, waitProcessed, waitSaved } from './harness'
import { EXPORT_SIZE, SOFTWARE_GL } from './launch'

const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')
const ffprobe = join(root, 'vendor/ffmpeg/bin/ffprobe.exe')

/** The music clips of the preview's audio plan: file name and offset (each once: songs repeat in a long show). */
const musicClips = (page: Page): Promise<{ file: string; offset: number }[]> =>
  page.evaluate(() => {
    const clips = (window as any).__diashow.player.current.plan.clips.filter((c: any) => c.kind === 'music')
    const seen = new Set<string>()
    return clips
      .map((c: any) => ({ file: c.src.split(/[\\/]/).pop(), offset: Math.round(c.offset * 1000) / 1000 }))
      .filter((c: { file: string }) => !seen.has(c.file) && !!seen.add(c.file))
  })
const musicFiles = async (page: Page): Promise<string[]> => (await musicClips(page)).map((c) => c.file)
const settings = async (page: Page): Promise<any> => (await project(page)).settings

test('music library: songs per theme, by mood, in the assistant, added to the own music, exported and packed', async () => {
  test.setTimeout((SOFTWARE_GL ? 25 : 10) * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-library-'))
  const folder = join(dataDir, 'Klassenfahrt')
  copyMedia(sampleFiles(), folder)
  const { app, page, errors } = await launch(dataDir)
  let jobId: string | null = null
  try {
    const catalogue: { song: string; themes: string[]; moods: string[]; title: string; path: string }[] = await page.evaluate(() =>
      (window as any).__diashow.store.getState().themeTracks.map((t: any) => ({ song: t.song, themes: t.themes, moods: t.moods, title: t.title, path: t.path }))
    )
    const titleOf = (song: string): string => catalogue.find((s) => s.song === song)!.title
    expect(catalogue.filter((s) => s.themes.includes('kenburns')).map((s) => s.song)).toEqual(['kenburns', 'kenburns-2', 'kenburns-3'])
    expect(catalogue.find((s) => s.song === 'festive-1')).toMatchObject({ themes: [], moods: expect.arrayContaining(['festive']) })
    const row = (song: string) => page.locator(`[data-testid="song-row"][data-song="${song}"]`)

    // ---- the assistant: the theme's song is the default, "More music" opens the chooser
    await page.getByRole('button', { name: /^(Neue Diashow mit Assistent…|New slideshow with assistant…)$/ }).click()
    const wizard = page.getByTestId('wizard')
    await expect(wizard).toBeVisible()
    await answerOpenDialog(app, [folder])
    await wizard.getByRole('button', { name: /^(Ordner auswählen…|Choose a folder…)$/ }).click()
    await expect(wizard).toHaveAttribute('data-step', '2', { timeout: 60_000 })
    await expect(wizard.getByTestId('wizard-theme-music')).toBeChecked()
    await expect(wizard.locator('.wizard-theme-song')).toContainText(titleOf('kenburns'))
    await expect(wizard.getByTestId('song-chooser')).toHaveCount(0)
    const more = wizard.getByTestId('wizard-more-music')
    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(wizard.locator('[data-testid="song-row"][data-song="auto"]').getByRole('radio')).toBeChecked()
    await wizard.locator('[data-testid="song-row"][data-song="kenburns-3"]').getByRole('radio').check()
    await expect.poll(async () => (await settings(page)).themeSong).toBe('kenburns-3')
    await expect(wizard.locator('.wizard-theme-song')).toContainText(titleOf('kenburns-3'))
    await wizard.getByRole('button', { name: /^(Überspringen|Skip)$/ }).last().click()
    await expect(wizard).toHaveCount(0)
    await waitProcessed(page)
    expect(await settings(page)).toMatchObject({ theme: 'kenburns', themeMusic: true, themeSong: 'kenburns-3' })
    await expect.poll(() => musicFiles(page), { timeout: 30_000 }).toEqual(['kenburns-3.m4a'])

    // ---- the Music tab: the theme's songs first, chosen with the mouse
    await page.getByRole('tab', { name: /^(Musik|Music)$/ }).click()
    const list = page.getByTestId('song-list')
    await expect(list).toBeVisible()
    await expect(row('kenburns-3').getByRole('radio')).toBeChecked()
    const order = await list.getByTestId('song-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-song')))
    expect(order.slice(0, 4)).toEqual(['auto', 'kenburns', 'kenburns-2', 'kenburns-3'])
    // then the other themes' songs, then the library (songs of no theme)
    const library = catalogue.filter((s) => !s.themes.length).map((s) => s.song)
    expect(order.slice(-library.length)).toEqual(library)
    expect(order.length).toBe(catalogue.length + 1)
    await row('kenburns-2').getByRole('radio').check()
    await expect.poll(async () => (await settings(page)).themeSong).toBe('kenburns-2')
    await expect.poll(() => musicFiles(page)).toEqual(['kenburns-2.m4a'])
    await expect(page.getByTestId('theme-credit')).toContainText(titleOf('kenburns-2'))

    // ---- and with the keyboard: one radio group, the arrow keys choose, Tab reaches the chosen song's Listen button
    await row('kenburns-2').getByRole('radio').focus()
    await page.keyboard.press('ArrowDown')
    await expect(row('kenburns-3').getByRole('radio')).toBeChecked()
    await expect(row('kenburns-3').getByRole('radio')).toBeFocused()
    await expect.poll(async () => (await settings(page)).themeSong).toBe('kenburns-3')
    await page.keyboard.press('Tab')
    const listen = row('kenburns-3').getByTestId('song-listen')
    await expect(listen).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(listen).toHaveAccessibleName(/^(Stopp|Stop): /)
    await page.keyboard.press('Enter')
    await expect(listen).toHaveAccessibleName(/^(Anhören|Listen): /)
    // only the chosen row's Listen button is a Tab stop
    expect(await list.getByTestId('song-listen').evaluateAll((b) => b.filter((x) => (x as HTMLElement).tabIndex === 0).length)).toBe(1)

    // ---- the library by mood: a festive song of no theme
    const chip = page.getByTestId('mood-festive')
    await chip.click()
    await expect(chip).toHaveAttribute('aria-pressed', 'true')
    const festive = catalogue.filter((s) => s.moods.includes('festive')).map((s) => s.song)
    await expect(list.getByTestId('song-row')).toHaveCount(festive.length + 1)
    await expect(row('kenburns-2')).toHaveCount(0)
    await row('festive-1').getByRole('radio').check()
    await expect.poll(async () => (await settings(page)).themeSong).toBe('festive-1')
    await expect.poll(() => musicFiles(page)).toEqual(['festive-1.m4a'])
    await page.getByTestId('mood-all').click()
    await expect(list.getByTestId('song-row')).toHaveCount(catalogue.length + 1)
    // a song of no theme stays when the theme changes; "Matches the theme" follows it again
    await page.getByRole('tab', { name: /^(Themen|Themes)$/ }).click()
    await page.locator('.theme-card', { hasText: /^Origami$/ }).click()
    await expect.poll(() => musicFiles(page)).toEqual(['festive-1.m4a'])
    await page.getByRole('tab', { name: /^(Musik|Music)$/ }).click()
    await expect(row('festive-1').getByRole('radio')).toBeChecked()
    await row('auto').getByRole('radio').check()
    await expect.poll(() => musicFiles(page)).toEqual(['origami.m4a'])
    await row('festive-1').getByRole('radio').check()
    await waitSaved(dataDir, (await project(page)).id, (p) => p.settings.themeSong === 'festive-1')

    // ---- "Add to my music": the bundled song becomes an own song of the playlist
    const add = page.getByTestId('song-add-own')
    await add.click()
    await expect.poll(async () => (await project(page)).music.length).toBe(1)
    await waitProcessed(page)
    const [song] = (await project(page)).music
    expect(song.path.split(/[\\/]/).slice(-2)).toEqual(['theme-music', 'festive-1.m4a'])
    expect(song).toMatchObject({ status: 'ready', title: titleOf('festive-1') })
    await expect(add).toBeDisabled()
    await expect(page.getByTestId('theme-music-own')).toBeVisible()
    await expect(page.locator('.track')).toHaveCount(1)
    await expect(page.locator('.track')).toContainText(titleOf('festive-1'))
    // it plays as an own song: own songs are trimmed, the theme song never is
    await page.evaluate(() => (window as any).__diashow.store.getState().update((p: any) => Object.assign(p.music[0], { trimIn: 4, trimOut: 30 })))
    await expect.poll(() => musicClips(page)).toEqual([{ file: 'festive-1.m4a', offset: 4 }])
    const lane = page.locator('svg.lane')
    await expect(lane.locator('text.title').first()).not.toHaveText(/^(Themenmusik|Theme music)/)

    // ---- the export plays it
    const show = await page.evaluate(() => {
      const d = (window as any).__diashow
      d.store.getState().setSettings({ timing: { mode: 'custom', customTotal: 12 } })
      return new Promise<number>((r) => setTimeout(() => r(d.player.current.tl.duration), 200))
    })
    expect(show).toBeCloseTo(12, 0)
    const out = join(dataDir, 'library.mp4')
    const info = await page.evaluate(
      ({ outPath, size }) => {
        const d = (window as any).__diashow
        return d.queueExport(d.store.getState().project, { outPath, ...size, fps: 30, codec: 'h264', quality: 'standard', hardware: true, locale: 'de-DE' }, 'Musikbibliothek')
      },
      { outPath: out, size: EXPORT_SIZE }
    )
    jobId = info.id as string
    const jobFile = join(await app.evaluate(({ app }) => app.getPath('userData')), 'exports', jobId, 'job.json')
    const job = JSON.parse(readFileSync(jobFile, 'utf8'))
    expect(job.themeSong).toBeUndefined()
    const srcs = job.audio.clips.filter((c: any) => c.kind === 'music').map((c: any) => c.src)
    expect(srcs.length).toBeGreaterThan(0)
    expect(srcs.every((s: string) => s.toLowerCase() === song.path.toLowerCase())).toBe(true)
    await expect
      .poll(() => page.evaluate((id) => (window as any).__diashow.store.getState().exportJobs.find((j: any) => j.id === id)?.state, jobId), { timeout: 600_000, intervals: [250] })
      .toBe('done')
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', out]).toString())
    expect(probe.streams.map((s: any) => s.codec_type).sort()).toEqual(['audio', 'video'])
    expect(Number(probe.format.duration)).toBeGreaterThan(show - 0.3)
    expect(Number(probe.format.duration)).toBeLessThan(show + 0.3)
    const detect = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', out, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
    const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(detect.stderr)?.[1])
    console.log(`export with a library song: ${probe.format.duration} s, mean volume ${mean} dB`)
    expect(mean).toBeGreaterThan(-40)

    // ---- "Pack project" copies it like any other song
    const packDir = join(dataDir, 'Packed')
    mkdirSync(packDir, { recursive: true })
    const dshow: string = await page.evaluate(async (dir) => {
      const w = window as any
      return w.api.packProject(w.__diashow.store.getState().project, dir)
    }, packDir)
    const packed = JSON.parse(readFileSync(dshow, 'utf8'))
    expect(packed.music.map((m: any) => m.path)).toEqual(['music/festive-1.m4a'])
    expect(readdirSync(join(dshow, '..', 'music'))).toEqual(['festive-1.m4a'])
    expect(existsSync(song.path)).toBe(true)
    expect(errors).toEqual([])
  } finally {
    if (jobId) await page.evaluate((id) => (window as any).api.queueRemove(id), jobId).catch(() => {})
    await app.close()
    removeDir(dataDir)
  }
})
