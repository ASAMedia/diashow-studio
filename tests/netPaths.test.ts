// Network shares in projects made elsewhere: no access (and so no Windows sign-in to the host)
// until the user trusts the host.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { MediaItem, MusicTrack } from '@shared/types'
import { uncHost, validHost } from '@shared/netPaths'
import { sanitizeAppSettings } from '../src/main/appSettings'
import { createMediaService } from '../src/main/media/service'
import { cacheFolderName } from '../src/main/media/serviceContext'
import { createNetTrust, pathHost } from '../src/main/netTrust'
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

  it('counts the device-namespace spellings of a share as that host, and refuses other device paths', async () => {
    // \\.\UNC\host\… reaches the host like \\host\… (Node and FFmpeg pass it to Windows as it is)
    expect(pathHost('\\\\.\\UNC\\Evil-Host\\share\\a.jpg')).toBe('evil-host')
    expect(pathHost('//./UNC/evil-host/share/a.jpg')).toBe('evil-host')
    expect(pathHost('\\??\\UNC\\evil-host\\share\\a.jpg')).toBe('evil-host')
    expect(pathHost('\\\\?\\UNC\\nas01\\share\\a.jpg')).toBe('nas01')
    expect(pathHost('\\\\nas01\\share\\a.jpg')).toBe('nas01')
    expect(pathHost('C:\\Users\\a.jpg')).toBe('')
    expect(pathHost('\\\\?\\C:\\very\\long\\a.jpg')).toBe('')
    // the multiple UNC provider, volumes, pipes: where they lead can't be told
    for (const p of ['\\\\?\\GLOBALROOT\\Device\\Mup\\evil-host\\share\\a.jpg', '\\\\.\\GLOBALROOT\\Device\\Mup\\evil-host\\s\\a.jpg', '\\\\?\\Volume{0}\\a.jpg', '\\\\.\\pipe\\x', '\\??\\GLOBALROOT\\x']) {
      expect([p, pathHost(p)]).toEqual([p, null])
    }
    const settings = { get: async () => ({ trustedHosts: ['nas01'] }), set: async () => {}, update: async () => {} }
    const net = createNetTrust(settings)
    await net.loaded
    expect(net.allowPath('C:\\Fotos\\a.jpg')).toBe(true)
    expect(net.allowPath('\\\\nas01\\fotos\\a.jpg')).toBe(true)
    expect(net.allowPath('\\\\.\\UNC\\nas01\\fotos\\a.jpg')).toBe(true)
    expect(net.allowPath('\\\\evil-host\\x\\a.jpg')).toBe(false)
    expect(net.allowPath('\\\\.\\UNC\\evil-host\\x\\a.jpg')).toBe(false)
    expect(net.allowPath('\\??\\UNC\\evil-host\\x\\a.jpg')).toBe(false)
    expect(net.allowPath('\\\\?\\GLOBALROOT\\Device\\Mup\\nas01\\fotos\\a.jpg')).toBe(false)
  })

  it('does not open the Live Photo video of a restored photo on an untrusted share', async () => {
    const photo = join(dir, 'live', 'IMG_0001.JPG')
    const mov = join(dir, 'live', 'IMG_0001.MOV')
    mkdirSync(join(dir, 'live'), { recursive: true })
    writeFileSync(photo, 'not a real jpeg')
    writeFileSync(mov, 'not a real mov')
    // the video counts as on a share nobody trusted (a local stand-in, so nothing reaches the network)
    const asked: string[] = []
    const allowPath = (p: string): boolean => {
      asked.push(p)
      return p !== mov
    }
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir: join(dir, 'cache-live'), allowPath })
    try {
      const item: MediaItem = {
        id: '00112233445566aa', path: photo, name: 'IMG_0001.JPG', kind: 'photo', format: 'JPEG', width: 10, height: 10,
        captureTime: 1, status: 'ready', live: { source: mov, duration: 2 }
      }
      const [r] = await svc.restoreMedia([item])
      expect(asked).toContain(mov)
      expect(r.live).toBeUndefined()
      expect(r.liveVideo).toBeUndefined()
      await svc.idle()
    } finally {
      await svc.dispose()
    }
  })

  it('keeps the cache of an id from a foreign project inside the cache folder', async () => {
    expect(cacheFolderName('0123456789abcdef')).toBe('0123456789abcdef')
    expect(cacheFolderName('theme-kenburns')).toBe('theme-kenburns')
    for (const id of ['..\\..\\Startup', '../x', 'a:b', 'C:\\Windows', 'CON', '', 'x'.repeat(200)]) {
      expect([id, cacheFolderName(id)]).toEqual([id, expect.stringMatching(/^[0-9a-f]{16}$/)])
    }
    // a song whose id is a path: its cache folder (made before the transcode) must stay in the cache
    const root = join(dir, 'ids')
    const cacheDir = join(root, 'cache')
    mkdirSync(root, { recursive: true })
    const song = join(root, 'song.mp3')
    writeFileSync(song, 'not really audio')
    const svc = createMediaService({ ffmpegDir: FFMPEG_DIR, cacheDir })
    try {
      const track: MusicTrack = { id: '..\\escaped', path: song, title: 'song', duration: 10, status: 'pending' }
      await svc.restoreMusic([track])
      await svc.idle()
      expect(existsSync(join(root, 'escaped'))).toBe(false)
      expect(readdirSync(root).sort()).toEqual(['cache', 'song.mp3'])
    } finally {
      await svc.dispose()
    }
  })
})
