// Renderer windows: shared setup for the editor window and the presentation window, which plays the
// show fullscreen on another display (or in a plain window when there is only one screen).
import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'

export function rendererWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: false,
    contextIsolation: true,
    backgroundThrottling: false
  }
}

/** Loads the renderer page; `hash` selects a mode (e.g. 'present'). */
export function loadRenderer(win: BrowserWindow, hash?: string): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL) return win.loadURL(process.env.ELECTRON_RENDERER_URL + (hash ? `#${hash}` : ''))
  return win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
}

export function denyPopups(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
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
  const main = owner && !owner.isDestroyed() && owner !== presentation ? owner : BrowserWindow.getAllWindows().find((w) => w !== presentation)
  const here = main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()
  const other = screen.getAllDisplays().find((d) => d.id !== here.id)
  const win = new BrowserWindow({
    ...(other
      ? { ...other.bounds, frame: false }
      : { width: 1280, height: 720, minWidth: 320, minHeight: 180 }),
    show: false,
    backgroundColor: '#000000',
    title: 'Diashow Studio – Präsentation',
    autoHideMenuBar: true,
    webPreferences: rendererWebPreferences()
  })
  win.setMenu(null)
  // Keep the window's own title (taskbar / Alt+Tab) instead of the page's
  win.on('page-title-updated', (e) => e.preventDefault())
  presentation = win
  denyPopups(win)
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    if (other) win.setBounds(other.bounds)
    win.show()
    // Fullscreen only once the window sits on the target display, or Windows picks the current one
    if (other) win.setFullScreen(true)
  })
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
