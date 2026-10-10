// Real-world check with a folder of original phone/camera files (DIASHOW_ORIGINALS_DIR, read
// only). Imports everything, measures how long it takes, builds a Magazine show with chapters
// from the folder names and exports one day folder at 1080p. Skipped without the variable.
// DIASHOW_ORIGINALS_IMPORT_ONLY=1 stops after the import measurement (no day show, no export) and
// prints a per-stage profile of the media pipeline (DIASHOW_MEDIA_TRACE, see src/main/media/trace.ts).
import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appArgs } from './launch'

const root = resolve(__dirname, '..')
const dir = process.env.DIASHOW_ORIGINALS_DIR
const importOnly = process.env.DIASHOW_ORIGINALS_IMPORT_ONLY === '1'
const out = process.env.DIASHOW_ORIGINALS_OUT ?? join(root, 'test-results', 'originals')
const ffprobe = join(root, 'vendor/ffmpeg/bin/ffprobe.exe')
const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')

test.setTimeout(3 * 60 * 60 * 1000)

interface TraceEvent {
  stage: string
  id?: string
  t0: number
  t1: number
  ok?: boolean
  [key: string]: unknown
}

/** Per stage: count, summed and wall-clock seconds, peak parallelism; plus why videos got a proxy. */
function traceSummary(file: string): string {
  if (!existsSync(file)) return '(no trace)'
  const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as TraceEvent)
  const start = Math.min(...events.filter((e) => e.stage === 'scan').map((e) => e.t0), Infinity)
  const base = Number.isFinite(start) ? start : Math.min(...events.map((e) => e.t0))
  const byStage = new Map<string, TraceEvent[]>()
  for (const e of events) byStage.set(e.stage, [...(byStage.get(e.stage) ?? []), e])
  const lines = ['stage                 n    sum s   from s     to s  peak  failed']
  for (const [stage, list] of [...byStage].sort((a, b) => Math.min(...a[1].map((e) => e.t0)) - Math.min(...b[1].map((e) => e.t0)))) {
    const sum = list.reduce((n, e) => n + (e.t1 - e.t0), 0) / 1000
    const from = (Math.min(...list.map((e) => e.t0)) - base) / 1000
    const to = (Math.max(...list.map((e) => e.t1)) - base) / 1000
    const edges = list.flatMap((e) => [[e.t0, 1], [e.t1, -1]] as Array<[number, number]>).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let cur = 0
    let peak = 0
    for (const [, d] of edges) peak = Math.max(peak, (cur += d))
    const failed = list.filter((e) => e.ok === false).length
    lines.push(`${stage.padEnd(20)} ${String(list.length).padStart(4)} ${sum.toFixed(1).padStart(8)} ${from.toFixed(1).padStart(8)} ${to.toFixed(1).padStart(8)} ${String(peak).padStart(5)} ${String(failed).padStart(7)}`)
  }
  const proxies = events.filter((e) => e.stage === 'video.proxy' || e.stage === 'live.proxy')
  const reasons = new Map<string, { n: number; media: number; wall: number }>()
  for (const e of proxies) {
    const key = `${e.stage} ${String(e.reason)} ${String(e.codec ?? '')} ${e.gpu ? 'gpu:' + String(e.gpu) : ''}`.trim()
    const r = reasons.get(key) ?? { n: 0, media: 0, wall: 0 }
    r.n++
    r.media += Number(e.duration) || 0
    r.wall += (e.t1 - e.t0) / 1000
    reasons.set(key, r)
  }
  lines.push('proxies by reason (count, media s, transcode s):')
  for (const [k, r] of reasons) lines.push(`  ${k}: ${r.n}, ${r.media.toFixed(0)} s, ${r.wall.toFixed(1)} s`)
  const longest = [...proxies].sort((a, b) => b.t1 - b.t0 - (a.t1 - a.t0)).slice(0, 5)
  lines.push('longest proxies: ' + longest.map((e) => `${String(e.reason)} ${Number(e.duration).toFixed(0)} s media → ${((e.t1 - e.t0) / 1000).toFixed(1)} s`).join('; '))
  lines.push(`direct-playable videos: ${events.filter((e) => e.stage === 'video.direct').length}`)
  return lines.join('\n')
}

test('original files: import, big show, export one day', async () => {
  test.skip(!dir, 'DIASHOW_ORIGINALS_DIR not set')
  if (!importOnly) {
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-orig-'))
  const traceFile = join(dataDir, 'trace.jsonl')
  const app = await electron.launch({ args: appArgs(), cwd: root, env: { ...process.env, DIASHOW_DATA_DIR: dataDir, DIASHOW_MEDIA_TRACE: traceFile } })
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
      const done = (m: any): boolean => m.status === 'ready' || m.status === 'error'
      const photos = p.media.filter((m: any) => m.kind === 'photo')
      const videos = p.media.filter((m: any) => m.kind === 'video')
      return {
        photos: photos.length,
        videos: videos.length,
        thumbs: p.media.filter((m: any) => m.thumb || m.status === 'error').length,
        displays: photos.filter((m: any) => m.display || m.status === 'error').length,
        photosReady: photos.filter(done).length,
        // Plays in the preview: playback set (and its sound extracted when it has some)
        playable: videos.filter((m: any) => m.status === 'error' || (m.playback && (!m.hasAudio || m.audio))).length,
        videosReady: videos.filter(done).length,
        loudness: videos.filter((m: any) => m.audio && m.loudness !== undefined).length,
        withAudio: videos.filter((m: any) => m.audio).length,
        hashes: p.media.filter((m: any) => m.hash).length,
        sharpness: photos.filter((m: any) => m.sharpness !== undefined).length,
        errors: p.media.filter((m: any) => m.status === 'error').map((m: any) => `${m.name}: ${m.error}`)
      }
    })
  let s = await stat()
  const at: Record<string, number> = {}
  const mark = (key: string, cond: boolean): void => {
    if (cond && at[key] === undefined) at[key] = Date.now() - t0
  }
  const total = (): number => s.photos + s.videos
  let lastLog = 0
  while (Date.now() - t0 < 60 * 60 * 1000) {
    s = await stat()
    mark('thumbs50', s.thumbs >= total() / 2)
    mark('thumbs', s.thumbs >= total())
    mark('displays', s.displays >= s.photos)
    mark('photos', s.photosReady >= s.photos)
    mark('playable', s.playable >= s.videos)
    mark('usable', s.thumbs >= total() && s.displays >= s.photos && s.playable >= s.videos)
    mark('videos', s.videosReady >= s.videos)
    if (at.photos !== undefined && s.videosReady >= s.videos) break
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now()
      console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s: thumbs ${s.thumbs}, displays ${s.displays}/${s.photos}, playable ${s.playable}/${s.videos}, videos ready ${s.videosReady}`)
    }
    await page.waitForTimeout(1000)
  }
  const allAt = Date.now() - t0
  const sec = (v: number | undefined): string => (v === undefined ? '–' : (v / 1000).toFixed(0))
  console.log(`import: ${s.photos} photos, ${s.videos} videos; listed after ${(listed / 1000).toFixed(1)} s, thumbnails ${(at.thumbs / 1000).toFixed(0)} s, photos ready ${(at.photos / 1000).toFixed(0)} s, everything ${(allAt / 1000).toFixed(0)} s`)
  console.log(
    `milestones (s): listed ${(listed / 1000).toFixed(1)}, half the thumbnails ${sec(at.thumbs50)}, all thumbnails ${sec(at.thumbs)}, photo displays ${sec(at.displays)}, ` +
      `photos ready ${sec(at.photos)}, videos playable ${sec(at.playable)}, show usable ${sec(at.usable)}, videos ready ${sec(at.videos)}, everything ${sec(allAt)}`
  )
  console.log(`analysis at the end: hashes ${s.hashes}/${total()}, sharpness ${s.sharpness}/${s.photos}, loudness ${s.loudness}/${s.withAudio}`)
  if (s.errors.length) console.log('errors:\n' + s.errors.join('\n'))

  if (importOnly) {
    // Analysis that may still run after the last item turned ready (silent clips never get a
    // loudness value): wait until nothing changed for 20 s
    const rest = Date.now()
    let key = ''
    let stableSince = Date.now()
    let analysedAt = 0
    while (Date.now() - rest < 10 * 60 * 1000 && Date.now() - stableSince < 20_000) {
      s = await stat()
      const k = `${s.hashes}/${s.sharpness}/${s.loudness}`
      if (k !== key) {
        key = k
        stableSince = Date.now()
        analysedAt = Date.now() - t0
      }
      await page.waitForTimeout(1000)
    }
    console.log(`analysis done at ${sec(Math.max(allAt, analysedAt))} s: hashes ${s.hashes}/${total()}, sharpness ${s.sharpness}/${s.photos}, loudness ${s.loudness}/${s.withAudio}`)
    await app.close()
    console.log(traceSummary(traceFile))
    // DIASHOW_ORIGINALS_TRACE_OUT=<file> keeps the raw trace for a closer look
    if (process.env.DIASHOW_ORIGINALS_TRACE_OUT && existsSync(traceFile)) copyFileSync(traceFile, process.env.DIASHOW_ORIGINALS_TRACE_OUT)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
    expect(errors).toEqual([])
    return
  }

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
    // beats too: the export below syncs slide changes to them
    return p && p.media.length && p.media.every(done) && p.music.every((m: any) => done(m) && m.beats)
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
