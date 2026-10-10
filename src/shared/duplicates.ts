// The same video clip twice in a show, e.g. the original from the phone next to a copy forwarded
// through WhatsApp (re-encoded, smaller). Pure functions; findRejects (renderer) uses them.
//
// A clip is recognised by its length and two difference hashes: the thumbnail (frame at 10 %, `hash`)
// and a frame at 60 % (`hash2`). A re-encode keeps both frames (a few bits apart at most), while a
// different clip of the same scene and length rarely matches at both times.
import type { MediaItem } from './types'

function popcount32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555)
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333)
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

/** Differing bits of two 64-bit hashes (16 hex chars); 64 when either is malformed. */
export function hashDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return 64
  return popcount32((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) + popcount32((parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0)
}

/** Hash bits that may differ per frame between a clip and its re-encode. */
export const CLIP_HASH_BITS = 6
/** Without the second hash, only near-identical thumbnails count. */
export const CLIP_THUMB_ONLY_BITS = 3

/** Lengths of a clip and its re-encode: within 0.35 s, or 2 % for long clips. */
export function sameLength(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.35, 0.02 * Math.max(a, b))
}

/** Two ready videos that are the same clip (original, re-encode, or the same file twice). */
export function sameClip(a: MediaItem, b: MediaItem): boolean {
  if (a.kind !== 'video' || b.kind !== 'video' || !a.hash || !b.hash || !a.duration || !b.duration) return false
  if (!sameLength(a.duration, b.duration)) return false
  // same shape (a re-encode keeps it; portrait vs. landscape never match)
  if (a.width && b.width && a.height && b.height && Math.abs(Math.log((a.width / a.height) / (b.width / b.height))) > 0.04) return false
  if (a.hash2 && b.hash2) return hashDistance(a.hash, b.hash) <= CLIP_HASH_BITS && hashDistance(a.hash2, b.hash2) <= CLIP_HASH_BITS
  return hashDistance(a.hash, b.hash) <= CLIP_THUMB_ONLY_BITS
}

/**
 * Which copy to keep: more pixels first (a re-encode is never larger), then the higher bit rate,
 * then the one with camera/phone data (messengers strip it). Positive when `a` is better.
 */
export function compareClipQuality(a: MediaItem, b: MediaItem): number {
  const pa = a.width * a.height
  const pb = b.width * b.height
  if (Math.abs(pa - pb) > 0.01 * Math.max(pa, pb)) return pa - pb
  const ra = a.bitrate ?? 0
  const rb = b.bitrate ?? 0
  if (Math.abs(ra - rb) > 0.05 * Math.max(ra, rb)) return ra - rb
  return Number(!!a.device) - Number(!!b.device)
}

/**
 * Groups of the same clip (indices into `items`, at least two each); the first index of a group is
 * the copy to keep, ties keep the earlier one.
 */
export function sameClipGroups(items: MediaItem[]): number[][] {
  const parent = items.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      if (sameClip(items[a], items[b])) parent[find(b)] = find(a)
    }
  }
  const groups = new Map<number, number[]>()
  items.forEach((_, i) => {
    const r = find(i)
    groups.set(r, [...(groups.get(r) ?? []), i])
  })
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const best = g.reduce((keep, i) => (compareClipQuality(items[i], items[keep]) > 0 ? i : keep), g[0])
      return [best, ...g.filter((i) => i !== best)]
    })
}
