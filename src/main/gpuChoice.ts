// Which graphics chip does what on a laptop with two. Chromium on Windows renders on the power-saving
// (integrated) chip unless told otherwise, while FFmpeg encodes on the fastest: every exported frame
// then travels from the integrated chip through memory to the other one. Measured on an Iris Xe +
// RTX 4070 laptop, 220 s show: 4K export 419 s mixed, 289 s all on the RTX, 306 s all on Intel with
// Quick Sync; 1080p 64 s vs 58 s. So the app renders on the high-performance chip by default; the
// setting 'saving' leaves the choice to Windows (battery).
//
// DIASHOW_GPU overrides it for tests and comparisons:
// - integrated: like a PC with only integrated graphics (a school PC without NVIDIA). NVIDIA's encoders
//   and CUDA decoding are left out and HDR proxies use the integrated Vulkan device.
// - discrete: render on the high-performance chip.

import type { AppSettings } from '@shared/types'

export const gpuOverride = process.env.DIASHOW_GPU === 'integrated' || process.env.DIASHOW_GPU === 'discrete' ? process.env.DIASHOW_GPU : undefined
export const integratedGpuOnly = gpuOverride === 'integrated'

/** Hardware encoder families to try, fastest first. */
export function hardwareEncoderFamilies(): string[] {
  return integratedGpuOnly ? ['qsv', 'amf'] : ['nvenc', 'qsv', 'amf']
}

/** The preference this start uses. */
export function gpuPreference(settings: AppSettings): 'performance' | 'saving' {
  return settings.gpuPreference === 'saving' ? 'saving' : 'performance'
}

/** Chromium switch for the override or the preference, if any. */
export function chromiumGpuSwitch(preference: 'performance' | 'saving'): string | undefined {
  if (gpuOverride === 'integrated') return 'force_low_power_gpu'
  if (gpuOverride === 'discrete' || preference === 'performance') return 'force_high_performance_gpu'
  return undefined
}

let running: 'performance' | 'saving' = 'performance'

/** Picks the chip for this start (before the app is ready) and returns the Chromium switch, if any. */
export function chooseGpu(settings: AppSettings): string | undefined {
  running = gpuPreference(settings)
  return chromiumGpuSwitch(running)
}

/** The preference in effect since the start (a changed setting waits for the next start). */
export function runningGpuPreference(): 'performance' | 'saving' {
  return running
}
