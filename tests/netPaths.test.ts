// Network shares in projects made elsewhere: no access (and so no Windows sign-in to the host)
// until the user trusts the host.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { MediaItem, MusicTrack } from '@shared/types'
import { uncHost, validHost } from '@shared/netPaths'
import { sanitizeAppSettings } from '../src/main/appSettings'
import { createMediaService } from '../src/main/media/service'
import { FFMPEG_DIR } from './helpers/media'

const dir = mkdtempSync(join(tmpdir(), 'diashow-net-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('network paths', () => {
  it('finds the host of UNC paths only', () => {
    expect(uncHost('\\\\NAS01\\Fotos\\a.jpg')).toBe('nas01')
    expect(uncHost('//nas01/fotos/a.jpg')).toBe('nas01')
    expect(uncHost('\\\\?\\UNC\\Server.school.de\\share\\x.mp4')).toBe('server.school.de')
    expect(uncHost('\\\\?\\C:\\Users\\a.jpg')).toBeNull()
    expect(uncHost('\\\\.\\PhysicalDrive0')).toBeNull()
    expect(uncHost('C:\\Users\\a.jpg')).toBeNull()
    expect(uncHost('Z:\\Fotos\\a.jpg')).toBeNull()
    expect(uncHost(42)).toBeNull()
  })

  it('stores only valid host names as trusted', () => {
    expect(validHost('nas01')).toBe(true)
    expect(validHost('10.0.0.5')).toBe(true)
    expect(validHost('evil host')).toBe(false)
    expect(validHost('a\\b')).toBe(false)
    expect(sanitizeAppSettings({ trustedHosts: ['NAS01', 'nas01', 'bad host', 3] }).trustedHosts).toEqual(['nas01'])
    expect(sanitizeAppSettings({ trustedHosts: 'nas01' }).trustedHosts).toEqual([])
  })

  it('does not touch untrusted shares when a project is restored, and drops foreign derived files', async () => {
    const trusted = new Set<string>()
    const seen: string[] = []
    const allowPath = (p: string): boolean => {
      seen.push(p)
      const h = uncHost(p)
      return !h || trusted.has(h)
    }
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: join(dir, 'cache'), allowPath })
    try {
      const photo: MediaItem = {
        id: '0123456789abcdef', path: '\\\\evil-host\\share\\a.jpg', name: 'a.jpg', kind: 'photo', format: 'JPEG',
        width: 10, height: 10, captureTime: 1, status: 'ready', thumb: '\\\\evil-host\\x\\t.jpg', display: '\\\\evil-host\\x\\d.jpg'
      }
      const [r] = await svc.restoreMedia([photo])
      expect(r).toMatchObject({ status: 'error', error: 'network-blocked' })
      // a local original with derived files pointing to a share: those are dropped, nothing is opened there
      const local: MediaItem = { ...photo, id: 'fedcba9876543210', path: join(dir, 'missing.jpg') }
      const [l] = await svc.restoreMedia([local])
      expect(l.thumb).toBeUndefined()
      expect(l.display).toBeUndefined()
      const song: MusicTrack = { id: 'm1', path: '\\\\evil-host\\music\\s.mp3', title: 's', duration: 10, status: 'ready', playback: '\\\\evil-host\\music\\s.mp3' }
      const [m] = await svc.restoreMusic([song])
      expect(m).toMatchObject({ status: 'error', error: 'network-blocked' })
      expect(seen.some((p) => p.startsWith('\\\\evil-host'))).toBe(true)
    } finally {
      await svc.dispose()
    }
  })
})
