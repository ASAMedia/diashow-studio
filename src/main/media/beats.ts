// Beat tracking for music tracks: spectral-flux onset envelope, tempo from its autocorrelation, beat
// placement by dynamic programming (D. Ellis, "Beat Tracking by Dynamic Programming", 2007).
// Pure JS. The envelope is computed while FFmpeg streams PCM, one pipe chunk (64 KB, ~3 ms of FFTs)
// per macrotask; the final tempo + DP stage is O(frames · period), ~20 ms for a 4-minute track.
import { abortError } from '../abort'
import { FfmpegError, summarizeStderr, type Ffmpeg } from '../ffmpeg'

export const BEAT_SR = 22050
const N = 1024
const HOP = 512
/** Envelope frames per second. */
export const FRAME_RATE = BEAT_SR / HOP
const MIN_BPM = 70
const MAX_BPM = 180
/** Log compression: log(1 + GAIN·|X|) with |X| normalised so a full-scale sine is ~0.5. */
const GAIN = 1000
/** Ellis' "tightness": how strongly the inter-beat interval is held to the tempo. */
const TIGHTNESS = 100
/**
 * Samples from a frame's start to the onset time it reports. Measured with click tracks: a sharp
 * onset produces its flux peak once it has moved ~3/4 of a hop into the window.
 */
const ONSET_LATENCY = 550

export interface BeatResult {
  bpm: number
  /** Seconds from the start of the track. */
  beats: number[]
}

/** In-place iterative radix-2 FFT of a real frame, returning |X[k]| for k = 0..n/2. */
class Fft {
  private readonly rev: Uint32Array
  private readonly cos: Float64Array
  private readonly sin: Float64Array
  private readonly re: Float64Array
  private readonly im: Float64Array

  constructor(private readonly n: number) {
    const bits = Math.log2(n)
    this.rev = new Uint32Array(n)
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
    this.cos = new Float64Array(n / 2)
    this.sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n)
      this.sin[i] = Math.sin((2 * Math.PI * i) / n)
    }
    this.re = new Float64Array(n)
    this.im = new Float64Array(n)
  }

  magnitudes(input: Float32Array, out: Float32Array): void {
    const { n, re, im, rev, cos, sin } = this
    for (let i = 0; i < n; i++) {
      re[rev[i]] = input[i]
      im[i] = 0
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = start + k
          const b = a + half
          const wr = cos[t]
          const wi = -sin[t]
          const tr = wr * re[b] - wi * im[b]
          const ti = wr * im[b] + wi * re[b]
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
    for (let k = 0; k <= n / 2; k++) out[k] = Math.hypot(re[k], im[k])
  }
}

/** Streaming onset strength: mean half-wave rectified increase of the log magnitude spectrum. */
export class OnsetEnvelope {
  private readonly fft = new Fft(N)
  private readonly window = new Float32Array(N)
  private readonly frame = new Float32Array(N)
  private readonly mag = new Float32Array(N / 2 + 1)
  private prev = new Float32Array(N / 2 + 1)
  private cur = new Float32Array(N / 2 + 1)
  private hasPrev = false
  private buf = new Float32Array(N * 64)
  private len = 0
  private readonly values: number[] = []

  constructor() {
    let sum = 0
    for (let i = 0; i < N; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)
      sum += this.window[i]
    }
    // |X| of a full-scale sine ≈ 0.5 after this scaling
    for (let i = 0; i < N; i++) this.window[i] /= sum
  }

  push(samples: Float32Array): void {
    if (this.len + samples.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, this.len + samples.length))
      next.set(this.buf.subarray(0, this.len))
      this.buf = next
    }
    this.buf.set(samples, this.len)
    this.len += samples.length
    let off = 0
    while (this.len - off >= N) {
      this.process(off)
      off += HOP
    }
    if (off) {
      this.buf.copyWithin(0, off, this.len)
      this.len -= off
    }
  }

  private process(off: number): void {
    const { frame, window, buf, mag } = this
    for (let i = 0; i < N; i++) frame[i] = buf[off + i] * window[i]
    this.fft.magnitudes(frame, mag)
    const cur = this.cur
    for (let k = 0; k < mag.length; k++) cur[k] = Math.log1p(GAIN * mag[k])
    let flux = 0
    if (this.hasPrev) {
      const prev = this.prev
      for (let k = 1; k < cur.length; k++) {
        const d = cur[k] - prev[k]
        if (d > 0) flux += d
      }
      flux /= cur.length - 1
    }
    this.values.push(flux)
    this.cur = this.prev
    this.prev = cur
    this.hasPrev = true
  }

  /** Onset strength per frame; frame i reports time (i·HOP + ONSET_LATENCY) / BEAT_SR. */
  finish(): Float32Array {
    return Float32Array.from(this.values)
  }
}

function mean(a: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return a.length ? s / a.length : 0
}

function std(a: ArrayLike<number>): number {
  const m = mean(a)
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2
  return a.length > 1 ? Math.sqrt(s / (a.length - 1)) : 0
}

/** Refines the position of a peak at i from its neighbours (parabolic fit), result in [i-0.5, i+0.5]. */
function parabolic(y: ArrayLike<number>, i: number): number {
  if (i <= 0 || i >= y.length - 1) return i
  const a = y[i - 1]
  const b = y[i]
  const c = y[i + 1]
  const den = a - 2 * b + c
  if (den >= 0 || b < a || b < c) return i
  return i + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den))
}

/**
 * Beat period in frames: autocorrelation of the envelope within 70–180 BPM, weighted by a
 * log-normal prior around 120 BPM (one octave wide), refined to a fraction of a frame.
 */
export function estimatePeriod(env: ArrayLike<number>): number {
  const n = env.length
  const m = mean(env)
  const minLag = Math.floor((60 * FRAME_RATE) / MAX_BPM)
  const maxLag = Math.ceil((60 * FRAME_RATE) / MIN_BPM)
  const score = new Float64Array(maxLag + 2)
  for (let lag = Math.max(1, minLag - 1); lag <= maxLag + 1 && lag < n; lag++) {
    let s = 0
    for (let t = 0; t + lag < n; t++) s += (env[t] - m) * (env[t + lag] - m)
    const bpm = (60 * FRAME_RATE) / lag
    const prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2)
    score[lag] = (s / (n - lag)) * prior
  }
  let best = minLag
  for (let lag = minLag; lag <= maxLag && lag < n; lag++) if (score[lag] > score[best]) best = lag
  return parabolic(score, best)
}

/** Autocorrelation of the envelope at `lag` relative to its variance (1 = perfectly periodic). */
function periodicity(env: ArrayLike<number>, lag: number): number {
  const n = env.length
  const m = mean(env)
  let at = 0
  let zero = 0
  for (let t = 0; t < n; t++) {
    const d = env[t] - m
    zero += d * d
    if (t + lag < n) at += d * (env[t + lag] - m)
  }
  return zero > 0 ? at / (n - lag) / (zero / n) : 0
}

/** Ellis' dynamic programming: best sequence of onsets spaced close to `period` frames. */
export function trackBeats(env: Float32Array, period: number): number[] {
  const n = env.length
  const sd = std(env)
  if (!(sd > 0) || n < 2 * period) return []
  // Local score: envelope normalised and smoothed with a Gaussian ~period/32 wide
  const radius = Math.max(1, Math.round(period / 8))
  const kernel: number[] = []
  for (let k = -radius; k <= radius; k++) kernel.push(Math.exp(-0.5 * ((k * 32) / period) ** 2))
  const local = new Float64Array(n)
  for (let t = 0; t < n; t++) {
    let s = 0
    for (let k = -radius; k <= radius; k++) {
      const j = t + k
      if (j >= 0 && j < n) s += (env[j] / sd) * kernel[k + radius]
    }
    local[t] = s
  }
  const from = Math.round(2 * period)
  const to = Math.max(1, Math.round(period / 2))
  const txwt = new Float64Array(from + 1)
  for (let d = to; d <= from; d++) txwt[d] = -TIGHTNESS * Math.log(d / period) ** 2
  let maxLocal = 0
  for (let t = 0; t < n; t++) maxLocal = Math.max(maxLocal, local[t])
  const threshold = 0.01 * maxLocal
  const cum = new Float64Array(n)
  const back = new Int32Array(n).fill(-1)
  let started = false
  for (let t = 0; t < n; t++) {
    let best = -Infinity
    let arg = -1
    for (let d = to; d <= from; d++) {
      const p = t - d
      // Before the first possible predecessor a beat may start a chain (score of the transition only)
      const s = txwt[d] + (p >= 0 ? cum[p] : 0)
      if (s > best) {
        best = s
        arg = p
      }
    }
    cum[t] = local[t] + best
    if (!started && local[t] < threshold) back[t] = -1
    else {
      back[t] = arg
      started = true
    }
  }
  // Last beat: the latest local maximum of the cumulative score above half the median maximum
  const maxima: number[] = []
  for (let t = 1; t < n - 1; t++) if (cum[t] > cum[t - 1] && cum[t] >= cum[t + 1]) maxima.push(t)
  if (!maxima.length) return []
  const med = [...maxima.map((t) => cum[t])].sort((a, b) => a - b)[maxima.length >> 1]
  let last = maxima[maxima.length - 1]
  for (let i = maxima.length - 1; i >= 0; i--) {
    if (2 * cum[maxima[i]] > med) {
      last = maxima[i]
      break
    }
  }
  const beats: number[] = []
  for (let t = last; t >= 0; t = back[t]) beats.push(t)
  beats.reverse()
  // Drop weak beats at the start and end (silence, fade in/out): smoothed onset strength at the beats
  const strength = beats.map((b) => local[b])
  const hann = [0.25, 0.75, 1, 0.75, 0.25]
  const smooth = strength.map((_, i) => {
    let s = 0
    for (let k = -2; k <= 2; k++) s += (strength[i + k] ?? 0) * hann[k + 2]
    return s
  })
  const rms = Math.sqrt(mean(smooth.map((v) => v * v)))
  const median = [...strength].sort((x, y) => x - y)[strength.length >> 1]
  // The smoothing lets a lone weak beat next to strong ones pass, so the raw strength counts too
  const weak = (i: number): boolean => smooth[i] <= 0.5 * rms || strength[i] < 0.25 * median
  let a = 0
  let b = beats.length - 1
  while (a <= b && weak(a)) a++
  while (b >= a && weak(b)) b--
  return beats.slice(a, b + 1)
}

/** Tempo from beat times: least squares over beat numbers (missed beats keep their slot). */
function tempoOf(times: number[], fallbackPeriodSec: number): number {
  if (times.length < 4) return 60 / fallbackPeriodSec
  const ibis = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b)
  const median = ibis[ibis.length >> 1]
  // Count beat slots interval by interval: rounding (t - t0) / median would drift by a slot once
  // the median (quantised to frames) is off by more than half a period over the whole track
  const idx = [0]
  for (let i = 1; i < times.length; i++) idx.push(idx[i - 1] + Math.max(1, Math.round((times[i] - times[i - 1]) / median)))
  const mx = mean(idx)
  const my = mean(times)
  let num = 0
  let den = 0
  for (let i = 0; i < times.length; i++) {
    num += (idx[i] - mx) * (times[i] - my)
    den += (idx[i] - mx) ** 2
  }
  const period = den > 0 ? num / den : median
  return 60 / period
}

/**
 * Removes the slowly varying floor (noise, sustained parts) from the envelope: the moving mean over
 * ~1 s is subtracted and negative values are clipped (Ellis' high-pass step).
 */
export function detrend(env: Float32Array): Float32Array {
  const n = env.length
  const r = Math.round(FRAME_RATE / 2)
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i]
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - r)
    const b = Math.min(n, i + r + 1)
    out[i] = Math.max(0, env[i] - (prefix[b] - prefix[a]) / (b - a))
  }
  return out
}

/** Beats and tempo from an onset envelope (FRAME_RATE frames per second); null without a pulse. */
export function beatsFromEnvelope(raw: Float32Array): BeatResult | null {
  // Shorter than ~6 s or (near) silent: no meaningful tempo
  if (raw.length < 6 * FRAME_RATE || !(std(raw) > 1e-6)) return null
  const env = detrend(raw)
  // No onsets worth the name (steady tones, near silence), or no periodicity (noise, free rhythm).
  // Measured: tones/noise peak below 0.05, pop music around 1.4; autocorrelation at the beat
  // period / variance: noise 0.11, click tracks > 0.5, pop music ~0.3.
  let peak = 0
  for (let i = 0; i < env.length; i++) peak = Math.max(peak, env[i])
  if (peak < 0.1) return null
  const period = estimatePeriod(env)
  if (periodicity(env, Math.round(period)) < 0.1) return null
  const frames = trackBeats(env, period)
  if (frames.length < 2) return null
  const times = frames.map((f) => Math.round(((parabolic(env, f) * HOP + ONSET_LATENCY) / BEAT_SR) * 1000) / 1000)
  const bpm = tempoOf(times, period / FRAME_RATE)
  return { bpm: Math.round(bpm * 10) / 10, beats: times }
}

/** Beat tracking of mono PCM at BEAT_SR (tests, short buffers). */
export function detectBeats(samples: Float32Array): BeatResult | null {
  const onset = new OnsetEnvelope()
  onset.push(samples)
  return beatsFromEnvelope(onset.finish())
}

/**
 * Decodes any audio file with FFmpeg (mono, 22.05 kHz float) and tracks its beats. The PCM is pulled
 * chunk by chunk with a macrotask yield in between, so FFmpeg (blocked by the full pipe) waits for
 * the analysis instead of a backlog of chunks being processed in one go.
 */
export async function detectBeatsInFile(ff: Ffmpeg, path: string, signal?: AbortSignal): Promise<BeatResult | null> {
  if (signal?.aborted) throw abortError()
  const child = ff.spawn(['-nostdin', '-loglevel', 'error', '-i', path, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(BEAT_SR), '-f', 'f32le', '-acodec', 'pcm_f32le', '-'])
  let stderr = ''
  child.stderr!.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString('utf8')).slice(-8000)
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  const onAbort = (): void => {
    child.kill()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const onset = new OnsetEnvelope()
  let carry: Buffer | null = null
  try {
    for await (const chunk of child.stdout! as AsyncIterable<Buffer>) {
      const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk
      const usable = buf.length - (buf.length % 4)
      carry = usable < buf.length ? Buffer.from(buf.subarray(usable)) : null
      if (usable) {
        // Copy into an aligned buffer: chunk offsets inside Node's pool are not 4-byte aligned
        const aligned = new Uint8Array(usable)
        aligned.set(buf.subarray(0, usable))
        onset.push(new Float32Array(aligned.buffer))
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    const code = await exited
    if (signal?.aborted) throw abortError()
    if (code !== 0) throw new FfmpegError(summarizeStderr(stderr) || `ffmpeg exited with code ${code}`, stderr, code)
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (child.exitCode === null) child.kill()
  }
  return beatsFromEnvelope(onset.finish())
}
