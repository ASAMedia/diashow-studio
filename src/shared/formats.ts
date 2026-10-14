// File types the app accepts. Lower-case, without dot.

/** Decoded directly by sharp (libvips). */
export const SHARP_IMAGE_EXT = ['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'avif', 'gif', 'tif', 'tiff', 'bmp']
/** HEIF family, decoded by FFmpeg (iPhone/Samsung HEIC, Sony HIF 10-bit 4:2:2). */
export const HEIF_EXT = ['heic', 'heif', 'hif']
/** Camera RAW: Sony ARW/SR2/SRF, DNG (iPhone ProRAW, Android), and common others. */
export const RAW_EXT = ['arw', 'sr2', 'srf', 'dng', 'cr2', 'cr3', 'nef', 'nrw', 'raf', 'orf', 'rw2', 'pef', 'srw']
export const JXL_EXT = ['jxl']
export const IMAGE_EXT = [...SHARP_IMAGE_EXT, ...HEIF_EXT, ...RAW_EXT, ...JXL_EXT]

/**
 * Phones: MOV/MP4 (H.264, HEVC, ProRes), 3GP. Sony: MP4 (XAVC S/HS/S-I), MTS/M2TS (AVCHD).
 * Others: MKV, WebM, AVI, M4V, MPG, WMV.
 */
export const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'qt', '3gp', '3g2', 'mts', 'm2ts', 'ts', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'wmv', 'mxf']

export const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff', 'alac', 'mka']
/** Audio Chromium plays without transcoding. */
export const NATIVE_AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus']

/** Sidecar files that come with camera/phone media and are skipped on import. */
export const SIDECAR_EXT = ['xml', 'thm', 'xmp', 'aae', 'bim', 'cpi', 'mpl', 'bdm', 'ppn', 'lrv', 'srt', 'ini', 'db']

export function extOf(path: string): string {
  const m = /\.([^.\\/]+)$/.exec(path)
  return m ? m[1].toLowerCase() : ''
}

export function classify(path: string): 'photo' | 'video' | 'audio' | null {
  const e = extOf(path)
  if (IMAGE_EXT.includes(e)) return 'photo'
  if (VIDEO_EXT.includes(e)) return 'video'
  if (AUDIO_EXT.includes(e)) return 'audio'
  return null
}

/** Dropped or pasted paths: songs go to the music, everything else (photos, videos, folders) into the show. */
export function splitAudio(paths: string[]): { audio: string[]; media: string[] } {
  return { audio: paths.filter((p) => classify(p) === 'audio'), media: paths.filter((p) => classify(p) !== 'audio') }
}
