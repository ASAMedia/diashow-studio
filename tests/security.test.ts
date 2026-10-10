// Electron hardening: which URLs count as the app's page, which navigations are blocked, what the
// dsmedia:// protocol serves (and to whom), and the IPC guard.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mediaUrl } from '@shared/api'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  protocol: { handle: vi.fn() },
  app: { on: vi.fn(), whenReady: () => new Promise(() => {}) },
  session: {},
  shell: { openExternal: vi.fn() },
  ipcMain: {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) {
      handlers.set(channel, listener)
    }
  }
}))
const { handleMediaRequest, mediaPathAllowed, originAllowed } = await import('../src/main/protocol')
const { guardIpc, isAppUrlFor, navigationAllowed } = await import('../src/main/security')
const { ipcMain } = await import('electron')

const dir = mkdtempSync(join(tmpdir(), 'diashow sec '))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('the app page', () => {
  const page = join(dir, 'out', 'renderer', 'index.html')
  const url = pathToFileURL(page).href

  it('accepts the built page with any hash, and the dev server', () => {
    expect(isAppUrlFor(url, page)).toBe(true)
    expect(isAppUrlFor(`${url}#present`, page)).toBe(true)
    expect(isAppUrlFor(`${url}?x=1#export-worker`, page)).toBe(true)
    expect(isAppUrlFor('http://localhost:5173/#present', page, 'http://localhost:5173')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(isAppUrlFor(pathToFileURL(join(dir, 'evil.html')).href, page)).toBe(false)
    expect(isAppUrlFor('https://example.com/', page)).toBe(false)
    expect(isAppUrlFor('http://localhost:5173/', page)).toBe(false)
    expect(isAppUrlFor('http://localhost:5174/', page, 'http://localhost:5173')).toBe(false)
    expect(isAppUrlFor('dsmedia://f/C%3A%5Cx.jpg', page)).toBe(false)
    expect(isAppUrlFor('file://evil-host/share/index.html', page)).toBe(false)
    expect(isAppUrlFor('', page)).toBe(false)
    expect(isAppUrlFor('not a url', page)).toBe(false)
  })

  it('keeps the app windows on the app page', () => {
    const app = (u: string): boolean => isAppUrlFor(u, page)
    expect(navigationAllowed(url, `${url}#present`, app)).toBe(true)
    // a dropped link or location change would put a web page next to window.api
    expect(navigationAllowed(url, 'https://example.com/', app)).toBe(false)
    expect(navigationAllowed('', 'https://example.com/', app)).toBe(false)
    expect(navigationAllowed('about:blank', 'file:///C:/Windows/', app)).toBe(false)
    // a window the main process pointed at a web page itself (tests: the phone page) is not the app
    expect(navigationAllowed('http://127.0.0.1:5000/tok/', 'http://127.0.0.1:5000/tok/f/1', app)).toBe(true)
  })
})

describe('dsmedia access limits', () => {
  it('serves photos, videos and music only', () => {
    expect(mediaPathAllowed('C:\\Users\\x\\Pictures\\IMG_0001.HEIC')).toBe(true)
    expect(mediaPathAllowed('C:\\cache\\ab12\\proxy.mp4')).toBe(true)
    expect(mediaPathAllowed('\\\\nas\\fotos\\klasse\\a.jpg')).toBe(true)
    expect(mediaPathAllowed('D:/Musik/song.mp3')).toBe(true)
    for (const p of [
      'C:\\Users\\x\\.ssh\\id_ed25519',
      'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies',
      'C:\\Users\\x\\Documents\\Zeugnisse.docx',
      'C:\\Users\\x\\Documents\\Diashow Studio\\trip.dshow',
      'C:\\x\\drawing.svg',
      'C:\\secret.txt:hidden.jpg',
      'C:\\x\\a.jpg::$DATA',
      '\\\\?\\C:\\x\\a.jpg',
      '\\\\.\\PhysicalDrive0\\a.jpg',
      'C:\\x\\..\\a.jpg',
      'relative\\a.jpg',
      'C:a.jpg',
      'C:\\x\\a\u0000.jpg'
    ]) {
      expect([p, mediaPathAllowed(p)]).toEqual([p, false])
    }
  })

  it('answers 404 for other files and 403 for foreign web pages', async () => {
    const doc = join(dir, 'notes.txt')
    const pic = join(dir, 'pic.jpg')
    writeFileSync(doc, 'secret')
    writeFileSync(pic, 'jpeg')
    expect((await handleMediaRequest(new Request(mediaUrl(doc)))).status).toBe(404)
    expect((await handleMediaRequest(new Request(mediaUrl(pic)))).status).toBe(200)
    expect((await handleMediaRequest(new Request(mediaUrl(pic), { headers: { Origin: 'null' } }))).status).toBe(200)
    expect((await handleMediaRequest(new Request(mediaUrl(pic), { headers: { Origin: 'https://evil.example' } }))).status).toBe(403)
    expect(originAllowed('file://')).toBe(true)
    expect(originAllowed('http://localhost:5173', 'http://localhost:5173/')).toBe(true)
    expect(originAllowed('http://localhost:5173', undefined)).toBe(false)
  })
})

describe('renderer paths that reach FFmpeg or the disk', async () => {
  const { checkDirectExport, checkLocalFile, checkOutputPath } = await import('../src/main/ipcGuards')
  it('lets FFmpeg read existing local files only, never URLs or protocols', async () => {
    const clip = join(dir, 'clip.mp4')
    writeFileSync(clip, 'x')
    expect(await checkLocalFile(clip)).toBe(clip)
    for (const p of ['http://evil.example/x.mp4', 'concat:C:\\a.mp4|C:\\b.mp4', 'tcp://1.2.3.4:5', 'file:C:\\x.mp4', '\\\\?\\C:\\x.mp4', 'relative.mp4', join(dir, 'gone.mp4'), dir, 42]) {
      await expect(checkLocalFile(p)).rejects.toThrow()
    }
  })

  it('writes (and deletes on cancel) only video files in existing folders', () => {
    expect(checkOutputPath(join(dir, 'out.mp4'))).toBe(join(dir, 'out.mp4'))
    for (const p of [join(dir, 'Zeugnis.docx'), join(dir, 'nope', 'out.mp4'), 'C:\\x\\out.mp4:stream', 'out.mp4', '\\\\.\\pipe\\x.mp4']) expect(() => checkOutputPath(p)).toThrow()
    const ok = { outPath: join(dir, 'out.mp4'), width: 1280, height: 720, fps: 30, codec: 'h264', quality: 'standard', hardware: true, audio: { duration: 5, clips: [] } }
    expect(checkDirectExport(ok)).toMatchObject({ outPath: join(dir, 'out.mp4'), width: 1280 })
    expect(() => checkDirectExport({ ...ok, width: 1e6 })).toThrow(/width/)
    expect(() => checkDirectExport({ ...ok, audio: { duration: 5, clips: [{ id: 'a', kind: 'music', src: 'http://x/a.mp3', start: 0, offset: 0, duration: 1, gain: [] }] } })).toThrow(/source/)
  })
})

describe('IPC guard', () => {
  it('answers only the app page, whichever module registered the channel', async () => {
    const warnings: string[] = []
    guardIpc((m) => warnings.push(m))
    ipcMain.handle('test:echo', (_e, v) => v)
    const listener = handlers.get('test:echo')!
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    try {
      expect(await listener({ senderFrame: { url: 'http://localhost:5173/#present' } }, 42)).toBe(42)
      expect(() => listener({ senderFrame: { url: 'https://evil.example/' } }, 1)).toThrow(/not available/)
      expect(() => listener({ senderFrame: null }, 1)).toThrow(/not available/)
    } finally {
      delete process.env.ELECTRON_RENDERER_URL
    }
    expect(warnings).toEqual(['blocked IPC test:echo', 'blocked IPC test:echo'])
  })
})
