// Downloads the face models into vendor/models and copies them, with MediaPipe's wasm, to
// src/renderer/public/vision (loaded offline by the renderer):
// - face detection: MediaPipe BlazeFace short range (Apache-2.0), for face-aware crops, Ken Burns
//   and pixelation;
// - face recognition: dlib's face recognition ResNet (CC0 / public domain, by Davis King), as
//   converted and uint8-quantised by face-api.js (MIT) and shipped with @vladmandic/face-api (MIT),
//   for "pixelate this person everywhere". Taken from node_modules when present, else downloaded.
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'vendor', 'models')
const FACE_API = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model'
const MODELS = {
  'blaze_face_short_range.tflite':
    'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
  'face_recognition_model.bin': `${FACE_API}/face_recognition_model.bin`,
  'face_recognition_model-weights_manifest.json': `${FACE_API}/face_recognition_model-weights_manifest.json`
}
const faceApiModels = join(root, 'node_modules', '@vladmandic', 'face-api', 'model')

mkdirSync(dir, { recursive: true })
for (const [name, url] of Object.entries(MODELS)) {
  const target = join(dir, name)
  if (existsSync(target) && !process.argv.includes('--force')) continue
  const local = join(faceApiModels, name)
  if (existsSync(local)) {
    copyFileSync(local, target)
    continue
  }
  console.log('[fetch-models] downloading', name)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(target))
}
// the renderer loads the models and MediaPipe's wasm from ./vision next to index.html
const pub = join(root, 'src', 'renderer', 'public', 'vision')
mkdirSync(pub, { recursive: true })
const wasm = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
for (const f of readdirSync(wasm)) copyFileSync(join(wasm, f), join(pub, f))
for (const name of Object.keys(MODELS)) copyFileSync(join(dir, name), join(pub, name))
console.log('[fetch-models] done:', dir, pub)
