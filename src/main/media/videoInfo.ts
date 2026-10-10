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
/**
 * Audio tracks Chromium can't decode but that don't stop the (muted) preview <video> nor WebCodecs
 * in an MP4/MOV, verified in Electron 44 (e2e/codecs.spec.ts): iPhone 16 spatial audio next to its
 * AAC track, little-endian LPCM. The sound itself always comes from the extracted audio file.
 */
const TOLERATED_AUDIO = ['apple_apac', 'pcm_s16le']
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

/** Decoders of this machine the renderer can use for originals (see src/main/codecSupport.ts). */
export interface DirectDecode {
  /**
   * 8-bit HEVC (Main profile) plays in the preview's <video> and decodes through WebCodecs. Chromium
   * has no software HEVC decoder, so this depends on the graphics hardware.
   */
  hevc?: boolean
}

/**
 * How a video becomes playable in the renderer: the original as is; a copy of its video stream in an
 * MP4 (container or extra audio tracks Chromium can't read, e.g. MKV or iPhone spatial audio); or a
 * transcoded H.264 proxy (rotation, HDR, 10-bit, codecs Chromium can't decode, …).
 */
export type PlaybackPlan = { kind: 'direct' } | { kind: 'remux'; reason: string } | { kind: 'proxy'; reason: string }

/** Why the video stream itself can't be decoded by both the preview and the export, or null. */
export function streamProxyReason(info: VideoInfo, decode: DirectDecode = {}): string | null {
  if (info.hdr || info.dolbyVision) return 'hdr'
  // The export draws WebCodecs frames without their rotation; proxies bake it in
  if (info.rotation !== 0) return 'rotation'
  if (info.interlaced) return 'interlaced'
  const s = info.stream
  const pix = s.pix_fmt ?? ''
  if (pix !== 'yuv420p' && pix !== 'yuvj420p') return `pixel format ${pix || '?'}`
  const codec = s.codec_name ?? ''
  const profile = (s.profile ?? '').toLowerCase()
  if (codec === 'h264') {
    if (!DIRECT_H264_PROFILES.includes(profile)) return `h264 profile ${s.profile ?? '?'}`
  } else if (codec === 'hevc') {
    if (!decode.hevc) return 'codec hevc'
    if (profile !== 'main') return `hevc profile ${s.profile ?? '?'}`
  } else if (codec !== 'vp9' && codec !== 'av1') {
    return `codec ${codec || '?'}`
  }
  const cw = s.width ?? 0
  const ch = s.height ?? 0
  if (Math.max(cw, ch) > MAX_DIRECT.long || Math.min(cw, ch) > MAX_DIRECT.short) return 'size'
  if (Math.abs(parseRational(s.sample_aspect_ratio || '1') - 1) > 0.01 && s.sample_aspect_ratio !== '0:1') return 'pixel aspect'
  return null
}

/**
 * Direct when the preview's <video> and the export's WebCodecs decoding both handle the original, as
 * verified in Electron 44 (e2e/codecs.spec.ts): no rotation, SDR, progressive 8-bit 4:2:0, at most UHD,
 *  - H.264 (<= High) or, when `decode.hevc`, HEVC Main in MP4/MOV (audio: Chromium codecs or
 *    TOLERATED_AUDIO) or in Matroska (Chromium audio codecs),
 *  - VP9 / AV1 in MP4 or WebM with Chromium audio codecs.
 * An H.264/HEVC stream that qualifies next to other audio is remuxed (video stream copied into an
 * MP4). Everything else gets a proxy.
 */
export function playbackPlan(path: string, probe: ProbeResult, info: VideoInfo, decode: DirectDecode = {}): PlaybackPlan {
  const reason = streamProxyReason(info, decode)
  if (reason) return { kind: 'proxy', reason }
  const ext = extOf(path)
  const fmt = probe.format.format_name ?? ''
  const codec = info.stream.codec_name ?? ''
  const copyable = codec === 'h264' || codec === 'hevc'
  const mp4 = ['mp4', 'mov', 'm4v'].includes(ext) && fmt.includes('mp4')
  const matroska = ['mkv', 'webm'].includes(ext) && fmt.includes('matroska')
  const webm = ext === 'webm' && fmt.includes('webm') && !copyable
  const odd = info.audioCodecs.find((c) => !CHROMIUM_AUDIO.includes(c))
  if (mp4) {
    const unplayable = info.audioCodecs.find((c) => !CHROMIUM_AUDIO.includes(c) && !(copyable && TOLERATED_AUDIO.includes(c)))
    if (!unplayable) return { kind: 'direct' }
    return copyable ? { kind: 'remux', reason: `audio ${unplayable}` } : { kind: 'proxy', reason: `audio ${unplayable}` }
  }
  if (copyable && matroska) return odd ? { kind: 'remux', reason: `audio ${odd}` } : { kind: 'direct' }
  if (webm) return odd ? { kind: 'proxy', reason: `audio ${odd}` } : { kind: 'direct' }
  return { kind: 'proxy', reason: 'container' }
}

/**
 * The first decodable audio stream (VideoInfo.audioIndex) can be copied into the extracted .m4a
 * instead of being re-encoded: AAC-LC, mono or stereo, from an MP4/MOV/Matroska file. Browsers and
 * the export mixer (which resamples to 48 kHz stereo) play any such stream.
 */
export function canCopyAudio(probe: ProbeResult, info: VideoInfo): boolean {
  if (info.audioIndex === null) return false
  const s = probe.streams.filter((x) => x.codec_type === 'audio')[info.audioIndex]
  const fmt = probe.format.format_name ?? ''
  if (!s || !(fmt.includes('mp4') || fmt.includes('matroska'))) return false
  const rate = Number(s.sample_rate)
  return s.codec_name === 'aac' && /^lc$/i.test(s.profile ?? '') && (s.channels ?? 0) >= 1 && (s.channels ?? 0) <= 2 && rate >= 8000 && rate <= 96000
}

/** Why the original can't be played as is ('container', 'rotation', 'hdr', …), or null (playbackPlan 'direct'). */
export function proxyReason(path: string, probe: ProbeResult, info: VideoInfo, decode: DirectDecode = {}): string | null {
  const plan = playbackPlan(path, probe, info, decode)
  return plan.kind === 'direct' ? null : plan.reason
}

/** True when Chromium can play the original file as is (playbackPlan 'direct'). */
export function isDirectPlayable(path: string, probe: ProbeResult, info: VideoInfo, decode: DirectDecode = {}): boolean {
  return playbackPlan(path, probe, info, decode).kind === 'direct'
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
