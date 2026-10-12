// Laptops with two graphics chips render on the high-performance one unless the user saves power.
import { describe, expect, it } from 'vitest'
import { sanitizeAppSettings } from '../src/main/appSettings'
import { chromiumGpuSwitch, chooseGpu, gpuPreference, runningGpuPreference } from '../src/main/gpuChoice'

describe('graphics chip choice', () => {
  it('renders on the high-performance chip by default and leaves it to Windows when saving power', () => {
    // the tests run without DIASHOW_GPU
    expect(gpuPreference({})).toBe('performance')
    expect(chromiumGpuSwitch('performance')).toBe('force_high_performance_gpu')
    expect(chromiumGpuSwitch('saving')).toBeUndefined()
    expect(chooseGpu({ gpuPreference: 'saving' })).toBeUndefined()
    expect(runningGpuPreference()).toBe('saving')
    expect(chooseGpu({})).toBe('force_high_performance_gpu')
    expect(runningGpuPreference()).toBe('performance')
  })

  it('stores only the known values', () => {
    expect(sanitizeAppSettings({ gpuPreference: 'saving' }).gpuPreference).toBe('saving')
    expect(sanitizeAppSettings({ gpuPreference: 'turbo' }).gpuPreference).toBeUndefined()
    expect(gpuPreference(sanitizeAppSettings({ gpuPreference: 3 }))).toBe('performance')
  })
})
