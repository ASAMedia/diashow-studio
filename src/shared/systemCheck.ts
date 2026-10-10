// System check (Settings → "Systemcheck"): what this PC offers the app, measured in the main process
// (src/main/systemCheck.ts) and the renderer (WebGL, WebCodecs, export benchmark).
import type { EncoderInfo } from './types'

export interface GpuDeviceInfo {
  vendor: string
  /** Device name where Chromium reports one, else the PCI device id. */
  device: string
  driver?: string
  active: boolean
}

export interface SystemInfo {
  gpu: {
    devices: GpuDeviceInfo[]
    /** app.getGPUFeatureStatus(): e.g. webgl2 'enabled', video_decode 'enabled', gpu_compositing 'enabled'. */
    features: Record<string, string>
  }
  encoders: EncoderInfo
  /** 8-bit HEVC plays without a proxy (graphics card decoder); null when no window could answer. */
  hevcDirect: boolean | null
  /** GPU tone mapping for HDR videos (libplacebo on Vulkan), or null (CPU). */
  tonemap: { device: number; decode: string } | null
  cpu: { model: string; threads: number }
  memory: { total: number; free: number }
  /** Free space where the media cache lives. */
  disk: { path: string; free: number | null; total: number | null }
  versions: { app: string; electron: string; chrome: string; node: string; ffmpeg: string; windows: string }
}

export interface EncoderTest {
  encoder: string
  hardware: boolean
  ok: boolean
  /** Wall time of encoding 1 s of 1080p30 (30 frames), FFmpeg start included. */
  seconds?: number
  /** Frames per second over that run. */
  fps?: number
  error?: string
}

/** Generated media for the export benchmark (deleted again with systemBenchCleanup). */
export interface BenchMedia {
  photos: { path: string; width: number; height: number }[]
  video: { path: string; width: number; height: number; duration: number; fps: number }
}
