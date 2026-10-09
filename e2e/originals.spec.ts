// Real-world check with a folder of original phone/camera files (DIASHOW_ORIGINALS_DIR, read
// only). Imports everything, measures how long it takes, builds a Magazine show with chapters
// from the folder names and exports one day folder at 1080p. Skipped without the variable.
import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(__dirname, '..')
const dir = process.env.DIASHOW_ORIGINALS_DIR
const out = join(root, 'test-results', 'originals')
const ffprobe = join(root, 'vendor/ffmpeg/bin/ffprobe.exe')
const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')

test.setTimeout(3 * 60 * 60 * 1000)

test('original files: import, big show, export one day', async () => {
  test.skip(!dir, 'DIASHOW_ORIGINALS_DIR not set')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-orig-'))
  const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, DIASHOW_DATA_DIR: dataDir } })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForFunction(() => !!(window as any).__diashow)

  // ---- whole folder
  const t0 = Date.now()
  await page.evaluate(async (d) => (window as any).__diashow.store.getState().createProject([d], 'Skicamp 2026 (alle)'), dir!)
  const listed = Date.now() - t0
  const stat = () =>
    page.evaluate(() => {
      const p = (window as any).__diashow.store.getState().project
      const photos = p.media.filter((m: any) => m.kind === 'photo')
      const videos = p.media.filter((m: any) => m.kind === 'video')
      return {
        photos: photos.length,
        videos: videos.length,
        thumbs: p.media.filter((m: any) => m.thumb).length,
        photosReady: photos.filter((m: any) => m.status === 'ready' || m.status === 'error').length,
        videosReady: videos.filter((m: any) => m.status === 'ready' || m.status === 'error').length,
        errors: p.media.filter((m: any) => m.status === 'error').map((m: any) => `${m.name}: ${m.error}`)
      }
    })
  let s = await stat()
  let thumbsAt = 0
  let photosAt = 0
  while (Date.now() - t0 < 60 * 60 * 1000) {
    s = await stat()
    if (!thumbsAt && s.thumbs >= s.photos + s.videos) thumbsAt = Date.now() - t0
    if (!photosAt && s.photosReady === s.photos) photosAt = Date.now() - t0
    if (photosAt && s.videosReady === s.videos) break
    await page.waitForTimeout(2000)
  }
  const allAt = Date.now() - t0
  console.log(`import: ${s.photos} photos, ${s.videos} videos; listed after ${(listed / 1000).toFixed(1)} s, thumbnails ${(thumbsAt / 1000).toFixed(0)} s, photos ready ${(photosAt / 1000).toFixed(0)} s, everything ${(allAt / 1000).toFixed(0)} s`)
  if (s.errors.length) console.log('errors:\n' + s.errors.join('\n'))

  const perf = await page.evaluate(async () => {
    const d = (window as any).__diashow
    const st = d.store.getState()
    st.setTheme('magazine')
    st.insertDayTitles('folder')
    await new Promise((r) => setTimeout(r, 500))
    const t1 = performance.now()
    st.setSettings({ look: 'warm' })
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    const edit = performance.now() - t1
    const tl = d.player.current.tl
    return { slides: tl.slides.length, duration: Math.round(tl.duration), editMs: Math.round(edit), titles: st.project ? d.store.getState().project.entries.filter((e: any) => e.auto === 'day').map((e: any) => `${e.title} – ${e.subtitle ?? ''}`) : [] }
  })
  console.log('big show', JSON.stringify(perf))
  await page.screenshot({ path: join(out, '_editor_all.png') })

  // ---- one day: Magazine with chapters, music, video sound, 1080p export
  const day = readdirSync(dir!).map((n) => join(dir!, n)).find((p) => statSync(p).isDirectory() && /2_/.test(p))!
  const music = readdirSync(dir!).filter((n) => /\.mp3$/i.test(n)).map((n) => join(dir!, n))
  await page.evaluate(async ({ d, m }) => {
    const st = (window as any).__diashow.store.getState()
    st.closeProject()
    await st.createProject([d], 'Skicamp 2026 – Sonntag')
    if (m.length) await (window as any).__diashow.store.getState().addMusic(m)
  }, { d: day, m: music })
  await page.waitForFunction(() => {
    const p = (window as any).__diashow.store.getState().project
    const done = (x: any) => x.status === 'ready' || x.status === 'error'
    return p && p.media.length && p.media.every(done) && p.music.every(done)
  }, null, { timeout: 30 * 60 * 1000, polling: 2000 })
  const show = await page.evaluate(async () => {
    const d = (window as any).__diashow
    const st = d.store.getState()
    st.setTheme('magazine')
    st.insertDayTitles('folder')
    st.setSettings({ timing: { mode: 'custom', customTotal: 90, beatSync: true }, playFullVideos: false })
    await new Promise((r) => setTimeout(r, 500))
    const p = d.store.getState().project
    const tl = d.player.current.tl
    return {
      items: p.media.length,
      slides: tl.slides.length,
      duration: Math.round(tl.duration),
      bpm: p.music.map((m: any) => m.bpm),
      faces: p.media.filter((m: any) => m.faces?.length).length,
      formats: [...new Set(p.media.map((m: any) => m.format))],
      devices: [...new Set(p.media.map((m: any) => m.device).filter(Boolean))]
    }
  })
  console.log('day show', JSON.stringify(show))
  const video = join(dataDir, 'sonntag.mp4')
  const t2 = Date.now()
  await page.evaluate(async (outPath) => {
    const d = (window as any).__diashow
    await d.exportShow(d.store.getState().project, { outPath, width: 1920, height: 1080, fps: 30, codec: 'h264', quality: 'high', hardware: true }, 'de-DE', () => {}, new AbortController().signal)
  }, video)
  console.log(`export took ${((Date.now() - t2) / 1000).toFixed(0)} s`)
  await page.screenshot({ path: join(out, '_editor_day.png') })
  await app.close()

  const probe = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'compact', video]).toString()
  console.log(probe)
  expect(probe).toContain('codec_type=audio')
  for (const [i, t] of [5, 20, 35, 50, 65, 80].entries()) {
    execFileSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', video, '-frames:v', '1', '-y', join(out, `day-${i}.jpg`)])
  }
  rmSync(dataDir, { recursive: true, force: true })
  expect(errors).toEqual([])
})
