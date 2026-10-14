// Theme music end to end: a new show plays its theme's song (audio lane, preview), switching the
// theme or picking another song changes it, music of its own replaces it and brings it back when
// removed, an older project stays silent until switched on, and an export carries the song (audible,
// as long as the show). Works in German and English (DIASHOW_LOCALE).
import { expect, test, type Page } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyMedia, ensureTestMedia, launch, project, projectFile, removeDir, root, sampleFiles, waitProcessed, waitSaved } from './harness'
import { EXPORT_SIZE, SOFTWARE_GL } from './launch'

const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')
const ffprobe = join(root, 'vendor/ffmpeg/bin/ffprobe.exe')

/** File names of the music in the preview's audio plan (each once: songs repeat in a long show). */
const musicFiles = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...new Set<string>((window as any).__diashow.player.current.plan.clips.filter((c: any) => c.kind === 'music').map((c: any) => c.src.split(/[\\/]/).pop()))])
const settings = async (page: Page): Promise<any> => (await project(page)).settings

test('theme music: plays by default, follows the theme, gives way to own music, exports', async () => {
  test.setTimeout((SOFTWARE_GL ? 25 : 10) * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-theme-'))
  const files = copyMedia(sampleFiles(), join(dataDir, 'media'))
  const [song] = copyMedia(['music/track1.mp3'], join(dataDir, 'music'))
  const { app, page, errors } = await launch(dataDir)
  let jobId: string | null = null
  try {
    // ---- a new show plays its theme's song
    await page.evaluate(async (paths) => {
      await (window as any).__diashow.store.getState().createProject(paths, 'Themenmusik')
    }, files)
    await waitProcessed(page)
    expect(await settings(page)).toMatchObject({ theme: 'kenburns', themeMusic: true, themeSong: 'auto' })
    await expect.poll(() => musicFiles(page), { timeout: 30_000 }).toEqual(['kenburns.m4a'])
    // the audio lane shows it like a song: title, waveform and beats
    const lane = page.locator('svg.lane')
    await expect(lane.locator('text.title').first()).toHaveText(/^(Themenmusik|Theme music): /)
    await expect.poll(() => lane.locator('path.wave').count(), { timeout: 60_000 }).toBeGreaterThan(0)
    expect(await lane.locator('line.beat').count()).toBeGreaterThan(5)

    // the preview plays it
    await page.evaluate(() => {
      const pl = (window as any).__diashow.player.current
      pl.seek(0)
      pl.play()
    })
    const playing = (): Promise<{ time: number; error: number } | null> =>
      page.evaluate(() => {
        const nodes = [...(window as any).__diashow.player.current.nodes.values()] as { src: string; el: HTMLAudioElement }[]
        const n = nodes.find((x) => /kenburns\.m4a$/.test(x.src))
        return n ? { time: n.el.currentTime, error: n.el.error?.code ?? 0 } : null
      })
    await expect.poll(async () => (await playing())?.time ?? 0, { timeout: 30_000, intervals: [250] }).toBeGreaterThan(1)
    expect((await playing())?.error).toBe(0)
    await page.evaluate(() => (window as any).__diashow.player.current.pause())

    // ---- switching the theme switches the song
    await page.locator('.theme-card', { hasText: /^Origami$/ }).click()
    await expect.poll(() => musicFiles(page)).toEqual(['origami.m4a'])

    // ---- the Music tab: another theme's song, and listening to it
    await page.getByRole('tab', { name: /^(Musik|Music)$/ }).click()
    const row = (song: string) => page.locator(`[data-testid="song-row"][data-song="${song}"]`)
    await expect(row('auto').getByRole('radio')).toBeChecked()
    await expect(page.getByTestId('theme-music-on')).toBeChecked()
    await row('vintage').getByRole('radio').check()
    await expect.poll(async () => (await settings(page)).themeSong).toBe('vintage')
    await expect.poll(() => musicFiles(page)).toEqual(['vintage.m4a'])
    await expect(page.getByTestId('theme-credit')).toContainText(/frei nutzbar \(CC0 \/ gemeinfrei\)|free to use \(CC0 \/ public domain\)/)
    const listen = row('vintage').getByTestId('song-listen')
    await listen.click()
    await expect(listen).toHaveAccessibleName(/^(Stopp|Stop): /)
    await listen.click()
    await expect(listen).toHaveAccessibleName(/^(Anhören|Listen): /)
    await row('auto').getByRole('radio').check()
    await expect.poll(() => musicFiles(page)).toEqual(['origami.m4a'])

    // ---- music of its own replaces the theme song; removing it brings the theme song back
    await page.evaluate(async (p) => (window as any).__diashow.store.getState().addMusic([p]), song)
    await waitProcessed(page)
    await expect.poll(() => musicFiles(page)).toEqual(['track1.mp3'])
    await expect(page.getByTestId('theme-music-own')).toBeVisible()
    await expect(lane.locator('text.title').first()).not.toHaveText(/^(Themenmusik|Theme music)/)
    await page.locator('.track').getByRole('button', { name: /^(Song entfernen|Remove song)/ }).click()
    await expect.poll(() => musicFiles(page)).toEqual(['origami.m4a'])
    await expect(page.getByTestId('theme-music-own')).toHaveCount(0)

    // ---- an older project without the fields stays silent until theme music is switched on
    const old = await project(page)
    expect(old.settings.theme).toBe('origami')
    delete old.settings.themeMusic
    delete old.settings.themeSong
    old.id = 'olderShow'
    old.name = 'Older show'
    writeFileSync(projectFile(dataDir, old.id), JSON.stringify(old))
    await page.evaluate(() => (window as any).__diashow.store.getState().openProject('olderShow'))
    await expect.poll(async () => (await project(page)).id).toBe('olderShow')
    expect((await settings(page)).themeMusic).toBeUndefined()
    await expect.poll(() => musicFiles(page)).toEqual([])
    await expect(lane.locator('text.title')).toHaveCount(0)
    await page.getByRole('tab', { name: /^(Musik|Music)$/ }).click()
    const on = page.getByTestId('theme-music-on')
    await expect(on).not.toBeChecked()
    await on.check()
    await expect.poll(() => musicFiles(page)).toEqual(['origami.m4a'])
    await waitSaved(dataDir, 'olderShow', (p) => p.settings.themeMusic === true && p.settings.themeSong === 'auto')

    // ---- the export carries the theme song: audible, as long as the show
    const show = await page.evaluate(() => {
      const d = (window as any).__diashow
      d.store.getState().setTheme('kenburns')
      d.store.getState().setSettings({ timing: { mode: 'custom', customTotal: 12 } })
      return new Promise<number>((r) => setTimeout(() => r(d.player.current.tl.duration), 200))
    })
    expect(show).toBeCloseTo(12, 0)
    const out = join(dataDir, 'theme.mp4')
    const info = await page.evaluate(
      ({ outPath, size }) => {
        const d = (window as any).__diashow
        return d.queueExport(d.store.getState().project, { outPath, ...size, fps: 30, codec: 'h264', quality: 'standard', hardware: true, locale: 'de-DE' }, 'Themenmusik')
      },
      { outPath: out, size: EXPORT_SIZE }
    )
    jobId = info.id as string
    // the job keeps the theme song with its path, so it can continue after a restart
    const jobFile = join(await app.evaluate(({ app }) => app.getPath('userData')), 'exports', jobId, 'job.json')
    const job = JSON.parse(readFileSync(jobFile, 'utf8'))
    expect(job.themeSong).toMatchObject({ song: 'kenburns', themes: ['kenburns'] })
    expect(existsSync(job.themeSong.path)).toBe(true)
    await expect
      .poll(() => page.evaluate((id) => (window as any).__diashow.store.getState().exportJobs.find((j: any) => j.id === id)?.state, jobId), { timeout: 600_000, intervals: [250] })
      .toBe('done')
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', out]).toString())
    expect(probe.streams.map((s: any) => s.codec_type).sort()).toEqual(['audio', 'video'])
    expect(Number(probe.format.duration)).toBeGreaterThan(show - 0.3)
    expect(Number(probe.format.duration)).toBeLessThan(show + 0.3)
    // silence would be about -91 dB; the theme song is normalised to -16 LUFS
    const detect = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', out, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
    const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(detect.stderr)?.[1])
    console.log(`export with theme music: ${probe.format.duration} s, mean volume ${mean} dB`)
    expect(mean).toBeGreaterThan(-40)
    expect(errors).toEqual([])
  } finally {
    if (jobId) await page.evaluate((id) => (window as any).api.queueRemove(id), jobId).catch(() => {})
    await app.close()
    removeDir(dataDir)
  }
})
