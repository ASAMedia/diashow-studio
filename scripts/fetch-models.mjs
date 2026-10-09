// Downloads the face detection model (MediaPipe BlazeFace short range, Apache-2.0) into
// vendor/models. Used for face-aware crops and Ken Burns.
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'vendor', 'models')
const MODELS = {
  'blaze_face_short_range.tflite':
    'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
}

mkdirSync(dir, { recursive: true })
for (const [name, url] of Object.entries(MODELS)) {
  const target = join(dir, name)
  if (existsSync(target) && !process.argv.includes('--force')) continue
  console.log('[fetch-models] downloading', name)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(target))
}
// the renderer loads the model and MediaPipe's wasm from ./vision next to index.html
const pub = join(root, 'src', 'renderer', 'public', 'vision')
mkdirSync(pub, { recursive: true })
const wasm = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
for (const f of readdirSync(wasm)) copyFileSync(join(wasm, f), join(pub, f))
for (const name of Object.keys(MODELS)) copyFileSync(join(dir, name), join(pub, name))
console.log('[fetch-models] done:', dir, pub)
