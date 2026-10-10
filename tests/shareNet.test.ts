// Share server on networks with public addresses (eduroam & co.): which interfaces are offered and in
// what order, and the token check that keeps the server closed to anyone without the link.
import { request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))
const { isPrivateIPv4, isPublicIPv4, lanAddresses } = await import('../src/main/share/net')
const { createShareServer } = await import('../src/main/share/server')

const tmp = mkdtempSync(join(tmpdir(), 'diashow-sharenet-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '255.255.0.0', mac: '', cidr: null })

describe('public addresses', () => {
  it('tells public from private, loopback, link-local and reserved addresses', () => {
    for (const a of ['141.35.10.20', '134.96.1.2', '8.8.8.8', '100.64.0.7', '100.127.255.1']) expect([a, isPublicIPv4(a)]).toEqual([a, true])
    for (const a of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.10.1', '0.0.0.0', '224.0.0.1', '239.1.1.1', '255.255.255.255', '240.0.0.1', '192.0.2.5', '198.51.100.7', '203.0.113.9', '198.18.0.1', '300.1.1.1', 'fe80::1', '']) {
      expect([a, isPublicIPv4(a)]).toEqual([a, false])
    }
    expect(isPrivateIPv4('141.35.10.20')).toBe(false)
  })

  it('offers public addresses of real adapters after the private ones, marked', () => {
    const list = lanAddresses({
      WLAN: [v4('141.35.10.20')],
      Ethernet: [v4('192.168.0.5')],
      'Ethernet 2': [v4('134.96.1.2')],
      'vEthernet (Default Switch)': [v4('172.20.0.1')],
      Tailscale: [v4('100.101.1.2')],
      'OpenVPN TAP': [v4('85.1.2.3')],
      'LAN-Verbindung* 1': [v4('169.254.3.3')],
      Loopback: [v4('127.0.0.1', true)]
    })
    expect(list).toEqual([
      { name: 'Ethernet', address: '192.168.0.5', kind: 'ethernet' },
      { name: 'vEthernet (Default Switch)', address: '172.20.0.1', kind: 'virtual' },
      { name: 'WLAN', address: '141.35.10.20', kind: 'wifi', public: true },
      { name: 'Ethernet 2', address: '134.96.1.2', kind: 'ethernet', public: true }
    ])
  })

  it('finds an address on a network that only has public ones (eduroam)', () => {
    const list = lanAddresses({ 'WLAN': [v4('141.35.200.17'), { ...v4('2001:638::1'), family: 'IPv6' } as never], Loopback: [v4('127.0.0.1', true)] })
    expect(list).toEqual([{ name: 'WLAN', address: '141.35.200.17', kind: 'wifi', public: true }])
  })

  it('answers a wrong or non-ASCII token with 404, never with the pages', async () => {
    const server = createShareServer({ uploadDir: join(tmp, 'up'), projectName: 'Test' })
    await server.listen('127.0.0.1')
    const get = (path: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const r = httpRequest({ host: '127.0.0.1', port: server.port!, path, agent: false }, (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        })
        r.on('error', reject)
        r.end()
      })
    try {
      const token = server.uploadToken
      // same number of characters, more bytes: must not reach timingSafeEqual with unequal lengths
      const umlauts = encodeURIComponent('ä'.repeat(token.length))
      expect(await get(`/${umlauts}/`)).toBe(404)
      expect(await get(`/${token.slice(0, -1)}x/`)).toBe(404)
      expect(await get(`/${token}/`)).toBe(200)
    } finally {
      await server.close()
    }
  })
})
