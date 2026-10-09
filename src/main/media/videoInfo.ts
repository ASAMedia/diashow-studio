// Pure analysis of ffprobe output: display size, rotation, HDR, playback compatibility, labels.
import { extOf } from '@shared/formats'
import { parseRational, type ProbeResult, type ProbeStream } from '../ffmpeg'

export interface VideoInfo {
  stream: ProbeStream
  /** Display size: rotation and non-square pixels applied. */
  width: number
  height: number
  /** Clockwise display rotation, one of 0/90/180/270. */
  rotation: number
  duration: number
  /** Source frame rate. */
  fps: number
  /** CFR rate used for proxies (<= 60). */
  proxyFps: number
  hdr: false | 'hlg' | 'pq'
  dolbyVision: boolean
  bitDepth: number
  chroma: '4:2:0' | '4:2:2' | '4:4:4' | 'other'
  interlaced: boolean
  /** Index (among audio streams, for -map 0:a:N) of the first decodable audio stream. */
  audioIndex: number | null
  audioCodecs: string[]
  hasAudio: boolean
}

/** Audio codecs Chromium decodes inside MP4/MOV/WebM. */
const CHROMIUM_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac']
const DIRECT_H264_PROFILES = ['baseline', 'constrained baseline', 'main', 'high', 'progressive high', 'constrained high']
const MAX_DIRECT = { long: 3840, short: 2160 }

export function videoStream(probe: ProbeResult): ProbeStream | undefined {
  return probe.streams.find(
    (s) => s.codec_type === 'video' && !s.disposition?.attached_pic && (s.width ?? 0) > 0
  )
}

export function rotationOf(stream: ProbeStream): number {
  let deg = 0
  const side = stream.side_data_list?.find((d) => typeof d.rotation === 'number')
  if (side) deg = Number(side.rotation)
  else if (stream.tags?.rotate) deg = -Number(stream.tags.rotate)
  // ffprobe reports the display matrix angle counter-clockwise; normalise to clockwise 0..270
  const cw = (((-Math.round(deg / 90) * 90) % 360) + 360) % 360
  return cw
}

function pixFmtInfo(pixFmt: string | undefined): { bitDepth: number; chroma: VideoInfo['chroma'] } {
  const f = pixFmt ?? ''
  const depth = /p(\d{2})(le|be)$/.exec(f)
  const bitDepth = depth ? Number(depth[1]) : f ? 8 : 8
  let chroma: VideoInfo['chroma'] = 'other'
  if (/^yuvj?420p/.test(f) || /^nv12|^p010|^p016/.test(f)) chroma = '4:2:0'
  else if (/^yuvj?422p/.test(f) || /^nv16|^p210|^y210/.test(f)) chroma = '4:2:2'
  else if (/^yuvj?444p|^gbrp|^rgb|^bgr/.test(f)) chroma = '4:4:4'
  return { bitDepth, chroma }
}

/** Source frame rate: average rate when sane, snapped to standard rates (VFR phone clips → 29.97). */
export function sourceFps(stream: ProbeStream): number {
  const avg = parseRational(stream.avg_frame_rate)
  const r = parseRational(stream.r_frame_rate)
  let fps = avg > 1 && avg < 1000 ? avg : r > 1 && r < 1000 ? r : 30
  const standard = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120, 240]
  const near = standard.reduce((best, s) => (Math.abs(s - fps) < Math.abs(best - fps) ? s : best))
  if (Math.abs(near - fps) / near < 0.005) fps = near
  return Math.round(fps * 1000) / 1000
}

/** Frame rate for CFR proxies: the source rate halved until <= 60 (120 → 60, 100 → 50). */
export function outputFps(stream: ProbeStream): number {
  let fps = sourceFps(stream)
  while (fps > 60.5) fps /= 2
  return Math.round(fps * 1000) / 1000
}

export function analyzeVideo(probe: ProbeResult): VideoInfo | null {
  const stream = videoStream(probe)
  if (!stream) return null
  const rotation = rotationOf(stream)
  const sar = parseRational(stream.sample_aspect_ratio)
  let w = stream.width ?? 0
  const h = stream.height ?? 0
  if (sar > 0 && Math.abs(sar - 1) > 0.01) w = Math.round(w * sar)
  const swap = rotation === 90 || rotation === 270
  const trc = stream.color_transfer ?? ''
  const dolbyVision = (stream.side_data_list ?? []).some((d) => /dovi|dolby/i.test(String(d.side_data_type)))
  const hdr = trc === 'arib-std-b67' ? 'hlg' : trc === 'smpte2084' ? 'pq' : false
  const { bitDepth, chroma } = pixFmtInfo(stream.pix_fmt)
  const audio = probe.streams.filter((s) => s.codec_type === 'audio')
  const decodable = audio.findIndex((s) => !!s.codec_name && s.codec_name !== 'none' && (s.channels ?? 1) > 0)
  const duration =
    parseFloat(probe.format.duration ?? '') || parseFloat(stream.duration ?? '') || 0
  const field = stream.field_order ?? 'progressive'
  return {
    stream,
    width: swap ? h : w,
    height: swap ? w : h,
    rotation,
    duration,
    fps: sourceFps(stream),
    proxyFps: outputFps(stream),
    hdr,
    dolbyVision,
    bitDepth,
    chroma,
    interlaced: ['tt', 'bb', 'tb', 'bt'].includes(field),
    audioIndex: decodable >= 0 ? decodable : null,
    audioCodecs: audio.map((s) => s.codec_name ?? 'unknown'),
    hasAudio: decodable >= 0
  }
}

/**
 * True when Chromium can play the original file as is: MP4/MOV/WebM, no rotation, SDR,
 * progressive 8-bit 4:2:0 H.264 (<= High), VP9 or AV1, at most UHD, and only Chromium audio codecs.
 */
export function isDirectPlayable(path: string, probe: ProbeResult, info: VideoInfo): boolean {
  const ext = extOf(path)
  const fmt = probe.format.format_name ?? ''
  const mp4 = ['mp4', 'mov', 'm4v'].includes(ext) && fmt.includes('mp4')
  const webm = ext === 'webm' && fmt.includes('webm')
  if (!mp4 && !webm) return false
  if (info.rotation !== 0 || info.hdr || info.dolbyVision || info.interlaced) return false
  const s = info.stream
  const pix = s.pix_fmt ?? ''
  if (pix !== 'yuv420p' && pix !== 'yuvj420p') return false
  const codec = s.codec_name ?? ''
  if (codec === 'h264') {
    if (!mp4 || !DIRECT_H264_PROFILES.includes((s.profile ?? '').toLowerCase())) return false
  } else if (codec !== 'vp9' && codec !== 'av1') {
    return false
  }
  const cw = s.width ?? 0
  const ch = s.height ?? 0
  if (Math.max(cw, ch) > MAX_DIRECT.long || Math.min(cw, ch) > MAX_DIRECT.short) return false
  if (Math.abs(parseRational(s.sample_aspect_ratio || '1') - 1) > 0.01 && s.sample_aspect_ratio !== '0:1') return false
  return info.audioCodecs.every((c) => CHROMIUM_AUDIO.includes(c))
}

const CODEC_LABEL: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  prores: 'ProRes',
  mpeg2video: 'MPEG-2',
  mpeg4: 'MPEG-4',
  mjpeg: 'Motion JPEG',
  dnxhd: 'DNxHD',
  vc1: 'VC-1',
  wmv3: 'WMV',
  wmv2: 'WMV',
  h263: 'H.263',
  theora: 'Theora',
  dvvideo: 'DV',
  cfhd: 'CineForm',
  vvc: 'VVC'
}

function hdrLabel(info: VideoInfo): string {
  if (info.dolbyVision) return info.hdr === 'hlg' ? ' Dolby Vision (HLG)' : ' Dolby Vision'
  if (info.hdr === 'hlg') return ' HDR (HLG)'
  if (info.hdr === 'pq') return ' HDR (PQ)'
  return ''
}

/** "XAVC HS · HEVC 4:2:2 10-bit", "HEVC 10-bit HDR (HLG)", "AVCHD", "ProRes 422 HQ", "H.264". */
export function videoFormatLabel(path: string, probe: ProbeResult, info: VideoInfo, make?: string): string {
  const ext = extOf(path)
  const s = info.stream
  const codec = s.codec_name ?? ''
  if (['mts', 'm2ts'].includes(ext) && codec === 'h264') return 'AVCHD'
  let name = CODEC_LABEL[codec] ?? codec.toUpperCase()
  if (codec === 'prores' && s.profile) {
    const p = s.profile.replace(/^ProRes\s*/i, '')
    name = /4444/.test(p) ? `ProRes ${p}` : `ProRes 422 ${p}`.replace(/\s+Standard$/i, '')
  }
  const sub = info.chroma !== '4:2:0' && info.chroma !== 'other' ? ` ${info.chroma}` : ''
  const depth = info.bitDepth > 8 ? ` ${info.bitDepth}-bit` : ''
  const tags = probe.format.tags ?? {}
  const brands = `${tags.major_brand ?? ''} ${tags.compatible_brands ?? ''}`
  const sony = /XAVC/i.test(brands) || (/sony/i.test(make ?? '') && ['mp4', 'mov'].includes(ext))
  if (sony && (codec === 'h264' || codec === 'hevc')) {
    const intra = /intra/i.test(s.profile ?? '')
    const family = codec === 'hevc' ? 'XAVC HS' : intra ? 'XAVC S-I' : 'XAVC S'
    return `${family} · ${name}${sub}${depth}${hdrLabel(info)}`
  }
  if (codec === 'prores' || codec === 'dnxhd') return name
  return `${name}${sub}${depth}${hdrLabel(info)}`
}
