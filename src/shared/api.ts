// Contract between renderer and main process. The preload script exposes an object
// implementing DiashowApi as `window.api`; each method maps to one IPC channel.
import type {
  Rect,
  EncoderInfo,
  ExportOptions,
  ExportProgress,
  MediaItem,
  MusicTrack,
  Project,
  ProjectSummary
} from './types'

export interface DiashowApi {
  platform: string
  locale(): Promise<string>

  // Media import. importPaths expands folders recursively, pairs Live Photos and RAW+JPEG,
  // returns items immediately (status 'pending'/'processing'), and keeps processing in the
  // background, reporting each change through onMediaUpdate.
  importPaths(paths: string[]): Promise<MediaItem[]>
  /** Re-validate media from a saved project (cache present? file still there?). */
  restoreMedia(items: MediaItem[]): Promise<MediaItem[]>
  onMediaUpdate(cb: (item: MediaItem) => void): () => void
  importMusic(paths: string[]): Promise<MusicTrack[]>
  restoreMusic(tracks: MusicTrack[]): Promise<MusicTrack[]>
  onMusicUpdate(cb: (track: MusicTrack) => void): () => void
  /** Peak values 0..1 for an audio lane. */
  waveform(path: string, buckets: number): Promise<number[]>

  pickMedia(): Promise<string[]>
  pickFolder(): Promise<string[]>
  pickMusic(): Promise<string[]>
  /** Absolute path of a File from a drag & drop event. */
  pathForFile(file: File): string

  // Projects, stored as JSON in Documents\Diashow Studio
  listProjects(): Promise<ProjectSummary[]>
  loadProject(id: string): Promise<Project>
  saveProject(project: Project): Promise<void>
  deleteProject(id: string): Promise<void>

  // Export: renderer renders frames, main encodes them with FFmpeg.
  encoders(): Promise<EncoderInfo>
  pickExportPath(defaultName: string): Promise<string | null>
  /** Mixes the audio plan, then starts the encoder. Resolves when ready for frames. */
  exportStart(options: ExportOptions): Promise<void>
  /** One RGBA frame, rows bottom-to-top (WebGL readPixels order), width*height*4 bytes. */
  exportFrame(rgba: Uint8Array): Promise<void>
  exportFinish(): Promise<string>
  exportCancel(): Promise<void>
  onExportProgress(cb: (p: ExportProgress) => void): () => void

  setFullscreen(on: boolean): Promise<void>
  revealInFolder(path: string): Promise<void>

  /** Store faces found by the renderer for a photo (persisted with the media cache). */
  setFaces(id: string, faces: Rect[]): Promise<void>
  /**
   * Playable versions of proxied videos at up to maxEdge pixels (e.g. 3840) for sharp 4K
   * exports. Reports ExportProgress with phase 'prepare'. Resolves with media id -> path.
   */
  prepareHires(ids: string[], maxEdge: number): Promise<Record<string, string>>

  /** Pack a project with copies of all its photos, videos and music into a folder. */
  pickPackDir(): Promise<string | null>
  packProject(project: Project, dir: string): Promise<string>
  /** Open a .dshow file (dialog), e.g. a packed project from another PC. */
  openProjectFile(): Promise<Project | null>
  importProjectFile(path: string): Promise<Project>
  /** A .dshow file was opened with the app (double click / second instance). */
  onOpenFile(cb: (path: string) => void): () => void

  /** Presentation: the show fullscreen on a second display (or a second window). */
  displays(): Promise<number>
  presentStart(): Promise<void>
  presentStop(): Promise<void>
  onPresentClosed(cb: () => void): () => void
}

/** URL scheme served by the main process with HTTP Range support (needed for video seeking). */
export const MEDIA_SCHEME = 'dsmedia'

export function mediaUrl(absPath: string): string {
  return `${MEDIA_SCHEME}://f/${encodeURIComponent(absPath)}`
}

export function pathFromMediaUrl(url: string): string {
  const u = new URL(url)
  return decodeURIComponent(u.pathname.replace(/^\//, ''))
}
