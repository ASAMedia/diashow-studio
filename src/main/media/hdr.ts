// Detection of the GPU tone-mapping path for HDR proxies (libplacebo on Vulkan). Runs once per FFmpeg
// binary: picks a Vulkan device, finds a hardware decoder that feeds it, and checks the result
// against the CPU chain on a tiny generated HLG clip. Proxies fall back to the CPU chain per file.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ffmpeg } from '../ffmpeg'
import { integratedGpuOnly } from '../gpuChoice'
import { gpuInputArgs, gpuVideoFilter, TONEMAP_CHAIN } from './video'
import { analyzeVideo } from './videoInfo'

export interface GpuTonemap {
  /** Vulkan device index: the first discrete GPU, else the first device. */
  device: number
  /** How frames reach the GPU: Vulkan video decoding, NVDEC (CUDA → Vulkan) or upload after software decoding. */
  decode: 'vulkan' | 'cuda' | 'upload'
}

/** Mean |difference| per channel (0..255) a working GPU path stays under on the test clip. */
const MAX_TEST_DIFF = 16

const cache = new Map<string, Promise<GpuTonemap | null>>()

/** Parses ffmpeg's verbose Vulkan "GPU listing" and returns the preferred device index. */
export function pickVulkanDevice(log: string, prefer: 'discrete' | 'integrated' = integratedGpuOnly ? 'integrated' : 'discrete'): number | null {
  const devices = [...log.matchAll(/^\s*(?:\[[^\]]*\]\s*)?(\d+):\s+(.+?)\s+\((discrete|integrated|virtual|cpu|other)\)/gm)].map((m) => ({
    index: Number(m[1]),
    kind: m[3]
  }))
  if (!devices.length) return null
  return (devices.find((d) => d.kind === prefer) ?? devices[0]).index
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  if (!a.length || a.length !== b.length) return Infinity
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

/**
 * GPU tone mapping available with this FFmpeg build and machine, or null. Cached per binary;
 * DIASHOW_GPU_TONEMAP=0 disables it (CPU chain only).
 */
export function detectGpuTonemap(ff: Ffmpeg): Promise<GpuTonemap | null> {
  if (process.env.DIASHOW_GPU_TONEMAP === '0') return Promise.resolve(null)
  let found = cache.get(ff.ffmpegPath)
  if (!found) {
    found = detect(ff).catch(() => null)
    cache.set(ff.ffmpegPath, found)
  }
  return found
}

/** The check's own clips left in the temp folder when an app quit during it (an hour old or more). */
export async function sweepOldChecks(dir = tmpdir(), now = Date.now()): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[])
  let removed = 0
  for (const name of names) {
    if (!/^diashow-hdr-\d+-[0-9a-f]{8}(-a|-h264)?\.(mp4|rgb)$/.test(name)) continue
    const file = join(dir, name)
    const st = await stat(file).catch(() => null)
    if (!st?.isFile() || now - st.mtimeMs < 3_600_000) continue
    await rm(file, { force: true }).then(
      () => removed++,
      () => {}
    )
  }
  return removed
}

async function detect(ff: Ffmpeg): Promise<GpuTonemap | null> {
  void sweepOldChecks()
  const signal = AbortSignal.timeout(60_000)
  let device: number | null
  try {
    const listing = await ff.log(['-init_hw_device', 'vulkan=vk', '-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.04', '-frames:v', '1', '-f', 'null', '-'], { level: 'verbose', signal })
    device = pickVulkanDevice(listing) ?? 0
  } catch {
    return null
  }
  const base = join(tmpdir(), `diashow-hdr-${process.pid}-${randomUUID().slice(0, 8)}`)
  const plain = `${base}-a.mp4`
  const clip = `${base}.mp4`
  const raw = `${base}.rgb`
  try {
    // Portrait HLG clip stored landscape: the check covers decoding, rotation and tone mapping
    await ff.run(
      ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=0.4', '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',
        '-x265-params', 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
        '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', plain],
      { signal }
    )
    await ff.run(['-display_rotation', '-90', '-i', plain, '-c', 'copy', clip], { signal })
    const info = analyzeVideo(await ff.probe(clip, signal))
    if (!info || !info.hdr || info.rotation !== 90) return null
    const small = 'scale=36:64:flags=area,format=rgb24'
    const reference = await ff.capture(['-i', clip, '-frames:v', '1', '-vf', `scale=360:640,${TONEMAP_CHAIN},${small}`, '-f', 'rawvideo', '-'], { signal })
    const attempt = async (gpu: GpuTonemap): Promise<{ ok: boolean; hwFailed: boolean }> => {
      try {
        await rm(raw, { force: true })
        const log = await ff.log(['-threads', '2', ...gpuInputArgs(gpu), '-i', clip, '-frames:v', '1', '-vf', `${gpuVideoFilter(info, 640, gpu, { fps: 30 })},${small}`, '-f', 'rawvideo', raw], { level: 'error', signal })
        const hwFailed = gpu.decode !== 'upload' && /hwaccel|failed setup/i.test(log)
        const ok = existsSync(raw) && meanAbsDiff(await readFile(raw), reference) < MAX_TEST_DIFF
        return { ok, hwFailed }
      } catch {
        return { ok: false, hwFailed: true }
      }
    }
    const upload: GpuTonemap = { device, decode: 'upload' }
    for (const decode of integratedGpuOnly ? (['vulkan'] as const) : (['vulkan', 'cuda'] as const)) {
      const r = await attempt({ device, decode })
      if (r.ok && !r.hwFailed) return { device, decode }
      // Intel's Windows driver decodes H.264 through Vulkan but not 10-bit HEVC. FFmpeg then decodes
      // HEVC in software and libplacebo uploads the frames (the picture above was still right), while
      // H.264 phone videos keep decoding on the GPU.
      if (r.ok && decode === 'vulkan' && (await decodesH264({ device, decode }, `${base}-h264.mp4`, signal))) return { device, decode }
    }
    return (await attempt(upload)).ok ? upload : null
  } catch {
    return null
  } finally {
    await Promise.all([plain, clip, raw, `${base}-h264.mp4`].map((f) => rm(f, { force: true })))
  }

  /** H.264 decodes on the GPU without falling back to software. */
  async function decodesH264(gpu: GpuTonemap, file: string, signal: AbortSignal): Promise<boolean> {
    try {
      await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=0.2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file], { signal })
      const log = await ff.log(['-threads', '2', ...gpuInputArgs(gpu), '-i', file, '-vf', 'libplacebo=w=64:h=36:format=yuv420p', '-f', 'null', '-'], { level: 'error', signal })
      return !/hwaccel|failed setup/i.test(log)
    } catch {
      return false
    }
  }
}
