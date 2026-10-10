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
  revealInFolder: (path) => ipcRenderer.invoke('shell:reveal', path),
  setFaces: (id, faces) => ipcRenderer.invoke('media:faces', id, faces),
  prepareHires: (ids, maxEdge) => ipcRenderer.invoke('export:hires', ids, maxEdge),
  pickPackDir: () => ipcRenderer.invoke('dialog:pack'),
  packProject: (project, dir) => ipcRenderer.invoke('project:pack', project, dir),
  openProjectFile: () => ipcRenderer.invoke('project:open-dialog'),
  importProjectFile: (path) => ipcRenderer.invoke('project:import-file', path),
  onOpenFile: (cb) => subscribe('app:open-file', cb),
  displays: () => ipcRenderer.invoke('app:displays'),
  presentStart: () => ipcRenderer.invoke('present:start'),
  presentStop: () => ipcRenderer.invoke('present:stop'),
  onPresentClosed: (cb) => subscribe('present:closed', cb),
  exportChunk: (data) => ipcRenderer.invoke('export:chunk', data),
  videoStrip: (path, count, height) => ipcRenderer.invoke('media:strip', path, count, height),
  cacheInfo: () => ipcRenderer.invoke('cache:info'),
  cleanCache: (what) => ipcRenderer.invoke('cache:clean', what),
  relinkMedia: (missing, folder) => ipcRenderer.invoke('media:relink', missing, folder),
  mediaPrioritize: (ids) => ipcRenderer.invoke('media:prioritize', ids),
  listBackups: (id) => ipcRenderer.invoke('project:backups', id),
  restoreBackup: (file) => ipcRenderer.invoke('project:restore-backup', file),
  getAppSettings: () => ipcRenderer.invoke('app:settings-get'),
  setAppSettings: (s) => ipcRenderer.invoke('app:settings-set', s),
  keepAwake: (on) => ipcRenderer.invoke('app:keep-awake', on),
  queueAdd: (job) => ipcRenderer.invoke('queue:add', job),
  queueList: () => ipcRenderer.invoke('queue:list'),
  queueCancel: (id) => ipcRenderer.invoke('queue:cancel', id),
  queueRemove: (id) => ipcRenderer.invoke('queue:remove', id),
  queueResume: (id) => ipcRenderer.invoke('queue:resume', id),
  onQueueUpdate: (cb) => subscribe('queue:update', cb),
  workerNext: () => ipcRenderer.invoke('worker:next'),
  segmentStart: (jobId, k, input) => ipcRenderer.invoke('worker:segment-start', jobId, k, input),
  segmentFinish: (jobId, k) => ipcRenderer.invoke('worker:segment-finish', jobId, k),
  workerFail: (jobId, message) => ipcRenderer.invoke('worker:fail', jobId, message)
}

contextBridge.exposeInMainWorld('api', api)
