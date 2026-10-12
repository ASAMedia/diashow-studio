// The demo video on the website (docs/media/demo.mp4, with its poster frame docs/media/demo.jpg), made
// by the app itself from the sample trip. Only runs on request:
//
//   npm run samples          (once: the sample trip, see scripts/samples.mjs)
//   npx electron-vite build && DIASHOW_DEMO_VIDEO=1 npx playwright test e2e/demo-video.spec.ts
//
// The show: about a dozen photos and two short clips of four days in Ken Burns with its theme song. The
// title "Studienfahrt Athen 2026" stands on the first photo, the other three days start with short
// chapter slides from the folder names. The Frans Hals couple has both faces pixelated (the privacy
// feature), and end credits roll at the end. It is exported like a user would
// (1280×720, H.264 + AAC, quality "high"); a video over the size budget for the website is encoded
// again with FFmpeg at a bit rate that fits it. The result is checked with ffprobe, and frames of it
// are saved to test-results/demo-video/ for a look.
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { launchOptions } from './launch'

const root = resolve(__dirname, '..')
const ffmpeg = join(root, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const ffprobe = join(root, 'vendor', 'ffmpeg', 'bin', 'ffprobe.exe')
const outDir = join(root, 'docs', 'media')
const frames = join(root, 'test-results', 'demo-video')
/** The website keeps the video under this size (bytes). */
const MAX_BYTES = 15 * 1000 * 1000
/** Length of the show in seconds (photos share what the title, chapters, clips and credits leave). */
const TOTAL = 74
/** Seconds of each chapter slide. */
const CHAPTER = 2.6
/** When the poster frame is taken (seconds): the title on the first photo. */
const POSTER_AT = 3.2
/** The theme of the show (DIASHOW_DEMO_THEME tries another one). */
const THEME = process.env.DIASHOW_DEMO_THEME ?? 'kenburns'

interface SampleItem {
  id: string
  file: string
  folder: string
}
interface SampleTrip {
  title: { de: string }
  folder: string
  items: SampleItem[]
}

/** The story of the video: four of the five days, in the order of the trip. */
const STORY = [
  'tuebingen-station', 'train-departure', 'acropolis-moon',
  'agora-church', 'zeus-columns-evening', 'souvlaki',
  'gold-mask', 'hals-couple', 'spring-fresco',
  'piraeus-ferry', 'fishing-boat', 'waves', 'aegina-sunset', 'fireworks'
]

/** The end credits; {song}, {artist} and {licence} are the theme song's. */
const CREDITS = {
  title: 'Danke fürs Zuschauen!',
  lines: ['Fotos und Videos: Wikimedia Commons (CC0 und gemeinfrei)', 'Musik: „{song}“ von {artist} ({licence})', '', 'Erstellt mit Diashow Studio']
}

const state = <T,>(page: Page, body: string): Promise<T> =>
  page.evaluate(`(async () => { const d = window.__diashow; const s = d.store.getState(); ${body} })()`) as Promise<T>

const probe = (file: string): any => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }))

/** One frame of a video as a JPEG of the given width. */
async function frameAt(file: string, at: number, width: number, quality = 82): Promise<Buffer> {
  const png = execFileSync(ffmpeg, ['-v', 'error', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { maxBuffer: 1 << 26 })
  return sharp(png).resize({ width }).jpeg({ quality, mozjpeg: true }).toBuffer()
}

test('demo video for the website', async () => {
  test.skip(!process.env.DIASHOW_DEMO_VIDEO, 'set DIASHOW_DEMO_VIDEO=1 to make the demo video of the website')
  test.setTimeout(20 * 60 * 1000)
  const trip: SampleTrip = JSON.parse(readFileSync(join(root, 'samples', 'samples.json'), 'utf8'))
  const dir = join(root, 'samples', 'media', trip.folder)
  const files = STORY.map((id) => {
    const it = trip.items.find((i) => i.id === id)
    if (!it) throw new Error(`no sample "${id}"`)
    return join(dir, it.folder, it.file)
  })
  const missing = files.filter((f) => !existsSync(f))
  if (missing.length) throw new Error(`the sample trip is missing (npm run samples): ${missing.length} files, e.g. ${missing[0]}`)
  const fileOf = (id: string): string => trip.items.find((i) => i.id === id)!.file

  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-demo-'))
  const raw = join(dataDir, 'demo-app.mp4')
  const opts = launchOptions(root, dataDir)
  opts.env.DIASHOW_LOCALE = 'de-DE'
  delete opts.env.DIASHOW_UPDATE_URL
  const app = await electron.launch(opts)
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => !!(window as any).__diashow)
    // the first-run assistant would only cover the window
    const wizard = page.getByTestId('wizard')
    await wizard.waitFor({ state: 'visible', timeout: 10_000 }).then(
      () => wizard.locator('button').filter({ hasText: /Überspringen|Skip/ }).first().click(),
      () => {}
    )

    // ---- the show: the story's files, chapters from the day folders
    await page.evaluate(({ files, name }) => (window as any).__diashow.store.getState().createProject(files, name), { files, name: trip.title.de })
    await page.waitForFunction(
      () => {
        const p = (window as any).__diashow.store.getState().project
        const done = (x: { status: string }) => x.status === 'ready' || x.status === 'error'
        return !!p && p.media.length > 0 && p.media.every(done)
      },
      null,
      { timeout: 300_000, polling: 250 }
    )
    expect(await state<string[]>(page, `return s.project.media.filter((m) => m.status !== 'ready').map((m) => m.name)`)).toEqual([])
    // the first day needs none: the show's title stands on its first photo
    await state(
      page,
      `s.insertDayTitles('folder'); d.store.getState().update((p) => { p.entries.splice(p.entries.findIndex((e) => e.type === 'text'), 1); p.entries.forEach((e) => e.type === 'text' && (e.duration = ${CHAPTER})) })`
    )
    const chapters = await state<string[]>(page, `return s.project.entries.filter((e) => e.type === 'text').map((e) => e.title + ' – ' + e.subtitle)`)
    console.log('chapters:', chapters.join(', '))
    expect(chapters).toHaveLength(3)

    // ---- the theme with its theme song, the show's title, short clips
    await state(
      page,
      `s.setTheme(${JSON.stringify(THEME)}); d.store.getState().setSettings({ themeMusic: true, themeSong: 'auto', showTitle: true, titleStyle: 'handwriting', maxVideoSeconds: 5, timing: { mode: 'custom', customTotal: ${TOTAL} } })`
    )
    // the passing train is loud: only the waves are heard (the music ducks under them)
    await state(page, `const m = s.project.media.find((x) => x.name === ${JSON.stringify(fileOf('train-departure'))}); const e = s.project.entries.find((x) => x.mediaId === m.id); s.setEntry(e.id, { muted: true })`)

    // ---- privacy: both faces of the painting pixelated, as a teacher would for pupils without consent
    const hals = await state<string>(page, `const m = s.project.media.find((x) => x.name === ${JSON.stringify(fileOf('hals-couple'))}); const e = s.project.entries.find((x) => x.mediaId === m.id); s.select([e.id]); s.set({ tab: 'slide', privacyEdit: e.id }); return e.id`)
    const editor = page.locator('.privacy-edit')
    await expect(editor).toBeVisible()
    await expect(editor.locator('.privacy-hint')).not.toContainText(/läuft noch/, { timeout: 120_000 })
    await expect.poll(() => editor.locator('.privacy-face-wrap').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
    await editor.locator('.kb-bar button').filter({ hasText: /Alle verpixeln/ }).click()
    await expect.poll(() => state<number>(page, `return s.project.entries.find((e) => e.id === ${JSON.stringify(hals)}).privacy?.length ?? 0`)).toBeGreaterThanOrEqual(2)
    await editor.locator('.kb-bar .btn.primary').click()
    await expect(editor).toHaveCount(0)

    // ---- rolling end credits
    await state(
      page,
      `const song = d.player.current.tl.themeSong; const lines = ${JSON.stringify(CREDITS.lines.join('\n'))}.replace('{song}', song.title).replace('{artist}', song.artist).replace('{licence}', song.licence); s.addCredits(); const e = d.store.getState().project.entries.at(-1); d.store.getState().setEntry(e.id, { title: ${JSON.stringify(CREDITS.title)}, subtitle: lines })`
    )
    await page.waitForTimeout(500)
    const plan = await state<{ duration: number; slides: string[] }>(
      page,
      `const tl = d.player.current.tl; return { duration: tl.duration, slides: tl.slides.map((x) => x.kind + ' ' + x.duration.toFixed(1) + (x.title ? ' ' + x.title.text : '')) }`
    )
    console.log(`show: ${plan.duration.toFixed(1)} s\n  ${plan.slides.join('\n  ')}`)

    // ---- export as a user would: 720p, quality "high"
    const job = await page.evaluate(
      ({ outPath, name }) => {
        const d = (window as any).__diashow
        return d.queueExport(d.store.getState().project, { outPath, width: 1280, height: 720, fps: 30, codec: 'h264', quality: 'high', hardware: true, locale: 'de-DE' }, name)
      },
      { outPath: raw, name: trip.title.de }
    )
    await expect
      .poll(() => page.evaluate((id) => (window as any).__diashow.store.getState().exportJobs.find((j: any) => j.id === id)?.state, job.id), { timeout: 900_000, intervals: [1000] })
      .toBe('done')
  } finally {
    await app.close()
  }

  try {
    // ---- the website's copy: picture and sound only (the chapter marks are a text track browsers
    // don't need), as exported when it fits, else encoded again to fit
    mkdirSync(outDir, { recursive: true })
    const target = join(outDir, 'demo.mp4')
    const info = probe(raw)
    const seconds = Number(info.format.duration)
    console.log(`exported: ${(statSync(raw).size / 1e6).toFixed(1)} MB, ${seconds.toFixed(1)} s`)
    const streams = ['-map', '0:v:0', '-map', '0:a:0', '-map_chapters', '-1']
    if (statSync(raw).size <= MAX_BYTES) execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', raw, ...streams, '-c', 'copy', '-movflags', '+faststart', target])
    else {
      // two passes at the bit rate that fills 95 % of the budget, sound as AAC 128 kbit/s
      const kbps = Math.floor(((MAX_BYTES * 0.95 * 8) / seconds - 128_000) / 1000)
      const pass = join(dataDir, 'x264')
      const common = ['-v', 'error', '-y', '-i', raw, ...streams, '-c:v', 'libx264', '-preset', 'slow', '-b:v', `${kbps}k`, '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-passlogfile', pass]
      execFileSync(ffmpeg, [...common, '-pass', '1', '-an', '-f', 'mp4', 'NUL'], { cwd: dataDir })
      execFileSync(ffmpeg, [...common, '-pass', '2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', target], { cwd: dataDir })
      console.log(`encoded again at ${kbps} kbit/s`)
    }

    // ---- checks: 1280×720 H.264 with AAC, the planned length, within the budget
    const out = probe(target)
    const video = out.streams.find((s: any) => s.codec_type === 'video')
    const audio = out.streams.find((s: any) => s.codec_type === 'audio')
    const bytes = statSync(target).size
    console.log(`docs/media/demo.mp4: ${(bytes / 1e6).toFixed(2)} MB, ${Number(out.format.duration).toFixed(1)} s, ${video.codec_name} ${video.width}x${video.height} ${video.r_frame_rate}, ${audio?.codec_name} ${audio?.sample_rate} Hz`)
    expect(bytes).toBeLessThanOrEqual(MAX_BYTES)
    expect([video.codec_name, video.width, video.height]).toEqual(['h264', 1280, 720])
    expect(audio?.codec_name).toBe('aac')
    expect(Math.abs(Number(out.format.duration) - TOTAL)).toBeLessThan(8)

    // ---- poster frame, and frames for a look
    writeFileSync(join(outDir, 'demo.jpg'), await frameAt(target, POSTER_AT, 1280, 80))
    rmSync(frames, { recursive: true, force: true })
    mkdirSync(frames, { recursive: true })
    const duration = Number(out.format.duration)
    for (let t = 1; t < duration; t += 3) writeFileSync(join(frames, `t${String(Math.round(t)).padStart(3, '0')}.jpg`), await frameAt(target, t, 640, 75))
    console.log(`poster: ${(statSync(join(outDir, 'demo.jpg')).size / 1000).toFixed(0)} kB; frames in ${frames}`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
  }
})
