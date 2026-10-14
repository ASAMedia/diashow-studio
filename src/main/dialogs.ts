// File dialogs: open and save dialogs over the window that asked for them (on their own when it is
// gone), and the pickers the renderer opens (dialog:*): photos and videos, a folder, music, where an
// export goes, and the target folder of "Pack project".
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from '@shared/formats'

/** The window an IPC call came from. */
export function windowOf(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}

export function showOpen(event: IpcMainInvokeEvent, opts: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  const win = windowOf(event)
  return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts)
}

export function showSave(event: IpcMainInvokeEvent, opts: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue> {
  const win = windowOf(event)
  return win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts)
}

function safeFileName(name: string): string {
  const cleaned = (name || 'Diashow').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.replace(/\.mp4$/i, '') || 'Diashow'
}

export function registerDialogs(): void {
  ipcMain.handle('dialog:media', async (e) => {
    const r = await showOpen(e, {
      title: 'Fotos und Videos hinzufügen',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Fotos und Videos', extensions: [...IMAGE_EXT, ...VIDEO_EXT] },
        { name: 'Alle Dateien', extensions: ['*'] }
      ]
    })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('dialog:folder', async (e) => {
    const r = await showOpen(e, { title: 'Ordner hinzufügen', properties: ['openDirectory', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('dialog:music', async (e) => {
    const r = await showOpen(e, {
      title: 'Musik hinzufügen',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Musik', extensions: AUDIO_EXT },
        { name: 'Alle Dateien', extensions: ['*'] }
      ]
    })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('dialog:export', async (e, defaultName: string) => {
    const r = await showSave(e, {
      title: 'Diashow exportieren',
      defaultPath: join(app.getPath('videos'), `${safeFileName(defaultName)}.mp4`),
      filters: [{ name: 'MPEG-4-Video', extensions: ['mp4'] }]
    })
    if (r.canceled || !r.filePath) return null
    return /\.mp4$/i.test(r.filePath) ? r.filePath : `${r.filePath}.mp4`
  })

  ipcMain.handle('dialog:pack', async (e) => {
    const r = await showOpen(e, { title: 'Projekt mit allen Medien packen – Zielordner', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })
}
