// HTTP server for sharing over the local network: phones upload photos and videos (streamed to disk)
// and download the files the user offers. No Electron APIs: shareMain.ts wires it to the app.
//
// Security model: every session gets two random tokens (upload page, download page); only paths below
// them are answered, everything else is a bare 404. Nothing maps a URL to the file system: uploads go
// to names this module makes up, and downloads are looked up by a random id among the files the user
// offered. No directory listings, no other files.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { basename, extname, join } from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { classify, extOf, IMAGE_EXT, VIDEO_EXT } from '@shared/formats'
import type { ShareOffer, ShareReceived } from '@shared/share'
import { contentType, parseRange } from '../protocol'
import { downloadPage, pageLang, uploadPage } from './pages'

export const DEFAULT_LIMITS = {
  /** Largest photo (48 MP ProRAW DNGs are ~100 MB). */
  photo: 250e6,
  /** Largest video (several minutes of 4K from a phone). */
  video: 4e9
}
/** Uploads written at the same time; more get 503 + Retry-After (the page waits and retries). */
export const MAX_CONCURRENT_UPLOADS = 6
/** Space left on the disk after an upload (the media cache needs room too). */
const DISK_RESERVE = 1024 ** 3
/** Name of the folder for uploads without a name. */
export const UNKNOWN_UPLOADER = 'Unbekannt'

/** MIME type → extension for files whose name has no extension the app knows (iOS "image.jpg" is fine, some apps send none). */
export const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/tiff': 'tif',
  'image/bmp': 'bmp',
  'image/x-adobe-dng': 'dng',
  'image/dng': 'dng',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'video/x-matroska': 'mkv',
  'video/x-m4v': 'm4v'
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

/**
 * A file or folder name that is safe on Windows: the last path component only, no control, bidi or
 * reserved characters, no leading dots (hidden files, "..") or trailing dots and spaces, no device
 * names (CON, NUL, …), at most `max` characters with the extension kept. '' when nothing is left.
 */
export function safeName(raw: string, max = 120): string {
  let s = String(raw ?? '').normalize('NFC')
  s = s.split(/[\\/]/).pop() ?? ''
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (!s) return ''
  if (RESERVED.test(s.split('.')[0])) s = `_${s}`
  if (s.length > max) {
    const ext = extname(s)
    const keep = ext.length < 12 ? ext : ''
    s = s.slice(0, max - keep.length).replace(/[.\s]+$/, '') + keep
  }
  return s
}

/** Safe file name for an upload, or null when it is no photo or video the app imports. */
export function uploadFileName(raw: string, mime?: string): { name: string; kind: 'photo' | 'video' } | null {
  let name = safeName(raw)
  let kind = classify(name)
  if (kind !== 'photo' && kind !== 'video') {
    const ext = MIME_EXT[(mime ?? '').split(';')[0].trim().toLowerCase()]
    if (!ext) return null
    name = `${safeName(name.replace(/\.[^.]*$/, ''), 100) || 'upload'}.${ext}`
    kind = classify(name)
    if (kind !== 'photo' && kind !== 'video') return null
  }
  if (!basename(name, extname(name))) name = `upload${extname(name)}`
  return { name, kind }
}

/** Folder name for an uploader: their (safe) name, or "Unbekannt". */
export function uploaderFolder(raw: string): string {
  return safeName(raw, 40) || UNKNOWN_UPLOADER
}

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987). */
export function contentDisposition(name: string, attachment: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

function decodeHeader(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v
  if (!s) return ''
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const token = (): string => randomBytes(24).toString('base64url')
/** Constant-time comparison; byte lengths are compared first (a non-ASCII guess must not throw). */
const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin'
}

class HttpError extends Error {
  constructor(readonly status: number, message = '') {
    super(message)
  }
}

/** Counts bytes and fails beyond `limit`. */
class Limit extends Transform {
  bytes = 0
  constructor(private limit: number) {
    super()
  }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length
    if (this.bytes > this.limit) cb(new HttpError(413, 'too large'))
    else cb(null, chunk)
  }
}

export interface ShareServerOptions {
  /** Folder for this project's uploads: <Documents>/Diashow Studio/Uploads/<project>. */
  uploadDir: string
  /** Shown on the pages. */
  projectName: string
  limits?: { photo: number; video: number }
  maxConcurrentUploads?: number
  /** Free bytes on the upload disk; injected for tests (default: statfs). */
  freeSpace?: (dir: string) => Promise<number | null>
  /** A file arrived completely (it is in its final place). */
  onReceived?: (file: ShareReceived) => void
  /** Anything shown in the dialog changed (uploads started/ended, downloads, offers). */
  onChange?: () => void
}

export interface ShareServer {
  readonly uploadToken: string
  readonly downloadToken: string
  readonly limits: { photo: number; video: number }
  /** Address and port while listening. */
  readonly host: string | null
  readonly port: number | null
  /** Starts listening on `host` (random free port); a running listener is closed first. */
  listen(host: string): Promise<void>
  uploadUrl(): string | null
  downloadUrl(): string | null
  collecting: boolean
  /** Adds a file for download; null when it is no existing photo/video file. */
  offer(path: string): Promise<ShareOffer | null>
  unoffer(id: string): void
  offers(): ShareOffer[]
  received(): ShareReceived[]
  /** Uploads being written now. */
  uploading(): number
  /** Stops listening, drops every connection and deletes partial uploads. */
  close(): Promise<void>
}

async function diskFree(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

export function createShareServer(opts: ShareServerOptions): ShareServer {
  const uploadToken = token()
  const downloadToken = token()
  const limits = opts.limits ?? DEFAULT_LIMITS
  const maxUploads = opts.maxConcurrentUploads ?? MAX_CONCURRENT_UPLOADS
  const freeSpace = opts.freeSpace ?? diskFree
  const offered = new Map<string, ShareOffer>()
  const received: ShareReceived[] = []
  /** Final paths (lower case) reserved by uploads in progress. */
  const reserved = new Set<string>()
  const partFiles = new Set<string>()
  const sockets = new Set<Socket>()
  let server: Server | null = null
  let host: string | null = null
  let port: number | null = null
  let active = 0
  let closed = false
  const changed = (): void => opts.onChange?.()

  const send = (res: ServerResponse, status: number, body = '', type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): void => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body)), 'Cache-Control': 'no-store', ...extra })
    res.end(body)
  }

  /** Answers before the request body was read: the connection is closed instead of reading a large body. */
  const reject = (req: IncomingMessage, res: ServerResponse, status: number, extra: Record<string, string> = {}): void => {
    if (req.complete) return send(res, status, '', undefined, extra)
    send(res, status, '', undefined, { ...extra, Connection: 'close' })
    res.once('finish', () => req.socket.destroy())
  }

  const notFound = (req: IncomingMessage, res: ServerResponse): void => reject(req, res, 404)

  function uniquePath(dir: string, name: string): string {
    const ext = extname(name)
    const stem = name.slice(0, name.length - ext.length)
    for (let i = 1; i < 100_000; i++) {
      const candidate = join(dir, i === 1 ? name : `${stem} (${i})${ext}`)
      const key = candidate.toLowerCase()
      if (reserved.has(key) || existsSync(candidate) || existsSync(`${candidate}.part`)) continue
      reserved.add(key)
      return candidate
    }
    throw new HttpError(500, 'no free name')
  }

  async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return reject(req, res, 405, { Allow: 'POST' })
    if (!api.collecting) return reject(req, res, 403)
    const file = uploadFileName(decodeHeader(req.headers['x-file-name']), req.headers['content-type'])
    if (!file) return reject(req, res, 415)
    const length = Number(req.headers['content-length'])
    if (!req.headers['content-length'] || !Number.isSafeInteger(length) || length < 0) return reject(req, res, 411)
    if (length === 0) return reject(req, res, 400)
    const limit = limits[file.kind]
    if (length > limit) return reject(req, res, 413)
    if (active >= maxUploads) return reject(req, res, 503, { 'Retry-After': '3' })
    active++
    changed()
    const uploader = uploaderFolder(decodeHeader(req.headers['x-uploader']))
    const dir = join(opts.uploadDir, uploader)
    let final: string | null = null
    let part: string | null = null
    try {
      await mkdir(dir, { recursive: true })
      const free = await freeSpace(dir)
      if (free !== null && free < length + DISK_RESERVE) throw new HttpError(507, 'disk full')
      final = uniquePath(dir, file.name)
      part = `${final}.part`
      partFiles.add(part)
      const counter = new Limit(Math.min(limit, length))
      await pipeline(req, counter, createWriteStream(part, { flags: 'wx' }))
      if (counter.bytes !== length) throw new HttpError(400, 'incomplete')
      if (closed) throw new HttpError(503, 'stopped')
      await rename(part, final)
      partFiles.delete(part)
      part = null
      const item: ShareReceived = { uploader, name: basename(final), path: final, size: length, kind: file.kind, at: Date.now() }
      received.push(item)
      send(res, 201, JSON.stringify({ ok: true, name: item.name }), 'application/json')
      opts.onReceived?.(item)
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400
      if (!res.writableEnded && !req.destroyed) reject(req, res, status)
      else res.destroy()
    } finally {
      if (part) {
        partFiles.delete(part)
        await rm(part, { force: true }).catch(() => {})
      }
      if (final) reserved.delete(final.toLowerCase())
      active--
      changed()
    }
  }

  async function handleFile(req: IncomingMessage, res: ServerResponse, id: string, query: URLSearchParams): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return reject(req, res, 405, { Allow: 'GET, HEAD' })
    const offer = offered.get(id)
    if (!offer) return notFound(req, res)
    let size: number
    let mtime: number
    try {
      const st = await stat(offer.path)
      if (!st.isFile()) return notFound(req, res)
      size = st.size
      mtime = st.mtimeMs
    } catch {
      return notFound(req, res)
    }
    const etag = `"${size.toString(36)}-${Math.floor(mtime).toString(36)}"`
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      'Content-Type': contentType(offer.path),
      'Content-Disposition': contentDisposition(offer.name, query.get('dl') === '1'),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=600',
      ETag: etag,
      'Last-Modified': new Date(mtime).toUTCString()
    }
    const ifRange = req.headers['if-range']
    let range = parseRange(req.headers.range ?? null, size)
    if (ifRange && ifRange !== etag) range = null
    if (range === 'invalid') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' })
      res.end()
      return
    }
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    // a download from the start, not a player's probe (iOS asks for bytes=0-1 first)
    if (start === 0 && end >= Math.min(size - 1, 65_535) && req.method === 'GET') {
      offer.downloads++
      changed()
    }
    res.writeHead(range ? 206 : 200, {
      ...headers,
      'Content-Length': String(size === 0 ? 0 : end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
    })
    if (req.method === 'HEAD' || size === 0) {
      res.end()
      return
    }
    await pipeline(createReadStream(offer.path, { start, end }), res).catch(() => res.destroy())
  }

  function page(res: ServerResponse, html: string, nonce?: string): void {
    const csp = [
      "default-src 'none'",
      nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "media-src 'self'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join('; ')
    send(res, 200, html, 'text/html; charset=utf-8', { 'Content-Security-Policy': csp })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? ''
    if (raw.length > 2048 || !raw.startsWith('/')) return notFound(req, res)
    const url = new URL(raw, 'http://share.local')
    // decoded segments; a malformed escape is simply not found
    let parts: string[]
    try {
      parts = url.pathname.split('/').slice(1).map(decodeURIComponent)
    } catch {
      return notFound(req, res)
    }
    const [tok, ...rest] = parts
    if (!tok) return notFound(req, res)
    const lang = pageLang(req.headers['accept-language'])
    if (sameToken(tok, uploadToken)) {
      if (rest.length === 0 || (rest.length === 1 && rest[0] === '')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return reject(req, res, 405, { Allow: 'GET' })
        const nonce = randomBytes(16).toString('base64')
        return page(
          res,
          uploadPage({
            lang,
            project: opts.projectName,
            uploadPath: `/${uploadToken}/upload`,
            collecting: api.collecting,
            photoExt: IMAGE_EXT,
            videoExt: VIDEO_EXT,
            mime: MIME_EXT,
            limits,
            nonce
          }),
          nonce
        )
      }
      if (rest.length === 1 && rest[0] === 'upload') return handleUpload(req, res)
      return notFound(req, res)
    }
    if (sameToken(tok, downloadToken)) {
      if (rest.length === 0 || (rest.length === 1 && rest[0] === '')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return reject(req, res, 405, { Allow: 'GET' })
        return page(res, downloadPage({ lang, project: opts.projectName, offers: [...offered.values()], fileHref }))
      }
      if (rest.length >= 2 && rest[0] === 'f') return handleFile(req, res, rest[1], url.searchParams)
      return notFound(req, res)
    }
    return notFound(req, res)
  }

  const fileHref = (o: ShareOffer): string => `/${downloadToken}/f/${o.id}/${encodeURIComponent(o.name)}`

  async function stopListening(): Promise<void> {
    const s = server
    server = null
    host = null
    port = null
    if (!s) return
    const done = new Promise<void>((resolve) => s.close(() => resolve()))
    s.closeAllConnections()
    for (const sock of sockets) sock.destroy()
    sockets.clear()
    await done
  }

  const api: ShareServer = {
    uploadToken,
    downloadToken,
    limits,
    collecting: true,
    get host() {
      return host
    },
    get port() {
      return port
    },

    async listen(h) {
      if (closed) throw new Error('share server closed')
      await stopListening()
      const s = createServer((req, res) => {
        handle(req, res).catch(() => {
          if (!res.headersSent) send(res, 500)
          else res.destroy()
        })
      })
      // Big uploads take minutes: no overall request time limit, but idle connections are dropped
      s.requestTimeout = 0
      s.headersTimeout = 30_000
      s.keepAliveTimeout = 5_000
      s.maxHeadersCount = 64
      s.setTimeout(60_000)
      s.maxConnections = 200
      s.on('connection', (sock) => {
        sockets.add(sock)
        sock.once('close', () => sockets.delete(sock))
      })
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject)
        s.listen({ host: h, port: 0, exclusive: true }, () => {
          s.off('error', reject)
          resolve()
        })
      })
      s.on('error', () => {})
      server = s
      host = h
      port = (s.address() as AddressInfo).port
    },

    uploadUrl() {
      return host && port ? `http://${host}:${port}/${uploadToken}/` : null
    },

    downloadUrl() {
      return host && port ? `http://${host}:${port}/${downloadToken}/` : null
    },

    async offer(path) {
      if (typeof path !== 'string' || !path) return null
      const kind = classify(path)
      if (kind !== 'video' && kind !== 'photo') return null
      for (const o of offered.values()) if (o.path.toLowerCase() === path.toLowerCase()) return o
      try {
        const st = await stat(path)
        if (!st.isFile()) return null
        const o: ShareOffer = { id: randomBytes(9).toString('base64url'), name: safeName(basename(path)) || `video.${extOf(path)}`, path, size: st.size, downloads: 0 }
        offered.set(o.id, o)
        changed()
        return o
      } catch {
        return null
      }
    },

    unoffer(id) {
      if (offered.delete(id)) changed()
    },

    offers: () => [...offered.values()].map((o) => ({ ...o })),
    received: () => received.map((r) => ({ ...r })),
    uploading: () => active,

    async close() {
      closed = true
      await stopListening()
      // uploads that were cut off delete their .part file when their pipeline fails; this catches the rest
      await Promise.all([...partFiles].map((p) => rm(p, { force: true }).catch(() => {})))
    }
  }
  return api
}
