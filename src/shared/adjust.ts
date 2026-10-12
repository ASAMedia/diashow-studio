// Light and colour of a photo or video (MediaEdit.adjust), like the "Light" and "Color" basics in the
// edit view of macOS Photos: brightness, contrast, warmth and saturation, each -100..100 (0 = as shot).
//
// The per-pixel math lives here once, in two languages that must agree:
// - ADJUST_GLSL: one step of the engine's picture shader (QUAD_FS) and of the editing layers
//   (EditedPicture), fed with adjustParams() as uniforms per drawn picture;
// - adjustPixel / adjustImageData: the same lines in TypeScript, for the small edited copies
//   (thumbnails). tests/adjust.test.ts runs the GLSL source as JavaScript and compares the two.
//
// On gamma-encoded sRGB values in 0..1 (as the colour looks), in this order:
// 1. warmth: a shift along a luma-neutral amber/blue direction, in proportion to the pixel's luma (black
//    stays black), only as far as every channel stays inside 0..1, so the luma stays exactly;
// 2. brightness: a rational curve through 0 and 1 (nothing clips): the shadows times 1/q, the highlights
//    rolled off with slope q; +b and -b undo each other;
// 3. contrast: Schlick's gain curve around 0.5, slope m at the midtones and 1/m at black and white;
// 4. saturation: the distance from the pixel's grey scaled, at most as far as it stays in range.
// Each stage looks at one pixel alone. An area the shader has already pixelated (one colour per block)
// therefore stays one colour per block: an adjustment can't bring back any detail of a face.
import type { MediaAdjust } from './types'

export const ADJUST_KEYS = ['brightness', 'contrast', 'warmth', 'saturation'] as const
export type AdjustKey = (typeof ADJUST_KEYS)[number]
/** Each slider goes from -ADJUST_MAX to ADJUST_MAX. */
export const ADJUST_MAX = 100

/** Luma weights (BT.709), as in the colour looks and the export's YUV. */
export const LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722]
/** Warmth's direction: red up, blue down, green so that the luma stays (LUMA · WARM_DIR = 0). */
export const WARM_DIR: readonly [number, number, number] = [0.6, -(0.6 * LUMA[0] - LUMA[2]) / LUMA[1], -1]
/** Warmth at ±100: the shift of a pixel of luma 1 along WARM_DIR (enough to neutralise indoor light). */
const WARM_GAIN = 0.3
/** Brightness at ±100 multiplies or divides the shadows by this (the midtone 0.5 goes to 0.75 or 0.25). */
const BRIGHT_BASE = 3
/** Contrast at ±100 doubles or halves the slope at the midtones. */
const CONTRAST_BASE = 2

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clampValue = (v: number): number => Math.min(ADJUST_MAX, Math.max(-ADJUST_MAX, v))
const valueOf = (a: MediaAdjust, k: AdjustKey): number => (finite(a[k]) ? clampValue(a[k]) : 0)

/** True when the adjustment changes the picture. */
export function isAdjusted(a: MediaAdjust | undefined | null): a is MediaAdjust {
  return !!a && ADJUST_KEYS.some((k) => valueOf(a, k) !== 0)
}

/** Short key of an adjustment for caches ('' when it changes nothing). */
export function adjustKey(a: MediaAdjust | undefined): string {
  return isAdjusted(a) ? ADJUST_KEYS.map((k) => valueOf(a, k)).join(',') : ''
}

/**
 * The adjustment as it is stored: whole numbers inside -100..100, zeros left out, undefined when nothing
 * is left (fields of a newer app stay).
 */
export function normalizeAdjust(a: MediaAdjust | undefined): MediaAdjust | undefined {
  if (!a) return undefined
  const out: Record<string, unknown> = { ...a }
  for (const k of ADJUST_KEYS) {
    const v = Math.round(valueOf(a, k))
    if (v) out[k] = v
    else delete out[k]
  }
  return Object.keys(out).length ? (out as MediaAdjust) : undefined
}

/**
 * A usable adjustment from stored data (project files): numbers clamped to -100..100, other values
 * dropped, zeros left out without counting as damage. `fixed` tells whether anything had to change.
 */
export function sanitizeAdjust(raw: unknown): { adjust: MediaAdjust | undefined; fixed: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { adjust: undefined, fixed: true }
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
  let fixed = false
  for (const k of ADJUST_KEYS) {
    const v = out[k]
    if (v === undefined) continue
    if (!finite(v)) {
      delete out[k]
      fixed = true
    } else if (v === 0) delete out[k]
    else if (clampValue(v) !== v) {
      out[k] = clampValue(v)
      fixed = true
    }
  }
  return { adjust: Object.keys(out).length ? (out as MediaAdjust) : undefined, fixed }
}

/** The adjustment with some sliders set (the others as they were), as it is stored. */
export function withAdjust(a: MediaAdjust | undefined, patch: MediaAdjust): MediaAdjust | undefined {
  return normalizeAdjust({ ...a, ...patch })
}

// ---------------------------------------------------------------- the per-pixel step

/** Uniforms of the step: brightness curve q, contrast slope m, saturation factor, warmth shift per unit of luma. */
export interface AdjustParams {
  q: number
  m: number
  sat: number
  warm: [number, number, number]
}

/** The numbers the per-pixel step works with, null when the adjustment changes nothing (no step at all). */
export function adjustParams(a: MediaAdjust | undefined | null): AdjustParams | null {
  if (!isAdjusted(a)) return null
  const v = (k: AdjustKey): number => valueOf(a, k) / ADJUST_MAX
  const w = v('warmth') * WARM_GAIN
  return {
    q: BRIGHT_BASE ** -v('brightness'),
    m: CONTRAST_BASE ** v('contrast'),
    sat: 1 + v('saturation'),
    warm: [w * WARM_DIR[0], w * WARM_DIR[1], w * WARM_DIR[2]]
  }
}

/**
 * GLSL of the step: `adjustColor(rgb, vec4(q, m, sat, 0), warm)`. Written as scalar statements that are
 * also valid JavaScript once the types are dropped (the unit test runs it that way); adjustInto below
 * is the same, line for line.
 */
export const ADJUST_GLSL = `
// how many times a channel at c can move by d before it leaves 0..1
float adjRoom(float c, float d) {
  return d > 1e-6 ? (1.0 - c) / d : (d < -1e-6 ? c / -d : 1e6);
}
// brightness: a curve through 0 and 1 with slope 1/q at black; contrast: Schlick's gain around 0.5
float adjTone(float c, float q, float m) {
  c = c / ((q - 1.0) * (1.0 - c) + 1.0);
  float t = c < 0.5 ? 2.0 * c : 2.0 - 2.0 * c;
  float e = t / ((m - 1.0) * (1.0 - t) + 1.0);
  return c < 0.5 ? 0.5 * e : 1.0 - 0.5 * e;
}
vec3 adjustColor(vec3 c, vec4 a, vec3 w) {
  float r = clamp(c.r, 0.0, 1.0);
  float g = clamp(c.g, 0.0, 1.0);
  float b = clamp(c.b, 0.0, 1.0);
  float y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  float k = min(1.0, min(adjRoom(r, w.x * y), min(adjRoom(g, w.y * y), adjRoom(b, w.z * y))));
  r = r + k * w.x * y;
  g = g + k * w.y * y;
  b = b + k * w.z * y;
  r = adjTone(r, a.x, a.y);
  g = adjTone(g, a.x, a.y);
  b = adjTone(b, a.x, a.y);
  y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  float s = a.z - 1.0;
  if (s > 0.0) s = min(s, min(adjRoom(r, r - y), min(adjRoom(g, g - y), adjRoom(b, b - y))));
  r = r + s * (r - y);
  g = g + s * (g - y);
  b = b + s * (b - y);
  return vec3(clamp(r, 0.0, 1.0), clamp(g, 0.0, 1.0), clamp(b, 0.0, 1.0));
}
`

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

function room(c: number, d: number): number {
  return d > 1e-6 ? (1 - c) / d : d < -1e-6 ? c / -d : 1e6
}

function tone(c: number, q: number, m: number): number {
  c = c / ((q - 1) * (1 - c) + 1)
  const t = c < 0.5 ? 2 * c : 2 - 2 * c
  const e = t / ((m - 1) * (1 - t) + 1)
  return c < 0.5 ? 0.5 * e : 1 - 0.5 * e
}

/** adjustColor of ADJUST_GLSL on one pixel (0..1), written into `out`. */
function adjustInto(p: AdjustParams, r0: number, g0: number, b0: number, out: number[]): void {
  const w = p.warm
  let r = clamp01(r0)
  let g = clamp01(g0)
  let b = clamp01(b0)
  let y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
  const k = Math.min(1, Math.min(room(r, w[0] * y), Math.min(room(g, w[1] * y), room(b, w[2] * y))))
  r = r + k * w[0] * y
  g = g + k * w[1] * y
  b = b + k * w[2] * y
  r = tone(r, p.q, p.m)
  g = tone(g, p.q, p.m)
  b = tone(b, p.q, p.m)
  y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
  let s = p.sat - 1
  if (s > 0) s = Math.min(s, Math.min(room(r, r - y), Math.min(room(g, g - y), room(b, b - y))))
  out[0] = clamp01(r + s * (r - y))
  out[1] = clamp01(g + s * (g - y))
  out[2] = clamp01(b + s * (b - y))
}

/** One pixel (0..1) through the step. */
export function adjustPixel(p: AdjustParams, r: number, g: number, b: number): [number, number, number] {
  const out = [0, 0, 0]
  adjustInto(p, r, g, b, out)
  return out as [number, number, number]
}

/** RGBA bytes (a canvas's ImageData) through the step, in place; alpha stays. */
export function adjustImageData(p: AdjustParams, data: Uint8ClampedArray): void {
  const out = [0, 0, 0]
  for (let i = 0; i < data.length; i += 4) {
    adjustInto(p, data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, out)
    // a clamped array rounds to the nearest byte, as the GPU does when it writes a pixel
    data[i] = out[0] * 255
    data[i + 1] = out[1] * 255
    data[i + 2] = out[2] * 255
  }
}
