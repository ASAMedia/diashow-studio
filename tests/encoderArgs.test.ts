// Encoder settings per hardware family: Intel Quick Sync needs look-ahead (or lower values) to reach
// the quality NVENC gives at the same level.
import { describe, expect, it } from 'vitest'
import { encoderArgs } from '../src/main/export/encoder'
import { proxyEncoderArgs } from '../src/main/media/video'

const value = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

describe('Quick Sync settings', () => {
  it('uses look-ahead ICQ for H.264 at the NVENC levels', () => {
    const levels = (['standard', 'high', 'max'] as const).map((q) => encoderArgs('h264_qsv', 'h264', q, 30))
    expect(levels.map((a) => value(a, '-global_quality'))).toEqual(['23', '19', '16'])
    for (const a of levels) expect(value(a, '-look_ahead')).toBe('1')
    expect(levels.map((a) => value(encoderArgs('h264_nvenc', 'h264', 'high', 30), '-cq'))).toEqual(['19', '19', '19'])
  })

  it('falls back to lower ICQ values on chips without look-ahead, and for HEVC', () => {
    const noLa = encoderArgs('h264_qsv', 'h264', 'high', 30, { qsvLookAhead: false })
    expect(noLa).not.toContain('-look_ahead')
    expect(value(noLa, '-global_quality')).toBe('15')
    const hevc = (['standard', 'high', 'max'] as const).map((q) => encoderArgs('hevc_qsv', 'hevc', q, 30))
    expect(hevc.map((a) => value(a, '-global_quality'))).toEqual(['17', '14', '12'])
    for (const a of hevc) {
      expect(a).not.toContain('-look_ahead')
      expect(value(a, '-tag:v')).toBe('hvc1')
    }
  })

  it('gives proxies and stabilised clips the same treatment', () => {
    expect(value(proxyEncoderArgs('h264_qsv', 30), '-look_ahead')).toBe('1')
    const old = proxyEncoderArgs('h264_qsv', 30, { qsvLookAhead: false })
    expect(old).not.toContain('-look_ahead')
    expect(value(old, '-global_quality')).toBe('17')
  })
})
