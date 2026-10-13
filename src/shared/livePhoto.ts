// Live Photos and Motion Photos: how their motion part plays on a slide. Once from the start, then
// the still (the show's "Play Live Photos" or the photo's own choice), or for the whole slide like the
// iPhone's effects: a Loop, whose end crossfades into its start so the seam doesn't jump, or a
// Bounce, forward and backward. The mapping from slide time to frames is the same for the preview
// and the export, so both show the same frames. Pure.
import type { Entry, LiveEffect, PhotoEntry } from './types'

export const LIVE_EFFECTS: readonly LiveEffect[] = ['loop', 'bounce']

/** Seconds of a Loop's crossfade from its end into its start (iOS: about this long). */
export const LOOP_FADE = 0.4

/** The effect of a photo's motion; undefined (play once) also for a value of a newer version. */
export function liveEffectOf(e: Entry | undefined): LiveEffect | undefined {
  const v = e?.type === 'photo' ? (e as PhotoEntry).liveEffect : undefined
  return v && LIVE_EFFECTS.includes(v) ? v : undefined
}

/**
 * Shortest automatic slide for a playing Live Photo of `duration` seconds: once, the motion and a
 * moment of the still; a Loop one pass through its seam; a Bounce forward and back.
 */
export function liveMinSeconds(duration: number, effect?: LiveEffect): number {
  return effect === 'bounce' ? 2 * duration : effect === 'loop' ? duration : duration + 0.8
}

/** Frames of a Loop's crossfade: about LOOP_FADE seconds, at most a third of the clip; none below 3 frames. */
export function loopFadeFrames(n: number, fps: number): number {
  if (n < 3) return 0
  return Math.max(1, Math.min(Math.floor(n / 3), Math.round(LOOP_FADE * fps)))
}

/** Seconds of one cycle of an effect on a clip of n frames: a Loop's period, or a Bounce there and back. */
export function cycleSeconds(effect: LiveEffect, n: number, fps: number): number {
  if (n <= 1 || !(fps > 0)) return 0
  return effect === 'bounce' ? (2 * (n - 1)) / fps : (n - loopFadeFrames(n, fps)) / fps
}

/** Frame `a` of the motion part; at a Loop's seam frame `b` is crossfaded over it by `w` (0..1). */
export interface MotionFrame {
  a: number
  b?: number
  w?: number
}

/**
 * Which of the n frames of a motion part (at `fps`) shows `t` seconds into its slide. Each frame
 * keeps its own frame time, so every frame shows once per cycle:
 * - Loop: the first pass plays from the start. Every later pass begins at the seam, where the last
 *   frames run on with the first ones fading in over them, one frame each, and carries on from there.
 * - Bounce: 0, 1, … n−1, n−2, … 1, 0, 1, …: the end frames show once at each turn, so it doesn't stall.
 */
export function motionFrame(effect: LiveEffect, t: number, n: number, fps: number): MotionFrame {
  if (n <= 1 || !(fps > 0)) return { a: 0 }
  // the frame slot; the epsilon keeps whole frame times (an export's) from rounding down
  const k = Math.max(0, Math.floor(t * fps + 1e-6))
  if (effect === 'bounce') {
    const phase = k % (2 * (n - 1))
    return { a: phase < n ? phase : 2 * (n - 1) - phase }
  }
  const fade = loopFadeFrames(n, fps)
  const period = n - fade
  const phase = k % period
  if (k < period || phase >= fade) return { a: phase }
  return { a: period + phase, b: phase, w: (phase + 1) / (fade + 1) }
}
