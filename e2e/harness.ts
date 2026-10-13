// Helpers for the specs that restart the app or need native dialogs (kiosk, present, backups, relink,
// pack, chapters): launching with a data folder, sample media copied to a temp folder, answers for the
// native file dialogs, and the first-run overlay. Selectors work in German and English. Drags and drops
// go through Chromium's own drag and drop (dragFiles, dragElement, dropFiles).
import { _electron as electron, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { launchOptions } from './launch'

export const root = resolve(__dirname, '..')
export const mediaDir = join(root, 'test-media')

/** Generates test-media/ when it is missing. */
export function ensureTestMedia(): void {
  if (!existsSync(join(mediaDir, '.complete-v2'))) execFileSync('node', ['scripts/make-test-media.mjs'], { cwd: root, stdio: 'inherit' })
}

/**
 * A few files of test-media (relative paths): photos, a video and, when the HEIC sample exists, an
 * iPhone Live Photo (HEIC + MOV). Small, so imports stay quick on slow machines.
 */
export function sampleFiles(opts: { video?: boolean; live?: boolean } = {}): string[] {
  const files = ['android/PXL_0002.jpg', 'iphone/IMG_0003.JPG', 'misc/photo.webp', 'misc/pano.png']
  if (opts.video) files.push('misc/plain.mp4')
  if (opts.live && existsSync(join(mediaDir, 'iphone/IMG_0001.HEIC'))) files.push('iphone/IMG_0001.HEIC', 'iphone/IMG_0001.MOV')
  return files
}

/**
 * Copies test-media files (relative paths) into `dest`, keeping their folders and modification times.
 * `distinct`: a few bytes go after the picture data (readers ignore them), so a show that has the
 * original takes the copy as a new photo instead of skipping it as a repeat (src/shared/repeats.ts).
 */
export function copyMedia(files: string[], dest: string, distinct = false): string[] {
  return files.map((rel) => {
    const to = join(dest, ...rel.split('/'))
    mkdirSync(dirname(to), { recursive: true })
    // CopyFileW keeps the modification time, from which media ids are derived
    copyFileSync(join(mediaDir, ...rel.split('/')), to)
    if (distinct) appendFileSync(to, `
${to}
`)
    return to
  })
}

/** Deletes a temp folder, retrying while Windows still holds files of a closed app. */
export function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (e) {
    console.warn(`could not delete ${dir}: ${(e as Error).message}`)
  }
}

export interface Session {
  app: ElectronApplication
  page: Page
  /** Renderer errors of the main window (console.error and uncaught exceptions). */
  errors: string[]
}

/** Starts the app with its data in `dataDir` and waits for the main window. */
export async function launch(dataDir: string, env: Record<string, string> = {}): Promise<Session> {
  const opts = launchOptions(root, dataDir)
  Object.assign(opts.env, env)
  const app = await electron.launch(opts)
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('console', (m) => {
      // MediaPipe prints its TFLite delegate info through console.error
      if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(e.message))
    await page.waitForFunction(() => !!(window as any).__diashow, null, { timeout: 60_000 })
    // the assistant opens by itself only while there are no projects yet
    if (!hasProjects(dataDir)) await dismissFirstRun(page)
    return { app, page, errors }
  } catch (e) {
    await app.close().catch(() => {})
    throw e
  }
}

const hasProjects = (dataDir: string): boolean => {
  try {
    return readdirSync(join(dataDir, 'Diashow Studio')).some((n) => n.endsWith('.dshow'))
  } catch {
    return false
  }
}

/**
 * Skips the first-run assistant (Wizard.tsx), which opens by itself on a first start without
 * projects, so it can't cover the home screen. (Driving the store with another show closes it too.)
 */
export async function dismissFirstRun(page: Page, wait = 5000): Promise<void> {
  const wizard = page.locator('[data-testid="wizard"]')
  try {
    await wizard.waitFor({ state: 'visible', timeout: wait })
  } catch {
    return
  }
  await wizard.locator('button').filter({ hasText: /Überspringen|Skip/ }).first().click()
  await expect(wizard).toHaveCount(0, { timeout: 10_000 })
}

/**
 * From now on the main process's native open dialogs (folder or file) answer with `paths` at once:
 * the app's own code runs as usual, only the Windows dialog is skipped.
 */
export async function answerOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, filePaths) => {
    const d = dialog as unknown as { showOpenDialog: (...args: unknown[]) => Promise<unknown> }
    d.showOpenDialog = async () => ({ canceled: false, filePaths })
  }, paths)
}

/** From now on the main process's native save dialogs answer with `filePath` at once. */
export async function answerSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, file) => {
    const d = dialog as unknown as { showSaveDialog: (...args: unknown[]) => Promise<unknown> }
    d.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, filePath)
}

/** Waits until the open project's media and music are processed (ready or failed). */
export async function waitProcessed(page: Page, timeout = 300_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const p = (window as any).__diashow.store.getState().project
      const done = (x: { status: string }): boolean => x.status === 'ready' || x.status === 'error'
      return !!p && p.media.length > 0 && p.media.every(done) && p.music.every(done)
    },
    null,
    { timeout, polling: 250 }
  )
}

/** The open project in the renderer store. */
export const project = (page: Page): Promise<any> => page.evaluate(() => (window as any).__diashow.store.getState().project)

/** Where projects of a data folder are saved (DIASHOW_DATA_DIR). */
export const projectFile = (dataDir: string, id: string): string => join(dataDir, 'Diashow Studio', `${id}.dshow`)

export function readProject(dataDir: string, id: string): any | null {
  try {
    return JSON.parse(readFileSync(projectFile(dataDir, id), 'utf8'))
  } catch {
    return null
  }
}

/** Waits until the saved file holds what `check` wants (saves are debounced). */
export async function waitSaved(dataDir: string, id: string, check: (p: any) => boolean, timeout = 30_000): Promise<void> {
  await expect.poll(() => {
    const p = readProject(dataDir, id)
    return !!p && check(p)
  }, { timeout, intervals: [200] }).toBe(true)
}

/** Opens the "⋯" menu of the editor and clicks the item whose text matches. */
export async function menu(page: Page, item: RegExp): Promise<void> {
  await page.locator('.titlebar button[title="Weitere Aktionen"], .titlebar button[title="More actions"]').click()
  await page.locator('.menu button').filter({ hasText: item }).click()
}

/** The main window is fullscreen (the hidden export worker doesn't count). */
export const isFullScreen = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.isFullScreen()))

// ---- drag and drop through Chromium's own pipeline (CDP Input.dispatchDragEvent): the page gets its
// dragenter, dragover, dragleave and drop from Chromium, which decides on each step as for a drag
// from Explorer

/** A drag in progress, moved step by step. */
export interface Drag {
  /**
   * The pointer moves to (x, y) (the first step brings the drag into the window). Where the element
   * under it changes, Chromium fires dragenter there and dragleave on the old one, but no dragover.
   */
  to(x: number, y: number): Promise<void>
  /** The pointer stays until `check` is done; dragover repeats meanwhile, as Windows repeats it. */
  hover(check: () => Promise<void>): Promise<void>
  /** The pointer leaves the window: the page gets a dragleave with nowhere to go (a point outside the view). */
  out(): Promise<void>
  /**
   * Released at (x, y). CDP's drop moves the pointer there itself first, so from another element
   * Chromium fires only dragenter at (x, y) and decides on the drop by it, as on a quick release in
   * Windows. 'drop': the page got it; 'refused': Chromium sent a dragleave instead; 'lost': neither.
   */
  drop(x: number, y: number): Promise<'drop' | 'refused' | 'lost'>
  /**
   * Esc: Windows ends the drag over the window with a dragleave with nowhere to go (sent here as a
   * move out of the view), and a drag that started in the page ends at its source with dragend
   * (CDP's dragCancel, which gives the drop targets nothing).
   */
  esc(): Promise<void>
}

/** Records the drag events the page gets, after its handlers: what a lost drop reports. */
async function watchDrags(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    w.__dragLog = []
    w.__dropSent = false
    w.__dropOutcome = null
    if (w.__dragLogged) return
    w.__dragLogged = true
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      window.addEventListener(type, (e: Event) => {
        const d = e as DragEvent
        if (type === 'drop') w.__dropOutcome = 'drop'
        // a refused drop: Chromium sends a dragleave with nowhere to go instead
        else if (type === 'dragleave' && w.__dropSent && !d.relatedTarget) w.__dropOutcome ??= 'refused'
        w.__dragLog.push(`${type} on ${(d.target as Element | null)?.className?.toString().slice(0, 30)} accepted=${d.defaultPrevented} effect=${d.dataTransfer?.dropEffect}`)
        w.__dragLog.splice(0, w.__dragLog.length - 12)
      })
    }
  })
}

/** The last drag events the page got (dragFiles, dragElement). */
export const dragLog = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__dragLog ?? [])

function dragSession(page: Page, cdp: CDPSession, data: object): Drag {
  let at: [number, number] | null = null
  const send = (type: string, x: number, y: number): Promise<unknown> => cdp.send('Input.dispatchDragEvent', { type, x, y, data } as any)
  const outside = async (): Promise<void> => {
    await send('dragOver', -40, at?.[1] ?? 10)
    at = null
  }
  return {
    async to(x, y) {
      if (!at) await send('dragEnter', x, y)
      at = [x, y]
      await send('dragOver', x, y)
    },
    async hover(check) {
      let hovering = true
      const repeat = (async () => {
        while (hovering && at) {
          await send('dragOver', ...at)
          await new Promise((r) => setTimeout(r, 50))
        }
      })()
      try {
        await check()
      } finally {
        hovering = false
        await repeat
      }
    },
    out: outside,
    async drop(x, y) {
      // (a dragover of its own to (x, y) first would let Chromium decide by that dragover instead)
      if (!at) await send('dragEnter', x, y)
      await page.evaluate(() => ((window as any).__dropSent = true))
      await send('drop', x, y)
      // the session stays until the page has the drop
      const outcome = await page
        .waitForFunction(() => (window as any).__dropOutcome, null, { timeout: 15_000, polling: 100 })
        .then((h) => h.jsonValue() as Promise<'drop' | 'refused'>, () => 'lost' as const)
      await cdp.detach()
      return outcome
    },
    async esc() {
      const [x, y] = at ?? [10, 10]
      await outside()
      await send('dragCancel', x, y)
      await cdp.detach()
    }
  }
}

/** Files dragged in from Explorer (which offers copy, move and link). */
export async function dragFiles(page: Page, files: string[]): Promise<Drag> {
  await watchDrags(page)
  const cdp = await page.context().newCDPSession(page)
  return dragSession(page, cdp, { items: [], files, dragOperationsMask: 1 | 2 | 16 })
}

/**
 * A drag of the page's own element at (x, y) (a slide, a song), started with the mouse; Chromium hands
 * the drag to the test (Input.setInterceptDrags) instead of the operating system.
 */
export async function dragElement(page: Page, x: number, y: number): Promise<Drag> {
  await watchDrags(page)
  const cdp = await page.context().newCDPSession(page)
  const mouse = (type: string, px: number, buttons: number): Promise<unknown> =>
    cdp.send('Input.dispatchMouseEvent', { type, x: px, y, button: buttons ? 'left' : 'none', buttons, clickCount: 1 } as any)
  await cdp.send('Input.setInterceptDrags', { enabled: true })
  const caught = new Promise<object>((resolve) => cdp.once('Input.dragIntercepted', (e) => resolve(e.data)))
  await mouse('mouseMoved', x, 0)
  await mouse('mousePressed', x, 1)
  // the drag starts once the pointer moved a few pixels with the button down
  for (let i = 1; i <= 5; i++) await mouse('mouseMoved', x + i * 2, 1)
  const data = await Promise.race([caught, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no drag started at ${x},${y}`)), 10_000))])
  await cdp.send('Input.setInterceptDrags', { enabled: false })
  return dragSession(page, cdp, data)
}

/**
 * A real drop of files through Chromium's drag and drop, at a point of the window. `check` runs while
 * they hover there. `from`: the pointer hovers there first and is released at once at the point, on
 * another element (Chromium then decides on the drop by that element's dragenter).
 */
export async function dropFiles(page: Page, files: string[], x: number, y: number, check?: () => Promise<void>, from?: [number, number]): Promise<void> {
  const drag = await dragFiles(page, files)
  await drag.to(...(from ?? [x, y]))
  await drag.hover(check ?? (async () => {}))
  const outcome = await drag.drop(x, y)
  if (outcome === 'drop') return
  await page.screenshot({ path: join(root, 'test-results', 'drop-lost.png') }).catch(() => {})
  throw new Error(`the drop at ${x},${y} never reached the page (${outcome}); the last drag events:\n${(await dragLog(page)).join('\n')}`)
}
