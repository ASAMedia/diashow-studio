// IPC for damaged project files ("Projekt reparieren"): the list of project files that cannot be
// opened, what a repair could rescue (the readable part of the file, or a backup), and the repair.
// Works for projects in the projects folder (with their backups) and for any .dshow file elsewhere
// (e.g. a packed project on a USB stick: rescued and imported as a new project).
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import type { ProjectRef, ProjectReportEvent, RepairChoice, RepairPlan } from '@shared/diagnostics'
import type { Project } from '@shared/types'
import { importProjectFile } from './projectFile'
import { readProjectText } from './projectSchema'
import { PROJECT_EXT, type ProjectStore } from './projects'

export interface ProjectRepairConfig {
  projects: ProjectStore
  onReport: (event: ProjectReportEvent) => void
}

/** A path ref that points into the projects folder becomes an id ref (so its backups count). */
function normalize(ref: ProjectRef, store: ProjectStore): ProjectRef {
  if (!ref || typeof ref !== 'object') throw new Error('no project')
  if ('id' in ref && typeof ref.id === 'string') return { id: ref.id }
  if (!('path' in ref) || typeof ref.path !== 'string' || !ref.path) throw new Error('no project')
  const file = resolve(ref.path)
  if (extname(file).toLowerCase() !== PROJECT_EXT) throw new Error('not a Diashow Studio project file (.dshow)')
  const id = basename(file, extname(file))
  if (dirname(file).toLowerCase() === resolve(store.dir).toLowerCase() && /^[A-Za-z0-9_-]{1,128}$/.test(id)) return { id }
  return { path: file }
}

export async function inspectRepair(ref: ProjectRef, store: ProjectStore): Promise<RepairPlan> {
  const r = normalize(ref, store)
  if ('id' in r) return store.inspectRepair(r.id)
  let salvage: RepairPlan['salvage'] = null
  try {
    const { project, report } = readProjectText(await readFile(r.path, 'utf8'), { salvage: true })
    salvage = { name: project.name, slides: project.entries.length, media: project.media.length, music: project.music.length, report }
  } catch {
    // nothing readable
  }
  return { file: r.path, salvage, backups: [] }
}

export async function applyRepair(ref: ProjectRef, choice: RepairChoice, cfg: ProjectRepairConfig): Promise<Project> {
  const r = normalize(ref, cfg.projects)
  if ('id' in r) return cfg.projects.repair(r.id, choice)
  if (choice?.kind !== 'salvage') throw new Error('a file outside the projects folder has no backups')
  return importProjectFile(r.path, cfg.projects, { salvage: true, onReport: cfg.onReport })
}

export function registerProjectRepair(cfg: ProjectRepairConfig): void {
  // the renderer knows the file before it is read, so a damaged one can be offered for repair
  ipcMain.handle('project:pick-file', async (e) => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Projekt öffnen',
      properties: ['openFile'],
      filters: [{ name: 'Diashow-Projekt', extensions: [PROJECT_EXT.slice(1)] }]
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })
  ipcMain.handle('project:damaged', () => cfg.projects.damaged())
  ipcMain.handle('project:repair-inspect', (_e, ref: ProjectRef) => inspectRepair(ref, cfg.projects))
  ipcMain.handle('project:repair', (_e, ref: ProjectRef, choice: RepairChoice) => applyRepair(ref, choice, cfg))
}
