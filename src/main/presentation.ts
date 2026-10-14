// Renderer windows: shared setup for the editor window and the presentation window, which plays the
// show fullscreen on another display (or in a plain window when there is only one screen).
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { APP_ICON } from './appIcon'
import { dialogText } from './dialogText'
import { devRendererUrl, openLinks } from './security'

/**
 * Every app window (editor, presentation, export worker): sandboxed renderer without Node, isolated
 * preload (only `window.api`), web security on. security.ts adds navigation, permission and IPC limits.
 */
export function rendererWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    webviewTag: false,
    backgroundThrottling: false
  }
}

/** Loads the renderer page; `hash` selects a mode (e.g. 'present'). */
export function loadRenderer(win: BrowserWindow, hash?: string): Promise<void> {
  const dev = devRendererUrl()
  if (dev) return win.loadURL(dev + (hash ? `#${hash}` : ''))
  return win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
}

/** No new windows; links to the app's own sites (GitHub, the licence) open in the browser (security.ts). */
export function denyPopups(win: BrowserWindow): void {
  openLinks(win.webContents)
}

let presentation: BrowserWindow | null = null

export function displayCount(): number {
  return screen.getAllDisplays().length
}

export function isPresentationWindow(win: BrowserWindow | undefined | null): boolean {
  return !!win && win === presentation
}

/**
 * Opens the presentation window (only one at a time). `owner` is the editor window: the presentation
 * goes to a display other than the owner's, fullscreen; `present:closed` is sent to the owner when
 * it closes for any reason, and it closes together with the owner.
 */
export function startPresentation(owner: BrowserWindow | undefined): void {
  if (presentation && !presentation.isDestroyed()) {
    presentation.focus()
    return
  }
  const main = owner && !owner.isDestroyed() && owner !== presentation ? owner : BrowserWindow.getAllWindows().find((w) => w !== presentation && w.isVisible())
  const here = main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()
  const other = screen.getAllDisplays().find((d) => d.id !== here.id)
  const win = new BrowserWindow({
    ...(other
      ? { ...other.bounds, frame: false }
      : { width: 1280, height: 720, minWidth: 320, minHeight: 180 }),
    show: false,
    backgroundColor: '#000000',
    title: dialogText('presentation'),
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: rendererWebPreferences()
  })
  win.setMenu(null)
  // Keep the window's own title (taskbar / Alt+Tab) instead of the page's
  win.on('page-title-updated', (e) => e.preventDefault())
  presentation = win
  denyPopups(win)
  let shown = false
  const show = (): void => {
    clearTimeout(fallback)
    if (shown || win.isDestroyed()) return
    shown = true
    if (other) win.setBounds(other.bounds)
    win.show()
    // Fullscreen only once the window sits on the target display, or Windows picks the current one
    if (other) win.setFullScreen(true)
  }
  // The first frame can take long without a graphics card (software WebGL); a hidden window gets no
  // animation frames, so it would wait even longer. Show it (black) after a few seconds at the latest.
  const fallback = setTimeout(show, 4000)
  win.once('ready-to-show', show)
  const closeWithOwner = (): void => {
    if (!win.isDestroyed()) win.close()
  }
  main?.once('closed', closeWithOwner)
  win.on('closed', () => {
    if (presentation === win) presentation = null
    if (main && !main.isDestroyed()) {
      main.removeListener('closed', closeWithOwner)
      main.webContents.send('present:closed')
    }
  })
  void loadRenderer(win, 'present')
}

export function stopPresentation(): void {
  if (presentation && !presentation.isDestroyed()) presentation.close()
}
