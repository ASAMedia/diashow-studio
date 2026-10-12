// "Problem melden" (Settings → Troubleshooting, About): what the bug form on GitHub is filled in with
// (app version, Windows version, graphics card; no names, paths or project data) and opening it in the
// browser. The app's windows can't open anything themselves (security.ts); this channel opens pages of
// the project on GitHub only (ipcGuards.checkProjectUrl), and only for the app's own page (guardIpc).
import { ipcMain, shell } from 'electron'
import { release, version } from 'node:os'
import { cleanField, gpuSummary, type ReportFields } from '@shared/reportProblem'
import { appVersion } from './about'
import { checkProjectUrl } from './ipcGuards'
import { gpuDevices, windowsVersion } from './systemCheck'

export function registerReportProblem(): void {
  ipcMain.handle('report:fields', async (): Promise<ReportFields> => ({
    version: cleanField(appVersion()),
    windows: cleanField(process.platform === 'win32' ? windowsVersion(version(), release()) : `${version()} (${release()})`),
    gpu: gpuSummary(await gpuDevices().catch(() => []))
  }))

  ipcMain.handle('shell:open-github', async (_e, url: unknown): Promise<void> => {
    await shell.openExternal(checkProjectUrl(url))
  })
}
