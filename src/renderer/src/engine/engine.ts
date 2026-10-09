import type { LookId, MediaItem, Project, ThemeId } from '@shared/types'
import { buildTimeline, slidesAt, type Timeline, type TimelineSlide } from '@shared/timeline'
import { Compositor, NEUTRAL_POST, type PostParams, type Tex } from './gl'
import { ExportVideoStore, ImageStore, TextStore, VideoPool } from './media'
import type { Ctx, SlideState, Theme } from './types'
import { classic, kenburns, retro } from './themes/simple'
import { magazine, origami, panels, reflections, vintage } from './themes/scene'
import { applyTextStyle, clamp01, drawTextBlock, smooth, type Box } from './draw'

export const THEME_IMPL: Record<ThemeId, Theme> = { classic, kenburns, retro, magazine, origami, panels, reflections, vintage }

const LOOK_POST: Record<LookId, Partial<PostParams>> = {
  natural: {},
  vivid: { saturation: 1.3, contrast: 1.08 },
  warm: { warmth: 0.9, saturation: 1.06 },
  cool: { warmth: -0.9, tint: 0.2 },
  dramatic: { contrast: 1.28, saturation: 0.85, vignette: 0.4 },
  faded: { fade: 0.35, saturation: 0.82, contrast: 0.92, warmth: 0.35 },
  mono: { mono: 1, contrast: 1.06 },
  noir: { mono: 1, contrast: 1.45, vignette: 0.5, brightness: 0.95 }
}

export type EngineMode = 'preview' | 'export'

export class Engine {
  readonly c: Compositor
  private images: ImageStore
  private texts: TextStore
  private videos?: VideoPool
  private exportVideos?: ExportVideoStore
  project?: Project
  tl?: Timeline
  playing = false
  /** Photos drawn from a placeholder in the last frame because their full image wasn't loaded yet. */
  missing = 0

  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    readonly mode: EngineMode
  ) {
    this.c = new Compositor(canvas, mode === 'export')
    this.images = new ImageStore(this.c, mode === 'export' ? 4096 : 2048, mode === 'export' ? 40 : 28)
    this.texts = new TextStore(this.c)
    if (mode === 'preview') this.videos = new VideoPool(this.c)
    else this.exportVideos = new ExportVideoStore(this.c)
  }

  setProject(project: Project, tl?: Timeline): Timeline {
    this.project = project
    this.tl = tl ?? buildTimeline(project)
    return this.tl
  }

  resize(W: number, H: number): void {
    this.c.resize(Math.max(2, Math.round(W)), Math.max(2, Math.round(H)))
  }

  states(t: number): SlideState[] {
    if (!this.tl) return []
    return slidesAt(this.tl, t).map((slide) => {
      const local = t - slide.start
      return {
        slide,
        local,
        p: clamp01(local / slide.duration),
        inP: slide.transIn > 0 ? clamp01(local / slide.transIn) : 1,
        outP: slide.transOut > 0 ? clamp01((local - (slide.duration - slide.transOut)) / slide.transOut) : 0
      }
    })
  }

  /** Path and source time of the video in cell `index` of a slide at slide-local time. */
  private videoSource(slide: TimelineSlide, local: number, index = 0): { path: string; time: number } | null {
    const m = slide.media[index]
    if (slide.kind === 'video' && m?.playback) return { path: m.playback, time: (slide.video?.trimIn ?? 0) + local }
    const clip = slide.clips?.[index]
    // a clip shorter than its slide holds its last frame
    if (clip && m?.playback) return { path: m.playback, time: clip.trimIn + Math.min(local, clip.trimOut - clip.trimIn - 0.04) }
    if (index === 0 && slide.live && m?.liveVideo) return { path: m.liveVideo, time: Math.min(local, slide.live.duration - 0.04) }
    return null
  }

  private ctx(t: number): Ctx {
    const project = this.project!
    return {
      c: this.c,
      W: this.c.W,
      H: this.c.H,
      t,
      project,
      tl: this.tl!,
      settings: project.settings,
      image: (m: MediaItem | undefined) => {
        if (!m) return null
        const full = this.images.get(m.display)
        if (full) return full
        this.missing++
        return this.images.get(m.thumb)
      },
      video: (slide, local, index) => {
        const src = this.videoSource(slide, local, index)
        if (!src) return null
        if (this.videos) return this.videos.frame(src.path, src.time, this.playing)
        return this.exportVideos!.get(src.path)
      },
      text: (spec) => this.texts.get(applyTextStyle(spec, project.settings.text))
    }
  }

  /** Media needed around time t: visible slides plus the Vintage pile and the Magazine cover. */
  private neededMedia(t: number, ahead: number): MediaItem[] {
    const tl = this.tl!
    const out = new Set<MediaItem>()
    for (const s of tl.slides) {
      if (s.start > t + ahead) break
      if (s.start + s.duration < t - 0.5) continue
      s.media.forEach((m) => out.add(m))
    }
    const theme = this.project!.settings.theme
    const cur = slidesAt(tl, t)
    const idx = cur.length ? cur[cur.length - 1].index : 0
    if (theme === 'vintage') for (let i = Math.max(0, idx - 6); i < idx; i++) tl.slides[i].media.slice(0, 1).forEach((m) => out.add(m))
    if (theme === 'magazine') {
      const cover = tl.slides.find((s) => s.kind === 'photos')
      if (cover) out.add(cover.media[0])
    }
    return [...out]
  }

  /** Export: wait until every texture for time t is decoded. */
  async prepare(t: number): Promise<void> {
    if (!this.tl || !this.project) return
    await Promise.all(this.neededMedia(t, 0).map((m) => (m.kind === 'photo' ? this.images.ensure(m.display) : Promise.resolve())))
    const paths = new Set<string>()
    for (const s of this.states(t)) for (let i = 0; i < Math.max(1, s.slide.entries.length); i++) {
      const src = this.videoSource(s.slide, s.local, i)
      if (!src) continue
      paths.add(src.path)
      await this.exportVideos?.prepare(src.path, src.time)
    }
    this.exportVideos?.keepOnly(paths)
  }

  render(t: number): void {
    if (!this.tl || !this.project) return
    const c = this.c
    const theme = THEME_IMPL[this.project.settings.theme] ?? kenburns
    const ctx = this.ctx(t)
    if (this.mode === 'preview') for (const m of this.neededMedia(t, 6)) if (m.kind === 'photo') ctx.image(m)
    const states = this.states(t)
    this.missing = 0

    if (states.length === 2 && theme.mode === 'composite') {
      const [a, b] = states
      c.target(1, theme.clear)
      theme.background?.(ctx, [a])
      theme.drawSlide(ctx, a)
      c.target(2, theme.clear)
      theme.background?.(ctx, [b])
      theme.drawSlide(ctx, b)
      c.target(0, theme.clear)
      const tr = theme.transition?.(ctx, b) ?? { kind: 'dissolve', dir: [1, 0] as [number, number] }
      this.composite(tr.kind, c.targetTex(1), c.targetTex(2), b.inP, tr.dir)
    } else {
      c.target(0, theme.clear)
      theme.background?.(ctx, states)
      for (const s of states) theme.drawSlide(ctx, s)
    }
    if (!theme.ownCaption) for (const s of states) this.caption(ctx, s, theme)

    const post: PostParams = { ...NEUTRAL_POST, ...LOOK_POST[this.project.settings.look], ...(theme.post?.(ctx) ?? {}), time: t }
    c.post(c.targetTex(0), post)
    this.images.tick()
    this.texts.tick()
    this.videos?.sweep()
  }

  /** Lower-third caption for themes that don't place captions themselves. */
  private caption(ctx: Ctx, s: SlideState, theme: Theme): void {
    const cap = s.slide.caption
    if (!cap) return
    const { W, H } = this.c
    const light = theme.clear[0] + theme.clear[1] + theme.clear[2] > 1.5
    const o = smooth((s.inP - 0.3) / 0.5) * (1 - smooth(s.outP / 0.6))
    if (o <= 0.001) return
    const pos = ctx.settings.text?.position && ctx.settings.text.position !== 'theme' ? ctx.settings.text.position : 'bottom-left'
    const base = { font: 'sans' as const, weight: 600, color: light ? '#2b2e2c' : '#ffffff', shadow: !light, maxWidth: W * 0.6, lineHeight: 1.15 }
    const specs = [{ ...base, text: cap.text, size: H * 0.04 }]
    if (cap.subtitle) specs.push({ ...base, text: cap.subtitle, size: H * 0.03 })
    drawTextBlock(ctx, specs, pos, { x: H * 0.02, y: H * 0.02, w: W - H * 0.04, h: H - H * 0.04 }, o)
  }

  /** Resting cell rectangles of a slide for crop editing, in canvas pixels. */
  editBoxes(slide: TimelineSlide): Box[] {
    if (!this.project || slide.kind !== 'photos') return []
    const theme = THEME_IMPL[this.project.settings.theme]
    return theme.boxes?.(this.c.W, this.c.H, slide, this.project.settings) ?? []
  }

  /** Cube and flip are drawn as 3D quads; everything else is a full-screen shader. */
  private composite(kind: string, a: Tex, b: Tex, p: number, dir: [number, number]): void {
    const c = this.c
    const { W, H } = c
    if (kind !== 'cube' && kind !== 'flip') {
      c.transition(kind, a, b, p, dir)
      return
    }
    const horizontal = dir[0] !== 0
    const sign = horizontal ? dir[0] : dir[1]
    const full = { x: 0, y: 0, w: W, h: H, flipY: true }
    const rot = (angle: number): { rotY?: number; rotX?: number } => (horizontal ? { rotY: angle * sign } : { rotX: angle * sign })
    if (kind === 'flip') {
      const e = p < 0.5 ? p * 2 : (1 - p) * 2
      const recede = -Math.sin(Math.PI * p) * H * 0.35
      if (p < 0.5) c.quad({ ...full, tex: a, ...rot((-e * Math.PI) / 2), z: recede, shade: e * 0.4 })
      else c.quad({ ...full, tex: b, ...rot((e * Math.PI) / 2), z: recede, shade: e * 0.4 })
      return
    }
    const depth = (horizontal ? W : H) / 2
    const theta = (p * Math.PI) / 2
    const recede = -Math.sin(Math.PI * p) * depth * 0.6
    const faceA = { ...full, tex: a, ...rot(-theta), lz: depth, z: -depth + recede, shade: Math.sin(theta) * 0.5 }
    const faceB = { ...full, tex: b, ...rot(Math.PI / 2 - theta), lz: depth, z: -depth + recede, shade: Math.cos(theta) * 0.5 }
    if (p < 0.5) {
      c.quad(faceB)
      c.quad(faceA)
    } else {
      c.quad(faceA)
      c.quad(faceB)
    }
  }

  readPixels(out: Uint8Array): void {
    this.c.readPixels(out)
  }

  dispose(): void {
    this.images.dispose()
    this.texts.dispose()
    this.videos?.dispose()
    this.exportVideos?.dispose()
    this.c.dispose()
  }
}

/** Fonts must be loaded before text textures are drawn (export renders immediately). */
export async function loadFonts(): Promise<void> {
  const specs = ['300 40px Inter', '400 40px Inter', '600 40px Inter', '700 40px Inter', '400 40px Anton', '400 40px Cinzel', '400 40px "Special Elite"', '400 40px "Playfair Display"', '500 40px "Barlow Semi Condensed"', '600 40px "Barlow Semi Condensed"', '800 40px "Nunito Sans"']
  await Promise.all(specs.map((s) => document.fonts.load(s).catch(() => [])))
}
