// "This person everywhere": matching descriptors, following faces through video samples,
// interpolating keyframes, coverage for the review before export, and face alignment.
import { describe, expect, it } from 'vitest'
import type { MediaItem, Person, PhotoEntry, Rect, VideoEntry, VideoFaces } from '@shared/types'
import {
  allVideoTracks, buildFaceTracks, mergeFaces, stabilizedArea, STABILIZE_ZOOM, faceArea, faceDistance, followFace, isCovered, MATCH_THRESHOLD, matchPerson, matchTrack, openPhotoFaces,
  openVideoFaces, peopleKey, photoPersonFaces, rectAt, sampleTimes, thinDescriptors, VIDEO_MAX_SAMPLES, videoPersonTracks, withoutMatch
} from '@shared/people'
import { applySimilarity, CHIP_SIZE, CHIP_TARGETS, chipTransform, eyeVisibility, fitSimilarity, recognisable, type Pt } from '@shared/faceAlign'
import { sanitizeDescriptor, sanitizeDescriptors, sanitizeVideoFaces } from '../src/main/media/faceData'

/** A unit-ish descriptor pointing mostly along axis `k`, with a little of `mix` along axis `k + 1`. */
function desc(k: number, mix = 0): number[] {
  const d = new Array(128).fill(0)
  d[k % 128] = 1 - mix
  d[(k + 1) % 128] = mix
  return d
}

const rect = (x: number, y: number, w = 0.1, h = 0.15): Rect => ({ x, y, w, h })
const person = (id: string, ...d: number[][]): Person => ({ id, desc: d })

describe('descriptor matching', () => {
  it('measures Euclidean distance', () => {
    expect(faceDistance([0, 0], [3, 4])).toBe(5)
    expect(faceDistance([1], [1, 2])).toBe(Infinity)
  })

  it('finds the closest person within the threshold', () => {
    const anna = person('anna', desc(0), desc(10))
    const ben = person('ben', desc(20))
    expect(matchPerson(desc(10, 0.1), [anna, ben])?.person.id).toBe('anna')
    expect(matchPerson(desc(20, 0.2), [anna, ben])?.person.id).toBe('ben')
    // far from everyone
    expect(matchPerson(desc(40), [anna, ben])).toBeNull()
    expect(matchPerson(undefined, [anna])).toBeNull()
    expect(matchPerson(desc(0), [])).toBeNull()
  })

  it('"not this person" drops the descriptors that made a wrong match', () => {
    const anna = person('anna', desc(0), desc(10))
    const wrong = desc(10, 0.1)
    const rest = withoutMatch(anna, wrong)
    expect(rest).toEqual([desc(0)])
    expect(matchPerson(wrong, [{ ...anna, desc: rest }])).toBeNull()
    // the right face still matches
    expect(matchPerson(desc(0, 0.05), [{ ...anna, desc: rest }])?.person.id).toBe('anna')
  })

  it('photo faces of marked people', () => {
    const m = { id: 'p', faces: [rect(0.1, 0.1), rect(0.5, 0.1), rect(0.8, 0.1)], faceDesc: [desc(0), desc(30), []] } as unknown as MediaItem
    const hits = photoPersonFaces(m, [person('anna', desc(0, 0.1))])
    expect(hits.map((h) => h.i)).toEqual([0])
    expect(photoPersonFaces(m, undefined)).toEqual([])
  })

  it('fingerprints people', () => {
    expect(peopleKey([person('a', desc(0))])).not.toBe(peopleKey([person('a', desc(0), desc(1))]))
  })
})

describe('video samples', () => {
  it('samples every half second, fewer for long clips', () => {
    expect(sampleTimes(2)).toEqual([0.25, 0.75, 1.25, 1.75])
    expect(sampleTimes(0)).toEqual([])
    const long = sampleTimes(600)
    expect(long.length).toBe(VIDEO_MAX_SAMPLES)
    expect(long[1] - long[0]).toBeCloseTo(600 / VIDEO_MAX_SAMPLES, 3)
  })

  it('keeps descriptors on every second sample and on faces that just appeared', () => {
    const s: VideoFaces[] = [
      { t: 0.25, faces: [rect(0.1, 0.1)], desc: [desc(0)] },
      { t: 0.75, faces: [rect(0.11, 0.1), rect(0.7, 0.5)], desc: [desc(0), desc(5)] },
      { t: 1.25, faces: [rect(0.12, 0.1)], desc: [desc(0)] },
      { t: 1.75, faces: [rect(0.13, 0.1)], desc: [desc(0)] }
    ]
    const thin = thinDescriptors(s)
    expect(thin[0].desc).toEqual([desc(0)])
    // the first face continues, the second is new
    expect(thin[1].desc).toEqual([[], desc(5)])
    expect(thin[2].desc).toEqual([desc(0)])
    expect(thin[3].desc).toBeUndefined()
    expect(thin[3].faces).toHaveLength(1)
  })
})

/** Two faces walking towards each other and past (with descriptors), sampled every 0.5 s. */
function crossing(): VideoFaces[] {
  const out: VideoFaces[] = []
  for (let i = 0; i < 10; i++) {
    const t = 0.25 + i * 0.5
    const a = rect(0.1 + i * 0.07, 0.3)
    const b = rect(0.8 - i * 0.07, 0.32)
    out.push({ t, faces: [b, a], desc: [desc(50, 0.02 * (i % 3)), desc(0, 0.02 * (i % 2))] })
  }
  return out
}

describe('face tracks', () => {
  it('follows two faces that cross, kept apart by their descriptors', () => {
    const tracks = buildFaceTracks(crossing())
    expect(tracks).toHaveLength(2)
    for (const tr of tracks) {
      expect(tr.keys).toHaveLength(10)
      const kinds = new Set(tr.keys.map((k) => k.desc!.indexOf(Math.max(...k.desc!))))
      // every key of a track is the same person
      expect(kinds.size).toBe(1)
    }
  })

  it('bridges a face missing for a few samples, splits after a long gap', () => {
    const at = (t: number, x: number): VideoFaces => ({ t, faces: [rect(x, 0.2)] })
    const short = [at(0.25, 0.1), at(0.75, 0.12), /* lost 1.25, 1.75 */ at(2.25, 0.16), at(2.75, 0.18)]
    expect(buildFaceTracks(short)).toHaveLength(1)
    const long = [at(0.25, 0.1), at(0.75, 0.12), { t: 1.25, faces: [] }, { t: 1.75, faces: [] }, { t: 2.25, faces: [] }, { t: 2.75, faces: [] }, at(3.25, 0.13), at(3.75, 0.14)]
    expect(buildFaceTracks(long)).toHaveLength(2)
  })

  it('does not join far-apart faces or very different sizes', () => {
    const s: VideoFaces[] = [
      { t: 0.25, faces: [rect(0.1, 0.1)] },
      { t: 0.75, faces: [rect(0.7, 0.6)] },
      { t: 1.25, faces: [rect(0.7, 0.6, 0.3, 0.45)] }
    ]
    expect(buildFaceTracks(s)).toHaveLength(3)
  })

  it('matches a track to a person by its best descriptor', () => {
    const [first] = buildFaceTracks(crossing())
    const who = first.keys[0].desc![0] === 1 ? 'zero' : 'fifty'
    const people = [person('zero', desc(0)), person('fifty', desc(50))]
    expect(matchTrack(first, people)?.person.id).toBe(who)
    expect(matchTrack(first, [person('x', desc(90))])).toBeNull()
  })
})

describe('keyframe interpolation', () => {
  const keys = [
    { t: 1, r: rect(0.1, 0.1) },
    { t: 1.5, r: rect(0.3, 0.1) },
    { t: 4, r: rect(0.5, 0.5) }
  ]

  it('holds before the first and after the last key, then stops', () => {
    expect(rectAt(keys, 0.8)).toEqual(keys[0].r)
    expect(rectAt(keys, 0.2)).toBeNull()
    expect(rectAt(keys, 4.3)).toEqual(keys[2].r)
    expect(rectAt(keys, 5)).toBeNull()
  })

  it('moves linearly between keys and grows to cover the way between them', () => {
    const mid = rectAt(keys, 1.25)!
    // centre halfway
    expect(mid.x + mid.w / 2).toBeCloseTo(0.25, 5)
    expect(mid.y + mid.h / 2).toBeCloseTo(0.175, 5)
    expect(mid.w).toBeGreaterThan(0.1)
    expect(mid.h).toBeCloseTo(0.15, 5)
    expect(rectAt(keys, 1)).toEqual(keys[0].r)
  })

  it('does not join keys further apart than the gap', () => {
    // 2.5 s between the second and third key, samples every 0.5 s: not joined
    expect(rectAt(keys, 2.7)).toBeNull()
    expect(rectAt(keys, 1.7)).toEqual(keys[1].r)
    expect(rectAt(keys, 3.8)).toEqual(keys[2].r)
    expect(rectAt([], 1)).toBeNull()
  })

  it('stays inside the picture', () => {
    const edge = [{ t: 0, r: rect(0, 0) }, { t: 0.5, r: rect(0.9, 0.85) }]
    const r = rectAt(edge, 0.25)!
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.y).toBeGreaterThanOrEqual(0)
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9)
    expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9)
  })
})

describe('following a clicked face', () => {
  it('builds the track of the face under the click, as pixelated areas', () => {
    const s = crossing()
    // the face that starts on the left, clicked at 1.0 s (between samples)
    const at = rectAt(buildFaceTracks(s).find((tr) => tr.keys[0].r.x < 0.5)!.keys, 1)!
    const keys = followFace(s, 1, at)!
    expect(keys).toHaveLength(10)
    expect(keys[0].r).toEqual(expect.objectContaining({ x: expect.closeTo(faceArea(rect(0.1, 0.3)).x, 3) }))
    expect(keys.every((k, i) => i === 0 || k.t > keys[i - 1].t)).toBe(true)
    expect(followFace(s, 1, rect(0.45, 0.8))).toBeNull()
  })

  it('joins the same person when they come back later', () => {
    const s: VideoFaces[] = []
    for (let i = 0; i < 4; i++) s.push({ t: 0.25 + i * 0.5, faces: [rect(0.2, 0.2)], desc: [desc(7)] })
    for (let i = 4; i < 10; i++) s.push({ t: 0.25 + i * 0.5, faces: [] })
    for (let i = 10; i < 14; i++) s.push({ t: 0.25 + i * 0.5, faces: [rect(0.7, 0.4), rect(0.1, 0.6)], desc: [desc(7, 0.05), desc(60)] })
    const keys = followFace(s, 0.75, rect(0.2, 0.2), desc(7))!
    expect(keys).toHaveLength(8)
    expect(keys[7].t).toBeCloseTo(6.75, 3)
    expect(keys[7].r.x).toBeCloseTo(faceArea(rect(0.7, 0.4)).x, 3)
  })
})

describe('coverage (review before export)', () => {
  it('a face counts as hidden when an area covers most of it', () => {
    const f = rect(0.4, 0.4)
    expect(isCovered(f, [faceArea(f)])).toBe(true)
    expect(isCovered(f, [rect(0.45, 0.45, 0.2, 0.2)])).toBe(false)
    expect(isCovered(f, [])).toBe(false)
  })

  it('open faces of a photo: neither pixelated nor a marked person', () => {
    const faces = [rect(0.1, 0.1), rect(0.4, 0.1), rect(0.7, 0.1)]
    const m = { id: 'm', kind: 'photo', faces, faceDesc: [desc(0), desc(20), desc(40)] } as unknown as MediaItem
    const e = { id: 'e', type: 'photo', mediaId: 'm', privacy: [faceArea(faces[1])] } as PhotoEntry
    expect(openPhotoFaces(e, m, [person('a', desc(0))])).toEqual([faces[2]])
  })

  it('open faces of a video: static areas, followed tracks and people count, only inside the trim', () => {
    const s = crossing()
    const m = { id: 'v', kind: 'video', duration: 5, videoFaces: s } as unknown as MediaItem
    const base = { id: 'e', type: 'video', mediaId: 'v' } as VideoEntry
    expect(openVideoFaces(base, m, undefined)).toHaveLength(10)
    // one of the two is a marked person: the other stays open (except where they overlap)
    const one = openVideoFaces(base, m, [person('a', desc(0))])
    expect(one.length).toBeGreaterThanOrEqual(8)
    expect(one.every((x) => x.faces.length === 1)).toBe(true)
    // both: nothing open
    expect(openVideoFaces(base, m, [person('a', desc(0)), person('b', desc(50))])).toEqual([])
    // the other followed by a track
    const tr = followFace(s, 0.25, s[0].faces[0])!
    expect(openVideoFaces({ ...base, privacyTracks: [tr] }, m, [person('a', desc(0))])).toEqual([])
    // trimmed to the first second
    expect(openVideoFaces({ ...base, trimOut: 1 }, m, undefined)).toHaveLength(3)
    expect(videoPersonTracks(m, [person('a', desc(0))])).toHaveLength(1)
    // "all faces" of the clip: both followed, nothing open
    expect(allVideoTracks(base, m)).toHaveLength(2)
    expect(openVideoFaces({ ...base, privacyTracks: allVideoTracks(base, m) }, m, undefined)).toEqual([])
    expect(allVideoTracks({ ...base, trimIn: 20 }, m)).toEqual([])
  })
})

describe('face alignment', () => {
  it('recovers a similarity transform', () => {
    const t = { a: 0.8, b: 0.3, tx: 12, ty: -4 }
    const src: Pt[] = [[10, 20], [60, 25], [35, 50], [36, 70]]
    const dst = src.map((p) => applySimilarity(t, p))
    const fit = fitSimilarity(src, dst)
    expect(fit.a).toBeCloseTo(0.8, 6)
    expect(fit.b).toBeCloseTo(0.3, 6)
    expect(fit.tx).toBeCloseTo(12, 6)
    expect(fit.ty).toBeCloseTo(-4, 6)
  })

  it('puts the eyes where the model expects them', () => {
    // a face tilted by 20 degrees, 200 px between the eyes
    const ang = (20 * Math.PI) / 180
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    const k = 200 / (CHIP_TARGETS[1][0] - CHIP_TARGETS[0][0])
    const kp = CHIP_TARGETS.map(([x, y]): Pt => [500 + k * (c * x - s * y), 300 + k * (s * x + c * y)])
    const t = chipTransform({ x: 400, y: 250, w: 400, h: 500 }, kp)
    const eye = applySimilarity(t, kp[0])
    expect(eye[0]).toBeCloseTo(CHIP_TARGETS[0][0], 3)
    expect(eye[1]).toBeCloseTo(CHIP_TARGETS[0][1], 3)
    // keypoints far outside the box are not trusted: the box decides
    const fromBox = chipTransform({ x: 0, y: 0, w: 100, h: 100 }, [[500, 500], [600, 500], [550, 550], [550, 600]])
    expect(fromBox.b).toBeCloseTo(0, 3)
  })
})

describe('stabilised clips', () => {
  it('zooms areas like the picture and grows them by the largest shift', () => {
    const mid = stabilizedArea(rect(0.45, 0.45, 0.1, 0.1), 1920, 1080)
    expect(mid.x + mid.w / 2).toBeCloseTo(0.5, 6)
    expect(mid.w).toBeGreaterThan(0.1 * (1 + STABILIZE_ZOOM))
    // a face near the right edge moves further right, the area stays in the picture
    const edge = stabilizedArea(rect(0.85, 0.2, 0.1, 0.15), 1920, 1080)
    expect(edge.x + edge.w / 2).toBeGreaterThan(0.9)
    expect(edge.x + edge.w).toBeLessThanOrEqual(1)
    // covers where the zoom puts the face, with room for the shift
    expect(edge.x).toBeLessThan(0.5 + 0.35 * (1 + STABILIZE_ZOOM) - 0.01)
  })
})

describe('closer search', () => {
  it('keeps known faces and their descriptors, adds new ones', () => {
    const known = [rect(0.1, 0.1), rect(0.5, 0.1)]
    const found = [rect(0.101, 0.1), rect(0.8, 0.6, 0.03, 0.05)]
    const m = mergeFaces(known, [desc(1), []], found, [desc(9), desc(20)])
    expect(m.faces).toEqual([...known, found[1]])
    // the first keeps its own descriptor; the second had none and no new match: stays empty
    expect(m.desc).toEqual([desc(1), [], desc(20)])
    const n = mergeFaces(known, undefined, found, [desc(9), desc(20)])
    expect(n.desc).toEqual([desc(9), [], desc(20)])
    expect(mergeFaces([], undefined, [], undefined)).toEqual({ faces: [], desc: undefined })
  })
})

describe('recognisable faces', () => {
  const chipWith = (band?: [number, number, number]): Uint8Array => {
    const px = new Uint8Array(CHIP_SIZE * CHIP_SIZE * 4)
    for (let y = 0; y < CHIP_SIZE; y++)
      for (let x = 0; x < CHIP_SIZE; x++) {
        const i = (y * CHIP_SIZE + x) * 4
        // skin, a darker brow line and pupils; goggles cover forehead to nose bridge
        let c: [number, number, number] = [205, 150, 125]
        if (y === 38 && x > 35 && x < 115) c = [90, 60, 50]
        if (Math.hypot(x - 47.5, y - 46.6) < 4 || Math.hypot(x - 100.5, y - 46.6) < 4) c = [40, 30, 30]
        if (band && y >= 28 && y < 64 && x >= 22 && x < 128) c = band
        px.set([...c, 255], i)
      }
    return px
  }

  it('sees whether the eyes are covered', () => {
    expect(eyeVisibility(chipWith())).toBeGreaterThan(0.8)
    expect(eyeVisibility(chipWith([60, 70, 200]))).toBeLessThan(0.05)
    expect(eyeVisibility(chipWith([20, 20, 25]))).toBeLessThan(0.05)
    // not skin at all (a dark glove taken for a face)
    const glove = new Uint8Array(CHIP_SIZE * CHIP_SIZE * 4).map((_, i) => (i % 4 === 3 ? 255 : 28))
    expect(eyeVisibility(glove)).toBe(0)
  })

  it('gates descriptors by confidence, size and visible eyes', () => {
    expect(recognisable(0.9, 40, 0.6)).toBe(true)
    expect(recognisable(0.5, 40, 0.6)).toBe(false)
    expect(recognisable(0.9, 8, 0.6)).toBe(false)
    expect(recognisable(0.9, 40, 0.1)).toBe(false)
  })
})

describe('face data from the renderer', () => {
  it('descriptors: 128 finite numbers aligned with the faces', () => {
    expect(sanitizeDescriptor(desc(3))).toEqual(desc(3))
    expect(sanitizeDescriptor([1, 2, 3])).toBeNull()
    expect(sanitizeDescriptor([...desc(3).slice(0, 127), Number.NaN])).toBeNull()
    expect(sanitizeDescriptors([desc(1), []], 2)).toEqual([desc(1), []])
    expect(sanitizeDescriptors([desc(1)], 2)).toBeUndefined()
    expect(sanitizeDescriptors('x', 0)).toBeUndefined()
  })

  it('video samples: ascending times, rects checked, descriptors kept only when aligned', () => {
    const out = sanitizeVideoFaces([
      { t: 0.25, faces: [rect(0.1, 0.1)], desc: [desc(0)] },
      { t: 0.2, faces: [] },
      { t: 0.75, faces: [rect(0.1, 0.1), { x: 'no' }], desc: [desc(0), desc(1)] },
      { t: 1.25, faces: [rect(0.1, 0.1)], desc: [[1, 2]] },
      null
    ])
    expect(out.map((s) => s.t)).toEqual([0.25, 0.75, 1.25])
    expect(out[0].desc).toEqual([desc(0)])
    expect(out[1].faces).toHaveLength(1)
    expect(out[1].desc).toBeUndefined()
    expect(out[2].desc).toBeUndefined()
    expect(sanitizeVideoFaces({})).toEqual([])
  })

  it('threshold is a sane distance', () => {
    expect(MATCH_THRESHOLD).toBeGreaterThan(0.3)
    expect(MATCH_THRESHOLD).toBeLessThan(0.7)
  })
})
