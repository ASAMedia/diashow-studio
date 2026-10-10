// System check: what this PC offers the app (graphics card, encoders, HEVC, HDR tone mapping, CPU,
// memory, disk, versions), for the dialog in Settings. The renderer adds what only it can see (WebGL,
// WebCodecs) and runs the export benchmark on media generated here.
import { app, ipcMain } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir, rm, statfs } from 'node:fs/promises'
import { availableParallelism, cpus, freemem, release, tmpdir, totalmem, version } from 'node:os'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import type { BenchMedia, EncoderTest, GpuDeviceInfo, SystemInfo } from '@shared/systemCheck'
import { directDecodeSupport } from './codecSupport'
import type { Ffmpeg } from './ffmpeg'
import { detectGpuTonemap } from './media/hdr'

const VENDORS: Record<number, string> = {
  0x10de: 'NVIDIA',
  0x8086: 'Intel',
  0x1002: 'AMD',
  0x1022: 'AMD',
  0x1414: 'Microsoft',
  0x5143: 'Qualcomm',
  0x13b5: 'ARM'
}

/** Hardware encoders the export and the proxies can use, tested in this order. */
const HW_ENCODERS = ['h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf']

interface ChromiumGpuDevice {
  vendorId?: number
  deviceId?: number
  active?: boolean
  driverVersion?: string
  deviceString?: string
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])
}

async function gpuDevices(): Promise<GpuDeviceInfo[]> {
  const info = (await withTimeout(app.getGPUInfo('complete'), 8000, null)) ?? (await withTimeout(app.getGPUInfo('basic'), 4000, null))
  const list = ((info as { gpuDevice?: ChromiumGpuDevice[] } | null)?.gpuDevice ?? []).filter((d) => d.vendorId || d.deviceId)
  return list.map((d) => ({
    vendor: VENDORS[d.vendorId ?? 0] ?? `0x${(d.vendorId ?? 0).toString(16).padStart(4, '0')}`,
    device: d.deviceString || `0x${(d.deviceId ?? 0).toString(16).padStart(4, '0')}`,
    driver: d.driverVersion || undefined,
    active: !!d.active
  }))
}

/** "Windows 11 Home (10.0.26100)": Windows 11 still calls itself Windows 10 in the registry. */
export function windowsVersion(name: string, rel: string): string {
  const build = Number(rel.split('.')[2])
  const fixed = build >= 22000 ? name.replace(/Windows 10/, 'Windows 11') : name
  return `${fixed} (${rel})`
}

async function freeSpace(path: string): Promise<{ free: number | null; total: number | null }> {
  for (const p of [path, dirname(path)]) {
    try {
      const s = await statfs(p)
      return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }
    } catch {
      // not there yet: try its parent
    }
  }
  return { free: null, total: null }
}

async function ffmpegVersion(ff: Ffmpeg): Promise<string> {
  try {
    const out = (await ff.capture(['-version'])).toString('utf8')
    return /ffmpeg version (\S+)/.exec(out)?.[1] ?? 'unknown'
  } catch {
    return 'missing'
  }
}

/** Encodes 1 s of generated 1080p30 with one encoder and times it. */
async function testEncode(ff: Ffmpeg, encoder: string): Promise<EncoderTest> {
  const hardware = !encoder.startsWith('lib')
  const t0 = performance.now()
  try {
    await ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30', '-frames:v', '30', '-pix_fmt', 'yuv420p', '-c:v', encoder, '-f', 'null', '-'], {
      signal: AbortSignal.timeout(60_000)
    })
    const seconds = (performance.now() - t0) / 1000
    return { encoder, hardware, ok: true, seconds: Math.round(seconds * 100) / 100, fps: Math.round(30 / seconds) }
  } catch (err) {
    return { encoder, hardware, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) }
  }
}

/** A photo-like 3000x2000 test picture: many coloured shapes (details for the scaler and the encoder). */
async function benchPhoto(path: string, seed: number): Promise<void> {
  let s = seed * 7919 + 13
  const r = (): number => ((s = (s * 16807) % 2147483647) / 2147483647)
  const shapes: string[] = []
  for (let i = 0; i < 400; i++) {
    const c = `hsl(${Math.floor(r() * 360)},${30 + Math.floor(r() * 50)}%,${20 + Math.floor(r() * 60)}%)`
    const x = r() * 3000
    const y = r() * 2000
    const w = 20 + r() * 200
    shapes.push(r() < 0.5 ? `<rect x="${x}" y="${y}" width="${w}" height="${20 + r() * 200}" fill="${c}" transform="rotate(${r() * 90} ${x} ${y})"/>` : `<circle cx="${x}" cy="${y}" r="${w / 2}" fill="${c}"/>`)
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2000"><rect width="3000" height="2000" fill="hsl(${seed * 97},25%,45%)"/>${shapes.join('')}</svg>`
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(path)
}

export function registerSystemCheck(cfg: { ff: Ffmpeg; cacheDir: string }): void {
  const benchDirs = new Set<string>()
  const cleanup = async (): Promise<void> => {
    const dirs = [...benchDirs]
    benchDirs.clear()
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})))
  }

  ipcMain.handle('system:info', async (): Promise<SystemInfo> => {
    const [devices, encoders, hevc, tonemap, disk, ffmpeg] = await Promise.all([
      gpuDevices(),
      cfg.ff.encoders(),
      withTimeout(directDecodeSupport().then((d) => d.hevc ?? null), 8000, null),
      withTimeout(detectGpuTonemap(cfg.ff), 90_000, null),
      freeSpace(cfg.cacheDir),
      ffmpegVersion(cfg.ff)
    ])
    const features = Object.fromEntries(Object.entries(app.getGPUFeatureStatus() as unknown as Record<string, string>).map(([k, v]) => [k, String(v)]))
    return {
      gpu: { devices, features },
      encoders,
      hevcDirect: hevc,
      tonemap: tonemap ? { device: tonemap.device, decode: tonemap.decode } : null,
      cpu: { model: (cpus()[0]?.model ?? 'unknown').trim(), threads: availableParallelism() },
      memory: { total: totalmem(), free: freemem() },
      disk: { path: cfg.cacheDir, ...disk },
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node,
        ffmpeg,
        windows: process.platform === 'win32' ? windowsVersion(version(), release()) : `${version()} (${release()})`
      }
    }
  })

  // One after another: hardware sessions running side by side would slow each other down
  ipcMain.handle('system:encoders', async (): Promise<EncoderTest[]> => {
    let listed = ''
    try {
      listed = (await cfg.ff.capture(['-encoders'])).toString('utf8')
    } catch {
      // no FFmpeg: nothing to test
    }
    const has = (name: string): boolean => new RegExp(`\\s${name}\\s`).test(listed)
    const out: EncoderTest[] = []
    for (const enc of [...HW_ENCODERS.filter(has), ...(has('libx264') ? ['libx264'] : [])]) out.push(await testEncode(cfg.ff, enc))
    return out
  })

  ipcMain.handle('system:bench-media', async (): Promise<BenchMedia> => {
    const dir = join(tmpdir(), `diashow-bench-${randomBytes(4).toString('hex')}`)
    benchDirs.add(dir)
    await mkdir(dir, { recursive: true })
    const photos = await Promise.all(
      [1, 2, 3].map(async (i) => {
        const path = join(dir, `photo${i}.jpg`)
        await benchPhoto(path, i)
        return { path, width: 3000, height: 2000 }
      })
    )
    const video = join(dir, 'clip.mp4')
    await cfg.ff.run(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video])
    return { photos, video: { path: video, width: 1920, height: 1080, duration: 3, fps: 30 } }
  })

  ipcMain.handle('system:bench-cleanup', () => cleanup())
  app.on('before-quit', () => void cleanup())
}
