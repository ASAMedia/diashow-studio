// Pictures as they are edited (rotate, straighten, crop; shared/mediaEdit.ts; light and colour,
// shared/adjust.ts) outside the engine:
// - EditedPicture: the original <img> in a box of the edited picture, placed with the exact CSS matrix of
//   the edit; for the layers over the preview, which lay out in pixels anyway. With light and colour it
//   is a small WebGL canvas running the engine's own GLSL step instead, so it follows a slider live.
// - MediaThumb / useEditedUrl: a small edited copy (drawn once on a canvas, kept as an object URL) for
//   thumbnails in CSS layouts (filmstrip, review grid, slide tab, presenter), which stay plain <img>s.
//   Light and colour go through the same step in TypeScript (adjustImageData).
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ImgHTMLAttributes } from 'react'
import { mediaUrl } from '@shared/api'
import { editedSize, editKey, isChanged, isEdited, sourceAspect, sourceToEdit } from '@shared/mediaEdit'
import { ADJUST_GLSL, adjustImageData, adjustKey, adjustParams, type AdjustParams } from '@shared/adjust'
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
  const style: CSSProperties = { position: 'absolute', left: 0, top: 0, width: W, height: H, maxWidth: 'none', transformOrigin: '0 0', transform }
  const key = adjustKey(props.edit?.adjust)
  const params = useMemo(() => adjustParams(props.edit?.adjust), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`edited-pic ${props.className ?? ''}`} style={{ position: 'absolute', left: props.box.x, top: props.box.y, width: W, height: H, overflow: 'hidden' }}>
      {props.src && (params ? <AdjustedImage src={props.src} params={params} style={style} /> : <img src={props.src} alt="" draggable={false} style={style} />)}
    </div>
  )
}

// ---------------------------------------------------------------- light and colour on a canvas

const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x, 1.0 - a_pos.y);
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec4 u_adj;
uniform vec3 u_warm;
out vec4 o;
${ADJUST_GLSL}
void main() {
  vec4 c = texture(u_tex, v_uv);
  o = vec4(adjustColor(c.rgb, u_adj, u_warm) * c.a, c.a);
}`

interface Painter {
  upload(bmp: ImageBitmap): void
  draw(p: AdjustParams): void
  dispose(): void
}

/** A WebGL2 painter for one canvas: the picture as a texture, drawn through the adjustment step. */
function painter(canvas: HTMLCanvasElement): Painter {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false })
  if (!gl) throw new Error('WebGL2 is not available')
  const shader = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error')
    return s
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS))
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS))
  gl.bindAttribLocation(prog, 0, 'a_pos')
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error')
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v)
  gl.useProgram(prog)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0)
  const uAdj = gl.getUniformLocation(prog, 'u_adj')
  const uWarm = gl.getUniformLocation(prog, 'u_warm')
  return {
    upload(bmp) {
      canvas.width = bmp.width
      canvas.height = bmp.height
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp)
    },
    draw(p) {
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.uniform4f(uAdj, p.q, p.m, p.sat, 0)
      gl.uniform3f(uWarm, p.warm[0], p.warm[1], p.warm[2])
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}

/** Longest side of the picture on the canvas (display images and video stills are smaller anyway). */
const MAX_EDGE = 4096

/** `src` through the light and colour step; the plain <img> until it is drawn, or when WebGL fails. */
function AdjustedImage({ src, params, style }: { src: string; params: AdjustParams; style: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const paint = useRef<Painter | null>(null)
  const latest = useRef(params)
  latest.current = params
  const [drawn, setDrawn] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => () => paint.current?.dispose(), [])
  useEffect(() => {
    let alive = true
    void (async () => {
      const blob = await (await fetch(src)).blob()
      let bmp = await createImageBitmap(blob)
      if (Math.max(bmp.width, bmp.height) > MAX_EDGE) {
        const k = MAX_EDGE / Math.max(bmp.width, bmp.height)
        const big = bmp
        bmp = await createImageBitmap(big, { resizeWidth: Math.round(big.width * k), resizeHeight: Math.round(big.height * k), resizeQuality: 'high' })
        big.close()
      }
      try {
        if (!alive || !ref.current) return
        paint.current ??= painter(ref.current)
        paint.current.upload(bmp)
        paint.current.draw(latest.current)
        setDrawn(src)
      } finally {
        bmp.close()
      }
    })().catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [src])
  useEffect(() => {
    if (drawn) paint.current?.draw(params)
  }, [params, drawn])

  const ready = drawn === src && !failed
  return (
    <>
      {!ready && <img src={src} alt="" draggable={false} style={style} />}
      {!failed && <canvas ref={ref} data-adjusted="" style={{ ...style, pointerEvents: 'none', visibility: ready ? 'visible' : 'hidden' }} />}
    </>
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
    // light and colour: the shader's step, pixel by pixel (thumbnails are small)
    const p = adjustParams(edit.adjust)
    if (p) {
      const px = g.getImageData(0, 0, W, H)
      adjustImageData(p, px.data)
      g.putImageData(px, 0, 0)
    }
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
  const key = url && isChanged(edit) ? `${url}|${editKey(edit)}|${aspect.toFixed(4)}|${edge}` : ''
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
 * straightened, cropped and with its light and colour. A plain <img> of the cached file when unedited.
 */
export function MediaThumb({ m, edge = 360, ...img }: { m: MediaItem; edge?: number } & ImgHTMLAttributes<HTMLImageElement>) {
  const src = useEditedUrl(isEdited(m.edit) || edge > 400 ? pictureFor(m, edge) : m.thumb ? mediaUrl(m.thumb) : undefined, m.edit, sourceAspect(m), edge)
  return <img alt="" {...img} src={src} data-edited={isChanged(m.edit) ? '' : undefined} />
}
