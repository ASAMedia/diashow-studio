// The clean-up removes the face data but nothing that is pixelated now may show afterwards: the
// engine's own index (engine/privacy.ts) gives the same areas before and after withoutFaceData, for
// photos and at every moment of a video (also the stabilised copy), and crops and Ken Burns moves
// (engine/draw.ts) stay where the faces were. In the web project like grouping.test.ts.
import { describe, expect, it } from 'vitest'
import { withoutFaceData } from '@shared/cleanup'
import { DEFAULT_SETTINGS, type Entry, type MediaItem, type PhotoEntry, type Project, type Rect, type VideoFaces } from '@shared/types'
import { PrivacyIndex } from '../src/renderer/src/engine/privacy'
import { facesFocus, kenBurnsUv, photoUv } from '../src/renderer/src/engine/draw'

const axis = (k: number): number[] => Array.from({ length: 128 }, (_, i) => (i === k ? 1 : 0))
const FA: Rect = { x: 0.2, y: 0.3, w: 0.1, h: 0.15 }
const FB: Rect = { x: 0.55, y: 0.35, w: 0.08, h: 0.12 }
const FC: Rect = { x: 0.75, y: 0.2, w: 0.06, h: 0.1 }
const MANUAL: Rect = { x: 0.02, y: 0.6, w: 0.1, h: 0.1 }

/** A marked face moving right, an unmarked one standing still, and a gap in the middle (face turned away). */
function samples(): VideoFaces[] {
  const out: VideoFaces[] = []
  for (let t = 0.25; t < 6; t += 0.5) {
    const gap = t > 2.6 && t < 3.6
    const faces = [{ x: 0.7, y: 0.5, w: 0.1, h: 0.16 }]
    const desc = [axis(50)]
    if (!gap) {
      faces.unshift({ x: 0.1 + t * 0.08, y: 0.25, w: 0.1, h: 0.16 })
      desc.unshift(axis(3))
    }
    out.push({ t, faces, desc })
  }
  return out
}

function project(): Project {
  const media: MediaItem[] = [
    { id: 'photo', path: 'C:\\p.jpg', name: 'p.jpg', kind: 'photo', format: 'JPEG', width: 1600, height: 900, captureTime: 0, status: 'ready', faces: [FA, FB, FC], faceDesc: [axis(3), axis(70), []] },
    { id: 'portrait', path: 'C:\\q.jpg', name: 'q.jpg', kind: 'photo', format: 'JPEG', width: 900, height: 1600, captureTime: 0, status: 'ready', faces: [FB], faceDesc: [axis(9)] },
    { id: 'clip', path: 'C:\\v.mp4', name: 'v.mp4', kind: 'video', format: 'MP4', width: 1280, height: 720, duration: 6, captureTime: 0, status: 'ready', videoFaces: samples() }
  ]
  const entries: Entry[] = [
    { id: 'e1', type: 'photo', mediaId: 'photo', privacy: [MANUAL] },
    { id: 'e2', type: 'photo', mediaId: 'portrait' },
    { id: 'e3', type: 'video', mediaId: 'clip', privacy: [MANUAL], privacyTracks: [[{ t: 1, r: { x: 0.4, y: 0.6, w: 0.1, h: 0.1 } }, { t: 2, r: { x: 0.45, y: 0.6, w: 0.1, h: 0.1 } }]] }
  ]
  return {
    version: 1, id: 'p', name: 'P', createdAt: 1, updatedAt: 1, entries, media, music: [], settings: DEFAULT_SETTINGS,
    people: [{ id: 'lena', name: 'Lena', desc: [axis(3)] }, { id: 'tom', desc: [axis(9)] }]
  }
}

const indexOf = (p: Project): PrivacyIndex => {
  const ix = new PrivacyIndex()
  ix.setProject(p)
  return ix
}
const times = Array.from({ length: 141 }, (_, i) => i * 0.05 - 0.5)

describe('pixelation survives the clean-up', () => {
  it('gives the engine the same areas for photos and at every moment of a video', () => {
    const before = project()
    const after = withoutFaceData(before)
    const a = indexOf(before)
    const b = indexOf(after)
    const m = (p: Project, id: string): MediaItem => p.media.find((x) => x.id === id)!
    // the marked people really are pixelated before (so the comparison means something)
    expect(a.at(m(before, 'photo')).length).toBe(2)
    expect(a.at(m(before, 'portrait')).length).toBe(1)
    expect(times.filter((t) => a.at(m(before, 'clip'), t).length > 1).length).toBeGreaterThan(50)
    for (const id of ['photo', 'portrait']) {
      expect(b.at(m(after, id))).toEqual(a.at(m(before, id)))
      // the motion of a Live Photo keeps the photo's areas
      expect(b.at(m(after, id), 1.2)).toEqual(a.at(m(before, id), 1.2))
    }
    for (const t of times) {
      expect(b.at(m(after, 'clip'), t), `t = ${t}`).toEqual(a.at(m(before, 'clip'), t))
      expect(b.at(m(after, 'clip'), t, true), `stabilised, t = ${t}`).toEqual(a.at(m(before, 'clip'), t, true))
    }
    // the unmarked face never was pixelated, and isn't now
    const free = { x: 0.7, y: 0.5, w: 0.1, h: 0.16 }
    expect(b.at(m(after, 'clip'), 4).some((r) => Math.abs(r.x - free.x) < 0.05 && Math.abs(r.y - free.y) < 0.05)).toBe(false)
  })

  it('keeps the areas for left-out slides and for every slide of the same picture', () => {
    const before = project()
    before.entries.push({ id: 'e1b', type: 'photo', mediaId: 'photo', excluded: true })
    const after = withoutFaceData(before)
    for (const id of ['e1', 'e1b']) {
      const e = after.entries.find((x) => x.id === id) as PhotoEntry
      expect(e.privacy?.length).toBeGreaterThanOrEqual(1)
    }
    // with the first slide deleted the other still pixelates the marked face
    const rest = { ...after, entries: after.entries.filter((e) => e.id !== 'e1') }
    const photo = after.media.find((x) => x.id === 'photo')!
    const before1 = indexOf(before).at(before.media.find((x) => x.id === 'photo')!)
    const after1 = indexOf(rest).at(photo)
    for (const r of before1.filter((x) => x !== MANUAL)) expect(after1).toContainEqual(r)
  })

  it('keeps crops and Ken Burns moves where the faces were', () => {
    const before = project()
    const after = withoutFaceData(before)
    for (const id of ['photo', 'portrait']) {
      const m0 = before.media.find((x) => x.id === id)!
      const m1 = after.media.find((x) => x.id === id)!
      const e = before.entries.find((x) => x.type !== 'text' && x.mediaId === id) as PhotoEntry
      expect(m1.faces).toBeUndefined()
      expect(facesFocus(m1)).toEqual(facesFocus(m0))
      for (const aspect of [16 / 9, 1, 9 / 16]) {
        expect(photoUv(e, m1, aspect)).toEqual(photoUv(e, m0, aspect))
        for (const t of [0, 0.3, 1]) expect(kenBurnsUv(e, m1, aspect, t)).toEqual(kenBurnsUv(e, m0, aspect, t))
      }
    }
  })

  it('leaves no face data behind', () => {
    const after = withoutFaceData(project(), 1_800_000_000_000)
    expect(after.people).toBeUndefined()
    expect(after.faceDataRemovedAt).toBe(1_800_000_000_000)
    for (const m of after.media) {
      expect(m.faces).toBeUndefined()
      expect(m.faceDesc).toBeUndefined()
      expect(m.videoFaces).toBeUndefined()
    }
    expect(JSON.stringify(after)).not.toMatch(/Lena|"desc"/)
    // a second clean-up changes nothing more
    const again = withoutFaceData(after, 1_800_000_000_000)
    expect(again).toEqual(after)
  })
})
