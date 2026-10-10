// dsmedia://f/<encoded absolute path> → local file, with HTTP Range support so <video> seeking and
// mediabunny's UrlSource work.
//
// Access limits: only photo, video and audio files are served (every file the renderer shows, the
// cache's thumbnails, display images and proxies included, has such an extension), never documents,
// keys or browser data, and never SVG (a document that can run scripts). Device paths (\\?\, \\.\),
// alternate data streams (file.txt:x.jpg) and requests from web pages other than the app's are refused.
import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { MEDIA_SCHEME, pathFromMediaUrl } from '@shared/api'
import { AUDIO_EXT, extOf, IMAGE_EXT, VIDEO_EXT } from '@shared/formats'

const SERVED_EXT = new Set([...IMAGE_EXT, ...VIDEO_EXT, ...AUDIO_EXT])

/** Network shares the user hasn't trusted are refused too (set by ipc.ts). */
let pathPolicy: (path: string) => boolean = () => true
export function setMediaPathPolicy(allow: (path: string) => boolean): void {
  pathPolicy = allow
}

/** May the renderer read this file through dsmedia://? (See the access limits above.) */
export function mediaPathAllowed(path: string): boolean {
  if (typeof path !== 'string' || !path || path.length > 4000 || path.includes('\0') || !isAbsolute(path)) return false
  // \\?\C:\…, \\.\PhysicalDrive0, \??\…: Win32 device namespaces
  if (/^[\\/]{2}[?.][\\/]|^[\\/]\?\?[\\/]/.test(path)) return false
  // a colon only right after the drive letter: no alternate data streams
  if (path.indexOf(':', /^[A-Za-z]:/.test(path) ? 2 : 0) >= 0) return false
  // forward slashes count as separators on Windows; "." / ".." segments are resolved by the OS: refuse them
  if (/(^|[\\/])\.{1,2}([\\/]|$)/.test(path)) return false
  return SERVED_EXT.has(extOf(path))
}

/**
 * Pages that may read media: the app's own (file://, "null" for file pages, the dev server) and
 * dsmedia itself. A request without Origin (a plain <img>/<video>) is fine.
 */
export function originAllowed(origin: string | null, devUrl = process.env.ELECTRON_RENDERER_URL): boolean {
  if (!origin || origin === 'null' || origin.startsWith('file://') || origin.startsWith(`${MEDIA_SCHEME}://`)) return true
  if (!devUrl) return false
  try {
    return new URL(devUrl).origin === origin
  } catch {
    return false
  }
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  json: 'application/json'
}

export function contentType(path: string): string {
  return MIME[extOf(path)] ?? 'application/octet-stream'
}

/** Parses a single "bytes=a-b" / "bytes=a-" / "bytes=-n" range. null = no/unsupported range header. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    const suffix = Number(m[2])
    if (suffix === 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || end < start) return 'invalid'
  return { start, end }
}

type Body = ConstructorParameters<typeof Response>[0]

function body(path: string, start: number, end: number): Body {
  const stream = Readable.toWeb(createReadStream(path, { start, end })) as WebReadableStream<Uint8Array>
  return stream as unknown as Body
}

// The dev renderer runs on http://localhost, so dsmedia:// is cross-origin there; mediabunny's
// UrlSource needs to read Content-Range/Content-Length from JS.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
}

export async function handleMediaRequest(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, HEAD' } })
  if (!originAllowed(request.headers.get('origin'))) return new Response('forbidden', { status: 403 })
  let path: string
  try {
    path = pathFromMediaUrl(request.url)
  } catch {
    return new Response('bad url', { status: 400 })
  }
  if (!mediaPathAllowed(path) || !pathPolicy(path)) return new Response('not found', { status: 404 })
  let size: number
  try {
    const st = await stat(path)
    if (!st.isFile()) return new Response('not found', { status: 404 })
    size = st.size
  } catch {
    return new Response('not found', { status: 404 })
  }
  const headers: Record<string, string> = {
    ...CORS,
    'Content-Type': contentType(path),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache'
  }
  const head = request.method === 'HEAD'
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
  }
  if (range) {
    const length = range.end - range.start + 1
    return new Response(head ? null : body(path, range.start, range.end), {
      status: 206,
      headers: { ...headers, 'Content-Length': String(length), 'Content-Range': `bytes ${range.start}-${range.end}/${size}` }
    })
  }
  if (size === 0) return new Response(head ? null : '', { status: 200, headers: { ...headers, 'Content-Length': '0' } })
  return new Response(head ? null : body(path, 0, size - 1), {
    status: 200,
    headers: { ...headers, 'Content-Length': String(size) }
  })
}

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, handleMediaRequest)
}
