// Pictures as they are edited (rotate, straighten, crop; shared/mediaEdit.ts) outside the engine:
// - EditedPicture: the original <img> in a box of the edited picture, placed with the exact CSS matrix of
//   the edit; for the layers over the preview, which lay out in pixels anyway.
// - MediaThumb / useEditedUrl: a small edited copy (drawn once on a canvas, kept as an object URL) for
//   thumbnails in CSS layouts (filmstrip, review grid, slide tab, presenter), which stay plain <img>s.
import { useEffect, useState, type ImgHTMLAttributes } from 'react'
import { mediaUrl } from '@shared/api'
import { editedSize, editKey, isEdited, sourceAspect, sourceToEdit } from '@shared/mediaEdit'
import type { MediaEdit, MediaItem } from '@shared/types'

export interface PxBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The picture `src` (the original, `aspect` = its width / height) as edited, filling `box` (which has
 * the edited aspect). `crop` false shows the straightened picture before the crop (the edit view).
 */
export function EditedPicture(props: { src?: string; edit?: MediaEdit; aspect: number; box: PxBox; crop?: boolean; className?: string }) {
  const { w: W, h: H } = props.box
  // the <img> covers the box (original uv (x, y) at (x·W, y·H)); the matrix takes it where the edit puts it
  const m = sourceToEdit(props.edit, props.aspect, props.crop ?? true)
  const transform = `matrix(${m[0]}, ${(m[1] * H) / W}, ${(m[2] * W) / H}, ${m[3]}, ${m[4] * W}, ${m[5] * H})`
  return (
    <div className={`edited-pic ${props.className ?? ''}`} style={{ position: 'absolute', left: props.box.x, top: props.box.y, width: W, height: H, overflow: 'hidden' }}>
      {props.src && (
        <img src={props.src} alt="" draggable={false} style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, maxWidth: 'none', transformOrigin: '0 0', transform }} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- edited copies

const ready = new Map<string, string>()
const making = new Map<string, Promise<string>>()
const MAX_COPIES = 300

async function render(url: string, edit: MediaEdit, aspect: number, edge: number): Promise<string> {
  const bmp = await createImageBitmap(await (await fetch(url)).blob())
  try {
    const size = editedSize(bmp.width, bmp.height, edit)
    const k = Math.min(1, edge / Math.max(size.w, size.h))
    const W = Math.max(1, Math.round(size.w * k))
    const H = Math.max(1, Math.round(size.h * k))
    const c = new OffscreenCanvas(W, H)
    const g = c.getContext('2d')!
    g.imageSmoothingQuality = 'high'
    // pixels of the original -> uv of the original -> uv of the edited picture -> pixels of the copy
    const m = sourceToEdit(edit, aspect)
    g.setTransform((m[0] * W) / bmp.width, (m[1] * H) / bmp.width, (m[2] * W) / bmp.height, (m[3] * H) / bmp.height, m[4] * W, m[5] * H)
    g.drawImage(bmp, 0, 0)
    return URL.createObjectURL(await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 }))
  } finally {
    bmp.close()
  }
}

function make(key: string, url: string, edit: MediaEdit, aspect: number, edge: number): Promise<string> {
  let p = making.get(key)
  if (!p) {
    p = render(url, edit, aspect, edge).then((u) => {
      ready.set(key, u)
      if (ready.size > MAX_COPIES) {
        const [oldKey, old] = ready.entries().next().value!
        ready.delete(oldKey)
        making.delete(oldKey)
        URL.revokeObjectURL(old)
      }
      return u
    })
    p.catch(() => making.delete(key))
    making.set(key, p)
  }
  return p
}

/**
 * `url` (a picture of the original, `aspect` its width / height) as edited, `edge` px on its long side;
 * the url itself when unedited, undefined while the copy is being made.
 */
export function useEditedUrl(url: string | undefined, edit: MediaEdit | undefined, aspect: number, edge = 480): string | undefined {
  const key = url && isEdited(edit) ? `${url}|${editKey(edit)}|${aspect.toFixed(4)}|${edge}` : ''
  const [, setDone] = useState('')
  useEffect(() => {
    if (!key || ready.has(key)) return
    let alive = true
    make(key, url!, edit!, aspect, edge)
      .then(() => alive && setDone(key))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return key ? ready.get(key) : url
}

/**
 * The cached picture of a media item to show at about `edge` px: the thumbnail, or the display image
 * when the edit keeps only a small part of the picture (a crop of the thumbnail would be blurry).
 */
export function pictureFor(m: MediaItem, edge: number): string | undefined {
  const part = editedSize(1, 1, m.edit)
  const big = !!m.display && (edge > 400 || (isEdited(m.edit) && part.w * part.h < 0.3))
  const path = big ? m.display : (m.thumb ?? m.display)
  return path ? mediaUrl(path) : undefined
}

/**
 * A media item's thumbnail (or, with a large `edge`, its display image) as it is shown: rotated,
 * straightened and cropped. A plain <img> of the cached file when unedited.
 */
export function MediaThumb({ m, edge = 360, ...img }: { m: MediaItem; edge?: number } & ImgHTMLAttributes<HTMLImageElement>) {
  const src = useEditedUrl(isEdited(m.edit) || edge > 400 ? pictureFor(m, edge) : m.thumb ? mediaUrl(m.thumb) : undefined, m.edit, sourceAspect(m), edge)
  return <img alt="" {...img} src={src} data-edited={isEdited(m.edit) ? '' : undefined} />
}
