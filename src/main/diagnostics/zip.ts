// A small ZIP writer for the diagnostics package: a few text files, deflated, built in memory.
// Names are UTF-8 (flag bit 11), times in DOS format. No ZIP64: the package stays far below 4 GB.
import { deflateRawSync, inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** Path inside the archive, forward slashes. */
  name: string
  data: Buffer | string
  /** Modification time, ms since epoch (default now). */
  mtime?: number
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms)
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

export function buildZip(entries: ZipEntry[], now = Date.now()): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const seen = new Set<string>()
  for (const e of entries) {
    const name = e.name.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!name || name.split('/').includes('..') || seen.has(name.toLowerCase())) throw new Error(`invalid zip entry name: ${e.name}`)
    seen.add(name.toLowerCase())
    const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data
    const packed = deflateRawSync(data, { level: 9 })
    const stored = packed.length >= data.length
    const body = stored ? data : packed
    const crc = crc32(data)
    const nameBuf = Buffer.from(name, 'utf8')
    const { time, date } = dosTime(e.mtime ?? now)
    const method = stored ? 0 : 8
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, body)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + body.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/** Reads back a ZIP written by buildZip (tests, and the check after saving). */
export function readZip(buf: Buffer): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = []
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (endAt < 0) throw new Error('not a zip file')
  const count = buf.readUInt16LE(endAt + 10)
  let p = buf.readUInt32LE(endAt + 16)
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('broken central directory')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const body = buf.subarray(start, start + csize)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    if (crc32(data) !== crc) throw new Error(`crc mismatch: ${name}`)
    out.push({ name, data })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}
