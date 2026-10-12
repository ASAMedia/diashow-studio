// Data model shared by the main process (media pipeline, export) and the renderer (editor, engine).

export type MediaKind = 'photo' | 'video'
export type MediaStatus = 'pending' | 'processing' | 'ready' | 'error'

/** A photo or video file the user imported. Paths are absolute Windows paths. */
export interface MediaItem {
  /** Stable id: hash of path + size + mtime. Also names the cache folder. */
  id: string
  path: string
  name: string
  kind: MediaKind
  /** Human readable format label, e.g. "HEIC", "Sony ARW", "XAVC HS · HEVC 4:2:2 10-bit". */
  format: string
  /** Camera / phone model if known, e.g. "iPhone 16 Pro", "ILCE-7M4". */
  device?: string
  /** Display size after rotation/orientation is applied. */
  width: number
  height: number
  /** Seconds (videos, and the motion part of live photos). */
  duration?: number
  fps?: number
  hasAudio?: boolean
  hdr?: boolean
  /** Capture time, ms since epoch (EXIF DateTimeOriginal / QuickTime CreationDate / file mtime). */
  captureTime: number
  /** Live Photo (iPhone HEIC+MOV pair) or Motion Photo (Android, embedded MP4). */
  live?: { source: string; duration: number }
  status: MediaStatus
  /** 0..1 while processing (proxy transcode). */
  progress?: number
  error?: string
  /** Derived files in the cache, set once processing is done. */
  thumb?: string
  /** Photos: sRGB JPEG, orientation applied, long edge <= 3840. */
  display?: string
  /** Videos: file Chromium can decode (original if compatible, else H.264 proxy). Always rotation 0, SDR. */
  playback?: string
  /** Videos with sound: extracted audio (m4a/AAC 48 kHz stereo). */
  audio?: string
  /** Live/Motion photos: playable H.264 proxy of the motion part. */
  liveVideo?: string
  /** True when playback is a transcoded proxy. */
  proxied?: boolean
  /** Faces found in the display image (normalised rects), set by the renderer's face detection. */
  faces?: Rect[]
  /** Photos: sharpness 0..1 (variance of the Laplacian on a small greyscale copy, normalised). */
  sharpness?: number
  /** Photos (and video thumbnails): 64-bit difference hash as 16 hex chars, for duplicate detection. */
  hash?: string
  /** Videos with sound: integrated loudness of the audio in LUFS (EBU R128). */
  loudness?: number
  /** Face descriptors (one vector per face, aligned with `faces`) for recognising the same person. */
  faceDesc?: number[][]
  /** Videos: faces found in frames sampled across the clip (t in source seconds). */
  videoFaces?: VideoFaces[]
  /**
   * Centre of the faces (weighted by size), kept when the clean-up removed the face data, so crops
   * and Ken Burns moves stay as they were. Only used while `faces` is empty.
   */
  faceFocus?: { x: number; y: number }
  /** Videos: stabilised version of `playback`, made on request (same timing and size). */
  stabilized?: string
  /** Videos: 0..1 while the stabilised version is being made. */
  stabilizing?: number
  /** Videos: difference hash of a frame at 60 % of the clip (`hash` is the thumbnail at 10 %), for finding the same clip twice. */
  hash2?: string
  /** Videos: bits per second of the original file (size / duration); a re-encode has fewer. */
  bitrate?: number
  /**
   * Rotation, straightening and crop set by the user (shared/mediaEdit.ts); applies wherever the
   * picture appears. Face data and pixelated areas stay in coordinates of the original picture.
   */
  edit?: MediaEdit
}

/** How a photo or video is turned, straightened and cropped, like the edit view of macOS Photos. */
export interface MediaEdit {
  /** Quarter turns, degrees clockwise. */
  rotate: 0 | 90 | 180 | 270
  /** Degrees clockwise, -45..45; the picture is zoomed so its frame shows no empty corners. */
  straighten: number
  /** The part of the straightened picture that is kept (normalised); all of it when undefined. */
  crop?: Rect
}

/** Faces in one sampled frame of a video. */
export interface VideoFaces {
  t: number
  faces: Rect[]
  /** Descriptors aligned with `faces`. */
  desc?: number[][]
}

/** Someone who must not be recognisable: pixelated wherever the face is recognised. */
export interface Person {
  id: string
  /** Optional label (e.g. a first name); only stored in the project. */
  name?: string
  /** Descriptors of the faces marked as this person. */
  desc: number[][]
}

export interface MusicTrack {
  id: string
  path: string
  title: string
  artist?: string
  duration: number
  status: MediaStatus
  error?: string
  /** File playable by Chromium's <audio> (original or transcoded m4a). */
  playback?: string
  /** Beat times in seconds from the start of the track, and the detected tempo. */
  beats?: number[]
  bpm?: number
  /** Integrated loudness in LUFS (EBU R128). */
  loudness?: number
  /** The part of the song that plays, seconds; the whole song when undefined. */
  trimIn?: number
  trimOut?: number
}

/** Normalised rectangle (0..1) inside a source image. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type GroupBreak = 'auto' | 'force' | 'join'

interface BaseEntry {
  id: string
  /** Custom on-screen seconds ("Play selected for"). */
  duration?: number
  /** Multi-photo themes: force a new slide before this entry, or join it with the previous one. */
  groupBreak?: GroupBreak
  /** Text shown on the slide (Magazine: bottom right of the main photo). */
  caption?: string
  /** Layout template chosen by the user for the slide that starts with this entry. */
  layout?: string
  /** Text boxes placed freely on the slide. */
  texts?: FreeText[]
  /** Left out of the show (culling); the entry stays in the project and can come back. */
  excluded?: boolean
  /** Culling: 0..5 stars. */
  rating?: number
  /** Free collage (slide layout 'free'): place of this item on its slide, slide coordinates 0..1, degrees. */
  place?: CollagePlace
}

export interface CollagePlace {
  x: number
  y: number
  w: number
  h: number
  rot: number
  /** Stacking order; higher is in front. */
  z: number
}

/** Animation of title and chapter slides. */
export type TitleStyle = 'theme' | 'handwriting' | 'typewriter' | 'bigDate' | 'credits'

/** A text box placed on a slide by the user. */
export interface FreeText {
  id: string
  text: string
  /** Centre of the box in slide coordinates, 0..1. */
  x: number
  y: number
  /** Font size as a fraction of the slide height. */
  size: number
  font: TextFont
  /** CSS colour. */
  color: string
  bold: boolean
  /** Behind the text: nothing, a soft shadow, a dark band, a white card or a speech bubble. */
  box: 'none' | 'shadow' | 'band' | 'card' | 'bubble'
  /** Degrees, clockwise. */
  rotation: number
}

/** Framing of a photo cropped into a cell: focus point (0..1 of the image) and zoom (>= 1). */
export interface Crop {
  x: number
  y: number
  zoom: number
}

export interface PhotoEntry extends BaseEntry {
  type: 'photo'
  mediaId: string
  /** Ken Burns start/end framing; default motion when undefined. */
  kenBurns?: { start: Rect; end: Rect }
  /** Framing in cropped layouts (Magazine, Origami, Sliding Panels, Classic fill). */
  crop?: Crop
  /** Show the whole picture (true) or crop it to fill its cell (false); undefined = project setting. */
  whole?: boolean
  /** Play the motion part of a Live/Motion photo; undefined = project default. */
  playLive?: boolean
  /** Areas made unrecognisable (pixelated), normalised to the picture. */
  privacy?: Rect[]
}

export interface VideoEntry extends BaseEntry {
  type: 'video'
  mediaId: string
  trimIn?: number
  trimOut?: number
  /** 0..2, default 1. */
  volume?: number
  muted?: boolean
  /** Override project ducking for this clip. */
  duck?: boolean
  /** Framing when the clip is cropped into a grid cell (Magazine). */
  crop?: Crop
  /** Whole picture or cropped; undefined = automatic (cropped when the shapes are close). */
  whole?: boolean
  /** Playback speed (0.25 = slow motion, 4 = time lapse); default 1. Sound plays (pitch kept) between 0.5 and 2. */
  speed?: number
  /** Areas made unrecognisable (pixelated), normalised to the picture; fixed for the whole clip. */
  privacy?: Rect[]
  /** Pixelated areas that follow a face through the clip: keyframes (t in source seconds). */
  privacyTracks?: { t: number; r: Rect }[][]
  /** Play the stabilised version of the clip (made in the background). */
  stabilize?: boolean
}

export interface TextEntry extends BaseEntry {
  type: 'text'
  title: string
  subtitle?: string
  /** Created by "day titles" / "chapters from folders"; replaced when those run again. */
  auto?: 'day'
  /** Songs (music ids) for the chapter this slide starts; the show's playlist when undefined. */
  music?: string[]
  /** Animation of this slide; the show's title style when undefined. */
  titleStyle?: TitleStyle
}

export type Entry = PhotoEntry | VideoEntry | TextEntry

export type ThemeId =
  | 'kenburns'
  | 'origami'
  | 'reflections'
  | 'panels'
  | 'vintage'
  | 'classic'
  | 'magazine'
  | 'retro'
  | 'scrapbook'
  | 'snapshots'
  | 'shatter'

export type LookId = 'natural' | 'vivid' | 'warm' | 'cool' | 'dramatic' | 'mono' | 'noir' | 'faded'

export type TransitionId =
  | 'dissolve'
  | 'fadeBlack'
  | 'fadeWhite'
  | 'push'
  | 'wipe'
  | 'moveIn'
  | 'reveal'
  | 'cube'
  | 'flip'
  | 'zoom'
  | 'droplet'

export type Direction = 'left' | 'right' | 'up' | 'down'
export type AspectRatio = '16:9' | '4:3' | '1:1' | '9:16'

export interface AudioSettings {
  /** 0..1 */
  musicVolume: number
  /** Play the sound of video clips. */
  videoSound: boolean
  /** Lower the music while a video with sound plays. */
  duck: boolean
  /** Music gain while ducked, 0..1 (0.2 = -14 dB). */
  duckLevel: number
  /** Ramp time in seconds. */
  duckFade: number
  fadeIn: number
  fadeOut: number
  /** Repeat the playlist if the show is longer than the music. */
  repeatMusic: boolean
  /** Crossfade between consecutive songs, seconds. */
  crossfade: number
  /** Bring songs and video sound to the same loudness. */
  normalize?: boolean
}

export type TextFont = 'theme' | 'sans' | 'rounded' | 'caption' | 'display' | 'serif' | 'editorial' | 'type' | 'hand'
export type TextPosition = 'theme' | 'bottom-left' | 'bottom-center' | 'bottom-right' | 'top-left' | 'center'

/** Overrides for titles and captions; 'theme' keeps the theme's own choice. */
export interface TextStyle {
  font: TextFont
  /** Size factor, 1 = theme default. */
  scale: number
  /** CSS colour, or '' for the theme colour. */
  color: string
  position: TextPosition
  uppercase: 'theme' | 'on' | 'off'
}

export interface ProjectSettings {
  theme: ThemeId
  look: LookId
  aspect: AspectRatio
  /** beatSync: slide changes land on beats of the music. */
  timing: { mode: 'fitToMusic' | 'custom'; customTotal: number; beatSync?: boolean }
  /** Used by themes with a free transition choice (Classic). */
  transition: { type: TransitionId; speed: number; direction: Direction }
  scaleToFill: boolean
  playFullVideos: boolean
  playLivePhotos: boolean
  loop: boolean
  audio: AudioSettings
  /** Show an opening title slide with the project name. */
  showTitle: boolean
  titleText?: string
  subtitleText?: string
  text?: TextStyle
  /** Longest stretch of a video that plays (seconds); 0 or undefined = whole clip. */
  maxVideoSeconds?: number
  /** Animation of title and chapter slides. */
  titleStyle?: TitleStyle
  /**
   * Play a bundled theme song while the show has no songs of its own (shared/themeMusic.ts). New
   * shows have it on; missing (older projects) means off, so their sound stays as it was.
   */
  themeMusic?: boolean
  /** Which theme song: 'auto' (or missing) follows the show's theme. */
  themeSong?: ThemeId | 'auto'
}

export const DEFAULT_TEXT_STYLE: TextStyle = { font: 'theme', scale: 1, color: '', position: 'theme', uppercase: 'theme' }

export interface Project {
  version: 1
  id: string
  name: string
  createdAt: number
  updatedAt: number
  entries: Entry[]
  /** Media referenced by entries, persisted so a project opens without re-probing. */
  media: MediaItem[]
  music: MusicTrack[]
  settings: ProjectSettings
  /** People pixelated wherever their face is recognised. */
  people?: Person[]
  /** Deletion reminder (ms since 1970): from then on the home screen suggests cleaning up (src/shared/cleanup.ts). */
  deleteAt?: number
  /**
   * When the clean-up removed the face data (ms since 1970). Pixelation was turned into fixed areas;
   * the background face search stays off until someone is marked again.
   */
  faceDataRemovedAt?: number
}

export interface ProjectSummary {
  id: string
  name: string
  updatedAt: number
  slideCount: number
  /** Thumbnail path of the first photo, if any. */
  cover?: string
  /** The project's deletion reminder, if set. */
  deleteAt?: number
}

/** Linear gain keyframe on the show timeline (seconds, linear gain). */
export interface GainPoint {
  t: number
  g: number
}

/** One audio source placed on the timeline. Gain points use timeline time and interpolate linearly. */
export interface AudioPlanClip {
  id: string
  kind: 'music' | 'video'
  /** Absolute path FFmpeg / <audio> can read. */
  src: string
  /** Timeline second the clip starts at. */
  start: number
  /** Offset into the source file, seconds. */
  offset: number
  /** Timeline seconds; the source span read is duration * rate. */
  duration: number
  gain: GainPoint[]
  /** Playback rate of the source with the pitch kept (video speed); default 1. */
  rate?: number
}

export interface AudioPlan {
  duration: number
  clips: AudioPlanClip[]
}

export type VideoCodec = 'h264' | 'hevc'
export type ExportQuality = 'standard' | 'high' | 'max'

export interface ExportOptions {
  outPath: string
  width: number
  height: number
  fps: number
  codec: VideoCodec
  quality: ExportQuality
  /** Use NVENC / QSV / AMF when available. */
  hardware: boolean
  audio: AudioPlan
  /**
   * 'rgba': raw frames through exportFrame (FFmpeg encodes). 'h264' / 'hevc': the renderer
   * encodes with WebCodecs and sends an Annex B elementary stream through exportChunk
   * (FFmpeg only muxes it with the audio).
   */
  input?: 'rgba' | 'yuv' | 'h264' | 'hevc'
}

export interface CacheInfo {
  dir: string
  /** Bytes. */
  total: number
  parts: { thumbs: number; display: number; proxies: number; hires: number; audio: number; other: number }
  /** Cache of media no saved project uses any more. */
  unused: number
  unusedItems: number
}

export interface BackupInfo {
  file: string
  savedAt: number
  slideCount: number
}

/** App-wide settings (not per project). */
export interface AppSettings {
  /** Kiosk: open this project fullscreen in a loop when the app starts. */
  kioskProjectId?: string | null
  /** Look for a newer release on GitHub when the app starts (at most once a day); on unless false. */
  updateCheck?: boolean
  /** Last automatic update check (ms since 1970) and the newest release it found. */
  updateCheckedAt?: number
  updateLatest?: { version: string; url: string } | null
  /** Network hosts (\\host\share) whose files may be opened without asking. */
  trustedHosts?: string[]
  /**
   * Laptops with two graphics chips: render on the high-performance one ('performance', default:
   * 4K exports about a third faster) or leave the choice to Windows ('saving'). Applies at the next start.
   */
  gpuPreference?: 'performance' | 'saving'
}

/** What the running app uses (app:gpu-choice). */
export interface GpuChoiceInfo {
  /** The preference in effect since the start. */
  running: 'performance' | 'saving'
  /** DIASHOW_GPU set for tests: the setting has no effect. */
  override: boolean
  /** Graphics chips Chromium sees; the setting matters only with two or more. */
  chips: number
}

export interface EncoderInfo {
  h264: string[]
  hevc: string[]
  /** Best hardware encoder per codec, if any. */
  hardware: { h264?: string; hevc?: string }
  /** h264_qsv accepts look-ahead (LA-ICQ, needed for NVENC-like quality); false on chips without it. */
  qsvLookAhead?: boolean
}

export interface ExportProgress {
  phase: 'prepare' | 'audio' | 'video' | 'finishing' | 'done' | 'error' | 'cancelled'
  frame?: number
  totalFrames?: number
  message?: string
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  theme: 'kenburns',
  look: 'natural',
  aspect: '16:9',
  timing: { mode: 'fitToMusic', customTotal: 120 },
  transition: { type: 'dissolve', speed: 0.5, direction: 'left' },
  scaleToFill: true,
  playFullVideos: true,
  playLivePhotos: false,
  loop: false,
  showTitle: true,
  themeMusic: true,
  themeSong: 'auto',
  audio: {
    musicVolume: 0.8,
    videoSound: true,
    duck: true,
    duckLevel: 0.2,
    duckFade: 0.6,
    fadeIn: 1,
    fadeOut: 3,
    repeatMusic: true,
    crossfade: 2,
    normalize: true
  }
}
