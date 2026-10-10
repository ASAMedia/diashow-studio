// Small pictures of faces and video frames for the people list and the review before export:
// cut from a photo's display image or a video frame, made one at a time and cached as object URLs.
import { useEffect, useState } from 'react'
import type { MediaItem, Rect } from '@shared/types'
import { mediaUrl } from '@shared/api'

const urls = new Map<string, Promise<string>>()
const MAX_URLS = 400
let chain: Promise<unknown> = Promise.resolve()

/** Runs jobs one after another so a long list doesn't decode dozens of pictures at once. */
function queued<T>(job: () => Promise<T>): Promise<T> {
  const p = chain.then(job, job)
  chain = p.catch(() => {})
  return p
}

/** The picture a face was found in: a photo's display image, or the video frame at time t. */
async function source(m: MediaItem, t: number | undefined, edge: number): Promise<ImageBitmap> {
  if (m.kind === 'video' && t !== undefined) {
    const [jpeg] = await window.api.videoFrames(m.playback ?? m.path, [t], edge)
    if (!jpeg?.length) throw new Error('no frame')
    return createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }))
  }
  const path = m.display ?? m.thumb
  if (!path) throw new Error('no picture')
  const blob = await (await fetch(mediaUrl(path))).blob()
  const k = Math.min(1, edge / Math.max(1, m.width, m.height))
  return createImageBitmap(blob, k < 1 ? { resizeWidth: Math.max(1, Math.round(m.width * k)), resizeQuality: 'medium' } : {})
}

function remember(key: string, make: () => Promise<string>): Promise<string> {
  let p = urls.get(key)
  if (!p) {
    p = queued(make)
    p.catch(() => urls.delete(key))
    urls.set(key, p)
    if (urls.size > MAX_URLS) {
      const [oldKey, old] = urls.entries().next().value!
      urls.delete(oldKey)
      void old.then((u) => URL.revokeObjectURL(u)).catch(() => {})
    }
  }
  return p
}

/** A square picture of the face `r` (normalised) with some margin, `size` px. */
export function faceCropUrl(m: MediaItem, r: Rect, t?: number, size = 96): Promise<string> {
  const key = `face|${m.id}|${t ?? ''}|${r.x},${r.y},${r.w},${r.h}|${size}`
  return remember(key, async () => {
    const bmp = await source(m, t, 1600)
    try {
      const W = bmp.width
      const H = bmp.height
      const side = Math.max(r.w * W, r.h * H) * 1.5
      const cx = (r.x + r.w / 2) * W
      const cy = (r.y + r.h / 2) * H
      const c = new OffscreenCanvas(size, size)
      const g = c.getContext('2d')!
      g.fillStyle = '#222'
      g.fillRect(0, 0, size, size)
      g.imageSmoothingQuality = 'high'
      g.drawImage(bmp, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size)
      return URL.createObjectURL(await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 }))
    } finally {
      bmp.close()
    }
  })
}

/** A whole video frame at time t (`edge` px long side), e.g. for the review grid. */
export function frameUrl(m: MediaItem, t: number, edge = 480): Promise<string> {
  return remember(`frame|${m.id}|${t}|${edge}`, async () => {
    const [jpeg] = await window.api.videoFrames(m.playback ?? m.path, [t], edge)
    if (!jpeg?.length) throw new Error('no frame')
    return URL.createObjectURL(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }))
  })
}

/** React helper: the URL once it is made (undefined before, or when it failed). */
export function useAsyncUrl(make: (() => Promise<string>) | null, deps: unknown[]): string | undefined {
  const [url, setUrl] = useState<string | undefined>()
  useEffect(() => {
    let alive = true
    setUrl(undefined)
    make?.()
      .then((u) => alive && setUrl(u))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return url
}
