// Helpers for the specs that restart the app or need native dialogs (kiosk, present, backups, relink,
// pack, chapters): launching with a data folder, sample media copied to a temp folder, answers for the
// native file dialogs, and the first-run overlay. Selectors work in German and English.
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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

/** Copies test-media files (relative paths) into `dest`, keeping their folders and modification times. */
export function copyMedia(files: string[], dest: string): string[] {
  return files.map((rel) => {
    const to = join(dest, ...rel.split('/'))
    mkdirSync(dirname(to), { recursive: true })
    // CopyFileW keeps the modification time, from which media ids are derived
    copyFileSync(join(mediaDir, ...rel.split('/')), to)
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
