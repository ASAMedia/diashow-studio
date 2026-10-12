// Streaming ZIP writer and reader for "Diashow als ZIP archivieren" (archive.ts). Entries go to the
// file one after another and are never held in memory as a whole; a local header is written before
// its data and patched with the CRC afterwards (no data descriptors, so every reader finds the sizes
// in both headers). ZIP64 records are written wherever a size, an offset or the number of entries
// outgrows the classic 32/16-bit fields: archives of many GB, more than 65 535 entries. Media are
// stored (method 0: photos and videos are compressed already, and storing is as fast as copying),
// text and the project are deflated. Names are UTF-8 (flag bit 11). The reader re-reads the central
// directory, the local headers and the data's CRC after writing (verifyZip). Electron-free.
import type { FileHandle } from 'node:fs/promises'
import { promisify } from 'node:util'
import * as zlib from 'node:zlib'
import { abortError } from '../abort'

const deflateRaw = promisify(zlib.deflateRaw)

/** Sizes and offsets from this value on need ZIP64 (the value itself marks "see the ZIP64 record"). */
export const ZIP64_LIMIT = 0xffffffff
/** The same for the number of entries in the end record. */
export const COUNT_LIMIT = 0xffff

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const END_SIG = 0x06054b50
const END64_SIG = 0x06064b50
const LOCATOR64_SIG = 0x07064b50
const ZIP64_EXTRA = 0x0001
const UTF8_FLAG = 0x0800
/** Version needed to extract: 2.0 (deflate), 4.5 (ZIP64). Made by: MS-DOS / FAT attributes. */
const V20 = 20
const V45 = 45
/** "Archive" attribute, like Windows sets on new files. */
const DOS_ARCHIVE = 0x20

const CHUNK = 1024 * 1024

// ---------------------------------------------------------------- CRC-32

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (ZIP, IEEE) with a table; `crc` continues an earlier result. */
export function crc32Table(data: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const nativeCrc = typeof zlib.crc32 === 'function' ? zlib.crc32 : null

/** CRC-32 of `data`, continuing `crc`: zlib's (Node 22.2+, many GB/s) or the table. */
export function crc32(data: Uint8Array, crc = 0): number {
  return nativeCrc ? nativeCrc(data, crc) >>> 0 : crc32Table(data, crc)
}

// ---------------------------------------------------------------- times

/** MS-DOS time and date of a local time (2 s steps, 1980–2107). */
export function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now())
  const year = d.getFullYear()
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 }
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

// ---------------------------------------------------------------- writing

/** Where the archive goes: positional writes (the writer patches each local header after its data). */
export interface ZipSink {
  write(data: Uint8Array, position: number): Promise<void>
}

/** Data of one entry, read from the start: resolves with the bytes read into `buf`, 0 at the end. */
export interface ZipSource {
  read(buf: Uint8Array): Promise<number>
}

/** An entry as written: what its central directory record says. */
export interface WrittenEntry {
  name: string
  method: 0 | 8
  crc: number
  /** Bytes of data in the archive (compressed). */
  compressedSize: number
  size: number
  /** Where its local header starts. */
  offset: number
  time: number
  date: number
  /** The local header carries a ZIP64 extra field with the sizes. */
  zip64Local: boolean
}

export interface ZipWriterOptions {
  /**
   * ZIP64 records everywhere, also for small data, with the classic fields set to "see ZIP64": for
   * tests, so independent readers must read every ZIP64 structure.
   */
  forceZip64?: boolean
  signal?: AbortSignal
  /** Entry data written (stored bytes or deflated input), as it goes. */
  onBytes?: (n: number) => void
}

export interface ZipSummary {
  entries: WrittenEntry[]
  /** Bytes of the whole archive. */
  size: number
  /** ZIP64 end records were written. */
  zip64: boolean
}

/** A sink writing to an open file. */
export function fileSink(fh: FileHandle): ZipSink {
  return {
    async write(data, position) {
      let done = 0
      while (done < data.length) {
        const { bytesWritten } = await fh.write(data, done, data.length - done, position + done)
        if (bytesWritten <= 0) throw new Error('ENOSPC: nothing could be written')
        done += bytesWritten
      }
    }
  }
}

/** A source reading a file from its current position. */
export function fileSource(fh: FileHandle): ZipSource {
  return { read: async (buf) => (await fh.read(buf, 0, buf.length, null)).bytesRead }
}

/** An entry name: forward slashes, no leading slash, no "." or ".." parts, no drive. */
export function checkEntryName(name: string): string {
  const n = String(name ?? '').replace(/\\/g, '/')
  const parts = n.split('/')
  if (!n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.includes('\0') || parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`invalid zip entry name: ${name}`)
  if (Buffer.byteLength(n, 'utf8') > COUNT_LIMIT) throw new Error(`zip entry name too long: ${n.slice(0, 80)}…`)
  return n
}

function zip64Extra(values: number[]): Buffer {
  const b = Buffer.alloc(4 + values.length * 8)
  b.writeUInt16LE(ZIP64_EXTRA, 0)
  b.writeUInt16LE(values.length * 8, 2)
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + i * 8))
  return b
}

function localHeader(e: WrittenEntry, nameBuf: Buffer): Buffer {
  const extra = e.zip64Local ? zip64Extra([e.size, e.compressedSize]) : Buffer.alloc(0)
  const h = Buffer.alloc(30)
  h.writeUInt32LE(LOCAL_SIG, 0)
  h.writeUInt16LE(e.zip64Local ? V45 : V20, 4)
  h.writeUInt16LE(UTF8_FLAG, 6)
  h.writeUInt16LE(e.method, 8)
  h.writeUInt16LE(e.time, 10)
  h.writeUInt16LE(e.date, 12)
  h.writeUInt32LE(e.crc, 14)
  h.writeUInt32LE(e.zip64Local ? ZIP64_LIMIT : e.compressedSize, 18)
  h.writeUInt32LE(e.zip64Local ? ZIP64_LIMIT : e.size, 22)
  h.writeUInt16LE(nameBuf.length, 26)
  h.writeUInt16LE(extra.length, 28)
  return Buffer.concat([h, nameBuf, extra])
}

function centralHeader(e: WrittenEntry, force: boolean): Buffer {
  const nameBuf = Buffer.from(e.name, 'utf8')
  // like most writers: both sizes go to the ZIP64 field together when either needs it
  const bigSizes = force || e.size >= ZIP64_LIMIT || e.compressedSize >= ZIP64_LIMIT
  const bigOffset = force || e.offset >= ZIP64_LIMIT
  const values = [...(bigSizes ? [e.size, e.compressedSize] : []), ...(bigOffset ? [e.offset] : [])]
  const extra = values.length ? zip64Extra(values) : Buffer.alloc(0)
  const version = values.length || e.zip64Local ? V45 : V20
  const h = Buffer.alloc(46)
  h.writeUInt32LE(CENTRAL_SIG, 0)
  h.writeUInt16LE(V45, 4)
  h.writeUInt16LE(version, 6)
  h.writeUInt16LE(UTF8_FLAG, 8)
  h.writeUInt16LE(e.method, 10)
  h.writeUInt16LE(e.time, 12)
  h.writeUInt16LE(e.date, 14)
  h.writeUInt32LE(e.crc, 16)
  h.writeUInt32LE(bigSizes ? ZIP64_LIMIT : e.compressedSize, 20)
  h.writeUInt32LE(bigSizes ? ZIP64_LIMIT : e.size, 24)
  h.writeUInt16LE(nameBuf.length, 28)
  h.writeUInt16LE(extra.length, 30)
  h.writeUInt16LE(0, 32)
  h.writeUInt16LE(0, 34)
  h.writeUInt16LE(0, 36)
  h.writeUInt32LE(DOS_ARCHIVE, 38)
  h.writeUInt32LE(bigOffset ? ZIP64_LIMIT : e.offset, 42)
  return Buffer.concat([h, nameBuf, extra])
}

/**
 * Writes a ZIP archive entry by entry to a sink. Names must be unique (case-insensitive, as Windows
 * extracts them). Call close() once at the end; until then the archive is incomplete.
 */
export class ZipWriter {
  private offset = 0
  private readonly written: WrittenEntry[] = []
  private readonly names = new Set<string>()
  private state: 'open' | 'busy' | 'closed' = 'open'

  constructor(
    private readonly sink: ZipSink,
    private readonly opts: ZipWriterOptions = {}
  ) {}

  /** Bytes written so far. */
  get position(): number {
    return this.offset
  }

  get entries(): readonly WrittenEntry[] {
    return this.written
  }

  private begin(name: string): string {
    if (this.state !== 'open') throw new Error(this.state === 'busy' ? 'the zip writer is busy with another entry' : 'the zip archive is closed')
    const n = checkEntryName(name)
    if (this.names.has(n.toLowerCase())) throw new Error(`duplicate zip entry: ${n}`)
    this.names.add(n.toLowerCase())
    this.state = 'busy'
    return n
  }

  private checkAbort(): void {
    if (this.opts.signal?.aborted) throw abortError()
  }

  /** A whole entry from memory: deflated (when that makes it smaller) or stored. */
  async addBuffer(name: string, data: Uint8Array, o: { deflate?: boolean; mtime?: number } = {}): Promise<WrittenEntry> {
    const n = this.begin(name)
    try {
      this.checkAbort()
      const packed = o.deflate ? await deflateRaw(data, { level: 9 }) : null
      const body = packed && packed.length < data.length ? packed : data
      const e: WrittenEntry = {
        name: n,
        method: body === data ? 0 : 8,
        crc: crc32(data),
        compressedSize: body.length,
        size: data.length,
        offset: this.offset,
        ...dosDateTime(o.mtime ?? Date.now()),
        zip64Local: !!this.opts.forceZip64 || data.length >= ZIP64_LIMIT
      }
      const head = localHeader(e, Buffer.from(n, 'utf8'))
      await this.sink.write(Buffer.concat([head, body]), this.offset)
      this.offset += head.length + body.length
      this.opts.onBytes?.(data.length)
      this.written.push(e)
      return e
    } finally {
      this.state = 'open'
    }
  }

  /**
   * A stored entry streamed from `source`, which must deliver exactly `size` bytes (the size of the
   * file when it was planned; a file that changed meanwhile is an error, the archive can't be trusted).
   */
  async addStream(name: string, source: ZipSource, size: number, o: { mtime?: number } = {}): Promise<WrittenEntry> {
    const n = this.begin(name)
    try {
      if (!(Number.isSafeInteger(size) && size >= 0)) throw new Error(`invalid size for ${n}`)
      this.checkAbort()
      const nameBuf = Buffer.from(n, 'utf8')
      const e: WrittenEntry = {
        name: n,
        method: 0,
        crc: 0,
        compressedSize: size,
        size,
        offset: this.offset,
        ...dosDateTime(o.mtime ?? Date.now()),
        zip64Local: !!this.opts.forceZip64 || size >= ZIP64_LIMIT
      }
      // the header goes first (the file stays sequential) and gets its CRC once the data is through
      const head = localHeader(e, nameBuf)
      await this.sink.write(head, e.offset)
      let pos = e.offset + head.length
      let crc = 0
      let total = 0
      let cur = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, size)))
      let next = Buffer.allocUnsafe(cur.length)
      let got = await source.read(cur)
      while (got > 0) {
        this.checkAbort()
        total += got
        if (total > size) throw new Error(`${n}: the file grew while it was archived`)
        const data = cur.subarray(0, got)
        crc = crc32(data, crc)
        // the next part is read while this one is written
        const [, more] = await Promise.all([this.sink.write(data, pos), source.read(next)])
        pos += got
        this.opts.onBytes?.(got)
        ;[cur, next] = [next, cur]
        got = more
      }
      if (total !== size) throw new Error(`${n}: the file shrank while it was archived`)
      e.crc = crc
      await this.sink.write(localHeader(e, nameBuf), e.offset)
      this.offset = pos
      this.written.push(e)
      return e
    } finally {
      this.state = 'open'
    }
  }

  /** Writes the central directory and the end records (ZIP64 when needed). */
  async close(): Promise<ZipSummary> {
    if (this.state !== 'open') throw new Error('the zip archive is closed or busy')
    this.state = 'closed'
    const force = !!this.opts.forceZip64
    const cdStart = this.offset
    let pos = cdStart
    let batch: Buffer[] = []
    let batchBytes = 0
    const flush = async (): Promise<void> => {
      if (!batch.length) return
      const buf = Buffer.concat(batch)
      batch = []
      batchBytes = 0
      await this.sink.write(buf, pos)
      pos += buf.length
    }
    for (const e of this.written) {
      const h = centralHeader(e, force)
      batch.push(h)
      batchBytes += h.length
      if (batchBytes >= 4 * CHUNK) await flush()
    }
    await flush()
    const cdSize = pos - cdStart
    const count = this.written.length
    const zip64 = force || count >= COUNT_LIMIT || cdSize >= ZIP64_LIMIT || cdStart >= ZIP64_LIMIT
    const tail: Buffer[] = []
    if (zip64) {
      const rec = Buffer.alloc(56)
      rec.writeUInt32LE(END64_SIG, 0)
      rec.writeBigUInt64LE(44n, 4)
      rec.writeUInt16LE(V45, 12)
      rec.writeUInt16LE(V45, 14)
      rec.writeUInt32LE(0, 16)
      rec.writeUInt32LE(0, 20)
      rec.writeBigUInt64LE(BigInt(count), 24)
      rec.writeBigUInt64LE(BigInt(count), 32)
      rec.writeBigUInt64LE(BigInt(cdSize), 40)
      rec.writeBigUInt64LE(BigInt(cdStart), 48)
      const loc = Buffer.alloc(20)
      loc.writeUInt32LE(LOCATOR64_SIG, 0)
      loc.writeUInt32LE(0, 4)
      loc.writeBigUInt64LE(BigInt(pos), 8)
      loc.writeUInt32LE(1, 16)
      tail.push(rec, loc)
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END_SIG, 0)
    end.writeUInt16LE(force ? COUNT_LIMIT : Math.min(count, COUNT_LIMIT), 8)
    end.writeUInt16LE(force ? COUNT_LIMIT : Math.min(count, COUNT_LIMIT), 10)
    end.writeUInt32LE(force ? ZIP64_LIMIT : Math.min(cdSize, ZIP64_LIMIT), 12)
    end.writeUInt32LE(force ? ZIP64_LIMIT : Math.min(cdStart, ZIP64_LIMIT), 16)
    end.writeUInt16LE(0, 20)
    tail.push(end)
    const buf = Buffer.concat(tail)
    await this.sink.write(buf, pos)
    pos += buf.length
    this.offset = pos
    return { entries: this.written.slice(), size: pos, zip64 }
  }
}

// ---------------------------------------------------------------- reading

/** Random access to an archive. */
export interface ZipInput {
  size: number
  /** Reads up to buf.length bytes at `position`; resolves with the bytes read. */
  read(buf: Uint8Array, position: number): Promise<number>
}

export function fileInput(fh: FileHandle, size: number): ZipInput {
  return { size, read: async (buf, position) => (await fh.read(buf, 0, buf.length, position)).bytesRead }
}

/** One record of the central directory. */
export interface CentralEntry {
  name: string
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  offset: number
  time: number
  date: number
  versionNeeded: number
}

export interface CentralDirectory {
  entries: CentralEntry[]
  /** The archive has ZIP64 end records. */
  zip64: boolean
  cdOffset: number
  cdSize: number
}

async function readAt(input: ZipInput, position: number, length: number): Promise<Buffer> {
  if (position < 0 || length < 0 || position + length > input.size) throw new Error('broken zip: a record points outside the file')
  const buf = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const n = await input.read(buf.subarray(done), position + done)
    if (n <= 0) throw new Error('broken zip: unexpected end of file')
    done += n
  }
  return buf
}

const u64 = (b: Buffer, at: number): number => {
  const v = b.readBigUInt64LE(at)
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('broken zip: a ZIP64 value is out of range')
  return Number(v)
}

/** The ZIP64 values of an extra block for the fields marked 0xFFFF…, in the fixed order. */
function readZip64Extra(extra: Buffer, want: { size: boolean; compressed: boolean; offset: boolean }): { size?: number; compressed?: number; offset?: number } {
  for (let p = 0; p + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(p)
    const len = extra.readUInt16LE(p + 2)
    if (p + 4 + len > extra.length) break
    if (id === ZIP64_EXTRA) {
      const out: { size?: number; compressed?: number; offset?: number } = {}
      let q = p + 4
      const end = p + 4 + len
      for (const key of ['size', 'compressed', 'offset'] as const) {
        if (!want[key]) continue
        if (q + 8 > end) throw new Error('broken zip: ZIP64 field too short')
        out[key] = u64(extra, q)
        q += 8
      }
      return out
    }
    p += 4 + len
  }
  if (want.size || want.compressed || want.offset) throw new Error('broken zip: ZIP64 field missing')
  return {}
}

/** Reads the end records and the central directory (with ZIP64). */
export async function readCentralDirectory(input: ZipInput): Promise<CentralDirectory> {
  const tailLen = Math.min(input.size, 22 + COUNT_LIMIT)
  const tail = await readAt(input, input.size - tailLen, tailLen)
  let at = -1
  for (let p = tail.length - 22; p >= 0; p--) {
    if (tail.readUInt32LE(p) === END_SIG && p + 22 + tail.readUInt16LE(p + 20) === tail.length) {
      at = p
      break
    }
  }
  if (at < 0) throw new Error('not a zip file (no end record)')
  const endPos = input.size - tailLen + at
  let count = tail.readUInt16LE(at + 10)
  let cdSize = tail.readUInt32LE(at + 12)
  let cdOffset = tail.readUInt32LE(at + 16)
  let zip64 = false
  if (endPos >= 20) {
    const loc = await readAt(input, endPos - 20, 20)
    if (loc.readUInt32LE(0) === LOCATOR64_SIG) {
      const recPos = u64(loc, 8)
      const rec = await readAt(input, recPos, 56)
      if (rec.readUInt32LE(0) !== END64_SIG) throw new Error('broken zip: ZIP64 end record missing')
      zip64 = true
      count = u64(rec, 32)
      cdSize = u64(rec, 40)
      cdOffset = u64(rec, 48)
    }
  }
  if (cdSize > 512 * 1024 * 1024) throw new Error('zip central directory too large')
  const cd = await readAt(input, cdOffset, cdSize)
  const entries: CentralEntry[] = []
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIG) throw new Error(`broken zip: central directory record ${i + 1} is damaged`)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new Error('broken zip: central directory is cut off')
    const flags = cd.readUInt16LE(p + 8)
    const rawName = cd.subarray(p + 46, p + 46 + nameLen)
    const compressed32 = cd.readUInt32LE(p + 20)
    const size32 = cd.readUInt32LE(p + 24)
    const offset32 = cd.readUInt32LE(p + 42)
    const big = readZip64Extra(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), {
      size: size32 === ZIP64_LIMIT,
      compressed: compressed32 === ZIP64_LIMIT,
      offset: offset32 === ZIP64_LIMIT
    })
    entries.push({
      name: flags & UTF8_FLAG ? rawName.toString('utf8') : rawName.toString('latin1'),
      flags,
      method: cd.readUInt16LE(p + 10),
      time: cd.readUInt16LE(p + 12),
      date: cd.readUInt16LE(p + 14),
      crc: cd.readUInt32LE(p + 16),
      compressedSize: big.compressed ?? compressed32,
      size: big.size ?? size32,
      offset: big.offset ?? offset32,
      versionNeeded: cd.readUInt16LE(p + 6)
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return { entries, zip64, cdOffset, cdSize }
}

/** Where an entry's data starts, after checking its local header against the central record. */
export async function entryDataOffset(input: ZipInput, e: CentralEntry): Promise<number> {
  const h = await readAt(input, e.offset, 30)
  if (h.readUInt32LE(0) !== LOCAL_SIG) throw new Error(`broken zip: local header of ${e.name} missing`)
  const nameLen = h.readUInt16LE(26)
  const extraLen = h.readUInt16LE(28)
  const rest = await readAt(input, e.offset + 30, nameLen + extraLen)
  const flags = h.readUInt16LE(6)
  const name = flags & UTF8_FLAG ? rest.subarray(0, nameLen).toString('utf8') : rest.subarray(0, nameLen).toString('latin1')
  if (name !== e.name || h.readUInt16LE(8) !== e.method) throw new Error(`broken zip: local header of ${e.name} does not match`)
  // without a data descriptor (bit 3), the local header has the sizes and the CRC too
  if (!(flags & 0x0008)) {
    const c32 = h.readUInt32LE(18)
    const s32 = h.readUInt32LE(22)
    const big = readZip64Extra(rest.subarray(nameLen), { size: s32 === ZIP64_LIMIT, compressed: c32 === ZIP64_LIMIT, offset: false })
    if (h.readUInt32LE(14) !== e.crc || (big.size ?? s32) !== e.size || (big.compressed ?? c32) !== e.compressedSize) throw new Error(`broken zip: local header of ${e.name} has other sizes`)
  }
  const start = e.offset + 30 + nameLen + extraLen
  if (start + e.compressedSize > input.size) throw new Error(`broken zip: ${e.name} is cut off`)
  return start
}

/** CRC-32 of an entry's uncompressed data (stored or deflated). */
export async function entryCrc(input: ZipInput, e: CentralEntry, o: { signal?: AbortSignal; onBytes?: (n: number) => void } = {}): Promise<{ crc: number; size: number }> {
  if (e.method !== 0 && e.method !== 8) throw new Error(`unsupported zip method ${e.method}: ${e.name}`)
  const start = await entryDataOffset(input, e)
  let crc = 0
  let size = 0
  const inflate = e.method === 8 ? zlib.createInflateRaw() : null
  const done = inflate
    ? new Promise<void>((resolve, reject) => {
        inflate.on('data', (chunk: Buffer) => {
          crc = crc32(chunk, crc)
          size += chunk.length
        })
        inflate.on('end', resolve)
        inflate.on('error', reject)
      })
    : Promise.resolve()
  const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, e.compressedSize)))
  try {
    for (let p = 0; p < e.compressedSize; ) {
      if (o.signal?.aborted) throw abortError()
      const want = Math.min(buf.length, e.compressedSize - p)
      const n = await input.read(buf.subarray(0, want), start + p)
      if (n <= 0) throw new Error(`broken zip: ${e.name} is cut off`)
      const part = buf.subarray(0, n)
      if (inflate) {
        // the inflater keeps a copy; wait for it when it asks to (or for its error)
        if (!inflate.write(Buffer.from(part))) await Promise.race([new Promise((r) => inflate.once('drain', r)), done])
      } else {
        crc = crc32(part, crc)
        size += n
      }
      p += n
      o.onBytes?.(n)
    }
    inflate?.end()
    await done
  } catch (err) {
    inflate?.destroy()
    done.catch(() => {})
    throw err
  }
  return { crc, size }
}

export interface VerifyOptions {
  /** CRC-check every entry when the data is at most this large (default 2 GiB)… */
  checkAllUpTo?: number
  /** …otherwise every deflated entry and a spread of stored ones, about this many bytes (default 1 GiB). */
  sampleBytes?: number
  signal?: AbortSignal
  /** Bytes read for CRC checks, as it goes. */
  onBytes?: (n: number) => void
}

export interface VerifyResult {
  entries: number
  /** Entries whose data was read back and CRC-checked. */
  checked: number
  bytesChecked: number
  zip64: boolean
}

/** Bytes the CRC check reads with these options (for progress). */
export function verifyPlan(entries: readonly { compressedSize: number; method: number }[], o: VerifyOptions = {}): number[] {
  const all = entries.reduce((n, e) => n + e.compressedSize, 0)
  if (all <= (o.checkAllUpTo ?? 2 * 1024 ** 3)) return entries.map((_, i) => i)
  let budget = o.sampleBytes ?? 1024 ** 3
  const pick = new Set<number>()
  entries.forEach((e, i) => {
    if (e.method !== 0) {
      pick.add(i)
      budget -= e.compressedSize
    }
  })
  // stored entries spread over the archive: first, last, middle, then the quarters' middles, …
  const stored = entries.map((e, i) => (e.method === 0 ? i : -1)).filter((i) => i >= 0)
  const order = new Set<number>()
  if (stored.length) {
    order.add(stored[0])
    order.add(stored[stored.length - 1])
    const spans: [number, number][] = [[0, stored.length - 1]]
    for (let k = 0; k < spans.length && order.size < stored.length; k++) {
      const [lo, hi] = spans[k]
      if (hi - lo < 2) continue
      const mid = (lo + hi) >> 1
      order.add(stored[mid])
      spans.push([lo, mid], [mid, hi])
    }
  }
  for (const i of order) {
    if (budget <= 0) break
    if (entries[i].compressedSize > budget && pick.size > 0) continue
    pick.add(i)
    budget -= entries[i].compressedSize
  }
  return [...pick].sort((a, b) => a - b)
}

/**
 * Checks a written archive: the central directory must list exactly the entries written, with the
 * same names, methods, sizes, CRCs and offsets; every local header must match; and the data of all
 * entries (or a sample of a very large archive) must have its CRC. Throws on the first difference.
 */
export async function verifyZip(input: ZipInput, written: readonly WrittenEntry[], o: VerifyOptions = {}): Promise<VerifyResult> {
  const dir = await readCentralDirectory(input)
  if (dir.entries.length !== written.length) throw new Error(`archive check failed: ${dir.entries.length} entries instead of ${written.length}`)
  dir.entries.forEach((e, i) => {
    const w = written[i]
    if (e.name !== w.name || e.method !== w.method || e.crc !== w.crc || e.size !== w.size || e.compressedSize !== w.compressedSize || e.offset !== w.offset) {
      throw new Error(`archive check failed: ${w.name} is listed differently`)
    }
  })
  for (const e of dir.entries) {
    if (o.signal?.aborted) throw abortError()
    await entryDataOffset(input, e)
  }
  let bytes = 0
  const pick = verifyPlan(dir.entries, o)
  for (const i of pick) {
    const e = dir.entries[i]
    const r = await entryCrc(input, e, { signal: o.signal, onBytes: o.onBytes })
    if (r.crc !== e.crc || r.size !== e.size) throw new Error(`archive check failed: the data of ${e.name} is damaged (CRC)`)
    bytes += e.compressedSize
  }
  return { entries: dir.entries.length, checked: pick.length, bytesChecked: bytes, zip64: dir.zip64 }
}
