import { app, BrowserWindow, protocol, shell } from 'electron'
import { join } from 'node:path'
import { MEDIA_SCHEME } from '@shared/api'
import { registerIpc } from './ipc'
import { registerMediaProtocol } from './protocol'

// Tests (and portable setups) can keep all data in one folder instead of AppData/Documents.
if (process.env.DIASHOW_DATA_DIR) {
  app.setPath('userData', join(process.env.DIASHOW_DATA_DIR, 'userData'))
  app.setPath('documents', join(process.env.DIASHOW_DATA_DIR, 'documents'))
}

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } }
])

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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

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
