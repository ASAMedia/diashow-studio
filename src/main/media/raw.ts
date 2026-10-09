// Camera RAW decoding with libraw-wasm in a worker thread (LibRaw's demosaic is synchronous and
// would otherwise block the Electron main process for ~1 s per file).
//
// libraw-wasm's public wrapper needs a browser Web Worker, so the worker loads the package's
// Emscripten module (dist/libraw.js + libraw.wasm) directly; that module runs fine in Node.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { Worker } from 'node:worker_threads'

export interface RawImage {
  width: number
  height: number
  channels: 3
  data: Uint8Array
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { readFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')
let ready = null
function init() {
  ready ??= (async () => {
    const factory = (await import(pathToFileURL(workerData.dist + '/libraw.js').href)).default
    const mod = await factory({ wasmBinary: readFileSync(workerData.dist + '/libraw.wasm') })
    return new mod.LibRaw()
  })()
  return ready
}
parentPort.on('message', async ({ id, file }) => {
  try {
    const lr = await init()
    lr.open(new Uint8Array(readFileSync(file)), { halfSize: true, useCameraWb: true, outputBps: 8, outputColor: 1 })
    const img = lr.imageData()
    if (!img || !img.data || img.colors !== 3 || img.bits !== 8) throw new Error('unsupported RAW output')
    const data = img.data.buffer instanceof SharedArrayBuffer ? img.data.slice() : img.data
    parentPort.postMessage({ id, width: img.width, height: img.height, data }, [data.buffer])
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e) })
  }
})
`

/** Directory with libraw.js / libraw.wasm, or null when the package is unavailable. */
export function librawDistDir(): string | null {
  try {
    const req = createRequire(import.meta.url)
    let dir = dirname(req.resolve('libraw-wasm'))
    // Worker threads cannot import ESM out of app.asar; electron-builder unpacks it (asarUnpack)
    dir = dir.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    return existsSync(join(dir, 'libraw.wasm')) ? dir : null
  } catch {
    return null
  }
}

interface Pending {
  resolve: (img: RawImage) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export interface RawDecoding {
  readonly available: boolean
  decode(file: string): Promise<RawImage>
  dispose(): void
}

export class RawDecoder implements RawDecoding {
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private seq = 0
  private idle: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    private readonly dist: string | null = librawDistDir(),
    private readonly timeoutMs = 90_000
  ) {}

  get available(): boolean {
    return !!this.dist && !this.disposed
  }

  get load(): number {
    return this.pending.size
  }

  /** Half-size demosaic, camera white balance, sRGB 8-bit, orientation applied. */
  decode(file: string): Promise<RawImage> {
    if (!this.available) return Promise.reject(new Error('libraw unavailable'))
    const worker = this.ensureWorker()
    if (this.idle) clearTimeout(this.idle)
    const id = ++this.seq
    return new Promise<RawImage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failAll(new Error('RAW decode timed out'))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      worker.postMessage({ id, file })
    })
  }

  dispose(): void {
    this.disposed = true
    this.failAll(new Error('disposed'))
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { dist: this.dist } })
    w.unref()
    w.on('message', (msg: { id: number; error?: string; width: number; height: number; data: Uint8Array }) => {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error))
      else p.resolve({ width: msg.width, height: msg.height, channels: 3, data: msg.data })
      this.scheduleIdle()
    })
    w.on('error', (err) => this.failAll(err))
    w.on('exit', () => {
      if (this.worker === w) this.worker = null
      this.failAll(new Error('RAW worker exited'))
    })
    this.worker = w
    return w
  }

  /** WASM memory never shrinks; drop the worker when no RAW was decoded for a while. */
  private scheduleIdle(): void {
    if (this.pending.size) return
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.stopWorker(), 30_000)
    this.idle.unref()
  }

  private stopWorker(): void {
    const w = this.worker
    this.worker = null
    if (w) void w.terminate()
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
    this.stopWorker()
  }
}

/** A few decoder workers; each RAW goes to the least busy one (each worker holds its own WASM heap). */
export class RawDecoderPool implements RawDecoding {
  private readonly decoders: RawDecoder[]

  constructor(size = 2, dist: string | null = librawDistDir()) {
    this.decoders = Array.from({ length: Math.max(1, size) }, () => new RawDecoder(dist))
  }

  get available(): boolean {
    return this.decoders[0].available
  }

  decode(file: string): Promise<RawImage> {
    const target = this.decoders.reduce((a, b) => (b.load < a.load ? b : a))
    return target.decode(file)
  }

  dispose(): void {
    for (const d of this.decoders) d.dispose()
  }
}
