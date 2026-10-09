import './threadpool'
import { app, BrowserWindow, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MEDIA_SCHEME } from '@shared/api'
import { registerIpc } from './ipc'
import { denyPopups, loadRenderer, rendererWebPreferences } from './presentation'
import { registerMediaProtocol } from './protocol'

// Tests (and portable setups) can keep all data in one folder instead of AppData/Documents.
if (process.env.DIASHOW_DATA_DIR) {
  app.setPath('userData', join(process.env.DIASHOW_DATA_DIR, 'userData'))
  app.setPath('documents', join(process.env.DIASHOW_DATA_DIR, 'documents'))
}
// CI runners have no GPU: WebGL then runs on SwiftShader.
if (process.env.DIASHOW_SOFTWARE_GL) app.commandLine.appendSwitch('enable-unsafe-swiftshader')

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } }
])

/** .dshow files among command line arguments (double click in Explorer → "app.exe" "file.dshow"). */
function projectFilesIn(argv: string[], cwd = process.cwd()): string[] {
  return argv
    .filter((a) => /\.dshow$/i.test(a) && !a.startsWith('-'))
    .map((a) => resolve(cwd, a))
    .filter((p) => existsSync(p))
}

let mainWindow: BrowserWindow | null = null
const pendingFiles: string[] = []

/**
 * Sends `app:open-file` once the page has loaded. The short delay gives a renderer that subscribes
 * in a React effect (after the load event) time to do so.
 */
function deliverFiles(): void {
  const win = mainWindow
  if (!win || win.isDestroyed() || !pendingFiles.length) return
  const send = (): void => {
    setTimeout(() => {
      if (win.isDestroyed()) return
      for (const file of pendingFiles.splice(0)) win.webContents.send('app:open-file', file)
    }, 500)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#1c1c1e',
    title: 'Diashow Studio',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#a0a0a8', height: 40 },
    webPreferences: rendererWebPreferences()
  })
  win.once('ready-to-show', () => win.show())
  denyPopups(win)
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  void loadRenderer(win)
  mainWindow = win
  deliverFiles()
  return win
}

if (!app.requestSingleInstanceLock()) {
  // Another instance runs: it receives our argv through 'second-instance'
  app.quit()
} else {
  pendingFiles.push(...projectFilesIn(process.argv))

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const win = mainWindow
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    pendingFiles.push(...projectFilesIn(argv, workingDirectory))
    deliverFiles()
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
    pendingFiles.push(path)
    deliverFiles()
  })

  app.whenReady().then(() => {
    registerMediaProtocol()
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
