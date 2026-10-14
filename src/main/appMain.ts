// IPC of the app and its windows: the UI language, fullscreen, showing a file in Explorer, displays and
// the graphics chip, the app settings, keeping the display awake (keepAwake.ts) and the presentation on
// a second display (presentation.ts).
import { app, ipcMain, powerSaveBlocker, shell } from 'electron'
import type { AppSettings, GpuChoiceInfo } from '@shared/types'
import type { AppSettingsStore } from './appSettings'
import { windowOf } from './dialogs'
import { gpuOverride, runningGpuPreference } from './gpuChoice'
import { createKeepAwake } from './keepAwake'
import { displayCount, isPresentationWindow, startPresentation, stopPresentation } from './presentation'
import { gpuDevices } from './systemCheck'

/** The UI language: Windows', or DIASHOW_LOCALE (e.g. en-US) for tests in either language. */
export const appLocale = (): string => process.env.DIASHOW_LOCALE || app.getLocale()

export function registerApp(d: { settings: AppSettingsStore }): void {
  const appSettings = d.settings
  const awake = createKeepAwake({
    start: () => powerSaveBlocker.start('prevent-display-sleep'),
    stop: (id) => powerSaveBlocker.stop(id)
  })
  const awakeWindows = new Set<number>()

  ipcMain.handle('app:locale', () => appLocale())

  ipcMain.handle('win:fullscreen', (e, on: boolean) => {
    windowOf(e)?.setFullScreen(!!on)
  })

  ipcMain.handle('shell:reveal', (_e, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('app:displays', () => displayCount())
  ipcMain.handle('app:gpu-choice', async (): Promise<GpuChoiceInfo> => {
    // Windows' software adapter ("Microsoft Basic Render Driver") is no second chip
    const chips = (await gpuDevices().catch(() => [])).filter((d) => !/microsoft|basic render/i.test(`${d.vendor} ${d.device}`)).length
    return { running: runningGpuPreference(), override: !!gpuOverride, chips }
  })
  ipcMain.handle('app:settings-get', () => appSettings.get())
  // merges: each part of the app (kiosk, update hint, …) writes only its own fields
  ipcMain.handle('app:settings-set', (_e, settings: AppSettings) => appSettings.update(settings))
  ipcMain.handle('app:keep-awake', (e, on: boolean) => {
    const contents = e.sender
    const owner = contents.id
    if (!awakeWindows.has(owner)) {
      awakeWindows.add(owner)
      // A closed window, a reloaded page or a crashed renderer gives up its requests
      const release = (): void => awake.release(owner)
      contents.on('did-navigate', release)
      contents.on('render-process-gone', release)
      contents.once('destroyed', () => {
        awakeWindows.delete(owner)
        release()
      })
    }
    awake.set(owner, !!on)
  })
  ipcMain.handle('present:start', (e) => {
    const win = windowOf(e)
    startPresentation(isPresentationWindow(win) ? undefined : win)
  })
  ipcMain.handle('present:stop', () => stopPresentation())
}
