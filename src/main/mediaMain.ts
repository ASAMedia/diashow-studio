// IPC of photos, videos and music (media/service.ts): importing (picked files are trusted on their
// network share, netTrust.ts), reopening a show's media, waveforms, frames and frame strips, face data,
// relinking moved originals, what is processed first, stabilising, the bundled theme songs, and the
// cache sizes and cleaning in Settings.
import { ipcMain } from 'electron'
import type { RepeatCandidate } from '@shared/repeats'
import type { ThemeTrack } from '@shared/themeMusic'
import type { MediaItem, MusicTrack, Rect, VideoFaces } from '@shared/types'
import { checkLocalFile, stringList } from './ipcGuards'
import type { MediaService } from './media/service'
import type { NetTrust } from './netTrust'
import type { ProjectStore } from './projects'
import { inThemeMusicDir } from './protocol'

export function registerMedia(d: { service: MediaService; projects: ProjectStore; themeMusic: Promise<ThemeTrack[]>; net: NetTrust }): void {
  const { service, net } = d
  ipcMain.handle('media:import', async (_e, paths: string[]) => {
    await net.trustPaths(stringList(paths))
    return service.importPaths(stringList(paths))
  })
  ipcMain.handle('media:import-new', async (_e, paths: string[], show: unknown) => {
    await net.trustPaths(stringList(paths))
    return service.importNew(stringList(paths), show as RepeatCandidate[])
  })
  ipcMain.handle('media:restore', async (_e, items: MediaItem[]) => {
    await net.loaded
    return service.restoreMedia(items)
  })
  ipcMain.handle('music:import', async (_e, paths: string[]) => {
    await net.trustPaths(stringList(paths))
    return service.importMusic(stringList(paths))
  })
  ipcMain.handle('music:restore', async (_e, tracks: MusicTrack[]) => {
    await net.loaded
    return service.restoreMusic(tracks)
  })
  ipcMain.handle('music:theme-songs', () => d.themeMusic)
  // the user agreed to open files on these network hosts (banner in the editor)
  ipcMain.handle('net:trust-hosts', (_e, hosts: unknown) => net.trustHosts(hosts))
  // paths FFmpeg reads for the renderer: existing files only, never URLs nor untrusted shares (ipcGuards.ts);
  // the bundled theme songs wherever the app is (as dsmedia:// serves them, protocol.ts)
  const readable = (p: string): boolean => net.allowPath(p) || inThemeMusicDir(p)
  ipcMain.handle('audio:waveform', async (_e, path: string, buckets: number) => service.waveform(await checkLocalFile(path, readable), buckets))
  ipcMain.handle('media:faces', (_e, id: string, faces: Rect[], desc?: number[][]) => service.setFaces(id, faces, desc))
  ipcMain.handle('media:video-faces', (_e, id: string, samples: VideoFaces[]) => service.setVideoFaces(id, samples))
  ipcMain.handle('media:frames', async (_e, path: string, times: number[], maxEdge: number) => service.videoFrames(await checkLocalFile(path, readable), times, maxEdge))
  ipcMain.handle('media:strip', async (_e, path: string, count: number, height: number) => service.videoStrip(await checkLocalFile(path, readable), count, height))
  ipcMain.handle('media:relink', async (_e, missing: MediaItem[], folder: string) => {
    await net.trustPaths([String(folder)])
    return service.relinkMedia(missing, folder)
  })
  ipcMain.handle('media:prioritize', (_e, ids: string[]) => service.prioritize(stringList(ids)))
  ipcMain.handle('media:stabilize', (_e, id: string) => service.stabilizeVideo(String(id)))
  ipcMain.handle('cache:info', async () => service.cacheInfo(await d.projects.references()))
  ipcMain.handle('cache:clean', async (_e, what: 'unused' | 'hires' | 'proxies') => service.cleanCache(what, await d.projects.references()))
}
