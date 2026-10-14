// The audio plan of an export job comes from the renderer, and FFmpeg reads every clip's source
// (src/main/export/validate.ts): ordinary absolute paths only, never a device path or a data stream.
import { describe, expect, it } from 'vitest'
import { validateAudio } from '../src/main/export/validate'

const plan = (src: string) => ({ duration: 10, clips: [{ id: 'c1', kind: 'music', src, start: 0, offset: 0, duration: 10, gain: [{ t: 0, g: 1 }] }] })

describe('export audio sources', () => {
  it('takes ordinary local and network paths', () => {
    for (const src of ['C:\\Users\\anna\\Music\\song.mp3', 'D:/Fotos/Tag 1/VID_0001.MOV', '\\\\nas\\fotos\\clip.mp4']) {
      expect(validateAudio(plan(src)).clips[0].src, src).toBe(src)
    }
  })

  it('refuses device paths, data streams and relative paths', () => {
    for (const src of ['\\\\?\\C:\\x.mp3', '\\\\.\\PhysicalDrive0', '\\\\.\\UNC\\host\\share\\a.mp3', '\\??\\C:\\x.mp3', '\\\\?\\GLOBALROOT\\Device\\Mup\\host\\a.mp3', 'C:\\music\\song.mp3:hidden.mp3', 'music\\song.mp3', 'https://example.com/a.mp3']) {
      expect(() => validateAudio(plan(src)), src).toThrow(/invalid source/)
    }
  })
})
