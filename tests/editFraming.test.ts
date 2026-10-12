// The engine's framing on an edited picture (engine/draw.ts): face-aware focus and the default Ken Burns
// motion use the faces where they sit after rotate / crop, and Ken Burns frames set before an edit are
// fitted to the picture's new shape instead of stretching it. (Renderer code: typechecked with the web
// project, see tsconfig.web.json.)
import { describe, expect, it } from 'vitest'
import type { MediaEdit, MediaItem, Rect } from '@shared/types'
import { DEFAULT_FOCUS_Y, facesFocus, fitFrame, kenBurnsOf } from '../src/renderer/src/engine/draw'

const photo = (id: string, w: number, h: number, edit?: MediaEdit, faces?: Rect[]): MediaItem =>
  ({ id, path: `C:/Fotos/${id}.jpg`, name: `${id}.jpg`, kind: 'photo', format: 'JPEG', width: w, height: h, captureTime: 1, status: 'ready', ...(edit ? { edit } : {}), ...(faces ? { faces } : {}) }) as MediaItem

describe('framing on the edited picture', () => {
  it('aims the default Ken Burns motion and the cell framing at the faces where they sit after the edit', () => {
    const face = { x: 0.05, y: 0.45, w: 0.1, h: 0.1 } // left edge of a landscape photo
    const plain = photo('p', 4000, 3000, undefined, [face])
    const turned = photo('p', 4000, 3000, { rotate: 90, straighten: 0 }, [face])
    expect(facesFocus(plain).x).toBeCloseTo(0.1, 12)
    // turned right, the left edge is now the top
    const f = facesFocus(turned)
    expect(f.x).toBeCloseTo(0.5, 12)
    expect(f.y).toBeCloseTo(0.1, 12)
    const kb = kenBurnsOf({ id: 'e', type: 'photo', mediaId: 'p' }, turned, 16 / 9)
    const top = Math.min(kb.start.y, kb.end.y)
    expect(top).toBe(0)
    // a cropped-away face no longer pulls the framing
    const cropped = photo('p', 4000, 3000, { rotate: 0, straighten: 0, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }, [face])
    expect(facesFocus(cropped)).toEqual({ x: 0.5, y: DEFAULT_FOCUS_Y })
  })

  it('keeps Ken Burns frames set before an edit undistorted', () => {
    // a frame made for a 4:3 picture in a 16:9 show, then the picture is turned to 3:4
    const r = { x: 0.1, y: 0.2, w: 0.8, h: 0.6 }
    expect(fitFrame(r, 4 / 3, 16 / 9)).toEqual({ x: expect.closeTo(0.1, 12), y: expect.closeTo(0.2, 12), w: expect.closeTo(0.8, 12), h: expect.closeTo(0.6, 12) })
    const fitted = fitFrame(r, 3 / 4, 16 / 9)
    expect(((fitted.w * 3) / 4 / fitted.h)).toBeCloseTo(16 / 9, 9)
    expect(fitted.x + fitted.w / 2).toBeCloseTo(0.5, 9)
    expect(fitted.y).toBeGreaterThanOrEqual(0)
    expect(fitted.y + fitted.h).toBeLessThanOrEqual(1 + 1e-12)
    const kb = kenBurnsOf({ id: 'e', type: 'photo', mediaId: 'p', kenBurns: { start: r, end: r } }, photo('p', 4000, 3000, { rotate: 90, straighten: 0 }), 16 / 9)
    expect(kb.start).toEqual(fitted)
  })
})
