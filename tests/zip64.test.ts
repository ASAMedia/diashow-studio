// The streaming ZIP writer of "Diashow als ZIP archivieren" (src/main/archive/zip64.ts): stored and
// deflated entries, UTF-8 names, CRC-32, ZIP64 (forced on small data, more than 65 535 entries, and a
// virtual entry larger than 4 GB with an entry behind it), the reader and the check after writing.
// Archives are also read by independent readers: Windows' tar.exe (libarchive), Python's zipfile and
// .NET's Expand-Archive, each where installed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import {
  COUNT_LIMIT,
  crc32,
  crc32Table,
  dosDateTime,
  entryCrc,
  fileInput,
  fileSink,
  readCentralDirectory,
  verifyPlan,
  verifyZip,
  ZIP64_LIMIT,
  ZipWriter,
  type WrittenEntry,
  type ZipInput,
  type ZipSink,
  type ZipSource
} from '../src/main/archive/zip64'
import { hasPowerShell, hasTar, powershellExtract, PYTHON, pythonRead, tarCount, tarExtract, tarSafeName } from './helpers/zipTools'

const tmp = mkdtempSync(join(tmpdir(), 'diashow-zip64-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

/** An archive in memory. */
class MemorySink implements ZipSink {
  buf = Buffer.alloc(1024)
  size = 0
  async write(data: Uint8Array, position: number): Promise<void> {
    const end = position + data.length
    if (end > this.buf.length) {
      const next = Buffer.alloc(Math.max(end, this.buf.length * 2))
      this.buf.copy(next, 0, 0, this.size)
      this.buf = next
    }
    Buffer.from(data.buffer, data.byteOffset, data.length).copy(this.buf, position)
    this.size = Math.max(this.size, end)
  }
  bytes(): Buffer {
    return this.buf.subarray(0, this.size)
  }
  input(): ZipInput {
    const b = this.bytes()
    return {
      size: b.length,
      async read(out, pos) {
        const part = b.subarray(pos, pos + out.length)
        out.set(part)
        return part.length
      }
    }
  }
}

/** A source delivering `data` in pieces of at most `piece` bytes. */
const bufferSource = (data: Buffer, piece = 7): ZipSource => {
  let at = 0
  return {
    async read(buf) {
      const n = Math.min(buf.length, piece, data.length - at)
      data.copy(Buffer.from(buf.buffer, buf.byteOffset, buf.length), 0, at, at + n)
      at += n
      return n
    }
  }
}

const save = (name: string, data: Buffer): string => {
  const file = join(tmp, name)
  writeFileSync(file, data)
  return file
}

/** Checks a file with every independent reader there is: names, sizes, CRCs (Python), extracted files (tar.exe). */
function checkIndependently(file: string, expected: Map<string, Buffer>, label: string): void {
  if (PYTHON) {
    const py = pythonRead(file)
    expect(py.bad, `${label}: python testzip`).toBeNull()
    expect(py.names, `${label}: python names`).toEqual([...expected.keys()])
    expect(py.sizes, `${label}: python sizes`).toEqual([...expected.values()].map((b) => b.length))
  }
  if (hasTar) {
    const files = tarExtract(file, join(tmp, `${label}-tar`), [...expected.keys()])
    const safe = [...expected].filter(([k]) => tarSafeName(k))
    expect(new Map([...files].sort()), `${label}: tar.exe`).toEqual(new Map(safe.map(([k, v]) => [k, v.length] as [string, number]).sort()))
  }
}

describe('CRC-32', () => {
  it('matches the standard check value, zlib and itself in pieces', () => {
    const check = Buffer.from('123456789')
    expect(crc32Table(check)).toBe(0xcbf43926)
    expect(crc32(check)).toBe(0xcbf43926)
    const data = Buffer.alloc(300_000)
    for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 24
    const whole = crc32Table(data)
    expect(crc32(data)).toBe(whole)
    if (typeof zlib.crc32 === 'function') expect(zlib.crc32(data) >>> 0).toBe(whole)
    // continued over pieces of odd sizes
    let c = 0
    let t = 0
    for (let p = 0; p < data.length; p += 12_345) {
      c = crc32(data.subarray(p, p + 12_345), c)
      t = crc32Table(data.subarray(p, p + 12_345), t)
    }
    expect(c).toBe(whole)
    expect(t).toBe(whole)
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })
})

describe('DOS times', () => {
  it('clamps to 1980–2107 and keeps 2-second steps', () => {
    expect(dosDateTime(new Date(1975, 0, 1).getTime())).toEqual({ time: 0, date: (1 << 5) | 1 })
    const d = dosDateTime(new Date(2026, 9, 12, 14, 30, 59).getTime())
    expect(d.date).toBe(((2026 - 1980) << 9) | (10 << 5) | 12)
    expect(d.time).toBe((14 << 11) | (30 << 5) | 29)
    expect(dosDateTime(new Date(2200, 0, 1).getTime()).date >> 9).toBe(127)
  })
})

describe('writing and reading', () => {
  const text = Buffer.from('Klassenfahrt nach Berlin – Grüße aus der Jugendherberge!\r\n'.repeat(200), 'utf8')
  const photo = Buffer.alloc(150_000)
  for (let i = 0; i < photo.length; i++) photo[i] = (i * 7919 + (i >> 8)) & 0xff
  const entries = new Map<string, Buffer>([
    ['LIESMICH.txt', text],
    ['media/Tag 1 – Ankunft/IMG_0001.JPG', photo],
    ['media/Größe Übung ß.jpg', photo.subarray(0, 1000)],
    ['media/Ästhetik 日本 🎒.png', Buffer.from('tiny')],
    ['music/leer.mp3', Buffer.alloc(0)],
    ['Klassenfahrt.dshow', Buffer.from(JSON.stringify({ name: 'Klassenfahrt Größe', entries: Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, type: 'photo' })) }), 'utf8')]
  ])

  async function build(force: boolean): Promise<{ sink: MemorySink; bytes: number; written: WrittenEntry[] }> {
    const sink = new MemorySink()
    let bytes = 0
    const zip = new ZipWriter(sink, { forceZip64: force, onBytes: (n) => (bytes += n) })
    for (const [name, data] of entries) {
      if (name.endsWith('.txt') || name.endsWith('.dshow')) await zip.addBuffer(name, data, { deflate: true, mtime: new Date(2026, 9, 12, 10, 0).getTime() })
      else await zip.addStream(name, bufferSource(data, 4093), data.length, { mtime: new Date(2025, 5, 1).getTime() })
    }
    const summary = await zip.close()
    expect(summary.zip64).toBe(force)
    expect(summary.size).toBe(sink.size)
    return { sink, bytes, written: summary.entries }
  }

  for (const force of [false, true]) {
    it(`stores media, deflates text, keeps UTF-8 names${force ? ' (ZIP64 forced everywhere)' : ''}`, async () => {
      const { sink, bytes, written } = await build(force)
      expect(bytes).toBe([...entries.values()].reduce((n, b) => n + b.length, 0))
      const input = sink.input()
      const dir = await readCentralDirectory(input)
      expect(dir.zip64).toBe(force)
      expect(dir.entries.map((e) => e.name)).toEqual([...entries.keys()])
      for (const e of dir.entries) {
        const data = entries.get(e.name)!
        expect(e.flags & 0x0800).toBe(0x0800)
        expect(e.size).toBe(data.length)
        expect(e.crc).toBe(crc32(data))
        // text deflated (smaller), media stored
        expect(e.method).toBe(e.name.endsWith('.txt') || e.name.endsWith('.dshow') ? 8 : 0)
        if (e.method === 8) expect(e.compressedSize).toBeLessThan(data.length)
        if (force) expect(e.versionNeeded).toBe(45)
        expect(await entryCrc(input, e)).toEqual({ crc: e.crc, size: data.length })
      }
      // the classic end record says "see ZIP64" when forced
      const b = sink.bytes()
      const end = b.subarray(b.length - 22)
      expect(end.readUInt32LE(0)).toBe(0x06054b50)
      expect(end.readUInt16LE(10)).toBe(force ? COUNT_LIMIT : entries.size)
      expect(end.readUInt32LE(16)).toBe(force ? ZIP64_LIMIT : dir.cdOffset)
      const check = await verifyZip(input, written)
      expect(check).toMatchObject({ entries: entries.size, checked: entries.size, zip64: force })

      const file = save(`basic-${force ? 'zip64' : 'classic'}.zip`, b)
      checkIndependently(file, entries, force ? 'forced' : 'classic')
      if (hasPowerShell && force) {
        const files = powershellExtract(file, join(tmp, 'forced-ps'))
        expect(new Map([...files].sort())).toEqual(new Map([...entries].map(([k, v]) => [k, v.length] as [string, number]).sort()))
      }
    })
  }

  it('reads back through a file and finds damage', async () => {
    const { sink, written } = await build(false)
    const file = save('damaged.zip', Buffer.from(sink.bytes()))
    const fh = await open(file, 'r+')
    try {
      const input = fileInput(fh, sink.size)
      const dir = await readCentralDirectory(input)
      const photoEntry = dir.entries.find((e) => e.name.endsWith('IMG_0001.JPG'))!
      // one byte of the stored photo flipped
      const at = photoEntry.offset + 30 + Buffer.byteLength(photoEntry.name) + 5000
      const one = Buffer.alloc(1)
      await fh.read(one, 0, 1, at)
      one[0] ^= 0xff
      await fh.write(one, 0, 1, at)
      const r = await entryCrc(input, photoEntry)
      expect(r.crc).not.toBe(photoEntry.crc)
      await expect(verifyZip(input, written)).rejects.toThrow(/IMG_0001.*CRC/)
      // a cut-off archive has no end record
      await expect(readCentralDirectory({ size: sink.size - 30, read: input.read })).rejects.toThrow(/end record|not a zip/)
    } finally {
      await fh.close()
    }
  })
})

describe('checks while writing', () => {
  it('refuses bad and duplicate names (also by case), a source of another size, and stops when cancelled', async () => {
    const zip = new ZipWriter(new MemorySink())
    for (const bad of ['', '/abs.jpg', '../escape.jpg', 'media/../../x.jpg', 'C:/x.jpg', 'media//x.jpg', 'a/./b']) {
      await expect(zip.addBuffer(bad, Buffer.from('x'))).rejects.toThrow(/invalid zip entry name/)
    }
    await zip.addBuffer('media/IMG_0001.JPG', Buffer.from('x'))
    await expect(zip.addBuffer('MEDIA/img_0001.jpg', Buffer.from('y'))).rejects.toThrow(/duplicate/)
    await expect(zip.addStream('grew.jpg', bufferSource(Buffer.alloc(100)), 50)).rejects.toThrow(/grew/)
    await expect(zip.addStream('shrank.jpg', bufferSource(Buffer.alloc(10)), 50)).rejects.toThrow(/shrank/)
    // a backslash is a folder separator
    const e = await zip.addBuffer('music\\Song.mp3', Buffer.from('z'))
    expect(e.name).toBe('music/Song.mp3')

    const ctrl = new AbortController()
    const stopping = new ZipWriter(new MemorySink(), { signal: ctrl.signal, onBytes: () => ctrl.abort() })
    await expect(stopping.addStream('big.mp4', bufferSource(Buffer.alloc(10_000), 1000), 10_000)).rejects.toThrow(/cancelled/)
  })
})

describe('ZIP64', () => {
  it('more than 65 535 entries: ZIP64 end records, read by other tools', async () => {
    const sink = new MemorySink()
    const zip = new ZipWriter(sink)
    const n = COUNT_LIMIT + 1000
    for (let i = 0; i < n; i++) await zip.addBuffer(`media/${String(i).padStart(6, '0')}.txt`, Buffer.from(`#${i}`))
    const summary = await zip.close()
    expect(summary.zip64).toBe(true)
    const b = sink.bytes()
    expect(b.readUInt16LE(b.length - 22 + 10)).toBe(COUNT_LIMIT)
    const dir = await readCentralDirectory(sink.input())
    expect(dir.entries).toHaveLength(n)
    expect(dir.entries[n - 1].name).toBe(`media/${String(n - 1).padStart(6, '0')}.txt`)
    const check = await verifyZip(sink.input(), summary.entries)
    expect(check.checked).toBe(n)
    const file = save('many.zip', b)
    if (PYTHON) {
      const py = pythonRead(file)
      expect(py.bad).toBeNull()
      expect(py.names).toHaveLength(n)
      expect(py.names[n - 1]).toBe(`media/${String(n - 1).padStart(6, '0')}.txt`)
    }
    if (hasTar) expect(tarCount(file)).toBe(n)
  }, 300_000)

  it('an entry larger than 4 GB and one behind it (streamed, never stored)', async () => {
    // a sink that keeps headers only: the big entry's data are zeros and read back as zeros
    const kept = new Map<number, Buffer>()
    let size = 0
    const sink: ZipSink = {
      async write(data, position) {
        if (data.length <= 64 * 1024) kept.set(position, Buffer.from(data))
        size = Math.max(size, position + data.length)
      }
    }
    const input: ZipInput = {
      get size() {
        return size
      },
      async read(buf, position) {
        const n = Math.max(0, Math.min(buf.length, size - position))
        const out = Buffer.from(buf.buffer, buf.byteOffset, n).fill(0)
        for (const [p, data] of kept) {
          const from = Math.max(p, position)
          const to = Math.min(p + data.length, position + n)
          if (from < to) data.copy(out, from - position, from - p, to - p)
        }
        return n
      }
    }
    const big = 2 ** 32 + 2 ** 20
    let left = big
    const zeros: ZipSource = {
      async read(buf) {
        const n = Math.min(buf.length, left)
        buf.fill(0, 0, n)
        left -= n
        return n
      }
    }
    const zip = new ZipWriter(sink)
    await zip.addBuffer('LIESMICH.txt', Buffer.from('vorne'), { deflate: true })
    const e = await zip.addStream('videos/Abschlussfilm 4K.mp4', zeros, big)
    const after = await zip.addBuffer('Klassenfahrt.dshow', Buffer.from('{"name":"hinten"}'), { deflate: true })
    const summary = await zip.close()
    expect(e.zip64Local).toBe(true)
    expect(e.size).toBe(big)
    expect(after.offset).toBeGreaterThan(ZIP64_LIMIT)
    expect(summary.zip64).toBe(true)

    const dir = await readCentralDirectory(input)
    expect(dir.zip64).toBe(true)
    expect(dir.cdOffset).toBeGreaterThan(ZIP64_LIMIT)
    const [first, video, last] = dir.entries
    expect(first).toMatchObject({ name: 'LIESMICH.txt', offset: 0 })
    expect(video).toMatchObject({ name: 'videos/Abschlussfilm 4K.mp4', size: big, compressedSize: big, method: 0, versionNeeded: 45 })
    expect(last).toMatchObject({ name: 'Klassenfahrt.dshow', offset: after.offset, versionNeeded: 45 })
    // the big entry's local header: sizes "see ZIP64", the ZIP64 field holds both
    const lh = kept.get(video.offset)!
    expect(lh.readUInt32LE(18)).toBe(ZIP64_LIMIT)
    expect(lh.readUInt32LE(22)).toBe(ZIP64_LIMIT)
    const extra = lh.subarray(30 + lh.readUInt16LE(26))
    expect(extra.readUInt16LE(0)).toBe(1)
    expect(Number(extra.readBigUInt64LE(4))).toBe(big)
    expect(Number(extra.readBigUInt64LE(12))).toBe(big)
    // the CRC of 4 GB of zeros, and the check after writing (sampled, then everything)
    expect(video.crc).toBe(crcOfZeros(big))
    const sampled = await verifyZip(input, summary.entries, { checkAllUpTo: 1024, sampleBytes: 1024 })
    expect(sampled.checked).toBe(2)
    const full = await verifyZip(input, summary.entries, { checkAllUpTo: Infinity })
    expect(full).toMatchObject({ entries: 3, checked: 3, zip64: true })
  }, 300_000)
})

/** CRC-32 of `n` zero bytes. */
function crcOfZeros(n: number): number {
  const chunk = Buffer.alloc(8 * 1024 * 1024)
  let c = 0
  for (let left = n; left > 0; left -= chunk.length) c = crc32(chunk.subarray(0, Math.min(chunk.length, left)), c)
  return c
}

describe('the check after writing', () => {
  it('reads all of a small archive and a spread sample of a large one', () => {
    const entries = [
      { compressedSize: 100, method: 8 },
      ...Array.from({ length: 40 }, () => ({ compressedSize: 1000, method: 0 })),
      { compressedSize: 50, method: 8 }
    ]
    expect(verifyPlan(entries)).toHaveLength(42)
    const sample = verifyPlan(entries, { checkAllUpTo: 10_000, sampleBytes: 5150 })
    // both deflated entries, then stored ones spread out: first, last, middle …
    expect(sample).toContain(0)
    expect(sample).toContain(41)
    expect(sample).toContain(1)
    expect(sample).toContain(40)
    expect(sample.length).toBe(2 + 5)
    expect(sample).toEqual([...sample].sort((a, b) => a - b))
  })
})

describe('big archive on disk (DIASHOW_ZIP_BIG=1)', () => {
  it.runIf(!!process.env.DIASHOW_ZIP_BIG)('writes a real archive larger than 4 GB that other tools read', async () => {
    const file = join(tmp, 'big.zip')
    const fh = await open(file, 'w+')
    const big = 2 ** 32 + 2 ** 24
    let left = big
    let seed = 1
    const noise = Buffer.alloc(4 * 1024 * 1024)
    for (let i = 0; i < noise.length; i++) noise[i] = (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24
    const source: ZipSource = {
      async read(buf) {
        const n = Math.min(buf.length, left)
        for (let p = 0; p < n; p += noise.length) noise.copy(buf, p, 0, Math.min(noise.length, n - p))
        left -= n
        return n
      }
    }
    try {
      const t0 = Date.now()
      const zip = new ZipWriter(fileSink(fh))
      await zip.addBuffer('LIESMICH.txt', Buffer.from('Grüße'), { deflate: true })
      await zip.addStream('videos/groß.mp4', source, big)
      await zip.addBuffer('nach 4 GB.txt', Buffer.from('hinten'), { deflate: true })
      const summary = await zip.close()
      console.log(`wrote ${summary.size} bytes in ${(Date.now() - t0) / 1000} s`)
      const check = await verifyZip(fileInput(fh, summary.size), summary.entries, { checkAllUpTo: Infinity })
      expect(check).toMatchObject({ entries: 3, checked: 3, zip64: true })
      await fh.close()
      if (PYTHON) {
        const py = pythonRead(file)
        expect(py.bad).toBeNull()
        expect(py.names).toEqual(['LIESMICH.txt', 'videos/groß.mp4', 'nach 4 GB.txt'])
        expect(py.sizes[1]).toBe(big)
      }
      if (hasTar) expect(tarCount(file)).toBe(3)
    } finally {
      await fh.close().catch(() => {})
      rmSync(file, { force: true })
    }
  }, 900_000)
})
