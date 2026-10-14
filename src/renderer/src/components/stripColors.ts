// The colours of the bars in the filmstrip's overview (StripOverview.tsx): the average colour of each
// picture's thumbnail, after its light and colour edit. A thumbnail is read once, shrunk to 8 × 8 pixels
// while it is decoded, and kept for the session; a few are read at a time, in the order asked for.
import { mediaUrl } from '@shared/api'
import { adjustImageData, adjustKey, adjustParams } from '@shared/adjust'
import type { MediaItem } from '@shared/types'

const SIZE = 8
const AT_ONCE = 3
const KEEP = 20000

const known = new Map<string, string>()
const waiting = new Map<string, MediaItem>()
const reading = new Set<string>()
const listeners = new Set<() => void>()
let frame = 0

const keyOf = (m: MediaItem): string | null => (m.thumb ? `${m.thumb}|${adjustKey(m.edit?.adjust)}` : null)

/** The average colour of a photo's or video's thumbnail as CSS, once it has been read ('' when it can't be). */
export function averageColor(m: MediaItem): string | undefined {
  const key = keyOf(m)
  return key ? known.get(key) : undefined
}

/** Reads the colours of these items that aren't known yet; `onColors` tells when some have arrived. */
export function wantColors(items: Iterable<MediaItem>): void {
  for (const m of items) {
    const key = keyOf(m)
    if (key && !known.has(key) && !reading.has(key) && !waiting.has(key)) waiting.set(key, m)
  }
  pump()
}

/** Calls `fn` (at most once a frame) when colours have arrived; returns the unsubscribe. */
export function onColors(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function pump(): void {
  while (reading.size < AT_ONCE && waiting.size) {
    const [key, m] = waiting.entries().next().value as [string, MediaItem]
    waiting.delete(key)
    reading.add(key)
    void read(m)
      .catch(() => '')
      .then((color) => {
        if (known.size >= KEEP) known.clear()
        known.set(key, color)
        reading.delete(key)
        if (!frame) frame = requestAnimationFrame(tell)
        pump()
      })
  }
}

function tell(): void {
  frame = 0
  for (const fn of listeners) fn()
}

async function read(m: MediaItem): Promise<string> {
  const blob = await (await fetch(mediaUrl(m.thumb!))).blob()
  const bmp = await createImageBitmap(blob, { resizeWidth: SIZE, resizeHeight: SIZE, resizeQuality: 'medium' })
  try {
    const g = new OffscreenCanvas(SIZE, SIZE).getContext('2d', { willReadFrequently: true })!
    g.drawImage(bmp, 0, 0)
    const px = g.getImageData(0, 0, SIZE, SIZE).data
    const adjust = adjustParams(m.edit?.adjust)
    if (adjust) adjustImageData(adjust, px)
    const sum = [0, 0, 0]
    for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += px[i + c]
    const n = px.length / 4
    return `rgb(${sum.map((v) => Math.round(v / n)).join(' ')})`
  } finally {
    bmp.close()
  }
}
