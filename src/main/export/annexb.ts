// H.264 / HEVC Annex B elementary streams (the renderer's WebCodecs output) → MPEG-TS with
// presentation and decoding timestamps, for FFmpeg to copy into MP4.
//
// A raw stream carries no timestamps. FFmpeg's raw demuxers number frames in decoding order, which
// is wrong as soon as the encoder uses B-frames (Chromium's H.264/HEVC encoders do). So the access
// units are put into display order here: the picture order count (POC) of each picture comes from
// its first slice header, and pictures leave a reorder buffer in POC order (flushed at every IDR),
// like a decoder's output process. Display index i gets pts = i / fps, decoding index k gets
// dts = (k - depth) / fps, with the reordering depth the stream declares.

/** Removes emulation prevention bytes (00 00 03 → 00 00). */
function rbsp(nal: Uint8Array, from: number, max = nal.length): Uint8Array {
  const end = Math.min(nal.length, max)
  const out = new Uint8Array(end - from)
  let n = 0
  let zeros = 0
  for (let i = from; i < end; i++) {
    const b = nal[i]
    if (zeros >= 2 && b === 3) {
      zeros = 0
      continue
    }
    zeros = b === 0 ? zeros + 1 : 0
    out[n++] = b
  }
  return out.subarray(0, n)
}

class BitReader {
  private pos = 0
  constructor(private readonly data: Uint8Array) {}

  bit(): number {
    const byte = this.pos >> 3
    if (byte >= this.data.length) throw new Error('bitstream ended')
    const b = (this.data[byte] >> (7 - (this.pos & 7))) & 1
    this.pos++
    return b
  }

  bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v = v * 2 + this.bit()
    return v
  }

  skip(n: number): void {
    this.pos += n
  }

  ue(): number {
    let zeros = 0
    while (this.bit() === 0) {
      if (++zeros > 31) throw new Error('bad exp-Golomb code')
    }
    return zeros ? 2 ** zeros - 1 + this.bits(zeros) : 0
  }

  se(): number {
    const k = this.ue()
    return k & 1 ? (k + 1) / 2 : -k / 2
  }
}

export type AnnexBCodec = 'h264' | 'hevc'

interface Picture {
  /** Access unit bytes (Annex B, start codes included). */
  data: Uint8Array
  decodeIndex: number
  poc: number
  displayIndex?: number
}

interface H264Sps {
  log2MaxFrameNum: number
  pocType: number
  log2MaxPocLsb: number
  frameMbsOnly: boolean
  separateColourPlane: boolean
  maxRefFrames: number
}

interface H264Pps {
  sps: number
  bottomFieldPicOrder: boolean
}

interface HevcSps {
  log2MaxPocLsb: number
  separateColourPlane: boolean
  maxReorder: number
}

interface HevcPps {
  sps: number
  outputFlagPresent: boolean
  extraSliceHeaderBits: number
}

function skipH264ScalingList(r: BitReader, size: number): void {
  let last = 8
  let next = 8
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256
    last = next === 0 ? last : next
  }
}

function parseH264Sps(nal: Uint8Array): { id: number; sps: H264Sps } {
  const r = new BitReader(rbsp(nal, 1, 1024))
  const profile = r.bits(8)
  r.skip(16)
  const id = r.ue()
  let separateColourPlane = false
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const chroma = r.ue()
    if (chroma === 3) separateColourPlane = r.bit() === 1
    r.ue()
    r.ue()
    r.skip(1)
    if (r.bit()) for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) if (r.bit()) skipH264ScalingList(r, i < 6 ? 16 : 64)
  }
  const log2MaxFrameNum = r.ue() + 4
  const pocType = r.ue()
  let log2MaxPocLsb = 0
  if (pocType === 0) log2MaxPocLsb = r.ue() + 4
  else if (pocType === 1) {
    r.skip(1)
    r.se()
    r.se()
    const n = r.ue()
    for (let i = 0; i < n; i++) r.se()
  }
  const maxRefFrames = r.ue()
  r.skip(1)
  r.ue()
  r.ue()
  const frameMbsOnly = r.bit() === 1
  return { id, sps: { log2MaxFrameNum, pocType, log2MaxPocLsb, frameMbsOnly, separateColourPlane, maxRefFrames } }
}

function parseH264Pps(nal: Uint8Array): { id: number; pps: H264Pps } {
  const r = new BitReader(rbsp(nal, 1, 64))
  const id = r.ue()
  const sps = r.ue()
  r.skip(1)
  return { id, pps: { sps, bottomFieldPicOrder: r.bit() === 1 } }
}

function skipProfileTierLevel(r: BitReader, maxSubLayersMinus1: number): void {
  r.skip(96)
  const profilePresent: boolean[] = []
  const levelPresent: boolean[] = []
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(r.bit() === 1)
    levelPresent.push(r.bit() === 1)
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.skip(2)
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) r.skip(88)
    if (levelPresent[i]) r.skip(8)
  }
}

function parseHevcSps(nal: Uint8Array): { id: number; sps: HevcSps } {
  const r = new BitReader(rbsp(nal, 2, 512))
  r.skip(4)
  const maxSubLayersMinus1 = r.bits(3)
  r.skip(1)
  skipProfileTierLevel(r, maxSubLayersMinus1)
  const id = r.ue()
  const chroma = r.ue()
  const separateColourPlane = chroma === 3 ? r.bit() === 1 : false
  r.ue()
  r.ue()
  if (r.bit()) for (let i = 0; i < 4; i++) r.ue()
  r.ue()
  r.ue()
  const log2MaxPocLsb = r.ue() + 4
  const allLayers = r.bit() === 1
  let maxReorder = 0
  for (let i = allLayers ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
    r.ue()
    maxReorder = r.ue()
    r.ue()
  }
  return { id, sps: { log2MaxPocLsb, separateColourPlane, maxReorder } }
}

function parseHevcPps(nal: Uint8Array): { id: number; pps: HevcPps } {
  const r = new BitReader(rbsp(nal, 2, 64))
  const id = r.ue()
  const sps = r.ue()
  r.skip(1)
  const outputFlagPresent = r.bit() === 1
  return { id, pps: { sps, outputFlagPresent, extraSliceHeaderBits: r.bits(3) } }
}

/** Picture order count tracking of one codec (POC types 0/2 for H.264; HEVC). */
interface PocState {
  prevMsb: number
  prevLsb: number
}

function pocFromLsb(state: PocState, lsb: number, log2MaxLsb: number): number {
  const max = 2 ** log2MaxLsb
  let msb = state.prevMsb
  if (lsb < state.prevLsb && state.prevLsb - lsb >= max / 2) msb += max
  else if (lsb > state.prevLsb && lsb - state.prevLsb > max / 2) msb -= max
  return msb + lsb
}

/** Pictures held for reordering: more than any real encoder reorders, so the order is always right. */
const REORDER_WINDOW = 16

const isH264Vcl = (type: number): boolean => type === 1 || type === 5
const isHevcVcl = (type: number): boolean => type < 32

export interface TsPacketSink {
  (data: Uint8Array): void
}

/**
 * Takes Annex B bytes in any chunking (push), emits MPEG-TS bytes (through `out`) with one PES per
 * access unit carrying its pts/dts. Call end() after the last chunk.
 */
export class AnnexBToTs {
  /** Pictures received (counted at their first slice), for progress. */
  frames = 0
  /** Unconsumed input: the NAL unit in progress (from nalStart) or a possible partial start code. */
  private buf = new Uint8Array(1 << 16)
  private len = 0
  private nalStart = -1
  /** Positions below this were already checked for start codes. */
  private scan = 0
  private au: Uint8Array[] = []
  private auHasVcl = false
  private auPoc: number | null = null
  private decodeCount = 0
  private displayCount = 0
  /** Pictures in decoding order that were not written yet. */
  private queue: Picture[] = []
  /** Pictures waiting for their display index (the reorder buffer). */
  private dpb: Picture[] = []
  private depth: number | null = null
  /** Bitstream not understood: from here on display order = decoding order. */
  private plain = false
  private readonly h264Sps = new Map<number, H264Sps>()
  private readonly h264Pps = new Map<number, H264Pps>()
  private readonly hevcSps = new Map<number, HevcSps>()
  private readonly hevcPps = new Map<number, HevcPps>()
  private readonly poc: PocState = { prevMsb: 0, prevLsb: 0 }
  private readonly ts: TsWriter

  constructor(
    private readonly codec: AnnexBCodec,
    private readonly fps: number,
    out: TsPacketSink
  ) {
    this.ts = new TsWriter(codec, out)
  }

  push(chunk: Uint8Array): void {
    if (this.len + chunk.length > this.buf.length) {
      const grown = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length))
      grown.set(this.buf.subarray(0, this.len))
      this.buf = grown
    }
    this.buf.set(chunk, this.len)
    this.len += chunk.length
    const b = this.buf
    const last = this.len - 3
    let i = Math.max(this.scan, this.nalStart >= 0 ? this.nalStart + 3 : 0)
    for (; i <= last; i++) {
      if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) continue
      if (this.nalStart >= 0) {
        // The NAL ends at the next start code; a 4-byte start code's leading zero is not part of it
        let end = i
        while (end > this.nalStart + 3 && b[end - 1] === 0) end--
        this.nal(b.slice(this.nalStart, end))
      }
      this.nalStart = i
      i += 2
    }
    this.scan = i
    const keepFrom = this.nalStart >= 0 ? this.nalStart : Math.max(0, this.len - 3)
    if (keepFrom > 0) {
      b.copyWithin(0, keepFrom, this.len)
      this.len -= keepFrom
      this.scan = Math.max(0, this.scan - keepFrom)
      if (this.nalStart >= 0) this.nalStart -= keepFrom
    }
  }

  /** Flushes the last access unit and every picture still waiting. */
  end(): void {
    if (this.nalStart >= 0 && this.len > this.nalStart + 3) this.nal(this.buf.slice(this.nalStart, this.len))
    this.len = 0
    this.nalStart = -1
    this.scan = 0
    this.finishAu()
    this.bump(0)
    this.write()
  }

  /** One NAL unit, start code included. */
  private nal(nal: Uint8Array): void {
    const h = nal[3]
    const type = this.codec === 'h264' ? h & 0x1f : (h >> 1) & 0x3f
    const vcl = this.codec === 'h264' ? isH264Vcl(type) : isHevcVcl(type)
    const firstSlice = vcl && (this.codec === 'h264' ? (nal[4] & 0x80) !== 0 : (nal[5] & 0x80) !== 0)
    // Parameter sets, SEI and delimiters before a picture, or its first slice, start a new access unit
    const prefix = this.codec === 'h264' ? (type >= 6 && type <= 9) || (type >= 14 && type <= 18) : (type >= 32 && type <= 35) || type === 39 || (type >= 41 && type <= 44)
    if (this.auHasVcl && (prefix || firstSlice)) this.finishAu()
    try {
      if (this.codec === 'h264') {
        if (type === 7) {
          const { id, sps } = parseH264Sps(nal.subarray(3))
          this.h264Sps.set(id, sps)
        } else if (type === 8) {
          const { id, pps } = parseH264Pps(nal.subarray(3))
          this.h264Pps.set(id, pps)
        }
      } else if (type === 33) {
        const { id, sps } = parseHevcSps(nal.subarray(3))
        this.hevcSps.set(id, sps)
      } else if (type === 34) {
        const { id, pps } = parseHevcPps(nal.subarray(3))
        this.hevcPps.set(id, pps)
      }
      if (firstSlice && !this.plain) this.auPoc = this.codec === 'h264' ? this.h264Poc(nal.subarray(3), type) : this.hevcPoc(nal.subarray(3), type)
    } catch {
      this.fallBack()
    }
    if (firstSlice) this.frames++
    this.au.push(nal)
    if (vcl) this.auHasVcl = true
  }

  private h264Poc(nal: Uint8Array, type: number): number | null {
    const r = new BitReader(rbsp(nal, 1, 64))
    r.ue()
    r.ue()
    const pps = this.h264Pps.get(r.ue())
    const sps = pps && this.h264Sps.get(pps.sps)
    if (!pps || !sps) throw new Error('slice before its parameter sets')
    const idr = type === 5
    this.setDepth(sps.pocType === 2 ? 0 : sps.maxRefFrames, idr)
    if (sps.pocType === 2) return null
    if (sps.pocType !== 0 || !sps.frameMbsOnly) throw new Error('unsupported picture order')
    if (sps.separateColourPlane) r.skip(2)
    r.skip(sps.log2MaxFrameNum)
    if (idr) {
      r.ue()
      this.poc.prevMsb = 0
      this.poc.prevLsb = 0
    }
    const lsb = r.bits(sps.log2MaxPocLsb)
    const poc = pocFromLsb(this.poc, lsb, sps.log2MaxPocLsb)
    if ((nal[0] & 0x60) !== 0) {
      this.poc.prevMsb = poc - lsb
      this.poc.prevLsb = lsb
    }
    return poc
  }

  private hevcPoc(nal: Uint8Array, type: number): number {
    const r = new BitReader(rbsp(nal, 2, 64))
    r.skip(1)
    const irap = type >= 16 && type <= 23
    if (irap) r.skip(1)
    const pps = this.hevcPps.get(r.ue())
    const sps = pps && this.hevcSps.get(pps.sps)
    if (!pps || !sps) throw new Error('slice before its parameter sets')
    // IDR and BLA pictures start a new coded video sequence; so does a CRA at the very start
    const newSequence = (type >= 16 && type <= 20) || (type === 21 && this.decodeCount === 0)
    this.setDepth(sps.maxReorder, newSequence)
    if (type === 19 || type === 20) {
      this.poc.prevMsb = 0
      this.poc.prevLsb = 0
      return 0
    }
    r.skip(pps.extraSliceHeaderBits)
    r.ue()
    if (pps.outputFlagPresent) r.skip(1)
    if (sps.separateColourPlane) r.skip(2)
    const lsb = r.bits(sps.log2MaxPocLsb)
    if (newSequence) {
      this.poc.prevMsb = 0
      this.poc.prevLsb = lsb
      return lsb
    }
    const poc = pocFromLsb(this.poc, lsb, sps.log2MaxPocLsb)
    const tid = (nal[1] & 7) - 1
    // Only temporal layer 0 pictures that are neither leading nor sub-layer non-reference anchor the POC
    const subLayerNonRef = type <= 14 && type % 2 === 0
    if (tid === 0 && !(type >= 6 && type <= 9) && !subLayerNonRef) {
      this.poc.prevMsb = poc - lsb
      this.poc.prevLsb = lsb
    }
    return poc
  }

  /** The reordering depth is fixed by the first picture (it sets every dts); a new sequence flushes. */
  private setDepth(depth: number, newSequence: boolean): void {
    if (this.depth === null) this.depth = Math.min(16, depth)
    if (newSequence) this.bump(0)
  }

  private fallBack(): void {
    if (this.plain) return
    this.plain = true
    this.bump(0)
  }

  private finishAu(): void {
    if (!this.au.length) return
    const data = concat(...this.au)
    const hasVcl = this.auHasVcl
    const poc = this.auPoc
    this.au = []
    this.auHasVcl = false
    this.auPoc = null
    if (!hasVcl) {
      // trailing parameter sets / SEI without a picture: attach to the next unit
      this.au.push(data)
      return
    }
    this.depth ??= 0
    const pic: Picture = { data, decodeIndex: this.decodeCount++, poc: poc ?? 0 }
    this.queue.push(pic)
    if (this.plain || poc === null) {
      // decoding order is display order
      this.bump(0)
      pic.displayIndex = this.displayCount++
    } else {
      this.dpb.push(pic)
      this.bump(REORDER_WINDOW)
    }
    this.write()
  }

  /** Outputs pictures in POC order until at most `keep` wait. */
  private bump(keep: number): void {
    while (this.dpb.length > keep) {
      let min = 0
      for (let i = 1; i < this.dpb.length; i++) if (this.dpb[i].poc < this.dpb[min].poc) min = i
      const [pic] = this.dpb.splice(min, 1)
      pic.displayIndex = this.displayCount++
    }
  }

  /** Writes queued pictures (decoding order) whose display index is known. */
  private write(): void {
    const depth = this.depth ?? 0
    while (this.queue.length && this.queue[0].displayIndex !== undefined) {
      const pic = this.queue.shift()!
      const tick = (n: number): number => Math.round(((n + depth) * 90000) / this.fps)
      // + depth frames: the first dts (decoding index - depth) must not be negative
      this.ts.pes(pic.data, tick(pic.displayIndex!), tick(pic.decodeIndex - depth))
    }
  }
}

/**
 * Counts the pictures of an Annex B stream (any chunking) the way AnnexBToTs does, at their first
 * slice, and remembers the NAL type of the first picture, without parsing or copying NAL units.
 * Export segments use it to check their frame count and that they start with an IDR picture.
 */
export class AnnexBFrameCounter {
  frames = 0
  /** NAL unit type of the first picture's first slice; null before any picture. */
  firstType: number | null = null
  /** Bytes from the last chunk that may begin a start code whose header is not complete yet. */
  private carry: Uint8Array = new Uint8Array(0)
  /** Bytes needed from a start code on: 3 + NAL header + the byte with the first-slice flag. */
  private readonly need: number

  constructor(private readonly codec: AnnexBCodec) {
    this.need = codec === 'h264' ? 5 : 6
  }

  push(chunk: Uint8Array): void {
    let b = chunk
    if (this.carry.length) {
      b = new Uint8Array(this.carry.length + chunk.length)
      b.set(this.carry)
      b.set(chunk, this.carry.length)
    }
    let i = 0
    for (; i + this.need <= b.length; i++) {
      if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) continue
      this.nal(b, i + 3)
      i += 2
    }
    this.carry = b.slice(i)
  }

  /** Call after the last chunk. */
  end(): void {
    this.carry = new Uint8Array(0)
  }

  /** The stream starts with a picture that begins a new sequence (H.264 IDR; HEVC IDR or BLA). */
  get startsWithIdr(): boolean {
    const t = this.firstType
    if (t === null) return false
    return this.codec === 'h264' ? t === 5 : t >= 16 && t <= 20
  }

  private nal(b: Uint8Array, h: number): void {
    const type = this.codec === 'h264' ? b[h] & 0x1f : (b[h] >> 1) & 0x3f
    const vcl = this.codec === 'h264' ? isH264Vcl(type) : isHevcVcl(type)
    if (!vcl) return
    const first = this.codec === 'h264' ? (b[h + 1] & 0x80) !== 0 : (b[h + 2] & 0x80) !== 0
    if (!first) return
    this.frames++
    this.firstType ??= type
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// ------------------------------------------------------------------ MPEG-TS

const TS = 188
const PMT_PID = 0x1000
const VIDEO_PID = 0x100

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 24
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
    t[i] = c >>> 0
  }
  return t
})()

/** CRC-32/MPEG-2 of PSI sections. */
export function crc32Mpeg(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0
  return crc >>> 0
}

/** Minimal single-program transport stream writer: PAT, PMT, one video PES per access unit. */
class TsWriter {
  private cc = new Map<number, number>()
  private started = false

  constructor(
    private readonly codec: AnnexBCodec,
    private readonly out: TsPacketSink
  ) {}

  private counter(pid: number): number {
    const c = this.cc.get(pid) ?? 0
    this.cc.set(pid, (c + 1) & 15)
    return c
  }

  private section(pid: number, body: number[]): void {
    const crc = crc32Mpeg(Uint8Array.from(body))
    const sec = [...body, (crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]
    const p = new Uint8Array(TS).fill(0xff)
    p.set([0x47, 0x40 | (pid >> 8), pid & 255, 0x10 | this.counter(pid), 0], 0)
    p.set(sec, 5)
    this.out(p)
  }

  private tables(): void {
    // PAT: program 1 → PMT
    this.section(0, [0x00, 0xb0, 13, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 255])
    const streamType = this.codec === 'h264' ? 0x1b : 0x24
    // PMT: PCR and the one video stream on VIDEO_PID
    this.section(PMT_PID, [
      0x02, 0xb0, 18, 0x00, 0x01, 0xc1, 0x00, 0x00,
      0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 255, 0xf0, 0x00,
      streamType, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 255, 0xf0, 0x00
    ])
  }

  pes(payload: Uint8Array, pts: number, dts: number): void {
    if (!this.started) {
      this.tables()
      this.started = true
    }
    const both = pts !== dts
    const header = new Uint8Array(both ? 19 : 14)
    header.set([0, 0, 1, 0xe0, 0, 0, 0x80, both ? 0xc0 : 0x80, both ? 10 : 5])
    writeTimestamp(header, 9, both ? 3 : 2, pts)
    if (both) writeTimestamp(header, 14, 1, dts)
    const pes = concat(header, payload)
    let at = 0
    let first = true
    while (at < pes.length) {
      const p = new Uint8Array(TS)
      const cc = this.counter(VIDEO_PID)
      p[0] = 0x47
      p[1] = (first ? 0x40 : 0) | (VIDEO_PID >> 8)
      p[2] = VIDEO_PID & 255
      // first packet: adaptation field with the PCR (= dts); last packet: stuffing
      const adaptation = first ? 8 : 0
      const room = TS - 4 - adaptation
      const left = pes.length - at
      const stuffing = left < room ? room - left - (adaptation ? 0 : 1) : 0
      const afLength = adaptation ? 7 + stuffing : left < room ? room - left - 1 : -1
      let o = 4
      if (afLength >= 0) {
        p[3] = 0x30 | cc
        p[o++] = afLength
        if (afLength > 0) {
          p[o++] = first ? 0x10 : 0x00
          if (first) {
            const base = Math.max(0, dts)
            p[o++] = Math.floor(base / 2 ** 25) & 255
            p[o++] = Math.floor(base / 2 ** 17) & 255
            p[o++] = Math.floor(base / 2 ** 9) & 255
            p[o++] = Math.floor(base / 2) & 255
            p[o++] = ((base & 1) << 7) | 0x7e
            p[o++] = 0
          }
          while (o < 4 + 1 + afLength) p[o++] = 0xff
        }
      } else {
        p[3] = 0x10 | cc
      }
      const n = Math.min(TS - o, left)
      p.set(pes.subarray(at, at + n), o)
      at += n
      first = false
      this.out(p)
    }
  }
}

function writeTimestamp(buf: Uint8Array, at: number, prefix: number, ts: number): void {
  const v = Math.max(0, ts) % 2 ** 33
  const hi = Math.floor(v / 2 ** 30)
  const mid = Math.floor(v / 2 ** 15) & 0x7fff
  const lo = v & 0x7fff
  buf[at] = (prefix << 4) | (hi << 1) | 1
  buf[at + 1] = mid >> 7
  buf[at + 2] = ((mid & 0x7f) << 1) | 1
  buf[at + 3] = lo >> 7
  buf[at + 4] = ((lo & 0x7f) << 1) | 1
}
