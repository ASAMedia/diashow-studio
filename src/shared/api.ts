// Contract between renderer and main process. The preload script exposes an object
// implementing DiashowApi as `window.api`; each method maps to one IPC channel.
import type {
  AppSettings,
  BackupInfo,
  CacheInfo,
  Rect,
  EncoderInfo,
  ExportOptions,
  ExportProgress,
  MediaItem,
  MusicTrack,
  Project,
  ProjectSummary,
  VideoFaces
} from './types'
import type { ExportJobInfo, ExportTask, NewExportJob, SegmentInput } from './exportQueue'
import type { ShareCommand, ShareFilesEvent, ShareStatus } from './share'
import type { BenchMedia, EncoderTest, SystemInfo } from './systemCheck'

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

  /**
   * Store faces found by the renderer for a photo (persisted with the media cache), with one
   * descriptor per face when known (without, older descriptors are dropped).
   */
  setFaces(id: string, faces: Rect[], desc?: number[][]): Promise<void>
  /** Store the faces found in sampled frames of a video (MediaItem.videoFaces). */
  setVideoFaces(id: string, samples: VideoFaces[]): Promise<void>
  /**
   * JPEG frames of a video (path: original or playback) at source times in seconds, ascending, at
   * most 64 per call, scaled to fit maxEdge, rotation applied and HDR tone-mapped like the proxies.
   * Aligned with `times`; an empty array where no frame could be read.
   */
  videoFrames(path: string, times: number[], maxEdge: number): Promise<Uint8Array[]>
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

  /** Encoded video (Annex B) for exports with input 'h264' / 'hevc', in decoding order. */
  exportChunk(data: Uint8Array): Promise<void>
  /** `count` small JPEG frames spread over a video (for trimming), as file paths. */
  videoStrip(path: string, count: number, height: number): Promise<string[]>
  /** Disk space used by thumbnails, display images, proxies and audio. */
  cacheInfo(): Promise<CacheInfo>
  /** 'unused': media no project uses; 'hires': 4K export versions; 'proxies': all video proxies (rebuilt when needed). */
  cleanCache(what: 'unused' | 'hires' | 'proxies'): Promise<CacheInfo>
  /** Look for moved files in a folder (same name and size). Old media id -> found item (processing starts). */
  relinkMedia(missing: MediaItem[], folder: string): Promise<Record<string, MediaItem>>
  /**
   * What the user looks at now (media or music ids, most urgent first): their pending processing
   * (thumbnail, display image, sound, proxy, analysis) goes ahead of all other work. Each call
   * replaces the previous one; [] returns to show order. Resolves at once, not when the work is done.
   */
  mediaPrioritize(ids: string[]): Promise<void>
  listBackups(projectId: string): Promise<BackupInfo[]>
  restoreBackup(file: string): Promise<Project>
  getAppSettings(): Promise<AppSettings>
  setAppSettings(settings: AppSettings): Promise<void>
  /** Keep the display awake (fullscreen show, presentation, kiosk). */
  keepAwake(on: boolean): Promise<void>

  // Export queue (src/shared/exportQueue.ts): jobs run one after another in a hidden worker window,
  // in segments, and continue after a crash or restart.
  /** Queues an export (rejects invalid jobs, or a second job writing the same file). Starts the worker. */
  queueAdd(job: NewExportJob): Promise<ExportJobInfo>
  /** All jobs, oldest first, including done / cancelled / failed ones until removed. */
  queueList(): Promise<ExportJobInfo[]>
  /** Stops a job (also a running one) and deletes its parts and partial output; state 'cancelled'. */
  queueCancel(id: string): Promise<void>
  /** Deletes a job that is not running (and its folder). */
  queueRemove(id: string): Promise<void>
  /** "Continue": paused / error → queued; starts the worker. */
  queueResume(id: string): Promise<void>
  /** Job list after every change, at most about 4 times a second (not sent to the worker). */
  onQueueUpdate(cb: (jobs: ExportJobInfo[]) => void): () => void
  // Worker window only (#export-worker):
  /** Next task, or null when nothing is left (the worker window is then closed). May wait while a job is being joined. */
  workerNext(): Promise<ExportTask | null>
  /** Opens segment k; its frames / stream then go through exportFrame / exportChunk. */
  segmentStart(jobId: string, k: number, input: SegmentInput): Promise<void>
  /** Closes segment k after all its frames: checks the frame count and stores it. */
  segmentFinish(jobId: string, k: number): Promise<void>
  /** Gives up on the job (state 'error' with the message); then call workerNext() again. */
  workerFail(jobId: string, message: string): Promise<void>

  /**
   * Stabilised copy of a video (MediaItem.stabilized); progress and the result arrive through
   * onMediaUpdate (MediaItem.stabilizing 0..1, then stabilized). Rejects when it fails.
   */
  stabilizeVideo(mediaId: string): Promise<void>

  // Sharing over the local network (src/shared/share.ts): upload page for phones, download page
  /** Starts / stops the server, changes its interface, offers files; resolves with the new status. */
  shareControl(cmd: ShareCommand): Promise<ShareStatus>
  /** Status after changes (uploads, downloads, offers), at most 4 times a second. */
  onShareUpdate(cb: (status: ShareStatus) => void): () => void
  /** Files that arrived from phones (one event per file). */
  onShareFiles(cb: (event: ShareFilesEvent) => void): () => void

  // System check (src/shared/systemCheck.ts)
  systemInfo(): Promise<SystemInfo>
  /** Encodes 1 s of 1080p with every hardware encoder (and libx264), one after another. */
  systemEncoderTest(): Promise<EncoderTest[]>
  /** Generates photos and a clip for the export benchmark in a temp folder. */
  systemBenchMedia(): Promise<BenchMedia>
  /** Deletes the benchmark media. */
  systemBenchCleanup(): Promise<void>
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
