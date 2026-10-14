// Screenshots for the in-app handbook (src/renderer/src/handbook/*.md), in German and English. They are
// written as JPEGs to src/renderer/public/handbook/<de|en>/, which are bundled with the app (and copied
// to the website by `npm run site`). Only runs on request:
//
//   npm run samples          (once: the sample trip, see scripts/samples.mjs)
//   npx electron-vite build && DIASHOW_HANDBOOK_SHOTS=1 npx playwright test e2e/handbook-shots.spec.ts
//
// With the sample trip in samples/media (DIASHOW_SAMPLES=1 fetches it when it is missing) the pictures
// show a real class trip: free photos and videos in day folders, chapters from the folder names, the
// theme music, faces of paintings pixelated. The English pictures rename the show and its day titles.
// Only the sample trip makes edit.jpg, panorama.jpg, livephoto.jpg, cleanup.jpg, archive.jpg,
// duplicate.jpg and trash.jpg (light and colour in the edit view, the 2.5:1 station panorama, a Live
// Photo made from the trip's waves clip as a loop, the clean-up and ZIP archive dialogs, a copy of the
// show in the editor, that copy in the trash). Without the samples (or with DIASHOW_SAMPLES=0) the
// other pictures are made from the generated test media, never from real photos. Either way the
// pictures show the dark theme, whatever Windows uses.
// DIASHOW_SHOTS_DIR=<folder> writes the pictures there instead (to try something out first).
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { launchOptions } from './launch'

const root = resolve(__dirname, '..')
const mediaDir = join(root, 'test-media')
const ffmpeg = join(root, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const outRoot = process.env.DIASHOW_SHOTS_DIR ? resolve(process.env.DIASHOW_SHOTS_DIR) : join(root, 'src', 'renderer', 'public', 'handbook')
const WIDTH = 1280
const HEIGHT = 800

type Lang = 'de' | 'en'

// ---------- the sample trip (scripts/samples.mjs)

interface SampleItem {
  id: string
  file: string
  folder: string
  kind: 'photo' | 'video'
}
interface SampleTrip {
  title: Record<Lang, string>
  folder: string
  days: { folder: string; de: { title: string; subtitle: string }; en: { title: string; subtitle: string } }[]
  items: SampleItem[]
}

const samplesRoot = join(root, 'samples')
const readTrip = (): SampleTrip => JSON.parse(readFileSync(join(samplesRoot, 'samples.json'), 'utf8'))
const tripDir = (trip: SampleTrip): string => join(samplesRoot, 'media', trip.folder)
const tripComplete = (trip: SampleTrip): boolean => trip.items.every((i) => existsSync(join(tripDir(trip), i.folder, i.file)))

/** The sample trip when it is there (or DIASHOW_SAMPLES=1: fetched first), else null (test media). */
function sampleTrip(): SampleTrip | null {
  const want = process.env.DIASHOW_SAMPLES
  if (want === '0') return null
  const trip = readTrip()
  if (tripComplete(trip)) return trip
  if (want !== '1') return null
  execFileSync('node', ['scripts/samples.mjs'], { cwd: root, stdio: 'inherit' })
  return readTrip()
}

// ---------- helpers

const state = <T,>(page: Page, body: string): Promise<T> =>
  page.evaluate(`(async () => { const d = window.__diashow; const s = d.store.getState(); ${body} })()`) as Promise<T>

async function shot(page: Page, lang: Lang, name: string): Promise<void> {
  await page.waitForTimeout(600)
  const layout = await page.evaluate(() => {
    const strip = document.querySelector('.strip')?.getBoundingClientRect()
    return { w: innerWidth, h: innerHeight, strip: strip ? [Math.round(strip.top), Math.round(strip.bottom)] : null }
  })
  console.log(lang, name, JSON.stringify(layout))
  const png = await page.screenshot()
  const jpg = await sharp(png).resize({ width: 1100 }).jpeg({ quality: 80, mozjpeg: true }).toBuffer()
  writeFileSync(join(outRoot, lang, `${name}.jpg`), jpg)
}

async function stubOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    ;(dialog as unknown as { showOpenDialog: () => Promise<unknown> }).showOpenDialog = async () => ({ canceled: false, filePaths: p })
  }, paths)
}

/** Every photo, video and song of the open show is processed (ready or failed). */
async function waitProcessed(page: Page, timeout = 480_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const p = (window as any).__diashow.store.getState().project
      const done = (x: { status: string }) => x.status === 'ready' || x.status === 'error'
      return !!p && p.media.length > 0 && p.media.every(done) && p.music.every(done)
    },
    null,
    { timeout, polling: 250 }
  )
}

/** The background face search has looked at every photo of the open show. */
async function facesFound(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__diashow.store.getState().project.media.every((m: any) => m.kind !== 'photo' || m.status !== 'ready' || m.faces !== undefined), null, {
    timeout: 300_000,
    polling: 500
  })
}

/** Opens the "⋯" menu of the editor and clicks the item whose text matches. */
async function menu(page: Page, item: RegExp): Promise<void> {
  await page.locator('.titlebar button[title="Weitere Aktionen"], .titlebar button[title="More actions"]').click()
  await page.locator('.menu button').filter({ hasText: item }).click()
}

interface SlideOf {
  /** The entry of the file. */
  id: string
  start: number
  duration: number
}

/** The entry of a photo or video (by file name) and where its slide is in the preview's timeline. */
const slideOf = (page: Page, name: string): Promise<SlideOf> =>
  state<SlideOf>(
    page,
    `const m = s.project.media.find((x) => x.name === ${JSON.stringify(name)}); const e = s.project.entries.find((x) => x.mediaId === m.id); const sl = d.player.current.tl.slides.find((x) => x.entries.some((y) => y.id === e.id)); return { id: e.id, start: sl.start, duration: sl.duration }`
  )

/** Selects a slide and shows a moment of it in the preview (`at`: 0..1 of the slide). */
async function showSlide(page: Page, sl: SlideOf, at = 0.6): Promise<void> {
  await state(page, `s.select([${JSON.stringify(sl.id)}]); d.player.current.seek(${sl.start + sl.duration * at})`)
}

/** A theme for the next pictures; the preview rebuilds its timeline. */
async function setTheme(page: Page, theme: string): Promise<void> {
  await state(page, `s.setTheme(${JSON.stringify(theme)})`)
  await page.waitForTimeout(800)
}

/** Scrolls the inspector so that the section holding the control `testId` starts at its top. */
async function showSection(page: Page, testId: string): Promise<void> {
  await expect(page.getByTestId(testId)).toBeVisible()
  await page.getByTestId(testId).evaluate((el) => el.closest('section')?.scrollIntoView({ block: 'start' }))
}

/**
 * A Live Photo made from a clip of the trip (CC0 like the clip): a 4:3 still and a 3-second MOV with
 * the same name, dated `at` (file time: the capture time of a JPEG without EXIF), in `dir`.
 */
function makeLivePhoto(clip: string, dir: string, name: string, at: Date): string[] {
  mkdirSync(dir, { recursive: true })
  const still = join(dir, `${name}.JPG`)
  const motion = join(dir, `${name}.MOV`)
  const vf = 'crop=ih*4/3:ih,scale=1440:1080'
  // the motion runs from 1.5 s before the still to 1.5 s after it, like on an iPhone
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', '8.5', '-i', clip, '-frames:v', '1', '-vf', vf, '-q:v', '2', still])
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', '7', '-t', '3', '-i', clip, '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-f', 'mov', motion])
  for (const f of [still, motion]) utimesSync(f, at, at)
  return [still, motion]
}

/** A short export in the queue, waited for until it is done. */
async function queueShortExport(page: Page, dataDir: string, name: string, lang: Lang): Promise<void> {
  await page.evaluate(
    ({ file, name, locale }) => {
      const d = (window as any).__diashow
      const p = structuredClone(d.store.getState().project)
      p.settings.timing = { mode: 'custom', customTotal: 12 }
      return d.queueExport(p, { outPath: file, width: 640, height: 360, fps: 30, codec: 'h264', quality: 'standard', hardware: true, locale }, name)
    },
    { file: join(dataDir, `${name}.mp4`), name, locale: lang === 'de' ? 'de-DE' : 'en-US' }
  )
  await page.waitForFunction(() => (window as any).__diashow.store.getState().exportJobs.some((j: any) => j.state === 'done'), null, { timeout: 300_000 })
}

/** Export dialog, queue, share and settings over the editor. */
async function dialogShots(page: Page, lang: Lang, dataDir: string, name: string): Promise<void> {
  await state(page, `s.set({ exportOpen: true })`)
  await expect(page.locator('.dialog').first()).toBeVisible()
  await shot(page, lang, 'export')
  await state(page, `s.set({ exportOpen: false })`)
  await queueShortExport(page, dataDir, name, lang)
  await state(page, `s.set({ dialog: 'queue' })`)
  await shot(page, lang, 'queue')

  // share over Wi-Fi (not started: no address in the picture), settings
  await state(page, `s.set({ dialog: 'share' })`)
  await shot(page, lang, 'share')
  await state(page, `s.set({ dialog: 'settings' })`)
  await page.waitForTimeout(1500)
  await shot(page, lang, 'settings')
  await state(page, `s.set({ dialog: null })`)
}

// ---------- the sample trip

/** Extra shows on the home screen: a name per language and the files of the trip they hold (the first is the cover). */
const OTHER_SHOWS: { name: Record<Lang, string>; ids: string[] }[] = [
  { name: { de: 'Projektwoche Antike', en: 'Project week: Antiquity' }, ids: ['gold-mask', 'marble-bust', 'fayum-portrait', 'spring-fresco', 'delphi-temple', 'sounion-temple'] },
  { name: { de: 'Elternabend: Rückblick Athen', en: "Parents' evening: Athens recap" }, ids: ['aegina-sunset', 'acropolis-moon', 'zeus-columns-evening', 'delphi-valley', 'fishing-boat', 'harbour-chapel'] }
]

async function sampleScenes(app: ElectronApplication, page: Page, lang: Lang, dataDir: string, trip: SampleTrip): Promise<void> {
  const de = lang === 'de'
  const dir = tripDir(trip)
  const item = (id: string): SampleItem => trip.items.find((i) => i.id === id) ?? fail(`no sample "${id}"`)
  const pathOf = (id: string): string => join(dir, item(id).folder, item(id).file)
  const name = trip.title[lang]

  // ---- two older shows for the home screen (their covers differ from the trip's)
  const wizard = page.getByTestId('wizard')
  await expect(wizard).toBeVisible()
  for (const show of OTHER_SHOWS) {
    await page.evaluate(({ files, name }) => (window as any).__diashow.store.getState().createProject(files, name), { files: show.ids.map(pathOf), name: show.name[lang] })
    await waitProcessed(page)
    // its faces are found before it closes: a photo whose search was cut short isn't searched again in this session
    await facesFound(page)
    await state(page, `s.closeProject()`)
    await expect(page.locator('.home .project').filter({ hasText: show.name[lang] })).toBeVisible()
  }

  // ---- assistant: the trip's folder, Ken Burns and its theme song
  await page.locator('.home .hero button').filter({ hasText: /Neue Diashow mit Assistent…|New slideshow with assistant…/ }).click()
  await expect(wizard).toBeVisible()
  await stubOpenDialog(app, [dir])
  await wizard.locator('.wizard-pick button').nth(1).click()
  await expect(wizard).toHaveAttribute('data-step', '2', { timeout: 120_000 })
  // the folder's name is the show's; the English pictures get an English one
  if (!de) await state(page, `s.update((p) => (p.name = ${JSON.stringify(name)}))`)
  await wizard.locator('.theme-card').nth(0).click()
  await page.waitForFunction(() => {
    const s = (window as any).__diashow.store.getState()
    return s.themeTracks.length > 0 && s.project.media.filter((m: any) => m.kind === 'photo').every((m: any) => m.thumb || m.status === 'error')
  }, null, { timeout: 180_000 })
  await expect(wizard.locator('.wizard-theme-song')).toBeVisible()
  await shot(page, lang, 'wizard')
  await wizard.locator('.wizard-foot .btn.primary').click()
  await wizard.locator('.wizard-finish button').nth(2).click()
  await expect(wizard).toHaveCount(0)
  await waitProcessed(page)

  // ---- chapters from the day folders ("2_Dienstag Athen" → "Dienstag" / "Athen"), in English renamed
  await state(page, `s.insertDayTitles('folder')`)
  if (!de) {
    const names = Object.fromEntries(trip.days.map((d) => [`${d.de.title}|${d.de.subtitle}`, d.en]))
    await state(
      page,
      `const names = ${JSON.stringify(names)}; s.update((p) => p.entries.forEach((e) => { const n = e.type === 'text' && e.auto === 'day' && names[e.title + '|' + e.subtitle]; if (n) { e.title = n.title; e.subtitle = n.subtitle } }))`
    )
  }
  const titles = await state<string[]>(page, `return s.project.entries.filter((e) => e.type === 'text').map((e) => e.title + ' – ' + e.subtitle)`)
  console.log(lang, 'chapters:', titles.join(', '))
  expect(titles).toHaveLength(trip.days.length)

  // ---- editor: Magazine, a slide of Athens
  await setTheme(page, 'magazine')
  await showSlide(page, await slideOf(page, item('tower-of-winds').file))
  await state(page, `s.set({ tab: 'themes' })`)
  await page.waitForTimeout(1500)
  await shot(page, lang, 'editor')

  // ---- music: Ken Burns with its theme song, the song chooser, the waveform under the filmstrip
  await setTheme(page, 'kenburns')
  await showSlide(page, await slideOf(page, item('aegina-sunset').file), 0.45)
  await state(page, `s.set({ tab: 'music' })`)
  await expect(page.getByTestId('song-chooser')).toBeVisible()
  await page.waitForTimeout(1500)
  await shot(page, lang, 'music')

  // ---- panorama: the station at dawn (2.5:1) in Ken Burns, halfway through its pan, with the Slide tab's Panorama section
  await showSlide(page, await slideOf(page, item('tuebingen-station').file), 0.5)
  await state(page, `s.set({ tab: 'slide' })`)
  await showSection(page, 'pano-mode')
  await page.waitForTimeout(1500)
  await shot(page, lang, 'panorama')

  // ---- a Live Photo as a loop: made from the waves clip, dated just after it (Friday), with the Slide tab's Live Photo section
  const liveName = 'IMG_20260508_143200'
  const live = makeLivePhoto(pathOf('waves'), join(dataDir, 'live'), liveName, new Date(2026, 4, 8, 14, 32))
  await state(page, `await s.importMedia(${JSON.stringify(live)}, 'byTime')`)
  await waitProcessed(page)
  const livePhoto = await slideOf(page, `${liveName}.JPG`)
  await state(page, `s.updateEntries([${JSON.stringify(livePhoto.id)}], (x) => { x.playLive = true; x.liveEffect = 'loop' })`)
  await page.waitForTimeout(800)
  await showSlide(page, await slideOf(page, `${liveName}.JPG`), 0.4)
  await state(page, `s.set({ tab: 'slide' })`)
  await showSection(page, 'live-mode')
  await expect(page.getByTestId('live-mode')).toHaveValue('loop')
  await page.waitForTimeout(2500)
  await shot(page, lang, 'livephoto')

  // ---- light and colour in the edit view: the floodlit chapel, cooler and a little brighter
  const chapel = await slideOf(page, item('chapel-night').file)
  await showSlide(page, chapel, 0.5)
  await state(
    page,
    `const e = s.project.entries.find((x) => x.id === ${JSON.stringify(chapel.id)}); s.update((p) => { p.media = p.media.map((m) => (m.id === e.mediaId ? { ...m, edit: { rotate: 0, straighten: 0, adjust: { brightness: 18, warmth: -32, contrast: 8 } } } : m)) }); s.set({ tab: 'slide' })`
  )
  await page.locator('.inspector button').filter({ hasText: /^\s*(Bearbeiten|Edit)\s*$/ }).first().click()
  await expect(page.locator('.photo-edit')).toBeVisible()
  await page.locator('.photo-edit .pe-tools button').filter({ hasText: /Licht und Farbe|Light and colour/ }).click()
  await expect(page.locator('.photo-edit .pe-adjust')).toBeVisible()
  await page.waitForTimeout(1500)
  await shot(page, lang, 'edit')
  await page.locator('.photo-edit .pe-actions .btn.primary').click()
  await expect(page.locator('.photo-edit')).toHaveCount(0)

  // ---- privacy: the faces of the Frans Hals couple, one pixelated, the other still to click
  const hals = await slideOf(page, item('hals-couple').file)
  await showSlide(page, hals, 0.5)
  await state(page, `s.set({ tab: 'slide', privacyEdit: ${JSON.stringify(hals.id)} })`)
  const editor = page.locator('.privacy-edit')
  await expect(editor).toBeVisible()
  // the close search of the photo has run and found both faces
  await expect(editor.locator('.privacy-hint')).not.toContainText(/läuft noch|still running/, { timeout: 120_000 })
  await expect.poll(() => editor.locator('.privacy-face-wrap').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
  const faces = await editor.locator('.privacy-face-wrap').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left))
  // the man on the left gets pixelated
  await editor.locator('.privacy-face-wrap').nth(faces.indexOf(Math.min(...faces))).locator('button.privacy-face').click()
  await expect(editor.locator('.privacy-face.on')).toHaveCount(1)
  await page.waitForTimeout(1500)
  await shot(page, lang, 'privacy')
  await state(page, `s.set({ privacyEdit: null })`)

  // ---- review grid: stars for the best, the shaky train window left out
  await state(page, `s.set({ view: 'cull' })`)
  await expect(page.locator('.cull-tile').first()).toBeVisible()
  await page.waitForTimeout(1000)
  const order = await state<string[]>(page, `const media = new Map(s.project.media.map((m) => [m.id, m.name])); return s.project.entries.filter((e) => e.type !== 'text').map((e) => media.get(e.mediaId))`)
  const tile = (id: string) => page.locator('.cull-tile').nth(order.indexOf(item(id).file))
  for (const [id, key] of [['acropolis-moon', '5'], ['tuebingen-station', '4'], ['agora-church', '4'], ['tower-of-winds', '3'], ['train-window', 'x']] as const) {
    await tile(id).click()
    await page.keyboard.press(key)
  }
  await tile('greek-salad').click()
  await shot(page, lang, 'cull')
  await state(page, `s.set({ view: 'editor' })`)

  // ---- dialogs over Origami, on the museum day; the export dialog counts faces that aren't pixelated
  await setTheme(page, 'origami')
  await state(page, `s.set({ tab: 'slide' })`)
  await showSlide(page, await slideOf(page, item('renoir-portrait').file), 0.7)
  await facesFound(page)
  await dialogShots(page, lang, dataDir, name)

  // ---- clean-up and archive dialogs
  await menu(page, /Nach dem Projekt aufräumen|Clean up after the project/)
  const cleanup = page.getByTestId('cleanup-dialog')
  await expect(cleanup.locator('[data-category="faces"]')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(800)
  await shot(page, lang, 'cleanup')
  await cleanup.locator('.actions button').filter({ hasText: /Abbrechen|Cancel/ }).click()
  await expect(cleanup).toHaveCount(0)

  await menu(page, /Als ZIP archivieren|Archive as ZIP/)
  const archive = page.getByTestId('archive-dialog')
  await expect(archive.getByTestId('archive-total')).toBeVisible({ timeout: 30_000 })
  // the target is in this PC's user folder: the picture shows a neutral one
  await archive.getByTestId('archive-target').evaluate((el, file) => (el.textContent = `D:\\${file}.zip`), name)
  await page.waitForTimeout(500)
  await shot(page, lang, 'archive')
  await archive.locator('.actions button').filter({ hasText: /Abbrechen|Cancel/ }).click()
  await expect(archive).toHaveCount(0)

  // ---- duplicate: the copy opens in the editor with its notice, on the moonlit Acropolis
  const original = await state<string>(page, `return s.project.id`)
  await menu(page, /^(Duplizieren|Duplicate)$/)
  await expect(page.getByTestId('duplicate-notice')).toBeVisible({ timeout: 60_000 })
  const copy = await state<string>(page, `return s.project.id`)
  expect(copy).not.toBe(original)
  await page.waitForFunction(() => ((window as any).__diashow.player.current?.tl?.slides.length ?? 0) > 1, null, { timeout: 60_000 })
  await page.waitForTimeout(1500)
  await showSlide(page, await slideOf(page, item('acropolis-moon').file), 0.5)
  await state(page, `s.set({ tab: 'themes' })`)
  await page.waitForTimeout(1500)
  await shot(page, lang, 'duplicate')

  // ---- the copy goes into the trash; the trash dialog lists it
  await state(page, `s.closeProject()`)
  const copyCard = page.locator(`.home .project[data-id="${copy}"]`)
  await copyCard.hover()
  await copyCard.locator('button.del').click()
  await expect(page.getByTestId('delete-dialog')).toBeVisible()
  await expect(page.getByTestId('delete-run')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('delete-run').click()
  await expect(page.getByTestId('delete-dialog')).toHaveCount(0, { timeout: 60_000 })
  await page.getByTestId('trash-open').click()
  const trash = page.getByTestId('trash-dialog')
  await expect(trash.getByTestId('trash-entry')).toHaveCount(1, { timeout: 30_000 })
  await page.mouse.move(0, 0)
  await page.waitForTimeout(800)
  await shot(page, lang, 'trash')
  await trash.locator('.actions .btn.primary').click()
  await expect(trash).toHaveCount(0)

  // ---- home with the trip and the older shows
  await state(page, `s.closeProject()`)
  await expect(page.locator('.home .project')).toHaveCount(1 + OTHER_SHOWS.length)
  await page.waitForTimeout(1200)
  await shot(page, lang, 'home')
}

function fail(message: string): never {
  throw new Error(message)
}

// ---------- the generated test media

async function testMediaScenes(app: ElectronApplication, page: Page, lang: Lang, dataDir: string): Promise<void> {
  const de = lang === 'de'
  if (!existsSync(mediaDir)) execFileSync('node', ['scripts/make-test-media.mjs'], { cwd: root, stdio: 'inherit' })
  const name = de ? 'Klassenfahrt' : 'Class trip'

  // ---- assistant: a folder, then theme and music
  const wizard = page.getByTestId('wizard')
  await expect(wizard).toBeVisible()
  await stubOpenDialog(app, [mediaDir])
  await wizard.locator('.wizard-pick button').nth(1).click()
  await expect(wizard).toHaveAttribute('data-step', '2', { timeout: 120_000 })
  await state(page, `s.update((p) => (p.name = ${JSON.stringify(name)}))`)
  await stubOpenDialog(app, [join(mediaDir, 'music', 'track1.mp3'), join(mediaDir, 'music', 'track2.m4a')])
  await wizard.locator('.wizard-music .row .btn').click()
  await wizard.locator('.theme-card').nth(6).click()
  await page.waitForFunction(() => {
    const p = (window as any).__diashow.store.getState().project
    return p.media.filter((m: any) => m.kind === 'photo' && m.thumb).length >= 3 && p.music.every((m: any) => m.status === 'ready')
  }, null, { timeout: 180_000 })
  await shot(page, lang, 'wizard')
  await wizard.locator('.wizard-foot .btn.primary').click()
  await wizard.locator('.wizard-finish button').nth(2).click()
  await expect(wizard).toHaveCount(0)
  await waitProcessed(page)

  // ---- editor, music
  const photoSlide = await state<{ id: string; t: number }>(
    page,
    `const tl = d.player.current.tl; const sl = tl.slides.find((x, i) => i > 0 && x.kind !== 'text' && x.entries.length >= 2) ?? tl.slides[1]; s.select(sl.entries.map((e) => e.id)); d.player.current.seek(sl.start + sl.duration * 0.6); return { id: sl.entries[0].id, t: sl.start + sl.duration * 0.6 }`
  )
  await state(page, `s.set({ tab: 'themes' })`)
  await shot(page, lang, 'editor')
  await state(page, `s.set({ tab: 'music' })`)
  await shot(page, lang, 'music')

  // ---- privacy: an area pixelated on a single photo, its editor open
  await state(
    page,
    `const tl = d.player.current.tl; const sl = tl.slides.find((x) => x.kind !== 'text' && x.entries.length === 1 && x.entries[0].type === 'photo') ?? tl.slides.find((x) => x.entries[0]?.type === 'photo'); const e = sl.entries[0]; s.updateEntries([e.id], (x) => (x.privacy = [{ x: 0.38, y: 0.22, w: 0.22, h: 0.3 }])); s.select([e.id]); s.set({ tab: 'slide', privacyEdit: e.id }); d.player.current.seek(sl.start + sl.duration * 0.5)`
  )
  await expect(page.locator('.privacy-edit')).toBeVisible()
  await page.waitForTimeout(1500)
  await shot(page, lang, 'privacy')
  await state(page, `s.set({ privacyEdit: null })`)

  // ---- review grid
  await state(page, `s.set({ view: 'cull' })`)
  await expect(page.locator('.cull-tile').first()).toBeVisible()
  await page.locator('.cull-tile').nth(1).click()
  await page.keyboard.press('4')
  await page.locator('.cull-tile').nth(2).click()
  await page.keyboard.press('x')
  await page.locator('.cull-tile').nth(0).click()
  await page.keyboard.press('5')
  await shot(page, lang, 'cull')
  await state(page, `s.set({ view: 'editor' })`)

  // ---- export dialog, then a short export in the queue, share, settings
  await state(page, `s.select([${JSON.stringify(photoSlide.id)}])`)
  await dialogShots(page, lang, dataDir, name)

  // ---- home with the show
  await state(page, `s.closeProject()`)
  await expect(page.locator('.project').first()).toBeVisible()
  await page.waitForTimeout(800)
  await shot(page, lang, 'home')
}

// ---------- run

for (const lang of ['de', 'en'] as const) {
  test(`handbook screenshots (${lang})`, async () => {
    test.skip(!process.env.DIASHOW_HANDBOOK_SHOTS, 'set DIASHOW_HANDBOOK_SHOTS=1 to renew the handbook screenshots')
    test.setTimeout(20 * 60 * 1000)
    const trip = sampleTrip()
    console.log(lang, trip ? `sample trip: ${tripDir(trip)}` : 'generated test media (npm run samples for the sample trip)')
    mkdirSync(join(outRoot, lang), { recursive: true })
    const dataDir = mkdtempSync(join(tmpdir(), 'diashow-shots-'))
    const opts = launchOptions(root, dataDir)
    opts.env.DIASHOW_LOCALE = lang === 'de' ? 'de-DE' : 'en-US'
    delete opts.env.DIASHOW_UPDATE_URL
    const app = await electron.launch(opts)
    try {
      const page = await app.firstWindow()
      await page.waitForFunction(() => !!(window as any).__diashow)
      await app.evaluate(({ BrowserWindow }, [w, h]) => {
        const win = BrowserWindow.getAllWindows().find((x) => x.isVisible()) ?? BrowserWindow.getAllWindows()[0]
        win.setContentSize(w, h)
        win.center()
      }, [WIDTH, HEIGHT])
      // one-time tips would cover parts of the pictures
      await page.evaluate(() => ['home', 'editor'].forEach((id) => localStorage.setItem(`tip:${id}`, '1')))
      // the pictures show the dark theme, whatever Windows uses on this PC
      await page.evaluate(() => {
        localStorage.setItem('appearance', 'dark')
        window.dispatchEvent(new Event('appearance'))
      })

      if (trip) await sampleScenes(app, page, lang, dataDir, trip)
      else await testMediaScenes(app, page, lang, dataDir)

      const made = readdirSync(join(outRoot, lang)).filter((f) => f.endsWith('.jpg'))
      console.log(lang, made.join(', '))
      // every picture the handbook names exists
      const md = readFileSync(join(root, 'src', 'renderer', 'src', 'handbook', `${lang}.md`), 'utf8')
      for (const m of md.matchAll(/!\[[^\]]*\]\(([\w.-]+)\)/g)) expect(made).toContain(m[1])
    } finally {
      await app.close()
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
}
