// File dialogs: open and save dialogs over the window that asked for them (on their own when it is
// gone), and the pickers the renderer opens (dialog:*): photos and videos, a folder, music, where an
// export goes, and the target folder of "Pack project".
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from '@shared/formats'
import { dialogText } from './dialogText'

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
      title: dialogText('addMedia'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: dialogText('photosAndVideos'), extensions: [...IMAGE_EXT, ...VIDEO_EXT] },
        { name: dialogText('allFiles'), extensions: ['*'] }
      ]
    })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('dialog:folder', async (e) => {
    const r = await showOpen(e, { title: dialogText('addFolder'), properties: ['openDirectory', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('dialog:music', async (e) => {
    const r = await showOpen(e, {
      title: dialogText('addMusic'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: dialogText('music'), extensions: AUDIO_EXT },
        { name: dialogText('allFiles'), extensions: ['*'] }
      ]
    })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('dialog:export', async (e, defaultName: string) => {
    const r = await showSave(e, {
      title: dialogText('exportShow'),
      defaultPath: join(app.getPath('videos'), `${safeFileName(defaultName)}.mp4`),
      filters: [{ name: dialogText('mp4'), extensions: ['mp4'] }]
    })
    if (r.canceled || !r.filePath) return null
    return /\.mp4$/i.test(r.filePath) ? r.filePath : `${r.filePath}.mp4`
  })

  ipcMain.handle('dialog:pack', async (e) => {
    const r = await showOpen(e, { title: dialogText('packTarget'), properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })
}
