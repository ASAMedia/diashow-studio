import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mediaUrl } from '@shared/api'

// app: the protocol's origin check asks security.ts whether the app runs from its sources
vi.mock('electron', () => ({ protocol: { handle: vi.fn() }, app: { isPackaged: false } }))
const { contentType, handleMediaRequest, parseRange } = await import('../src/main/protocol')

const dir = mkdtempSync(join(tmpdir(), 'diashow proto '))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const file = join(dir, 'Clip ä #1.mp4')
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
writeFileSync(file, bytes)

const get = (headers: Record<string, string> = {}, path = file): Promise<Response> =>
  handleMediaRequest(new Request(mediaUrl(path), { headers }))

describe('dsmedia protocol', () => {
  it('serves the whole file with 200', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('1000')
    expect(res.headers.get('access-control-expose-headers')).toContain('Content-Range')
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
  })

  it('serves byte ranges with 206', async () => {
    const res = await get({ Range: 'bytes=10-19' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 10-19/1000')
    expect(res.headers.get('content-length')).toBe('10')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])

    const open = await get({ Range: 'bytes=990-' })
    expect(open.headers.get('content-range')).toBe('bytes 990-999/1000')
    expect((await open.arrayBuffer()).byteLength).toBe(10)

    const suffix = await get({ Range: 'bytes=-5' })
    expect(suffix.headers.get('content-range')).toBe('bytes 995-999/1000')
  })

  it('answers 416 for unsatisfiable ranges and 404 for missing files', async () => {
    expect((await get({ Range: 'bytes=5000-' })).status).toBe(416)
    expect((await get({}, join(dir, 'nope.mp4'))).status).toBe(404)
  })

  it('maps extensions to content types', () => {
    expect(contentType('a.MOV')).toBe('video/quicktime')
    expect(contentType('a.jpg')).toBe('image/jpeg')
    expect(contentType('a.m4a')).toBe('audio/mp4')
    expect(contentType('a.opus')).toBe('audio/ogg')
    expect(parseRange('bytes=0-0', 10)).toEqual({ start: 0, end: 0 })
    expect(parseRange('items=1-2', 10)).toBeNull()
  })
})
