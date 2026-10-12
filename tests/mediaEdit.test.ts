// Rotate, straighten and crop (shared/mediaEdit.ts): the map from the edited picture to the original
// (quarter turns, the tilt with its zoom, the crop), the way back, face boxes and pixelated areas on
// the edited picture, the crop presets and handles, and repairing stored edits in project files.
import { describe, expect, it } from 'vitest'
import {
  apply, areaToSource, compose, cropToRatio, dragCrop, editedAspect, editedSize, editToSource, facesInEdit, IDENTITY, invert, isEdited, mapRect,
  normalizeEdit, presetOf, presetRatio, rectToEdit, rotateEdit, sanitizeEdit, shownAspect, sourceToEdit, straightenZoom, withProjectFields, type Affine
} from '@shared/mediaEdit'
import { faceArea } from '@shared/people'
import { DEFAULT_SETTINGS, type MediaEdit, type MediaItem, type Project, type Rect } from '@shared/types'
import { PROJECT_VERSION, validateProject } from '../src/main/projectSchema'
import { buildTimeline } from '@shared/timeline'
import { mediaAspect } from '@shared/layout'

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps
const expectPoint = (p: [number, number], x: number, y: number, eps = 1e-9): void => {
  expect(close(p[0], x, eps) && close(p[1], y, eps), `(${p[0]}, ${p[1]}) ≈ (${x}, ${y})`).toBe(true)
}
const corners: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]]

/** Deterministic pseudo random numbers. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

function randomEdit(r: () => number): MediaEdit {
  const rotate = ([0, 90, 180, 270] as const)[Math.floor(r() * 4)]
  const straighten = (r() - 0.5) * 90
  const w = 0.1 + r() * 0.9
  const h = 0.1 + r() * 0.9
  const crop = r() < 0.2 ? undefined : { x: r() * (1 - w), y: r() * (1 - h), w, h }
  return crop ? { rotate, straighten, crop } : { rotate, straighten }
}

/** Point inside the ellipse inscribed in r (normalised coordinates). */
const inEllipse = (p: [number, number], r: Rect, eps = 1e-9): boolean => {
  const dx = (p[0] - (r.x + r.w / 2)) / (r.w / 2)
  const dy = (p[1] - (r.y + r.h / 2)) / (r.h / 2)
  return dx * dx + dy * dy <= 1 + eps
}

describe('edit transform', () => {
  it('leaves an unedited picture alone', () => {
    expect(isEdited(undefined)).toBe(false)
    expect(isEdited({ rotate: 0, straighten: 0 })).toBe(false)
    expect(isEdited({ rotate: 0, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } })).toBe(false)
    expect(editToSource(undefined, 1.5)).toEqual(IDENTITY)
    expect(editToSource({ rotate: 0, straighten: 0 }, 1.5)).toEqual(IDENTITY)
    expect(editedSize(4000, 3000, undefined)).toEqual({ w: 4000, h: 3000 })
  })

  it('turns by quarters clockwise', () => {
    // 90°: the original's bottom-left corner becomes the top-left one
    const m90 = editToSource({ rotate: 90, straighten: 0 }, 4 / 3)
    expectPoint(apply(m90, 0, 0), 0, 1)
    expectPoint(apply(m90, 1, 0), 0, 0)
    expectPoint(apply(m90, 1, 1), 1, 0)
    expect(editedSize(4000, 3000, { rotate: 90, straighten: 0 })).toEqual({ w: 3000, h: 4000 })
    const m180 = editToSource({ rotate: 180, straighten: 0 }, 4 / 3)
    expectPoint(apply(m180, 0, 0), 1, 1)
    expectPoint(apply(m180, 0.25, 0.75), 0.75, 0.25)
    // 270° (a turn to the left): the top-right corner becomes the top-left one
    const m270 = editToSource({ rotate: 270, straighten: 0 }, 4 / 3)
    expectPoint(apply(m270, 0, 0), 1, 0)
    expectPoint(apply(m270, 0, 1), 0, 0)
    expect(shownAspect({ width: 4000, height: 3000, edit: { rotate: 270, straighten: 0 } })).toBeCloseTo(0.75, 12)
  })

  it('crops a part of the picture', () => {
    const m = editToSource({ rotate: 0, straighten: 0, crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.6 } }, 1.5)
    expectPoint(apply(m, 0, 0), 0.25, 0.1)
    expectPoint(apply(m, 1, 1), 0.75, 0.7)
    expect(editedSize(3000, 2000, { rotate: 0, straighten: 0, crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.6 } })).toEqual({ w: 1500, h: 1200 })
    // turned, then cropped: the crop is a part of the turned picture
    const t = editToSource({ rotate: 90, straighten: 0, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, 1.5)
    // the top-left quarter of the turned picture is the bottom-left quarter of the original
    expect(mapRect(t, { x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 })
  })

  it('zooms a straightened picture just enough to fill its frame (no empty corners)', () => {
    expect(straightenZoom(1, 45)).toBeCloseTo(Math.SQRT2, 12)
    expect(straightenZoom(1.5, 0)).toBe(1)
    // for 4:3 at 10°: cos + (4/3)·sin
    expect(straightenZoom(4 / 3, -10)).toBeCloseTo(Math.cos(Math.PI / 18) + (4 / 3) * Math.sin(Math.PI / 18), 12)
    for (const aspect of [0.5625, 0.75, 1, 4 / 3, 16 / 9, 3]) {
      for (const deg of [-45, -12.3, -0.1, 0.1, 5, 30, 45]) {
        for (const rotate of [0, 90] as const) {
          const m = editToSource({ rotate, straighten: deg }, aspect)
          const pts = corners.map(([u, v]) => apply(m, u, v))
          // every corner of the picture is inside the original…
          for (const [x, y] of pts) {
            expect(x).toBeGreaterThanOrEqual(-1e-9)
            expect(x).toBeLessThanOrEqual(1 + 1e-9)
            expect(y).toBeGreaterThanOrEqual(-1e-9)
            expect(y).toBeLessThanOrEqual(1 + 1e-9)
          }
          // …and one of them touches its edge (no more zoom than needed)
          const gap = Math.min(...pts.flatMap(([x, y]) => [x, 1 - x, y, 1 - y]))
          expect(gap).toBeLessThan(1e-9)
        }
      }
    }
  })

  it('keeps every crop of every edit inside the original picture', () => {
    const r = rng(7)
    for (let i = 0; i < 500; i++) {
      const e = randomEdit(r)
      const aspect = 0.4 + r() * 2.6
      for (const [u, v] of [...corners, [0.5, 0.5] as [number, number]]) {
        const [x, y] = apply(editToSource(e, aspect), u, v)
        expect(x > -1e-9 && x < 1 + 1e-9 && y > -1e-9 && y < 1 + 1e-9, JSON.stringify({ e, aspect, u, v, x, y })).toBe(true)
      }
    }
  })

  it('turns the picture by the tilt without shearing it', () => {
    // in pixels, the edited picture's axes stay at right angles and keep their length ratio
    const aspect = 1.5
    const e: MediaEdit = { rotate: 0, straighten: 20, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } }
    const m = editToSource(e, aspect)
    const size = editedSize(aspect, 1, e)
    const ux = [m[0] * aspect, m[1]] // edited x axis in original pixels (height = 1)
    const uy = [m[2] * aspect, m[3]]
    expect(ux[0] * uy[0] + ux[1] * uy[1]).toBeCloseTo(0, 12)
    expect(Math.hypot(ux[0], ux[1]) / Math.hypot(uy[0], uy[1])).toBeCloseTo(size.w / size.h, 12)
    // the axis is turned 20° the other way (the picture is turned clockwise on screen)
    expect((Math.atan2(ux[1], ux[0]) * 180) / Math.PI).toBeCloseTo(-20, 9)
  })

  it('goes back and forth between the edited picture and the original', () => {
    const r = rng(11)
    for (let i = 0; i < 100; i++) {
      const e = randomEdit(r)
      const aspect = 0.5 + r() * 2
      const there = editToSource(e, aspect)
      const back = sourceToEdit(e, aspect)
      const p: [number, number] = [r(), r()]
      expectPoint(apply(back, ...apply(there, ...p)), p[0], p[1], 1e-9)
      expect(compose(back, there).map((v, k) => close(v, IDENTITY[k], 1e-9))).toEqual([true, true, true, true, true, true])
      expect(invert(invert(there)).every((v, k) => close(v, there[k], 1e-9))).toBe(true)
    }
  })

  it('turns an edit a quarter with its crop and tilt (the picture turns as a whole)', () => {
    const r = rng(3)
    for (let i = 0; i < 100; i++) {
      const e = randomEdit(r)
      const aspect = 0.5 + r() * 2
      const right = rotateEdit(e, 1)
      const left = rotateEdit(e, -1)
      expect(right.straighten).toBe(e.straighten)
      expect(editedAspect(aspect, right)).toBeCloseTo(1 / editedAspect(aspect, e), 9)
      const u = r()
      const v = r()
      // a point (u, v) of the right-turned picture was at (v, 1 - u) before the turn
      expectPoint(apply(editToSource(right, aspect), u, v), ...apply(editToSource(e, aspect), v, 1 - u), 1e-9)
      expectPoint(apply(editToSource(left, aspect), u, v), ...apply(editToSource(e, aspect), 1 - v, u), 1e-9)
    }
    // four turns are none; left undoes right
    let e: MediaEdit = { rotate: 0, straighten: 3, crop: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }
    const start = e
    for (let i = 0; i < 4; i++) e = rotateEdit(e, 1)
    expect(e.rotate).toBe(0)
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(e.crop![k]).toBeCloseTo(start.crop![k], 12)
    expect(rotateEdit(rotateEdit(start, 1), -1)).toEqual({ ...start, crop: expect.objectContaining({}) })
    expect(rotateEdit(undefined, -1)).toEqual({ rotate: 270, straighten: 0 })
  })
})

describe('faces and pixelated areas on the edited picture', () => {
  const aspect = 4 / 3

  it('moves face boxes with the picture and leaves out those cropped away', () => {
    const face = { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }
    // turned right: the top-left face is now at the top right
    const [turned] = facesInEdit([face], { rotate: 90, straighten: 0 }, aspect)
    expect(turned.x).toBeCloseTo(0.8, 12)
    expect(turned.y).toBeCloseTo(0.1, 12)
    expect(turned.w).toBeCloseTo(0.1, 12)
    // cropped to the right half: gone; half of it in the crop: clipped
    expect(facesInEdit([face], { rotate: 0, straighten: 0, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }, aspect)).toEqual([])
    const [half] = facesInEdit([face], { rotate: 0, straighten: 0, crop: { x: 0.15, y: 0, w: 0.85, h: 1 } }, aspect)
    expect(half.x).toBe(0)
    expect(half.w).toBeCloseTo(0.05 / 0.85, 12)
    expect(rectToEdit(face, undefined, aspect)).toEqual(face)
  })

  it('keeps a pixelated face covered after any edit, also where it is partly cropped away', () => {
    // the engine pixelates in the original picture's coordinates: what the edited picture shows of
    // the face comes from inside the area, whatever the turn, tilt and crop
    const r = rng(5)
    const face = { x: 0.42, y: 0.3, w: 0.16, h: 0.2 }
    const area = faceArea(face)
    for (let i = 0; i < 50; i++) {
      const e = randomEdit(r)
      const there = editToSource(e, aspect)
      const back = sourceToEdit(e, aspect)
      for (let k = 0; k < 40; k++) {
        // a point of the face's core, wherever it lands on the edited picture
        const p: [number, number] = [face.x + face.w * (0.2 + 0.6 * r()), face.y + face.h * (0.2 + 0.6 * r())]
        const shown = apply(back, ...p)
        if (shown[0] < 0 || shown[0] > 1 || shown[1] < 0 || shown[1] > 1) continue // cropped away
        expect(inEllipse(apply(there, ...shown), area, 1e-9)).toBe(true)
      }
    }
  })

  it('turns an area drawn on the edited picture into one of the original that covers it', () => {
    const r = rng(9)
    for (let i = 0; i < 200; i++) {
      const e = randomEdit(r)
      const a = 0.5 + r() * 2
      const drawn = { x: r() * 0.7, y: r() * 0.7, w: 0.05 + r() * 0.3, h: 0.05 + r() * 0.3 }
      const stored = areaToSource(drawn, e, a)
      const m = editToSource(e, a)
      // every point of the drawn ellipse is inside the stored one
      for (let k = 0; k < 64; k++) {
        const t = (k / 64) * Math.PI * 2
        const p: [number, number] = [drawn.x + drawn.w / 2 + (Math.cos(t) * drawn.w) / 2, drawn.y + drawn.h / 2 + (Math.sin(t) * drawn.h) / 2]
        expect(inEllipse(apply(m, ...p), stored, 1e-6)).toBe(true)
      }
      // and it is no bigger than needed: some point of the drawn ellipse touches its edge
      const reach = Math.max(
        ...Array.from({ length: 720 }, (_, k) => {
          const t = (k / 720) * Math.PI * 2
          const [x, y] = apply(m, drawn.x + drawn.w / 2 + (Math.cos(t) * drawn.w) / 2, drawn.y + drawn.h / 2 + (Math.sin(t) * drawn.h) / 2)
          return ((x - stored.x - stored.w / 2) / (stored.w / 2)) ** 2 + ((y - stored.y - stored.h / 2) / (stored.h / 2)) ** 2
        })
      )
      expect(reach).toBeGreaterThan(0.999)
    }
    // quarter turns map an area exactly
    const drawn = { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }
    const exact = areaToSource(drawn, { rotate: 90, straighten: 0 }, 1.5)
    const box = mapRect(editToSource({ rotate: 90, straighten: 0 }, 1.5), drawn)
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(exact[k]).toBeCloseTo(box[k], 6)
    // a circle on screen stays the same circle when only tilted (pixels: width = aspect · height)
    const circle = { x: 0.4, y: 0.4, w: 0.2 / 1.5, h: 0.2 }
    const tilted = areaToSource(circle, { rotate: 0, straighten: 17 }, 1.5)
    expect((tilted.w * 1.5) / tilted.h).toBeCloseTo(1, 6)
    expect(tilted.h).toBeCloseTo(0.2 / straightenZoom(1.5, 17), 6)
  })
})

describe('crop presets and handles', () => {
  it('knows the presets and their portrait / landscape swap', () => {
    expect(presetRatio('free', 1.5)).toBeNull()
    expect(presetRatio('original', 1.5)).toBe(1.5)
    expect(presetRatio('original', 1.5, true)).toBeCloseTo(2 / 3, 12)
    expect(presetRatio('1:1', 1.5)).toBe(1)
    expect(presetRatio('4:3', 1.5)).toBeCloseTo(4 / 3, 12)
    expect(presetRatio('3:2', 1.5, true)).toBeCloseTo(2 / 3, 12)
    expect(presetRatio('16:9', 0.75)).toBeCloseTo(16 / 9, 12)
    expect(presetRatio('9:16', 0.75)).toBeCloseTo(9 / 16, 12)
  })

  it('fits the largest crop of a preset around the current one', () => {
    const frameAspect = 1.5
    for (const ratio of [1, 1.5, 4 / 3, 16 / 9, 9 / 16, 3 / 4]) {
      const c = cropToRatio({ x: 0.6, y: 0.1, w: 0.3, h: 0.3 }, ratio, frameAspect)
      expect((c.w / c.h) * frameAspect).toBeCloseTo(ratio, 9)
      expect(c.x).toBeGreaterThanOrEqual(0)
      expect(c.y).toBeGreaterThanOrEqual(0)
      expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-12)
      expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-12)
      expect(Math.max(c.w, c.h)).toBeCloseTo(1, 12)
      expect(presetOf(c, frameAspect, frameAspect).preset).not.toBe('free')
    }
    expect(cropToRatio(undefined, 1.5, 1.5)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(presetOf(cropToRatio(undefined, 9 / 16, 1.5), 1.5, 1.5)).toEqual({ preset: '9:16', swap: false })
    expect(presetOf(cropToRatio(undefined, 3 / 4, 1.5), 1.5, 1.5)).toEqual({ preset: '4:3', swap: true })
    expect(presetOf({ x: 0, y: 0, w: 0.5, h: 0.31 }, 1.5, 1.5).preset).toBe('free')
    expect(presetOf(undefined, 1.5, 1.5).preset).toBe('free')
  })

  it('drags edges and corners freely, inside the picture and not below the smallest size', () => {
    const start = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }
    expect(dragCrop(start, 'move', 0.5, -0.5, null, 1.5)).toEqual({ x: 0.4, y: 0, w: 0.6, h: 0.6 })
    const se = dragCrop(start, 'se', 0.1, -0.1, null, 1.5)
    expect(se.x).toBe(0.2)
    expect(se.w).toBeCloseTo(0.7, 12)
    expect(se.h).toBeCloseTo(0.5, 12)
    const wide = dragCrop(start, 'w', -0.9, 0, null, 1.5)
    expect([wide.x, wide.y, wide.w, wide.h].map((v) => +v.toFixed(12))).toEqual([0, 0.2, 0.8, 0.6])
    const tiny = dragCrop(start, 'n', 0, 0.9, null, 1.5)
    expect(tiny.h).toBeCloseTo(0.05, 12)
    expect(tiny.y + tiny.h).toBeCloseTo(0.8, 12)
  })

  it('keeps the shape of a preset while dragging', () => {
    const r = rng(13)
    const frameAspect = 4 / 3
    const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const
    for (let i = 0; i < 300; i++) {
      const ratio = [1, 16 / 9, 9 / 16, 4 / 3][i % 4]
      const start = cropToRatio({ x: r() * 0.5, y: r() * 0.5, w: 0.3, h: 0.3 }, ratio, frameAspect)
      const small = { ...start, w: start.w * 0.5, h: start.h * 0.5, x: start.x + start.w * 0.25, y: start.y + start.h * 0.25 }
      const c = dragCrop(small, handles[i % 8], (r() - 0.5) * 1.5, (r() - 0.5) * 1.5, ratio, frameAspect)
      expect((c.w / c.h) * frameAspect).toBeCloseTo(ratio, 9)
      expect(c.x).toBeGreaterThanOrEqual(-1e-12)
      expect(c.y).toBeGreaterThanOrEqual(-1e-12)
      expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-12)
      expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-12)
    }
    // a corner scales from the opposite corner
    const sq = { x: 0.25, y: 0.25, w: 0.375, h: 0.5 } // square in pixels at 4:3
    const c = dragCrop(sq, 'se', 0.1, 0, 1, frameAspect)
    expect(c.x).toBe(0.25)
    expect(c.y).toBe(0.25)
    expect(c.w).toBeCloseTo(0.475, 12)
  })
})

describe('stored edits', () => {
  it('keeps a valid edit as it is', () => {
    const edit = { rotate: 90, straighten: -2.5, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } }
    expect(sanitizeEdit(edit)).toEqual({ edit, fixed: false })
    // fields of a newer app survive
    expect(sanitizeEdit({ ...edit, flip: true }).edit).toEqual({ ...edit, flip: true })
    // an edit that changes nothing is dropped without counting as damage
    expect(sanitizeEdit({ rotate: 0, straighten: 0 })).toEqual({ edit: undefined, fixed: false })
  })

  it('rounds, clamps or drops bad values', () => {
    expect(sanitizeEdit('turned')).toEqual({ edit: undefined, fixed: true })
    expect(sanitizeEdit({ rotate: -90, straighten: 0 })).toEqual({ edit: { rotate: 270, straighten: 0 }, fixed: true })
    expect(sanitizeEdit({ rotate: 93, straighten: 0 }).edit?.rotate).toBe(90)
    expect(sanitizeEdit({ rotate: 0, straighten: 80 })).toEqual({ edit: { rotate: 0, straighten: 45 }, fixed: true })
    expect(sanitizeEdit({ rotate: 'left', straighten: 'x', crop: { x: 0.1 } })).toEqual({ edit: undefined, fixed: true })
    expect(sanitizeEdit({ rotate: 180, straighten: Number.NaN })).toEqual({ edit: { rotate: 180, straighten: 0 }, fixed: true })
    const moved = sanitizeEdit({ rotate: 0, straighten: 0, crop: { x: 0.8, y: -0.2, w: 0.5, h: 1.5 } })
    expect(moved.fixed).toBe(true)
    expect(moved.edit?.crop).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 })
    expect(sanitizeEdit({ rotate: 90, straighten: 0, crop: { x: 0, y: 0, w: 0, h: 0.5 } })).toEqual({ edit: { rotate: 90, straighten: 0 }, fixed: true })
  })

  it('stores what the editor makes without a repair later', () => {
    const r = rng(17)
    for (let i = 0; i < 300; i++) {
      const e = normalizeEdit(randomEdit(r))
      if (!e) continue
      const again = sanitizeEdit(JSON.parse(JSON.stringify(e)))
      expect(again.fixed, JSON.stringify(e)).toBe(false)
      expect(again.edit).toEqual(e)
    }
    expect(normalizeEdit({ rotate: 0, straighten: 0.04 })).toBeUndefined()
  })

  it('is repaired in project files without a new format version', () => {
    expect(PROJECT_VERSION).toBe(1)
    const m = (id: string, edit: unknown): MediaItem =>
      ({ id, path: `C:\\Fotos\\${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: 4000, height: 3000, captureTime: 1, status: 'ready', thumb: 'C:\\t.jpg', display: 'C:\\d.jpg', edit }) as MediaItem
    const project: Project = {
      version: 1,
      id: 'p',
      name: 'Edits',
      createdAt: 1,
      updatedAt: 2,
      entries: ['a', 'b', 'c', 'd'].map((id) => ({ id: `e${id}`, type: 'photo' as const, mediaId: id })),
      media: [
        m('a', { rotate: 90, straighten: 3.5, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }),
        m('b', { rotate: 45, straighten: 100 }),
        m('c', 'nonsense'),
        m('d', { rotate: 0, straighten: 0, crop: { x: 0.5, y: 0.5, w: 0.9, h: 0.2 } })
      ],
      music: [],
      settings: structuredClone(DEFAULT_SETTINGS)
    }
    const valid = validateProject({ ...project, media: [project.media[0]], entries: [project.entries[0]] })
    expect(valid.report.changes).toEqual([])
    expect(valid.project.media[0].edit).toEqual(project.media[0].edit)
    const { project: fixed, report } = validateProject(structuredClone(project))
    expect(report.changes).toEqual([{ code: 'mediaRepaired', count: 3 }])
    expect(fixed.media.map((x) => x.edit)).toEqual([
      project.media[0].edit,
      { rotate: 90, straighten: 45 },
      undefined,
      { rotate: 0, straighten: 0, crop: { x: 0.09999999999999998, y: 0.5, w: 0.9, h: 0.2 } }
    ])
    expect('edit' in fixed.media[2]).toBe(false)
  })
})

describe('project fields of a media item', () => {
  it('keeps the edit and the kept face centre when the cache sends the item again (restore, relink, updates)', () => {
    const edit: MediaEdit = { rotate: 90, straighten: 2, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }
    const project = { id: 'a', edit, faceFocus: { x: 0.3, y: 0.4 } } as MediaItem
    const cached = { id: 'b', path: 'C:/new/a.jpg', status: 'ready', faces: [] } as unknown as MediaItem
    expect(withProjectFields(cached, project)).toEqual({ ...cached, edit, faceFocus: { x: 0.3, y: 0.4 } })
    // the project's edit wins, also when it has none; a face centre only the cache knows stays
    const stale = { ...cached, edit: { rotate: 180, straighten: 0 }, faceFocus: { x: 0.9, y: 0.9 } } as MediaItem
    expect(withProjectFields(stale, { id: 'a' } as MediaItem)).toEqual({ ...cached, faceFocus: { x: 0.9, y: 0.9 } })
    expect(withProjectFields(stale, project)).toEqual({ ...cached, edit, faceFocus: { x: 0.3, y: 0.4 } })
    // nothing to change: the same object (snapshots and the engine's caches rely on identity)
    const same = { ...cached, edit }
    expect(withProjectFields(same, { id: 'a', edit } as MediaItem)).toBe(same)
    expect(withProjectFields(cached, undefined)).toBe(cached)
  })
})

describe('affine helpers', () => {
  it('maps rects by their corners', () => {
    const m: Affine = [0, 1, -1, 0, 1, 0] // a quarter turn of the unit square
    expect(mapRect(m, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({ x: expect.closeTo(0.4, 12), y: expect.closeTo(0.1, 12), w: expect.closeTo(0.4, 12), h: expect.closeTo(0.3, 12) })
  })
})

describe('the edited picture in layouts', () => {
  const photo = (id: string, w: number, h: number, edit?: MediaEdit, faces?: Rect[]): MediaItem =>
    ({ id, path: `C:/Fotos/${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: w, height: h, captureTime: 1, status: 'ready', ...(edit ? { edit } : {}), ...(faces ? { faces } : {}) }) as MediaItem

  it('decides portrait or landscape by the edited shape (a lone portrait is paired, a turned one not)', () => {
    const slides = (edit?: MediaEdit): string[][] => {
      const p: Project = {
        version: 1,
        id: 'p',
        name: 'Layout',
        createdAt: 1,
        updatedAt: 1,
        entries: ['a', 'b', 'c'].map((id) => ({ id, type: 'photo' as const, mediaId: id })),
        media: [photo('a', 3000, 4000, edit), photo('b', 4000, 3000), photo('c', 4000, 3000)],
        music: [],
        settings: { ...structuredClone(DEFAULT_SETTINGS), theme: 'origami', showTitle: false }
      }
      return buildTimeline(p).slides.map((s) => s.entries.map((e) => e.id))
    }
    expect(mediaAspect(photo('a', 3000, 4000, { rotate: 90, straighten: 0 }))).toBeCloseTo(4 / 3, 12)
    expect(slides()[0]).toEqual(['a', 'b'])
    expect(slides({ rotate: 90, straighten: 0 })[0]).toEqual(['a'])
    // a square crop of the portrait is no portrait either
    expect(slides({ rotate: 0, straighten: 0, crop: { x: 0, y: 0.125, w: 1, h: 0.75 } })[0]).toEqual(['a'])
  })

})
