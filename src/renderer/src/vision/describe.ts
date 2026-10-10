// Face descriptors, offline: dlib's face recognition ResNet (weights CC0, converted and quantised by
// face-api.js, MIT) on TensorFlow.js (Apache-2.0; WebGL, CPU as a fallback). A face becomes 128
// numbers; the same person gives close vectors (Euclidean distance, see @shared/people).
import { FaceRecognitionNet, NetInput, tf } from '@vladmandic/face-api'
import { CHIP_SIZE, chipTransform, eyeVisibility, recognisable, type Pt } from '@shared/faceAlign'
import type { Rect } from '@shared/types'

interface TfExtra {
  setBackend(name: string): Promise<boolean>
  ready(): Promise<void>
  getBackend(): string
}
const tfx = tf as unknown as TfExtra

let net: Promise<FaceRecognitionNet> | null = null
export let tfBackend = ''

/**
 * WebGL emulated on the CPU (no graphics driver: SwiftShader, llvmpipe, Microsoft Basic Render)
 * runs in the same GPU process as the preview and would stall it; the CPU backend doesn't.
 */
function softwareWebGL(): boolean {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2')
    if (!gl) return true
    const renderer = String(gl.getParameter(gl.RENDERER) ?? '')
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return /swiftshader|llvmpipe|softpipe|basic render|software/i.test(renderer)
  } catch {
    return true
  }
}

/** Loads the recognition model (face_recognition_model.bin, 6.4 MB) from `base`. */
export function loadRecognizer(base: string): Promise<FaceRecognitionNet> {
  net ??= (async () => {
    // WebGL through an OffscreenCanvas; the CPU backend is slower but always there
    if (softwareWebGL() || !(await tfx.setBackend('webgl').catch(() => false))) await tfx.setBackend('cpu')
    await tfx.ready()
    tfBackend = tfx.getBackend()
    const manifest = (await (await fetch(`${base}face_recognition_model-weights_manifest.json`)).json()) as { weights: Parameters<typeof tf.io.decodeWeights>[1] }[]
    const bin = await (await fetch(`${base}face_recognition_model.bin`)).arrayBuffer()
    const n = new FaceRecognitionNet()
    n.loadFromWeightMap(tf.io.decodeWeights(bin, manifest[0].weights))
    return n
  })()
  net.catch(() => (net = null))
  return net
}

/** The face as the model wants it: 150 x 150, eyes and mouth in place, from the full-size picture. */
export function chip(src: ImageBitmap, face: { r: Rect; kp?: Pt[] }): ImageData {
  const W = src.width
  const H = src.height
  const box = { x: face.r.x * W, y: face.r.y * H, w: face.r.w * W, h: face.r.h * H }
  const kp = face.kp?.map(([x, y]): Pt => [x * W, y * H])
  const t = chipTransform(box, kp)
  const canvas = new OffscreenCanvas(CHIP_SIZE, CHIP_SIZE)
  const g = canvas.getContext('2d', { willReadFrequently: true })!
  g.fillStyle = '#000'
  g.fillRect(0, 0, CHIP_SIZE, CHIP_SIZE)
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.setTransform(t.a, t.b, -t.b, t.a, t.tx, t.ty)
  g.drawImage(src, 0, 0)
  return g.getImageData(0, 0, CHIP_SIZE, CHIP_SIZE)
}

const BATCH = 1

/** A face to describe: box and keypoints normalised to the picture, detector confidence. */
export interface FaceIn {
  r: Rect
  kp?: Pt[]
  score: number
}

/**
 * Descriptors (128 numbers, 3 decimals) of the faces in `src`, in order. Faces that can't be
 * recognised reliably (eyes covered by goggles or sunglasses, too small, unsure detections) get an
 * empty descriptor: they are never taken for someone.
 */
export async function describe(base: string, src: ImageBitmap, faces: FaceIn[]): Promise<number[][]> {
  if (!faces.length) return []
  const n = await loadRecognizer(base)
  const out: number[][] = []
  // One face at a time: WebGL programs are compiled per tensor shape, so a changing batch size
  // would compile them again; single faces also leave the GPU free for the preview in between.
  for (let i = 0; i < faces.length; i += BATCH) {
    const group = faces.slice(i, i + BATCH)
    const chips = group.map((f) => chip(src, f))
    const usable = group.map((f, k) => {
      const eyePx = f.kp ? Math.hypot((f.kp[1][0] - f.kp[0][0]) * src.width, (f.kp[1][1] - f.kp[0][1]) * src.height) : f.r.w * src.width * 0.4
      return recognisable(f.score, eyePx, eyeVisibility(chips[k].data))
    })
    const inputs = chips.filter((_, k) => usable[k]).map((c) => tf.browser.fromPixels(c))
    if (!inputs.length) {
      group.forEach(() => out.push([]))
      continue
    }
    // straight into the network: face-api's input helpers expect DOM elements (no worker support)
    const res = n.forwardInput(new NetInput(inputs, true))
    try {
      const data = await res.data()
      let k = 0
      for (const ok of usable) {
        if (!ok) out.push([])
        else {
          out.push(Array.from(data.subarray(k * 128, k * 128 + 128), (v) => Math.round(v * 1e3) / 1e3))
          k++
        }
      }
    } finally {
      res.dispose()
      inputs.forEach((x) => x.dispose())
    }
  }
  return out
}
