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
}

export interface TextEntry extends BaseEntry {
  type: 'text'
  title: string
  subtitle?: string
  /** Created by "day titles" / "chapters from folders"; replaced when those run again. */
  auto?: 'day'
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
}

export type TextFont = 'theme' | 'sans' | 'rounded' | 'caption' | 'display' | 'serif' | 'editorial' | 'type'
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
}

export interface ProjectSummary {
  id: string
  name: string
  updatedAt: number
  slideCount: number
  /** Thumbnail path of the first photo, if any. */
  cover?: string
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
  duration: number
  gain: GainPoint[]
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
}

export interface EncoderInfo {
  h264: string[]
  hevc: string[]
  /** Best hardware encoder per codec, if any. */
  hardware: { h264?: string; hevc?: string }
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
  audio: {
    musicVolume: 0.8,
    videoSound: true,
    duck: true,
    duckLevel: 0.2,
    duckFade: 0.6,
    fadeIn: 1,
    fadeOut: 3,
    repeatMusic: true,
    crossfade: 2
  }
}
