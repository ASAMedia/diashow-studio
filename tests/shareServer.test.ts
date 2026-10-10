// Sharing over the local network: the HTTP server (tokens, no traversal, streamed uploads with
// limits, range downloads, stopping), safe names, page language and the interface list.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ShareReceived } from '@shared/share'

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))
const { createShareServer, safeName, uploadFileName, uploaderFolder, contentDisposition } = await import('../src/main/share/server')
const { pageLang } = await import('../src/main/share/pages')
const { adapterKind, isPrivateIPv4, lanAddresses } = await import('../src/main/share/net')

const tmp = mkdtempSync(join(tmpdir(), 'diashow-share-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

/** One HTTP request; `body` is sent at once, or `write` streams it and decides when to end. */
function req(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string | number>; body?: Buffer; write?: (r: import('node:http').ClientRequest) => void } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers: opts.headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    r.on('error', reject)
    if (opts.write) opts.write(r)
    else r.end(opts.body)
  })
}

const bytes = (n: number, seed = 1): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256))
const upload = (port: number, token: string, name: string, body: Buffer, uploader = '', type = 'image/jpeg'): Promise<Reply> =>
  req(port, 'POST', `/${token}/upload`, {
    headers: { 'X-File-Name': encodeURIComponent(name), 'X-Uploader': encodeURIComponent(uploader), 'Content-Type': type, 'Content-Length': body.length },
    body
  })

function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? filesIn(p) : [p]
  })
}

async function startServer(name: string, extra: Partial<Parameters<typeof createShareServer>[0]> = {}) {
  const uploadDir = join(tmp, name)
  const received: ShareReceived[] = []
  const server = createShareServer({ uploadDir, projectName: 'Klassenfahrt <Berlin>', onReceived: (f) => received.push(f), ...extra })
  await server.listen('127.0.0.1')
  return { server, uploadDir, received, port: server.port! }
}

describe('safe names', () => {
  it('keeps only a harmless last path component', () => {
    expect(safeName('..\\..\\Windows\\win.ini')).toBe('win.ini')
    expect(safeName('../../etc/passwd')).toBe('passwd')
    expect(safeName('..')).toBe('')
    expect(safeName('  .hidden.jpg ')).toBe('hidden.jpg')
    expect(safeName('a<b>c:d"e|f?g*h.jpg')).toBe('a_b_c_d_e_f_g_h.jpg')
    expect(safeName('evil‮gpj.exe')).toBe('evil_gpj.exe')
    expect(safeName('CON.jpg')).toBe('_CON.jpg')
    expect(safeName('photo. . .')).toBe('photo')
    expect(safeName(`${'x'.repeat(300)}.jpeg`)).toMatch(/^x{115}\.jpeg$/)
  })

  it('accepts only photos and videos the app imports, by extension or MIME type', () => {
    expect(uploadFileName('IMG_0001.HEIC')).toEqual({ name: 'IMG_0001.HEIC', kind: 'photo' })
    expect(uploadFileName('trim.MOV')).toEqual({ name: 'trim.MOV', kind: 'video' })
    expect(uploadFileName('notes.txt')).toBeNull()
    expect(uploadFileName('song.mp3', 'audio/mpeg')).toBeNull()
    expect(uploadFileName('blob', 'image/jpeg')).toEqual({ name: 'blob.jpg', kind: 'photo' })
    expect(uploadFileName('', 'video/quicktime')).toEqual({ name: 'upload.mov', kind: 'video' })
    expect(uploadFileName('x.exe', 'image/png')).toEqual({ name: 'x.png', kind: 'photo' })
    expect(uploaderFolder('')).toBe('Unbekannt')
    expect(uploaderFolder('  ../..  ')).toBe('Unbekannt')
    expect(uploaderFolder('Mia/../../x')).toBe('x')
    expect(uploaderFolder('Jonas Müller')).toBe('Jonas Müller')
  })

  it('writes Content-Disposition with an ASCII fallback and the UTF-8 name', () => {
    expect(contentDisposition('Klassenfahrt Größe "1".mp4', true)).toBe(`attachment; filename="Klassenfahrt Gr__e _1_.mp4"; filename*=UTF-8''Klassenfahrt%20Gr%C3%B6%C3%9Fe%20%221%22.mp4`)
    expect(contentDisposition('a.mp4', false)).toMatch(/^inline; /)
  })

  it('picks German or English from Accept-Language', () => {
    expect(pageLang('de-DE,de;q=0.9,en;q=0.8')).toBe('de')
    expect(pageLang('en-US,en;q=0.9,de;q=0.8')).toBe('en')
    expect(pageLang('fr-FR,de;q=0.7,en;q=0.5')).toBe('de')
    expect(pageLang('en;q=0.5,de;q=0.6')).toBe('de')
    expect(pageLang(undefined)).toBe('en')
  })

  it('lists private IPv4 interfaces, Wi-Fi first', () => {
    expect(isPrivateIPv4('192.168.1.20')).toBe(true)
    expect(isPrivateIPv4('172.20.0.1')).toBe(true)
    expect(isPrivateIPv4('172.32.0.1')).toBe(false)
    expect(isPrivateIPv4('100.101.1.2')).toBe(false)
    expect(isPrivateIPv4('169.254.3.3')).toBe(false)
    const v4 = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '255.255.255.0', mac: '', cidr: null })
    const list = lanAddresses({
      'vEthernet (WSL)': [v4('172.28.16.1')],
      Ethernet: [v4('10.0.0.5')],
      'LAN-Verbindung* 10': [v4('192.168.137.1')],
      WLAN: [v4('192.168.178.23'), { ...v4('fe80::1'), family: 'IPv6' as const } as never],
      Loopback: [v4('127.0.0.1', true)],
      Tailscale: [v4('100.64.1.2')]
    })
    expect(list.map((a) => [a.name, a.kind])).toEqual([
      ['WLAN', 'wifi'],
      ['Ethernet', 'ethernet'],
      ['LAN-Verbindung* 10', 'hotspot'],
      ['vEthernet (WSL)', 'virtual']
    ])
    expect(adapterKind('Wi-Fi 2', '10.1.1.1')).toBe('wifi')
  })
})

describe('share server', () => {
  it('answers only below its tokens, never with files outside the offers', async () => {
    const { server, port } = await startServer('tokens')
    try {
      const secret = join(tmp, 'secret.mp4')
      writeFileSync(secret, 'secret')
      const up = server.uploadToken
      const dl = server.downloadToken
      expect(up).toMatch(/^[\w-]{32}$/)
      expect(up).not.toBe(dl)
      expect(server.uploadUrl()).toBe(`http://127.0.0.1:${port}/${up}/`)
      const page = await req(port, 'GET', `/${up}/`, { headers: { 'Accept-Language': 'de-DE' } })
      expect(page.status).toBe(200)
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(page.headers['content-security-policy']).toContain("default-src 'none'")
      expect(page.headers['x-content-type-options']).toBe('nosniff')
      expect(page.headers['referrer-policy']).toBe('no-referrer')
      const html = page.body.toString()
      expect(html).toContain('Fotos &amp; Videos teilen')
      expect(html).toContain('Klassenfahrt &lt;Berlin&gt;')
      expect(html).not.toContain('<Berlin>')
      expect((await req(port, 'GET', `/${up}/`, { headers: { 'Accept-Language': 'en-GB' } })).body.toString()).toContain('Share photos &amp; videos')
      expect((await req(port, 'GET', `/${dl}/`)).status).toBe(200)
      for (const path of [
        '/',
        '/favicon.ico',
        `/${up.slice(0, -1)}/`,
        `/${up}x/`,
        `/${up.toUpperCase()}/`,
        `/${up}/../${dl}/f/`,
        `/${dl}/f/`,
        `/${dl}/f/unknown/x.mp4`,
        `/${dl}/f/..%2F..%2Fsecret.mp4/x`,
        `/${dl}/..%5Csecret.mp4`,
        `/${dl}/${encodeURIComponent(secret)}`,
        `/${dl}/f/${encodeURIComponent(secret)}/secret.mp4`,
        '/%2e%2e/%2e%2e/secret.mp4',
        `/${up}/%E0%A4%A`,
        `/${up}/upload/../../secret.mp4`
      ]) {
        const r = await req(port, 'GET', path)
        expect([path, r.status]).toEqual([path, 404])
        expect(r.body.length).toBe(0)
      }
      // wrong methods
      expect((await req(port, 'GET', `/${up}/upload`)).status).toBe(405)
      expect((await req(port, 'DELETE', `/${dl}/`)).status).toBe(405)
      // nothing but media files can be offered
      expect(await server.offer(join(tmp, 'nope.mp4'))).toBeNull()
      writeFileSync(join(tmp, 'notes.txt'), 'x')
      expect(await server.offer(join(tmp, 'notes.txt'))).toBeNull()
    } finally {
      await server.close()
    }
  })

  it('streams uploads to disk under safe, unique names per uploader', async () => {
    const { server, uploadDir, received, port } = await startServer('upload')
    try {
      const body = bytes(3_000_000)
      const r = await upload(port, server.uploadToken, '../../evil.jpg', body, '../Mia')
      expect(r.status).toBe(201)
      expect(JSON.parse(r.body.toString())).toEqual({ ok: true, name: 'evil.jpg' })
      const first = join(uploadDir, 'Mia', 'evil.jpg')
      expect(readFileSync(first).equals(body)).toBe(true)
      // same name again: a new file next to it; without a name: "Unbekannt"
      expect((await upload(port, server.uploadToken, 'evil.jpg', bytes(10), 'Mia')).status).toBe(201)
      expect((await upload(port, server.uploadToken, 'IMG_0001.MOV', bytes(20), '', 'video/quicktime')).status).toBe(201)
      expect(filesIn(uploadDir).map((f) => f.slice(uploadDir.length + 1)).sort()).toEqual(['Mia\\evil (2).jpg', 'Mia\\evil.jpg', 'Unbekannt\\IMG_0001.MOV'].sort())
      expect(received.map((f) => [f.uploader, f.name, f.kind, f.size])).toEqual([
        ['Mia', 'evil.jpg', 'photo', 3_000_000],
        ['Mia', 'evil (2).jpg', 'photo', 10],
        ['Unbekannt', 'IMG_0001.MOV', 'video', 20]
      ])
      expect(server.received()).toHaveLength(3)
      // nothing was written outside the upload folder
      expect(existsSync(join(tmp, 'evil.jpg'))).toBe(false)

      // the body goes to disk while it arrives (a .part file grows), not into memory first
      const half = bytes(2_000_000, 7)
      let partSeen = 0
      const streamed = await req(port, 'POST', `/${server.uploadToken}/upload`, {
        headers: { 'X-File-Name': 'stream.mp4', 'X-Uploader': 'Ben', 'Content-Type': 'video/mp4', 'Content-Length': half.length * 2 },
        write: (r) => {
          r.write(half)
          const part = join(uploadDir, 'Ben', 'stream.mp4.part')
          const poll = setInterval(() => {
            if (existsSync(part) && statSync(part).size >= 1_000_000) {
              partSeen = statSync(part).size
              clearInterval(poll)
              r.end(half)
            }
          }, 20)
        }
      })
      expect(streamed.status).toBe(201)
      expect(partSeen).toBeGreaterThanOrEqual(1_000_000)
      expect(statSync(join(uploadDir, 'Ben', 'stream.mp4')).size).toBe(4_000_000)
      expect(existsSync(join(uploadDir, 'Ben', 'stream.mp4.part'))).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('refuses wrong types, too large files, closed uploads, and too many at once', async () => {
    const { server, uploadDir, port } = await startServer('limits', { limits: { photo: 1000, video: 5000 }, maxConcurrentUploads: 1 })
    try {
      const tok = server.uploadToken
      expect((await upload(port, tok, 'notes.txt', bytes(10), '', 'text/plain')).status).toBe(415)
      expect((await upload(port, tok, 'song.mp3', bytes(10), '', 'audio/mpeg')).status).toBe(415)
      expect((await upload(port, tok, 'big.jpg', bytes(1001))).status).toBe(413)
      expect((await upload(port, tok, 'ok.jpg', bytes(1000))).status).toBe(201)
      expect((await upload(port, tok, 'clip.mp4', bytes(4000), '', 'video/mp4')).status).toBe(201)
      expect((await upload(port, tok, 'clip.mp4', bytes(5001), '', 'video/mp4')).status).toBe(413)
      expect((await upload(port, tok, 'empty.jpg', Buffer.alloc(0))).status).toBe(400)
      // a client that stops early leaves nothing behind
      await expect(
        req(port, 'POST', `/${tok}/upload`, {
          headers: { 'X-File-Name': 'cut.mp4', 'Content-Type': 'video/mp4', 'Content-Length': 4000 },
          write: (r) => {
            r.write(bytes(1000))
            setTimeout(() => r.destroy(), 100)
          }
        })
      ).rejects.toThrow()
      await new Promise((r) => setTimeout(r, 200))
      expect(filesIn(uploadDir).map((f) => f.slice(uploadDir.length + 1)).sort()).toEqual(['Unbekannt\\clip.mp4', 'Unbekannt\\ok.jpg'])

      // one upload at a time: a second one gets 503 + Retry-After while the first is running
      let release = (): void => {}
      const slow = req(port, 'POST', `/${tok}/upload`, {
        headers: { 'X-File-Name': 'slow.mp4', 'Content-Type': 'video/mp4', 'Content-Length': 2000 },
        write: (r) => {
          r.write(bytes(1000))
          release = () => r.end(bytes(1000))
        }
      })
      await new Promise((r) => setTimeout(r, 150))
      expect(server.uploading()).toBe(1)
      const busy = await upload(port, tok, 'second.jpg', bytes(10))
      expect(busy.status).toBe(503)
      expect(busy.headers['retry-after']).toBe('3')
      release()
      expect((await slow).status).toBe(201)
      expect(server.uploading()).toBe(0)

      // uploads switched off
      server.collecting = false
      expect((await upload(port, tok, 'late.jpg', bytes(10))).status).toBe(403)
      server.collecting = true
      expect((await upload(port, tok, 'late.jpg', bytes(10))).status).toBe(201)
    } finally {
      await server.close()
    }
  })

  it('refuses uploads when the disk would run full', async () => {
    const { server, port } = await startServer('disk', { freeSpace: async () => 1024 ** 3 + 500 })
    try {
      expect((await upload(port, server.uploadToken, 'a.jpg', bytes(400))).status).toBe(201)
      expect((await upload(port, server.uploadToken, 'b.jpg', bytes(600))).status).toBe(507)
    } finally {
      await server.close()
    }
  })

  it('serves offered files with ranges, type and disposition', async () => {
    const { server, port } = await startServer('download')
    try {
      const file = join(tmp, 'Klassenfahrt Größe.mp4')
      const data = bytes(10_000, 3)
      writeFileSync(file, data)
      const offer = (await server.offer(file))!
      expect(offer).toMatchObject({ name: 'Klassenfahrt Größe.mp4', size: 10_000, downloads: 0 })
      expect(await server.offer(file)).toEqual(offer)
      const page = await req(port, 'GET', `/${server.downloadToken}/`)
      const href = /href="([^"?]+)"/.exec(page.body.toString())![1]
      expect(href).toBe(`/${server.downloadToken}/f/${offer.id}/${encodeURIComponent(offer.name)}`)

      const full = await req(port, 'GET', href)
      expect(full.status).toBe(200)
      expect(full.headers['content-type']).toBe('video/mp4')
      expect(full.headers['accept-ranges']).toBe('bytes')
      expect(full.headers['content-length']).toBe('10000')
      expect(full.headers['content-disposition']).toMatch(/^inline; filename="Klassenfahrt Gr__e\.mp4"; filename\*=UTF-8''Klassenfahrt%20Gr%C3%B6%C3%9Fe\.mp4$/)
      expect(full.body.equals(data)).toBe(true)

      const part = await req(port, 'GET', href, { headers: { Range: 'bytes=100-199' } })
      expect(part.status).toBe(206)
      expect(part.headers['content-range']).toBe('bytes 100-199/10000')
      expect(part.headers['content-length']).toBe('100')
      expect(part.body.equals(data.subarray(100, 200))).toBe(true)
      // iOS Safari starts with bytes=0-1 and continues with open ranges
      const probe = await req(port, 'GET', href, { headers: { Range: 'bytes=0-1' } })
      expect([probe.status, probe.body.length, probe.headers['content-range']]).toEqual([206, 2, 'bytes 0-1/10000'])
      const tail = await req(port, 'GET', href, { headers: { Range: 'bytes=9990-' } })
      expect(tail.body.equals(data.subarray(9990))).toBe(true)
      const suffix = await req(port, 'GET', href, { headers: { Range: 'bytes=-10' } })
      expect(suffix.headers['content-range']).toBe('bytes 9990-9999/10000')
      const bad = await req(port, 'GET', href, { headers: { Range: 'bytes=20000-' } })
      expect([bad.status, bad.headers['content-range']]).toEqual([416, 'bytes */10000'])
      // a stale If-Range gets the whole file
      const stale = await req(port, 'GET', href, { headers: { Range: 'bytes=0-9', 'If-Range': '"other"' } })
      expect(stale.status).toBe(200)
      const head = await req(port, 'HEAD', href)
      expect([head.status, head.headers['content-length'], head.body.length]).toEqual([200, '10000', 0])
      const save = await req(port, 'GET', `${href}?dl=1`)
      expect(save.headers['content-disposition']).toMatch(/^attachment; /)
      expect(server.offers()[0].downloads).toBe(3)

      server.unoffer(offer.id)
      expect((await req(port, 'GET', href)).status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('stops: refuses connections, cuts running uploads and removes their partial file', async () => {
    const { server, uploadDir, port } = await startServer('stop')
    const running = req(port, 'POST', `/${server.uploadToken}/upload`, {
      headers: { 'X-File-Name': 'cut.mp4', 'Content-Type': 'video/mp4', 'Content-Length': 100_000 },
      write: (r) => r.write(bytes(10_000))
    })
    running.catch(() => {})
    const part = join(uploadDir, 'Unbekannt', 'cut.mp4.part')
    for (let i = 0; i < 50 && !existsSync(part); i++) await new Promise((r) => setTimeout(r, 20))
    expect(existsSync(part)).toBe(true)
    await server.close()
    await expect(running).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 100))
    expect(filesIn(uploadDir)).toEqual([])
    expect(server.port).toBeNull()
    expect(server.uploadUrl()).toBeNull()
    await expect(req(port, 'GET', `/${server.uploadToken}/`)).rejects.toThrow(/ECONNREFUSED/)
    await expect(server.listen('127.0.0.1')).rejects.toThrow(/closed/)
  })

  it('moves to another address with new port, same links', async () => {
    const { server } = await startServer('move')
    try {
      const token = server.uploadToken
      const before = server.port
      await server.listen('127.0.0.1')
      expect(server.uploadToken).toBe(token)
      expect(server.port).not.toBeNull()
      expect((await req(server.port!, 'GET', `/${token}/`)).status).toBe(200)
      if (before !== server.port) await expect(req(before!, 'GET', `/${token}/`)).rejects.toThrow(/ECONNREFUSED/)
    } finally {
      await server.close()
    }
  })
})
