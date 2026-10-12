// Light and colour (shared/adjust.ts): the colour math (neutral at 0, monotonic, never NaN or out of
// range, warmth and saturation keep the luma), the GLSL step and the TypeScript step giving the same
// colours, a pixelated block staying one colour, and stored adjustments in project files.
import { describe, expect, it } from 'vitest'
import {
  ADJUST_GLSL, ADJUST_KEYS, adjustImageData, adjustKey, adjustParams, adjustPixel, isAdjusted, LUMA, normalizeAdjust, sanitizeAdjust, withAdjust,
  type AdjustParams
} from '@shared/adjust'
import { editKey, isChanged, isEdited, normalizeEdit, rotateEdit, sanitizeEdit } from '@shared/mediaEdit'
import { DEFAULT_SETTINGS, type MediaAdjust, type MediaItem, type Project } from '@shared/types'
import { PROJECT_VERSION, validateProject } from '../src/main/projectSchema'

type RGB = [number, number, number]
const luma = (c: readonly number[]): number => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2]

/** Deterministic pseudo random numbers. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
}

/** Colours that tend to break things (black, white, primaries, out of range) and random ones. */
function colours(n: number, seed = 1): RGB[] {
  const r = rng(seed)
  const edge: RGB[] = [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1], [0.5, 0.5, 0.5], [0.02, 0.01, 0.0], [0.99, 0.98, 1], [-0.1, 1.2, 0.5]]
  return [...edge, ...Array.from({ length: n }, () => [r(), r(), r()] as RGB)]
}

/** Every slider at -100, 0 and 100, and random values in between. */
function settings(n: number, seed = 2): MediaAdjust[] {
  const out: MediaAdjust[] = []
  const vals = [-100, 0, 100]
  for (const b of vals) for (const c of vals) for (const w of vals) for (const s of vals) out.push({ brightness: b, contrast: c, warmth: w, saturation: s })
  const r = rng(seed)
  for (let i = 0; i < n; i++) out.push(Object.fromEntries(ADJUST_KEYS.map((k) => [k, Math.round((r() - 0.5) * 200)])))
  return out
}

/** The step as the shader would run it with every slider at 0 (the engine skips it then). */
const NEUTRAL: AdjustParams = { q: 1, m: 1, sat: 1, warm: [0, 0, 0] }
const params = (a: MediaAdjust): AdjustParams => adjustParams(a) ?? NEUTRAL
const grey = (a: MediaAdjust, v: number): number => adjustPixel(params(a), v, v, v)[0]

/**
 * ADJUST_GLSL as a JavaScript function: the types dropped, GLSL's built-ins as small helpers. Fails on
 * syntax this little translation doesn't know, so the shader stays checkable.
 */
function glslAsJs(src: string): (p: AdjustParams, c: RGB) => RGB {
  const js = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\b(?:float|vec3|vec4)\s+(\w+)\s*\(([^)]*)\)\s*\{/g, (_m, name: string, args: string) => `function ${name}(${args.split(',').map((a) => a.trim().split(/\s+/).pop()).join(', ')}) {`)
    .replace(/\bfloat\s+(\w+)\s*=/g, 'let $1 =')
  expect(js).not.toMatch(/\b(float|int|vec[234]|mat[234]|uniform)\s/)
  const helpers = 'const clamp = (v, a, b) => Math.min(b, Math.max(a, v)); const min = Math.min; const max = Math.max; const vec3 = (r, g, b) => [r, g, b];'
  const adjustColor = new Function(`${helpers}\n${js}\nreturn adjustColor;`)() as (c: object, a: object, w: object) => RGB
  return (p, c) => adjustColor({ r: c[0], g: c[1], b: c[2] }, { x: p.q, y: p.m, z: p.sat, w: 0 }, { x: p.warm[0], y: p.warm[1], z: p.warm[2] })
}

describe('light and colour: the colour math', () => {
  it('changes nothing at 0', () => {
    expect(adjustParams(undefined)).toBeNull()
    expect(adjustParams({})).toBeNull()
    expect(adjustParams({ brightness: 0, contrast: 0, warmth: 0, saturation: 0 })).toBeNull()
    expect(isAdjusted({ brightness: 0 })).toBe(false)
    expect(isAdjusted({ warmth: -3 })).toBe(true)
    // the step itself is the identity with neutral numbers
    for (const c of colours(300)) {
      const out = adjustPixel(NEUTRAL, ...c)
      for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(Math.min(1, Math.max(0, c[i])), 12)
    }
    // and 8-bit pixels come back as they were
    const px = new Uint8ClampedArray(256 * 4).map((_, i) => (i * 37) % 256)
    const copy = px.slice()
    adjustImageData(NEUTRAL, px)
    expect([...px]).toEqual([...copy])
  })

  it('never gives NaN or values outside 0..1', () => {
    for (const a of settings(200)) {
      const p = params(a)
      for (const c of colours(60)) {
        for (const v of adjustPixel(p, ...c)) {
          expect(Number.isFinite(v), `${JSON.stringify(a)} ${c}`).toBe(true)
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('brightness and contrast: monotonic curves through black and white, nothing clipped hard', () => {
    for (const k of ['brightness', 'contrast'] as const) {
      for (let v = -100; v <= 100; v += 10) {
        const a = { [k]: v }
        expect(grey(a, 0)).toBeCloseTo(0, 12)
        expect(grey(a, 1)).toBeCloseTo(1, 12)
        // brighter input, brighter output, and no flat run (a hard clip) anywhere
        let last = -1
        for (let x = 0; x <= 1.0001; x += 1 / 64) {
          const y = grey(a, Math.min(1, x))
          expect(y, `${k} ${v} at ${x}`).toBeGreaterThan(last)
          last = y
        }
      }
    }
    // more brightness lifts every midtone; a lift of 100 takes 0.5 to 0.75, -100 to 0.25
    for (const x of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      let last = -1
      for (let v = -100; v <= 100; v += 10) {
        const y = grey({ brightness: v }, x)
        expect(y).toBeGreaterThan(last)
        last = y
      }
    }
    expect(grey({ brightness: 100 }, 0.5)).toBeCloseTo(0.75, 9)
    expect(grey({ brightness: -100 }, 0.5)).toBeCloseTo(0.25, 9)
    // +b and -b undo each other
    for (const x of [0.1, 0.3, 0.6, 0.9]) expect(grey({ brightness: -40 }, grey({ brightness: 40 }, x))).toBeCloseTo(x, 9)
    // contrast turns around the midtones: darker shadows and brighter highlights, 0.5 stays
    expect(grey({ contrast: 60 }, 0.5)).toBeCloseTo(0.5, 9)
    expect(grey({ contrast: 60 }, 0.25)).toBeLessThan(0.25)
    expect(grey({ contrast: 60 }, 0.75)).toBeGreaterThan(0.75)
    expect(grey({ contrast: -60 }, 0.25)).toBeGreaterThan(0.25)
    expect(grey({ contrast: -60 }, 0.75)).toBeLessThan(0.75)
  })

  it('warmth turns grey amber or blue and keeps the luma', () => {
    const warm = adjustPixel(params({ warmth: 60 }), 0.5, 0.5, 0.5)
    const cool = adjustPixel(params({ warmth: -60 }), 0.5, 0.5, 0.5)
    expect(warm[0]).toBeGreaterThan(0.55)
    expect(warm[2]).toBeLessThan(0.45)
    expect(cool[0]).toBeLessThan(0.45)
    expect(cool[2]).toBeGreaterThan(0.55)
    // black stays black, white stays white (no colour cast where nothing can move)
    expect(adjustPixel(params({ warmth: 100 }), 0, 0, 0)).toEqual([0, 0, 0])
    expect(adjustPixel(params({ warmth: 100 }), 1, 1, 1).map((v) => +v.toFixed(9))).toEqual([1, 1, 1])
    for (const w of [-100, -50, -10, 10, 50, 100]) {
      for (const c of colours(400, 3)) {
        const inRange = c.map((v) => Math.min(1, Math.max(0, v)))
        expect(Math.abs(luma(adjustPixel(params({ warmth: w }), ...c)) - luma(inRange)), `${w} ${c}`).toBeLessThan(1e-9)
      }
    }
    // in 8-bit pixels the luma stays within rounding
    const r = rng(5)
    const px = new Uint8ClampedArray(4000).map(() => Math.floor(r() * 256))
    const before = px.slice()
    adjustImageData(params({ warmth: -80 }), px)
    for (let i = 0; i < px.length; i += 4) expect(Math.abs(luma([px[i], px[i + 1], px[i + 2]]) - luma([before[i], before[i + 1], before[i + 2]]))).toBeLessThan(1)
  })

  it('saturation keeps the luma: -100 is grey, +100 stops at the edge of the colours', () => {
    for (const c of colours(300, 4)) {
      const inRange = c.map((v) => Math.min(1, Math.max(0, v)))
      const y = luma(inRange)
      const flat = adjustPixel(params({ saturation: -100 }), ...c)
      for (const v of flat) expect(v).toBeCloseTo(y, 9)
      for (const s of [-50, 40, 100]) expect(Math.abs(luma(adjustPixel(params({ saturation: s }), ...c)) - y)).toBeLessThan(1e-9)
    }
    // a muted colour gets more colourful
    const muted: RGB = [0.6, 0.5, 0.4]
    const vivid = adjustPixel(params({ saturation: 50 }), ...muted)
    expect(vivid[0] - vivid[2]).toBeGreaterThan(0.2 * 1.4)
  })

  it('the shader (GLSL) and the thumbnails (TypeScript) give the same colours', () => {
    const shader = glslAsJs(ADJUST_GLSL)
    let n = 0
    for (const a of settings(120, 6)) {
      const p = params(a)
      for (const c of colours(40, 7)) {
        const gpu = shader(p, c)
        const cpu = adjustPixel(p, ...c)
        for (let i = 0; i < 3; i++) expect(Math.abs(gpu[i] - cpu[i]), `${JSON.stringify(a)} ${c}`).toBeLessThan(1e-12)
        n++
      }
    }
    expect(n).toBeGreaterThan(5000)
    // a few colours spelled out: brighter and warmer
    const p = params({ brightness: 40, warmth: 40 })
    for (const c of [[0.2, 0.3, 0.4], [0.5, 0.5, 0.5], [0.8, 0.6, 0.3]] as RGB[]) {
      const out = shader(p, c)
      expect(out).toEqual(adjustPixel(p, ...c))
      expect(luma(out)).toBeGreaterThan(luma(c))
      expect(out[0] - out[2]).toBeGreaterThan(c[0] - c[2])
    }
  })

  it('a pixelated block stays one colour, however bright it gets', () => {
    // a 16 x 16 "face" of fine detail, pixelated as the shader does it: every pixel gets the block's mean
    const r = rng(8)
    const N = 16
    const face = Array.from({ length: N * N }, () => [r(), r(), r()] as RGB)
    const mean = [0, 1, 2].map((i) => face.reduce((s, c) => s + c[i], 0) / face.length) as RGB
    const block = new Uint8ClampedArray(N * N * 4)
    for (let i = 0; i < N * N; i++) block.set([mean[0] * 255, mean[1] * 255, mean[2] * 255, 255], i * 4)
    for (const a of [{ brightness: 100 }, { brightness: 100, contrast: 100, saturation: 100 }, { brightness: -100, warmth: 100 }, { contrast: 100 }]) {
      const px = block.slice()
      adjustImageData(params(a), px)
      for (let i = 4; i < px.length; i += 4) expect([px[i], px[i + 1], px[i + 2]]).toEqual([px[0], px[1], px[2]])
      // the step looks at one pixel alone: the block's colour decides, never the detail under it
      const one = adjustPixel(params(a), ...mean)
      expect(Math.abs(one[0] * 255 - px[0])).toBeLessThanOrEqual(1)
    }
  })
})

describe('light and colour: stored with the edit', () => {
  it('is kept with the edit, apart from the geometry', () => {
    const adjust = { brightness: 30, warmth: -20 }
    expect(isEdited({ rotate: 0, straighten: 0, adjust })).toBe(false)
    expect(isChanged({ rotate: 0, straighten: 0, adjust })).toBe(true)
    expect(isChanged({ rotate: 0, straighten: 0, adjust: { brightness: 0 } })).toBe(false)
    expect(normalizeEdit({ rotate: 0, straighten: 0, adjust })).toEqual({ rotate: 0, straighten: 0, adjust })
    expect(normalizeEdit({ rotate: 0, straighten: 0, adjust: { brightness: 0 } })).toBeUndefined()
    expect(normalizeEdit({ rotate: 90, straighten: 0, adjust: { contrast: 0 } })).toEqual({ rotate: 90, straighten: 0 })
    // whole numbers inside ±100, zeros left out
    expect(normalizeAdjust({ brightness: 12.6, contrast: 300, warmth: 0, saturation: -0.2 })).toEqual({ brightness: 13, contrast: 100 })
    expect(withAdjust({ brightness: 30 }, { warmth: 10 })).toEqual({ brightness: 30, warmth: 10 })
    expect(withAdjust({ brightness: 30 }, { brightness: 0 })).toBeUndefined()
    // caches see the change; turning the picture keeps it
    expect(editKey({ rotate: 0, straighten: 0, adjust })).not.toBe('')
    expect(editKey({ rotate: 0, straighten: 0, adjust })).not.toBe(editKey({ rotate: 0, straighten: 0, adjust: { brightness: 31, warmth: -20 } }))
    expect(editKey({ rotate: 90, straighten: 0, adjust })).not.toBe(editKey({ rotate: 90, straighten: 0 }))
    expect(adjustKey({ brightness: 0 })).toBe('')
    expect(rotateEdit({ rotate: 0, straighten: 0, adjust }, 1)).toEqual({ rotate: 90, straighten: 0, adjust })
  })

  it('is clamped or dropped when a stored value is wrong', () => {
    expect(sanitizeAdjust({ brightness: 20, warmth: -5 })).toEqual({ adjust: { brightness: 20, warmth: -5 }, fixed: false })
    expect(sanitizeAdjust({ brightness: 250, contrast: -101 })).toEqual({ adjust: { brightness: 100, contrast: -100 }, fixed: true })
    expect(sanitizeAdjust({ brightness: 'bright', warmth: Number.NaN, saturation: 10 })).toEqual({ adjust: { saturation: 10 }, fixed: true })
    expect(sanitizeAdjust({ brightness: 0 })).toEqual({ adjust: undefined, fixed: false })
    expect(sanitizeAdjust('dark')).toEqual({ adjust: undefined, fixed: true })
    // a newer app's sliders survive
    expect(sanitizeAdjust({ brightness: 10, highlights: -30 }).adjust).toEqual({ brightness: 10, highlights: -30 })
    // inside the edit: an edit of light and colour alone is kept
    expect(sanitizeEdit({ rotate: 0, straighten: 0, adjust: { warmth: 40 } })).toEqual({ edit: { rotate: 0, straighten: 0, adjust: { warmth: 40 } }, fixed: false })
    expect(sanitizeEdit({ rotate: 90, straighten: 0, adjust: [1, 2] })).toEqual({ edit: { rotate: 90, straighten: 0 }, fixed: true })
    expect(sanitizeEdit({ rotate: 0, straighten: 0, adjust: { brightness: 0 } })).toEqual({ edit: undefined, fixed: false })
    // what the editor stores is read back without a repair
    const r = rng(9)
    for (let i = 0; i < 200; i++) {
      const e = normalizeEdit({ rotate: 0, straighten: (r() - 0.5) * 4, adjust: Object.fromEntries(ADJUST_KEYS.map((k) => [k, (r() - 0.5) * 260])) })
      if (!e) continue
      const again = sanitizeEdit(JSON.parse(JSON.stringify(e)))
      expect(again.fixed, JSON.stringify(e)).toBe(false)
      expect(again.edit).toEqual(e)
    }
  })

  it('is repaired in project files without a new format version', () => {
    expect(PROJECT_VERSION).toBe(1)
    const m = (id: string, edit: unknown): MediaItem =>
      ({ id, path: `C:\\Fotos\\${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: 4000, height: 3000, captureTime: 1, status: 'ready', thumb: 'C:\\t.jpg', display: 'C:\\d.jpg', edit }) as MediaItem
    const project: Project = {
      version: 1,
      id: 'p',
      name: 'Light',
      createdAt: 1,
      updatedAt: 2,
      entries: ['a', 'b', 'c', 'd'].map((id) => ({ id: `e${id}`, type: 'photo' as const, mediaId: id })),
      media: [
        m('a', { rotate: 0, straighten: 0, adjust: { brightness: 35, contrast: 10, warmth: -25, saturation: 5 } }),
        m('b', { rotate: 90, straighten: 0, adjust: { brightness: 400 } }),
        m('c', { rotate: 0, straighten: 0, adjust: { warmth: 'warm' } }),
        m('d', { rotate: 0, straighten: 0, adjust: 'nonsense' })
      ],
      music: [],
      settings: structuredClone(DEFAULT_SETTINGS)
    }
    const valid = validateProject({ ...project, media: [project.media[0]], entries: [project.entries[0]] })
    expect(valid.report.changes).toEqual([])
    expect(valid.project.media[0].edit).toEqual(project.media[0].edit)
    const { project: fixed, report } = validateProject(structuredClone(project))
    expect(report.changes).toEqual([{ code: 'mediaRepaired', count: 3 }])
    expect(fixed.media.map((x) => x.edit)).toEqual([project.media[0].edit, { rotate: 90, straighten: 0, adjust: { brightness: 100 } }, undefined, undefined])
  })
})
