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
  GpuChoiceInfo,
  MediaItem,
  MusicTrack,
  Project,
  ProjectSummary,
  VideoFaces
} from './types'
import type { ExportJobInfo, ExportTask, NewExportJob, SegmentInput } from './exportQueue'
import type { ThemeTrack } from './themeMusic'
import type { ShareCommand, ShareFilesEvent, ShareStatus } from './share'
import type { CleanupChoice, CleanupInventory, CleanupResult, DeleteExtras } from './cleanup'
import type { HistoryRestore, HistoryUpload } from './history'
import type { ArchiveChoice, ArchiveInventory, ArchiveProgress, ArchiveResult, ArchiveTarget, ArchiveVideo } from './archive'
import type { BenchMedia, EncoderTest, SystemInfo } from './systemCheck'
import type { AboutInfo, UpdateStatus } from './about'
import type { ReportFields } from './reportProblem'
import type { DamagedProject, DiagnosticsInput, DiagnosticsPreview, ProjectRef, ProjectReportEvent, RendererLogEntry, RepairChoice, RepairPlan } from './diagnostics'

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
  /** The bundled theme songs (src/shared/themeMusic.ts), ready to play; [] when there are none. */
  themeSongs(): Promise<ThemeTrack[]>
  /** Peak values 0..1 for an audio lane. */
  waveform(path: string, buckets: number): Promise<number[]>

  pickMedia(): Promise<string[]>
  pickFolder(): Promise<string[]>
  pickMusic(): Promise<string[]>
  /** Absolute path of a File from a drag & drop event. */
  pathForFile(file: File): string
  /**
   * Ctrl+V in the editor: the files copied in Explorer, or a copied picture without a file (a
   * screenshot) saved as a PNG in Documents\Diashow Studio\Eingefügt\<project> first; [] otherwise.
   */
  clipboardMedia(projectName: string): Promise<string[]>

  // Projects, stored as JSON in Documents\Diashow Studio
  listProjects(): Promise<ProjectSummary[]>
  loadProject(id: string): Promise<Project>
  /**
   * Saves a project; the editor sends its undo history along (src/shared/history.ts). `resendHistory`:
   * the main process misses patches the upload referred to, the next save must send all of them.
   */
  saveProject(project: Project, history?: HistoryUpload): Promise<{ resendHistory?: boolean } | void>
  /** Deletes a project with its older versions, undo history and the face data of its media; `extras`: its caches, uploads, finished exports too. */
  deleteProject(id: string, extras?: DeleteExtras): Promise<CleanupResult>

  // Undo history kept per show in the app's data folder (src/main/history.ts)
  /** The stored history of the show loaded last with loadProject, checked and validated; null when there is none that fits. */
  loadHistory(projectId: string): Promise<HistoryRestore | null>
  /** Deletes the stored history of a show, or (null) of every show. */
  clearHistory(projectId: string | null): Promise<{ files: number; bytes: number }>

  // "Nach dem Projekt aufräumen" (src/shared/cleanup.ts)
  /** What the app keeps for a project (face data, uploads, caches, older versions, export jobs), with sizes. */
  cleanupInventory(projectId: string): Promise<CleanupInventory>
  /** Removes what was chosen, for good; pixelation stays. Save an open project first and take the result's project. */
  cleanupRun(projectId: string, choice: CleanupChoice): Promise<CleanupResult>
  /** Deletion reminder of a project that is not open (null: none). */
  setDeleteAt(projectId: string, at: number | null): Promise<void>

  // "Diashow als ZIP archivieren" (src/shared/archive.ts)
  /** What the archive of a saved project would hold, with sizes, a suggested target and its free space. */
  archiveInventory(projectId: string): Promise<ArchiveInventory>
  /** Save dialog for the .zip (`bytes`: about how large it becomes, for the FAT32 check); null when cancelled. */
  pickArchiveTarget(suggested: string, bytes: number): Promise<ArchiveTarget | null>
  /** "Add another video file…": open dialog for videos to put into the archive. */
  pickArchiveVideos(): Promise<ArchiveVideo[]>
  /** Writes and checks the archive at a target from pickArchiveTarget; progress through onArchiveProgress. */
  archiveRun(projectId: string, choice: ArchiveChoice, target: string): Promise<ArchiveResult>
  /** Stops the archive being written and deletes its partial file. */
  archiveCancel(): Promise<void>
  onArchiveProgress(cb: (p: ArchiveProgress) => void): () => void

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
  /** Graphics chip in use and how many there are (Settings → Graphics chip). */
  gpuChoice(): Promise<GpuChoiceInfo>
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
  /** Merges the given fields into the stored settings (null clears a field). */
  setAppSettings(settings: AppSettings): Promise<void>
  /** Keep the display awake (fullscreen show, presentation, kiosk). */
  keepAwake(on: boolean): Promise<void>

  // Export queue (src/shared/exportQueue.ts): jobs run one after another in a hidden worker window,
  // in segments, and continue after a crash or restart.
  /** Queues an export (rejects invalid jobs, or a second job writing the same file). Starts the worker. */
  /** Lets the app open files on these network hosts (\\host\share) from now on. */
  trustNetworkHosts(hosts: string[]): Promise<void>
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

  // About dialog and update hint (src/shared/about.ts)
  aboutInfo(): Promise<AboutInfo>
  /** THIRD_PARTY_NOTICES.txt shipped with the app; null when it is missing (development). */
  thirdPartyNotices(): Promise<string | null>
  /**
   * Newest release on GitHub. Without `force` (start-up): at most once a day, nothing when switched
   * off in Settings or in a development build. `force` (About dialog) always asks. Never rejects.
   */
  checkUpdate(force?: boolean): Promise<UpdateStatus>

  // "Problem melden" (src/shared/reportProblem.ts)
  /** App version, Windows version and graphics card for the bug form; nothing personal. */
  reportFields(): Promise<ReportFields>
  /** Opens a page of the project on GitHub in the browser; rejects any other URL. */
  openGithub(url: string): Promise<void>

  // Diagnostics and project checks (src/shared/diagnostics.ts)
  /** An error of this window for the log file (fire and forget; rate-limited and capped by the main process). */
  logError(entry: RendererLogEntry): void
  /** The files of the diagnostics package as they would be saved (nothing is written). */
  diagnosticsPreview(input: DiagnosticsInput): Promise<DiagnosticsPreview>
  /** Asks where to save the diagnostics package (zip) and writes it; null when cancelled. */
  diagnosticsSave(input: DiagnosticsInput): Promise<string | null>
  /** A project had to be repaired when it was opened, imported, restored or rescued. */
  onProjectReport(cb: (event: ProjectReportEvent) => void): () => void
  /** Project files in the projects folder that cannot be opened (damaged, or from a newer app). */
  damagedProjects(): Promise<DamagedProject[]>
  /** Asks for a .dshow file (open dialog) without reading it; null when cancelled. */
  pickProjectFile(): Promise<string | null>
  /** What a repair can rescue from a damaged project file, and its backups. */
  inspectRepair(ref: ProjectRef): Promise<RepairPlan>
  /** Repairs a damaged project (rescue or backup); resolves with the project to open. */
  repairProject(ref: ProjectRef, choice: RepairChoice): Promise<Project>
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
