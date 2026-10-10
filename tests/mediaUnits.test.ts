// Pure helpers of the media pipeline: orientation mapping, pairing, probe analysis, labels.
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import type { ProbeResult } from '../src/main/ffmpeg'
import { parseRational } from '../src/main/ffmpeg'
import { applyOrientation, photoFormatLabel } from '../src/main/media/photo'
import { pairFiles, type ScannedFile } from '../src/main/media/scan'
import { fitEven, fpsRational } from '../src/main/media/video'
import { analyzeVideo, canCopyAudio, isDirectPlayable, outputFps, playbackPlan, videoFormatLabel } from '../src/main/media/videoInfo'
import type { Tags } from '../src/main/media/exif'

describe('applyOrientation', () => {
  // 3x2 image with unique pixel values so every flip/rotation is distinguishable
  const W = 3
  const H = 2
  const pixels = Buffer.from([...Array(W * H).keys()].flatMap((i) => [i * 40, 255 - i * 40, i * 20]))

  for (let o = 1; o <= 8; o++) {
    it(`matches libvips auto-orientation for EXIF ${o}`, async () => {
      const tiff = await sharp(pixels, { raw: { width: W, height: H, channels: 3 } }).withMetadata({ orientation: o }).tiff({ compression: 'lzw' }).toBuffer()
      const expected = await sharp(tiff).rotate().raw().toBuffer()
      const actual = await applyOrientation(sharp(pixels, { raw: { width: W, height: H, channels: 3 } }), o).raw().toBuffer()
      expect([...actual]).toEqual([...expected])
    })
  }
})

function file(path: string, kind: ScannedFile['kind']): ScannedFile {
  const name = path.split('\\').pop()!
  const ext = name.split('.').pop()!.toLowerCase()
  return { path, dir: path.slice(0, path.lastIndexOf('\\')), name, base: name.slice(0, -(ext.length + 1)), ext, kind, size: 1, mtimeMs: 1 }
}

describe('pairFiles', () => {
  it('pairs Live Photos, drops RAW twins, keeps unrelated files', () => {
    const groups = pairFiles([
      file('C:\\a\\IMG_1.HEIC', 'photo'),
      file('C:\\a\\IMG_1.MOV', 'video'),
      file('C:\\a\\DSC1.ARW', 'photo'),
      file('C:\\a\\DSC1.JPG', 'photo'),
      file('C:\\a\\DSC2.ARW', 'photo'),
      file('C:\\a\\DSC3.ARW', 'photo'),
      file('C:\\a\\DSC3.HIF', 'photo'),
      file('C:\\b\\IMG_1.MOV', 'video'),
      file('C:\\a\\clip.mp4', 'video'),
      file('C:\\a\\clip.jpg', 'photo')
    ])
    const summary = groups.map((g) => `${g.file.path}${g.live ? ' +live' : ''}${g.raw ? ' -raw' : ''}`).sort()
    expect(summary).toEqual([
      'C:\\a\\DSC1.JPG -raw',
      'C:\\a\\DSC2.ARW',
      'C:\\a\\DSC3.HIF -raw',
      'C:\\a\\IMG_1.HEIC +live',
      'C:\\a\\clip.jpg',
      'C:\\a\\clip.mp4',
      'C:\\b\\IMG_1.MOV'
    ])
  })
})

function probe(stream: Record<string, unknown>, format: Record<string, unknown> = {}, extra: Record<string, unknown>[] = []): ProbeResult {
  return {
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10', ...format },
    streams: [{ index: 0, codec_type: 'video', width: 1920, height: 1080, pix_fmt: 'yuv420p', codec_name: 'h264', profile: 'High', avg_frame_rate: '30/1', ...stream }, ...(extra as never[])]
  }
}

describe('video analysis', () => {
  it('detects rotation, HDR and direct playability', () => {
    const plain = probe({}, {}, [{ index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2 }])
    const info = analyzeVideo(plain)!
    expect(isDirectPlayable('x.mp4', plain, info)).toBe(true)
    expect(isDirectPlayable('x.mkv', plain, info)).toBe(false)

    const rotated = probe({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] })
    const r = analyzeVideo(rotated)!
    expect([r.rotation, r.width, r.height]).toEqual([90, 1080, 1920])
    expect(isDirectPlayable('x.mov', rotated, r)).toBe(false)

    const hlg = probe({ codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: 'arib-std-b67', profile: 'Main 10' })
    const h = analyzeVideo(hlg)!
    expect(h.hdr).toBe('hlg')
    expect(videoFormatLabel('IMG.MOV', hlg, h)).toBe('HEVC 10-bit HDR (HLG)')

    const pcm = probe({}, {}, [{ index: 1, codec_type: 'audio', codec_name: 'pcm_s16be', channels: 2 }])
    expect(isDirectPlayable('C0001.MP4', pcm, analyzeVideo(pcm)!)).toBe(false)

    const hi10 = probe({ pix_fmt: 'yuv420p10le', profile: 'High 10' })
    expect(isDirectPlayable('a.mp4', hi10, analyzeVideo(hi10)!)).toBe(false)

    const uhd60 = probe({ width: 4096, height: 2160 })
    expect(isDirectPlayable('a.mp4', uhd60, analyzeVideo(uhd60)!)).toBe(false)

    const anamorphic = probe({ width: 1440, height: 1080, sample_aspect_ratio: '4:3' }, { format_name: 'mpegts' })
    expect(analyzeVideo(anamorphic)!.width).toBe(1920)
    expect(videoFormatLabel('00001.MTS', anamorphic, analyzeVideo(anamorphic)!)).toBe('AVCHD')
  })

  it('playbackPlan: direct only for streams verified in Electron 44, remux when only the wrapping is wrong', () => {
    const aac = { index: 1, codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2, sample_rate: '48000' }
    const plan = (path: string, p: ProbeResult, hevc = false): string => {
      const r = playbackPlan(path, p, analyzeVideo(p)!, { hevc })
      return r.kind === 'direct' ? 'direct' : `${r.kind}: ${r.reason}`
    }
    const mkv = { format_name: 'matroska,webm' }
    // iPhone 16: AAC + spatial audio (APAC) next to H.264 plays as it is
    expect(plan('IMG.MOV', probe({}, {}, [aac, { index: 2, codec_type: 'audio', codec_name: 'apple_apac', channels: 4 }]))).toBe('direct')
    // H.264 + AAC in Matroska (e.g. a screen recording) plays as it is
    expect(plan('show.mkv', probe({}, mkv, [aac]))).toBe('direct')
    // Matroska with AC-3, MP4 with big-endian LPCM (Sony XAVC S): the video stream is copied
    expect(plan('show.mkv', probe({}, mkv, [{ index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 6 }]))).toBe('remux: audio ac3')
    expect(plan('C0001.MP4', probe({}, {}, [{ index: 1, codec_type: 'audio', codec_name: 'pcm_s16be', channels: 2 }]))).toBe('remux: audio pcm_s16be')
    // 8-bit HEVC only where the renderer decodes it, in MP4/MOV and Matroska; never 10-bit, HDR or rotated
    const hevc8 = probe({ codec_name: 'hevc', profile: 'Main', pix_fmt: 'yuvj420p' }, {}, [aac])
    expect(plan('PXL.mp4', hevc8)).toBe('proxy: codec hevc')
    expect(plan('PXL.mp4', hevc8, true)).toBe('direct')
    expect(plan('a.mkv', probe({ codec_name: 'hevc', profile: 'Main' }, mkv, [aac]), true)).toBe('direct')
    expect(plan('PXL.mp4', probe({ codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le' }), true)).toBe('proxy: pixel format yuv420p10le')
    expect(plan('PXL.mp4', probe({ codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le', color_transfer: 'arib-std-b67' }), true)).toBe('proxy: hdr')
    expect(plan('PXL.mp4', probe({ codec_name: 'hevc', profile: 'Main', side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }), true)).toBe('proxy: rotation')
    // Larger than UHD and other containers keep their proxies
    expect(plan('DJI.mp4', probe({ codec_name: 'hevc', profile: 'Main', width: 3840, height: 2880 }), true)).toBe('proxy: size')
    expect(plan('00001.MTS', probe({}, { format_name: 'mpegts' }, [aac]))).toBe('proxy: container')
    expect(plan('clip.avi', probe({}, { format_name: 'avi' }, [aac]))).toBe('proxy: container')
    // VP9 in WebM as before; VP9 with an odd audio codec in WebM can't be remuxed into MP4 here
    expect(plan('a.webm', probe({ codec_name: 'vp9', profile: 'Profile 0' }, mkv, [{ index: 1, codec_type: 'audio', codec_name: 'opus', channels: 2 }]))).toBe('direct')
    expect(plan('a.webm', probe({ codec_name: 'vp9', profile: 'Profile 0' }, mkv, [{ index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 2 }]))).toBe('proxy: audio ac3')
  })

  it('canCopyAudio: AAC-LC mono/stereo from MP4 or Matroska is kept, everything else re-encoded', () => {
    const withAudio = (a: Record<string, unknown>, format: Record<string, unknown> = {}): boolean => {
      const p = probe({}, format, [{ index: 1, codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2, sample_rate: '48000', ...a }])
      return canCopyAudio(p, analyzeVideo(p)!)
    }
    expect(withAudio({})).toBe(true)
    expect(withAudio({ channels: 1, sample_rate: '44100' })).toBe(true)
    expect(withAudio({}, { format_name: 'matroska,webm' })).toBe(true)
    expect(withAudio({ channels: 6 })).toBe(false)
    expect(withAudio({ profile: 'HE-AAC' })).toBe(false)
    expect(withAudio({ codec_name: 'pcm_s16be', profile: undefined })).toBe(false)
    expect(withAudio({}, { format_name: 'mpegts' })).toBe(false)
    const silent = probe({})
    expect(canCopyAudio(silent, analyzeVideo(silent)!)).toBe(false)
  })

  it('labels Sony XAVC variants and ProRes', () => {
    const xavc = { tags: { major_brand: 'XAVC', compatible_brands: 'XAVCmp42iso2' } }
    const hs = probe({ codec_name: 'hevc', pix_fmt: 'yuv422p10le', profile: 'Rext', color_transfer: 'arib-std-b67' }, xavc)
    expect(videoFormatLabel('C0001.MP4', hs, analyzeVideo(hs)!)).toBe('XAVC HS · HEVC 4:2:2 10-bit HDR (HLG)')
    const si = probe({ pix_fmt: 'yuv422p10le', profile: 'High 4:2:2 Intra' }, xavc)
    expect(videoFormatLabel('C0002.MP4', si, analyzeVideo(si)!)).toBe('XAVC S-I · H.264 4:2:2 10-bit')
    const s = probe({}, xavc)
    expect(videoFormatLabel('C0003.MP4', s, analyzeVideo(s)!)).toBe('XAVC S · H.264')
    const prores = probe({ codec_name: 'prores', profile: 'HQ', pix_fmt: 'yuv422p10le' })
    expect(videoFormatLabel('a.mov', prores, analyzeVideo(prores)!)).toBe('ProRes 422 HQ')
  })

  it('frame rate and sizing helpers', () => {
    expect(outputFps({ index: 0, avg_frame_rate: '30000/1001' })).toBe(29.97)
    expect(outputFps({ index: 0, avg_frame_rate: '120/1' })).toBe(60)
    expect(outputFps({ index: 0, avg_frame_rate: '100/1' })).toBe(50)
    expect(outputFps({ index: 0, avg_frame_rate: '30/1' })).toBe(30)
    expect(outputFps({ index: 0, avg_frame_rate: '0/0', r_frame_rate: '25/1' })).toBe(25)
    expect(fpsRational(29.97)).toBe('30000/1001')
    expect(fpsRational(59.94)).toBe('60000/1001')
    expect(fpsRational(25)).toBe('25')
    expect(fitEven(3840, 2160, 1920)).toEqual([1920, 1080])
    expect(fitEven(1080, 1920, 1920)).toEqual([1080, 1920])
    expect(fitEven(641, 361, 1920)).toEqual([642, 362])
    expect(parseRational('4:3')).toBeCloseTo(4 / 3)
  })
})

describe('photo labels', () => {
  const tags = (t: Record<string, unknown>): Tags => t as Tags
  it('names formats meaningfully', () => {
    expect(photoFormatLabel('a.HIF', tags({ Make: 'SONY', BitDepthLuma: 10, ChromaFormat: '4:2:2' }))).toBe('Sony HIF 10-bit 4:2:2')
    expect(photoFormatLabel('a.HEIC', tags({ BitDepthLuma: 8, ChromaFormat: '4:2:0' }))).toBe('HEIC')
    expect(photoFormatLabel('a.ARW', tags({}))).toBe('Sony ARW')
    expect(photoFormatLabel('a.dng', tags({ Make: 'Apple' }))).toBe('Apple ProRAW (DNG)')
    expect(photoFormatLabel('a.jpeg', tags({}))).toBe('JPEG')
    expect(photoFormatLabel('a.png', tags({}))).toBe('PNG')
  })
})
