// Chapter marks end to end: the export dialog offers "Chapters as jump marks" for a show with
// chapter slides and copies the list for YouTube; the exported MP4 carries the chapters
// (ffprobe -show_chapters), and the finished job in the queue copies the same list.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answerSaveDialog, ensureTestMedia, launch, mediaDir, removeDir, root, sampleFiles, waitProcessed, type Session } from './harness'
import { SOFTWARE_GL } from './launch'

const ffprobe = join(root, 'vendor/ffmpeg/bin/ffprobe.exe')
/** The clipboard text (Windows keeps line breaks as CRLF). */
const clipboard = async (s: Session): Promise<string> => (await s.app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n')
const stamp = (t: number): string => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

/** The chapter list the show should have: its title at 0:00, then each chapter slide at its start. */
const expectedList = (page: Page): Promise<{ start: number; title: string }[]> =>
  page.evaluate(() => {
    const tl = (window as any).__diashow.player.current.tl
    return [
      { start: 0, title: 'Kapitel' },
      ...tl.slides.filter((s: any) => s.kind === 'text').map((s: any) => ({ start: s.start, title: s.entries[0].title }))
    ]
  })

test('chapters: offered in the export dialog, written into the MP4, copied for YouTube', { lock: 'clipboard' }, async () => {
  test.setTimeout((SOFTWARE_GL ? 15 : 5) * 60 * 1000)
  ensureTestMedia()
  const dataDir = mkdtempSync(join(tmpdir(), 'diashow-chapters-'))
  let s: Session | null = null
  // the user's clipboard text, put back at the end
  let saved = ''
  try {
    s = await launch(dataDir)
    const { app, page } = s
    saved = await app.evaluate(({ clipboard }) => clipboard.readText())
    await page.evaluate(async (paths) => {
      const d = (window as any).__diashow
      await d.store.getState().createProject(paths, 'Kapitel')
    }, sampleFiles().map((f) => join(mediaDir, ...f.split('/'))))
    await waitProcessed(page)
    // two chapter slides: before the first photo and in the middle
    await page.evaluate(() => {
      const st = (window as any).__diashow.store.getState()
      st.setTheme('classic')
      st.setSettings({ timing: { mode: 'custom', customTotal: 14 }, showTitle: true })
      st.update((p: any) => {
        p.entries.splice(2, 0, { id: 'chapter-2', type: 'text', title: 'Dienstag' })
        p.entries.unshift({ id: 'chapter-1', type: 'text', title: 'Montag' })
      })
    })
    const list = await expectedList(page)
    expect(list.map((c) => c.title)).toEqual(['Kapitel', 'Montag', 'Dienstag'])
    const text = list.map((c) => `${stamp(c.start)} ${c.title}`).join('\n')

    // ---- the export dialog: the option is on, the list can be copied
    await page.locator('.titlebar .btn.primary').filter({ hasText: /Exportieren|Export/ }).click()
    const dialog = page.locator('.dialog').filter({ hasText: /Diashow exportieren|Export slideshow/ })
    await expect(dialog).toBeVisible()
    const option = dialog.locator('label.check').filter({ hasText: /Kapitel als Sprungmarken|Chapters as jump marks/ }).locator('input')
    await expect(option).toBeChecked()
    await expect(dialog).toContainText(/3 Kapitel|3 chapters/)
    await dialog.locator('button').filter({ hasText: /Kapitel kopieren|Copy chapters/ }).click()
    await expect.poll(() => clipboard(s!)).toBe(text)

    // ---- a small export through the dialog (720p, 24 fps); the save dialog answers from the test
    await dialog.locator('select').filter({ has: page.locator('option[value="2160"]') }).selectOption('720')
    await dialog.locator('select').filter({ has: page.locator('option[value="60"]') }).selectOption('24')
    const out = join(dataDir, 'kapitel.mp4')
    await answerSaveDialog(app, out)
    await dialog.locator('.actions .btn.primary').click()
    await expect(dialog).toContainText(/im Hintergrund|in the background/)
    await dialog.locator('.actions .btn.primary').click()
    await expect.poll(() => page.evaluate(() => (window as any).__diashow.store.getState().exportJobs.map((j: any) => j.state).join()), {
      timeout: (SOFTWARE_GL ? 12 : 4) * 60 * 1000,
      intervals: [250]
    }).toBe('done')

    // ---- the MP4 has the chapters, each until the next one
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_chapters', '-show_format', out]).toString('utf8'))
    console.log(probe.chapters.map((c: any) => `${Number(c.start_time).toFixed(2)}-${Number(c.end_time).toFixed(2)} ${c.tags?.title}`).join(' | '))
    expect(probe.chapters.map((c: any) => c.tags?.title)).toEqual(list.map((c) => c.title))
    probe.chapters.forEach((c: any, i: number) => {
      expect(Number(c.start_time)).toBeCloseTo(list[i].start, 2)
      if (i + 1 < list.length) expect(Number(c.end_time)).toBeCloseTo(list[i + 1].start, 2)
    })
    expect(Number(probe.chapters.at(-1).end_time)).toBeCloseTo(Number(probe.format.duration), 1)

    // ---- the finished job in the queue copies the same list
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await page.evaluate(() => (window as any).__diashow.store.getState().set({ dialog: 'queue' }))
    await page.locator('.job.done button').filter({ hasText: /Kapitel kopieren|Copy chapters/ }).click()
    await expect.poll(() => clipboard(s!)).toBe(text)
    await page.keyboard.press('Escape')
    expect(s.errors).toEqual([])
  } finally {
    if (saved) await s?.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved).catch(() => {})
    await s?.app.close().catch(() => {})
    removeDir(dataDir)
  }
})
