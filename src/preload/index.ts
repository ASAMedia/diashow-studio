import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DiashowApi } from '@shared/api'

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: unknown, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: DiashowApi = {
  platform: process.platform,
  locale: () => ipcRenderer.invoke('app:locale'),
  importPaths: (paths) => ipcRenderer.invoke('media:import', paths),
  restoreMedia: (items) => ipcRenderer.invoke('media:restore', items),
  onMediaUpdate: (cb) => subscribe('media:update', cb),
  importMusic: (paths) => ipcRenderer.invoke('music:import', paths),
  restoreMusic: (tracks) => ipcRenderer.invoke('music:restore', tracks),
  onMusicUpdate: (cb) => subscribe('music:update', cb),
  waveform: (path, buckets) => ipcRenderer.invoke('audio:waveform', path, buckets),
  pickMedia: () => ipcRenderer.invoke('dialog:media'),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  pickMusic: () => ipcRenderer.invoke('dialog:music'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  listProjects: () => ipcRenderer.invoke('project:list'),
  loadProject: (id) => ipcRenderer.invoke('project:load', id),
  saveProject: (project) => ipcRenderer.invoke('project:save', project),
  deleteProject: (id) => ipcRenderer.invoke('project:delete', id),
  encoders: () => ipcRenderer.invoke('export:encoders'),
  pickExportPath: (name) => ipcRenderer.invoke('dialog:export', name),
  exportStart: (options) => ipcRenderer.invoke('export:start', options),
  exportFrame: (rgba) => ipcRenderer.invoke('export:frame', rgba),
  exportFinish: () => ipcRenderer.invoke('export:finish'),
  exportCancel: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => subscribe('export:progress', cb),
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  revealInFolder: (path) => ipcRenderer.invoke('shell:reveal', path)
}

contextBridge.exposeInMainWorld('api', api)
