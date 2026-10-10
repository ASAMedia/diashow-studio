// Which video streams can skip the proxy? Checks, inside the app's renderer (Electron 44), both
// paths a video takes: the preview's <video> element and the export's WebCodecs decoding through
// mediabunny (same calls as ExportVideoStore: getPrimaryVideoTrack → VideoSampleSink → toVideoFrame →
// WebGL texture). Frames are compared with FFmpeg's decode of the same file (block averages, so
// scaling/chroma filters don't matter but a wrong matrix, range or a broken decode does).
// Generated clips cover the stream kinds; DIASHOW_ORIGINALS_DIR (read only) adds real phone files.
import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appArgs } from './launch'

const root = resolve(__dirname, '..')
const ffmpeg = join(root, 'vendor/ffmpeg/bin/ffmpeg.exe')
const ffprobe = join(root, 'vendor/ffmpeg/bin/ffprobe.exe')
const originals = process.env.DIASHOW_ORIGINALS_DIR
const GRID_X = 32
const GRID_Y = 18
const TIMES = [0.5, 1.2, 2.0]

interface Clip {
  name: string
  path: string
  /** Seconds to compare; long files are also checked in the middle and near the end (seeking). */
  times?: number[]
}

function duration(path: string): number {
  return Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]).toString()) || 0
}

interface PageResult {
  name: string
  codec: string | null
  mime: string
  canPlay: string
  configSupported: boolean | null
  configSupportedHw: boolean | null
  configSupportedSw: boolean | null
  canDecode: boolean
  rotation: number
  webcodecs: { grids: number[][]; error?: string; fps?: number; seekMs?: number }
  video: { grids: number[][]; error?: string; width?: number; height?: number }
}

function makeClips(dir: string): Clip[] {
  const src = ['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3']
  const x265 = (extra: string): string[] => ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', `log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709${extra}`]
  const bt709 = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']
  const specs: Array<{ name: string; args: string[] }> = [
    { name: 'hevc8-hvc1.mp4', args: [...x265(''), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', ...bt709, '-c:a', 'aac'] },
    { name: 'hevc8-hev1.mp4', args: [...x265(''), '-pix_fmt', 'yuv420p', '-tag:v', 'hev1', ...bt709, '-c:a', 'aac'] },
    { name: 'hevc8-fullrange.mp4', args: [...x265(':range=full'), '-pix_fmt', 'yuvj420p', '-color_range', 'pc', '-tag:v', 'hvc1', ...bt709, '-c:a', 'aac'] },
    { name: 'hevc8-bframes.mov', args: ['-c:v', 'libx265', '-preset', 'fast', '-x265-params', 'log-level=error:bframes=4:colorprim=bt709:transfer=bt709:colormatrix=bt709', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', ...bt709, '-c:a', 'aac'] },
    { name: 'hevc10-sdr.mp4', args: [...x265(''), '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', ...bt709, '-c:a', 'aac'] },
    { name: 'h264.mkv', args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...bt709, '-c:a', 'aac'] },
    { name: 'h264.mp4', args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...bt709, '-c:a', 'aac'] },
    // Sony XAVC S style: H.264 with LPCM sound
    { name: 'h264-pcm.mov', args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...bt709, '-c:a', 'pcm_s16le'] },
    { name: 'hevc8.mkv', args: [...x265(''), '-pix_fmt', 'yuv420p', ...bt709, '-c:a', 'aac'] }
  ]
  return specs.map((s) => {
    const path = join(dir, s.name)
    execFileSync(ffmpeg, ['-v', 'error', '-y', ...src, ...s.args, '-shortest', path])
    return { name: s.name, path }
  })
}

/** One real file per stream kind of interest from the originals folder (read only). */
function realClips(dir: string): Clip[] {
  const files: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(mp4|mov|mkv)$/i.test(e.name)) files.push(p)
    }
  }
  walk(dir)
  const found = new Map<string, Clip>()
  for (const path of files) {
    const j = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]).toString())
    const v = j.streams.find((s: any) => s.codec_type === 'video')
    if (!v) continue
    const rot = (v.side_data_list ?? []).some((d: any) => typeof d.rotation === 'number' && d.rotation !== 0)
    const hdr = ['arib-std-b67', 'smpte2084'].includes(v.color_transfer)
    const audio = j.streams.filter((s: any) => s.codec_type === 'audio').map((s: any) => s.codec_name).join('+')
    let kind = ''
    if (rot || hdr) continue
    if (/\.mkv$/i.test(path)) kind = `mkv ${v.codec_name}`
    else if (v.codec_name === 'hevc' && v.pix_fmt.startsWith('yuv') && !v.pix_fmt.includes('10')) kind = `hevc8 ${v.pix_fmt} ${Math.max(v.width, v.height) > 2000 ? 'uhd' : 'hd'} ${j.format.tags?.['com.android.manufacturer'] ?? j.format.tags?.['com.apple.quicktime.make'] ?? ''}`
    else if (v.codec_name === 'h264' && audio.includes('apac')) kind = 'h264 + apac'
    const d = Number(j.format.duration) || 0
    if (kind && !found.has(kind)) found.set(kind, { name: `real ${kind}`, path, times: d > 10 ? [...TIMES, d * 0.5, d * 0.9] : TIMES })
  }
  return [...found.values()]
}

/** Block means (GRID_X x GRID_Y, RGB) of FFmpeg's frames at t: the frame there and its two neighbours. */
function reference(path: string, t: number): { grids: number[][]; w: number; h: number } {
  const j = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate', '-of', 'json', path]).toString())
  const w = j.streams[0].width
  const h = j.streams[0].height
  const [num, den] = String(j.streams[0].avg_frame_rate).split('/').map(Number)
  const fps = num && den ? num / den : 30
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-ss', Math.max(0, t - 1 / fps).toFixed(4), '-i', path, '-map', '0:v:0', '-frames:v', '3', '-vf', 'scale=out_color_matrix=bt709:out_range=pc,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 })
  const size = w * h * 3
  const grids: number[][] = []
  for (let f = 0; f * size + size <= raw.length; f++) grids.push(blockMeans(raw.subarray(f * size, (f + 1) * size), w, h, 3))
  return { grids, w, h }
}

function blockMeans(px: Uint8Array, w: number, h: number, channels: number): number[] {
  const out: number[] = []
  for (let by = 0; by < GRID_Y; by++) {
    for (let bx = 0; bx < GRID_X; bx++) {
      const x0 = Math.floor((bx * w) / GRID_X)
      const x1 = Math.floor(((bx + 1) * w) / GRID_X)
      const y0 = Math.floor((by * h) / GRID_Y)
      const y1 = Math.floor(((by + 1) * h) / GRID_Y)
      const sum = [0, 0, 0]
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) sum[c] += px[(y * w + x) * channels + c]
      const n = (x1 - x0) * (y1 - y0)
      out.push(sum[0] / n, sum[1] / n, sum[2] / n)
    }
  }
  return out
}

/** Median |difference| over all block channels, against the closest of the reference frames. */
function diff(grid: number[], refs: number[][]): number {
  if (!grid?.length) return Infinity
  return Math.min(
    ...refs.map((r) => {
      const d = grid.map((v, i) => Math.abs(v - r[i])).sort((a, b) => a - b)
      return d[Math.floor(d.length / 2)]
    })
  )
}

test('which video streams play without a proxy (preview <video> and export WebCodecs)', async () => {
  test.setTimeout(10 * 60 * 1000)
  const tmp = mkdtempSync(join(tmpdir(), 'diashow-codecs-'))
  const app = await electron.launch({ args: appArgs(), cwd: root, env: { ...process.env, DIASHOW_DATA_DIR: tmp } })
  try {
    const clips = [...makeClips(tmp), ...(originals ? realClips(originals) : [])]
    // The remux the service does for these (same arguments as remuxVideo in src/main/media/video.ts;
    // long real files cut to 6 s)
    for (const c of clips.filter((c) => /mkv|apac|pcm/.test(c.name))) {
      const path = join(tmp, `remux-${clips.indexOf(c)}.mp4`)
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', c.path, '-t', '6', '-map', '0:v:0', '-c:v', 'copy', '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-f', 'mp4', path])
      clips.push({ name: `${c.name} → remux`, path })
    }
    const page = await app.firstWindow()
    // What the main process can learn about hardware decoding without a renderer
    const gpu = await app.evaluate(async ({ app }) => JSON.stringify(await app.getGPUInfo('complete')))
    const decodeInfo = JSON.stringify(JSON.parse(gpu), (k, v) => (k && typeof v !== 'object' && !/video|decod|hevc|codec/i.test(k) ? undefined : v))
    console.log('getGPUInfo video decoding:', decodeInfo.slice(0, 3000))
    await page.waitForFunction(() => !!(window as any).__diashow)
    // mediabunny's browser bundle defines a global `Mediabunny` (the app bundles the same version)
    await page.evaluate(readFileSync(join(root, 'node_modules/mediabunny/dist/bundles/mediabunny.cjs'), 'utf8') + ';window.Mediabunny = Mediabunny; true')
    const results: PageResult[] = await page.evaluate(
      async ({ clips, times, gx, gy }) => {
        const MB = (window as any).Mediabunny
        const url = (p: string): string => `dsmedia://f/${encodeURIComponent(p)}`
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2')!
        const tex = gl.createTexture()
        const fb = gl.createFramebuffer()
        // Same upload as the engine (texImage2D of a VideoFrame / <video>), then the full frame read back
        const grid = (src: TexImageSource, w: number, h: number): number[] => {
          gl.bindTexture(gl.TEXTURE_2D, tex)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
          const px = new Uint8Array(w * h * 4)
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
          const out: number[] = []
          for (let by = 0; by < gy; by++) {
            for (let bx = 0; bx < gx; bx++) {
              const x0 = Math.floor((bx * w) / gx)
              const x1 = Math.floor(((bx + 1) * w) / gx)
              const y0 = Math.floor((by * h) / gy)
              const y1 = Math.floor(((by + 1) * h) / gy)
              const sum = [0, 0, 0]
              for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) sum[c] += px[(y * w + x) * 4 + c]
              const n = (x1 - x0) * (y1 - y0)
              out.push(sum[0] / n, sum[1] / n, sum[2] / n)
            }
          }
          return out
        }
        const out: any[] = []
        for (const clip of clips) {
          const r: any = { name: clip.name, webcodecs: { grids: [] }, video: { grids: [] } }
          const input = new MB.Input({ source: new MB.UrlSource(url(clip.path)), formats: MB.ALL_FORMATS })
          try {
            const track = await input.getPrimaryVideoTrack()
            const audio = await input.getPrimaryAudioTrack()
            r.codec = await track.getCodecParameterString()
            const audioCodec = audio ? await audio.getCodecParameterString() : null
            const mimeType = await input.getMimeType()
            r.mime = mimeType
            r.canPlay = document.createElement('video').canPlayType(`${mimeType.split(';')[0]}; codecs="${[r.codec, audioCodec].filter(Boolean).join(', ')}"`)
            r.rotation = track.rotation
            const cfg = await track.getDecoderConfig()
            const supported = async (accel?: HardwareAcceleration): Promise<boolean | null> => {
              try {
                return (await VideoDecoder.isConfigSupported(accel ? { ...cfg, hardwareAcceleration: accel } : cfg)).supported ?? false
              } catch {
                return null
              }
            }
            r.configSupported = await supported()
            r.configSupportedHw = await supported('prefer-hardware')
            r.configSupportedSw = await supported('prefer-software')
            r.canDecode = await track.canDecode()
            const sink = new MB.VideoSampleSink(track)
            try {
              for (const t of clip.times ?? times) {
                const s0 = performance.now()
                const sample = await sink.getSample(t)
                r.webcodecs.seekMs = Math.max(r.webcodecs.seekMs ?? 0, Math.round(performance.now() - s0))
                if (!sample) throw new Error(`no sample at ${t}`)
                const frame = sample.toVideoFrame()
                r.webcodecs.grids.push(grid(frame, frame.displayWidth, frame.displayHeight))
                frame.close()
                sample.close()
              }
              // Sequential decoding speed (export reads clips front to back)
              const t0 = performance.now()
              let n = 0
              for await (const s of sink.samples(0, 2)) {
                s.close()
                n++
              }
              r.webcodecs.fps = Math.round(n / ((performance.now() - t0) / 1000))
            } catch (e) {
              r.webcodecs.error = String(e)
            }
          } catch (e) {
            r.webcodecs.error = String(e)
          } finally {
            input.dispose()
          }
          // Preview path: a muted <video> seeked to each time
          const el = document.createElement('video')
          el.muted = true
          el.crossOrigin = 'anonymous'
          el.preload = 'auto'
          try {
            await new Promise<void>((resolve, reject) => {
              el.onloadeddata = () => resolve()
              el.onerror = () => reject(new Error(`media error ${el.error?.code}: ${el.error?.message}`))
              setTimeout(() => reject(new Error('timeout')), 15000)
              el.src = url(clip.path)
            })
            r.video.width = el.videoWidth
            r.video.height = el.videoHeight
            for (const t of clip.times ?? times) {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('seek timeout')), 15000)
                el.requestVideoFrameCallback(() => {
                  clearTimeout(timer)
                  resolve()
                })
                el.currentTime = t
              })
              r.video.grids.push(grid(el, el.videoWidth, el.videoHeight))
            }
          } catch (e) {
            r.video.error = String(e)
          } finally {
            el.removeAttribute('src')
            el.load()
          }
          out.push(r)
        }
        return out
      },
      { clips, times: TIMES, gx: GRID_X, gy: GRID_Y }
    )
    const rows: string[] = []
    const verdict: Record<string, boolean> = {}
    for (const r of results) {
      const clip = clips.find((c) => c.name === r.name)!
      const times = clip.times ?? TIMES
      const refs = times.map((t) => reference(clip.path, t).grids)
      const wc = r.webcodecs.grids.map((g, i) => diff(g, refs[i]))
      const vid = r.video.grids.map((g, i) => diff(g, refs[i]))
      const ok = !r.webcodecs.error && !r.video.error && wc.length === times.length && vid.length === times.length && Math.max(...wc, ...vid) < 3
      if (/yuvj420p hd Google/.test(r.name)) {
        // Negative control: the same frames with their full-range YUV misread as limited range must
        // fail the threshold (the raw planes are re-read without their range flag)
        const wrong = times.map((t) => {
          const yuv = execFileSync(ffmpeg, ['-v', 'error', '-ss', t.toFixed(4), '-i', clip.path, '-map', '0:v:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuvj420p', '-'], { maxBuffer: 1 << 30 })
          const rgb = execFileSync(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-s', `${r.video.width}x${r.video.height}`, '-i', '-', '-vf', 'scale=out_color_matrix=bt709:out_range=pc,format=rgb24', '-f', 'rawvideo', '-'], { input: yuv, maxBuffer: 1 << 30 })
          return blockMeans(rgb, r.video.width ?? 1920, r.video.height ?? 1080, 3)
        })
        rows.push(`negative control for ${r.name} (full range misread as limited): diff ${r.webcodecs.grids.map((g, i) => diff(g, [wrong[i]]).toFixed(1)).join('/')}`)
      }
      verdict[r.name] = ok
      rows.push(
        `${r.name}: codec ${r.codec} (${r.mime}) canPlayType '${r.canPlay}', isConfigSupported ${r.configSupported} (hw ${r.configSupportedHw}, sw ${r.configSupportedSw}), canDecode ${r.canDecode}, rotation ${r.rotation}\n` +
          `   webcodecs: ${r.webcodecs.error ?? `diff ${wc.map((d) => d.toFixed(1)).join('/')}, ${r.webcodecs.fps} fps, slowest seek ${r.webcodecs.seekMs} ms`}\n` +
          `   <video>:   ${r.video.error ?? `${r.video.width}x${r.video.height}, diff ${vid.map((d) => d.toFixed(1)).join('/')}`}\n` +
          `   => ${ok ? 'PLAYS WITHOUT PROXY' : 'needs a proxy'}`
      )
    }
    console.log(rows.join('\n'))
    // The generated reference clips: H.264 MP4 must pass (sanity check of the probe itself)
    expect(verdict['h264.mp4']).toBe(true)
  } finally {
    await app.close()
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
})
