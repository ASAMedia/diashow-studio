// Export speed and quality: the same real day show through the export paths (I420 frames, RGBA
// frames, WebCodecs), compared with a near-lossless x264 reference. Needs DIASHOW_ORIGINALS_DIR
// (read only). DIASHOW_SPEED_VARIANTS picks the variants, DIASHOW_SPEED_REF caches the reference.
import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appArgs } from './launch'

const root = resolve(__dirname, '..')
const dir = process.env.DIASHOW_ORIGINALS_DIR
const ffprobe = join(root, 'vendor/ffmpeg/bin/ffprobe.exe')
const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')

test.setTimeout(2 * 60 * 60 * 1000)

test('export speed and quality per path', async () => {
  test.skip(!dir, 'DIASHOW_ORIGINALS_DIR not set')
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-speed-'))
  const app = await electron.launch({ args: appArgs(), cwd: root, env: { ...process.env, DIASHOW_DATA_DIR: dataDir } })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForFunction(() => !!(window as any).__diashow)
  const day = readdirSync(dir!).map((n) => join(dir!, n)).find((p) => statSync(p).isDirectory() && /2_/.test(p))!
  const music = readdirSync(dir!).filter((n) => /\.mp3$/i.test(n)).map((n) => join(dir!, n))
  const t0 = Date.now()
  await page.evaluate(async ({ d, m }) => {
    const st = (window as any).__diashow.store.getState()
    await st.createProject([d], 'Speed')
    if (m.length) await (window as any).__diashow.store.getState().addMusic(m)
  }, { d: day, m: music })
  await page.waitForFunction(() => {
    const p = (window as any).__diashow.store.getState().project
    const done = (x: any) => x.status === 'ready' || x.status === 'error'
    return p && p.media.length && p.media.every(done) && p.music.every(done)
  }, null, { timeout: 30 * 60 * 1000, polling: 2000 })
  console.log(`import ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  const show = await page.evaluate(async () => {
    const d = (window as any).__diashow
    const st = d.store.getState()
    st.setTheme('magazine')
    st.insertDayTitles('folder')
    await new Promise((r) => setTimeout(r, 500))
    const p = d.store.getState().project
    return { items: p.media.length, duration: Math.round(d.player.current.tl.duration), loudness: p.media.filter((m: any) => m.loudness != null).length, music: p.music.map((m: any) => m.loudness) }
  })
  console.log('show', JSON.stringify(show))

  // a shorter show keeps the comparison quick
  const limit = Number(process.env.DIASHOW_SPEED_ENTRIES ?? 40)
  const dur = await page.evaluate(async (n) => {
    const d = (window as any).__diashow
    d.store.getState().update((p: any) => { p.entries = p.entries.slice(0, n) })
    await new Promise((r) => setTimeout(r, 500))
    return d.player.current.tl.duration
  }, limit)
  console.log(`exporting ${dur.toFixed(0)} s of show`)
  // DIASHOW_SPEED_SIZE, e.g. 3840x2160; 4K first builds full-resolution sources like the export dialog
  const [width, height] = (process.env.DIASHOW_SPEED_SIZE ?? '1920x1080').split('x').map(Number)
  if (Math.max(width, height) > 1920) {
    const t = Date.now()
    const n = await page.evaluate(async (edge) => {
      const s = (window as any).__diashow.store
      const p = s.getState().project
      const used = new Set(p.entries.map((e: any) => e.mediaId))
      const proxied = p.media.filter((m: any) => used.has(m.id) && m.kind === 'video' && m.proxied && Math.max(m.width, m.height) > 1920)
      const paths = await (window as any).api.prepareHires(proxied.map((m: any) => m.id), edge)
      s.setState({ project: { ...p, media: p.media.map((m: any) => (paths[m.id] ? { ...m, playback: paths[m.id] } : m)) } })
      return proxied.length
    }, Math.max(width, height))
    console.log(`hires sources for ${n} videos: ${((Date.now() - t) / 1000).toFixed(0)} s`)
  }
  const run = async (name: string, opts: { path?: string; hardware: boolean; quality?: string; encoder?: object }, file?: string): Promise<string> => {
    const out = file ?? join(dataDir, `${name}.mp4`)
    const t = Date.now()
    const last = await page.evaluate(async ({ outPath, opts, width, height }) => {
      const d = (window as any).__diashow
      let tick: any = null
      await d.exportShow(d.store.getState().project, { outPath, width, height, fps: 30, codec: 'h264', quality: 'high', ...opts }, 'de-DE', (p: any) => (tick = p), new AbortController().signal)
      return tick
    }, { outPath: out, opts, width, height })
    const secs = (Date.now() - t) / 1000
    const probe = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,nb_frames:format=duration,size', '-of', 'compact', out]).toString().trim().replace(/\s*\n/g, ' ')
    const ph = Object.entries(last.phases).map(([k, v]) => `${k} ${(v as number).toFixed(1)}`).join(', ')
    console.log(`${name}: ${secs.toFixed(1)} s (${(dur / secs).toFixed(2)}x realtime), path ${last.path}, ms/frame: ${ph} | ${probe}`)
    return out
  }
  const variants = (process.env.DIASHOW_SPEED_VARIANTS ?? 'auto,ref').split(',')
  const files: Record<string, string> = {}
  if (variants.includes('auto')) files.auto = await run('auto', { hardware: true })
  if (variants.includes('nvenc')) files.nvenc = await run('ffmpeg-nvenc-rgba', { path: 'rgba', hardware: true })
  if (variants.includes('webcodecs')) files.webcodecs = await run('webcodecs', { path: 'webcodecs', hardware: true })
  // DIASHOW_SPEED_WC: JSON list of WebCodecs config overrides to try
  for (const [i, enc] of (JSON.parse(process.env.DIASHOW_SPEED_WC ?? '[]') as object[]).entries()) {
    files[`wc${i} ${JSON.stringify(enc)}`] = await run(`wc${i}`, { path: 'webcodecs', hardware: true, encoder: enc })
  }
  if (variants.includes('x264')) files.x264 = await run('ffmpeg-x264', { hardware: false })
  // near-lossless reference to compare the others against
  // (DIASHOW_SPEED_REF keeps it between runs)
  const refFile = process.env.DIASHOW_SPEED_REF
  if (refFile && existsSync(refFile)) files.ref = refFile
  else if (variants.includes('ref')) files.ref = await run('reference', { path: 'rgba', hardware: false, quality: 'max' }, refFile)
  await app.close()

  if (files.ref) {
    for (const [name, file] of Object.entries(files)) {
      if (name === 'ref') continue
      const lines = ['ssim', 'psnr'].map((f) => {
        const r = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-i', files.ref, '-lavfi', f, '-f', 'null', '-'], { encoding: 'utf8' })
        return r.stderr.split(/\r?\n/).filter((l) => /SSIM|PSNR/.test(l)).map((l) => l.replace(/^.*\] /, '')).join(' ')
      })
      console.log(`${name} vs reference: ${lines.join(' | ')}`)
    }
  }
  rmSync(dataDir, { recursive: true, force: true })
  expect(errors).toEqual([])
})
