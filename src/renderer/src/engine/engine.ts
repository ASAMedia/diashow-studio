import type { LookId, MediaAdjust, MediaEdit, MediaItem, Project, TextEntry, ThemeId } from '@shared/types'
import { editedSize, editToSource, isEdited, sourceAspect, type Affine } from '@shared/mediaEdit'
import { panoramaOf } from '@shared/panorama'
import { adjustParams, type AdjustParams } from '@shared/adjust'
import { motionFrame } from '@shared/livePhoto'
import { buildTimeline, clipSeconds, slidesAt, titleStyleOf, type Timeline, type TimelineSlide } from '@shared/timeline'
import { Compositor, NEUTRAL_LOOK, NEUTRAL_POST, type Look, type PostParams, type Tex } from './gl'
import { ExportVideoStore, ImageStore, MotionStore, TextStore, VideoPool } from './media'
import type { Ctx, SlideState, Theme } from './types'
import { classic, kenburns, retro } from './themes/simple'
import { magazine, origami, panels, reflections, vintage } from './themes/scene'
import { drawShatter, scrapbook, shatter, snapshots } from './themes/extra'
import { applyTextStyle, clamp01, drawTextBlock, smooth, type Box } from './draw'
import { drawFreeText } from './freeText'
import { drawStyledTitle } from './titles'
import { drawCollage } from './collage'
import { PrivacyIndex } from './privacy'

export const THEME_IMPL: Record<ThemeId, Theme> = { classic, kenburns, retro, magazine, origami, panels, reflections, vintage, scrapbook, snapshots, shatter }

/** Transitions that move pictures (eased); dissolves and fades blend linearly. */
const MOVING = new Set(['push', 'wipe', 'moveIn', 'reveal', 'zoom', 'cube', 'flip', 'droplet'])

// colour looks act on photos and videos only (not on paper, backgrounds or text)
const LOOKS: Record<LookId, Partial<Look>> = {
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

/**
 * Memory one looping or bouncing Live Photo may take while its slide is near (a 3 s iPhone motion
 * part, 90 frames of 1440×1080, takes about 210 MB as decoded); bigger ones are kept scaled down.
 */
const MOTION_BUDGET = { preview: 256e6, export: 512e6 }

export class Engine {
  readonly c: Compositor
  private images: ImageStore
  private texts: TextStore
  private videos?: VideoPool
  private exportVideos?: ExportVideoStore
  /** Loop and Bounce: motion parts decoded into memory (preview and export). */
  private motions: MotionStore
  project?: Project
  tl?: Timeline
  playing = false
  /** Photos drawn from a placeholder in the last frame because their full image wasn't loaded yet. */
  missing = 0

  /** The last frame had everything: no picture still loading, every video at its frame. */
  get settled(): boolean {
    return this.missing === 0 && (this.videos?.settled() ?? true)
  }
  /** Areas to pixelate per media id: drawn areas, followed faces, marked people (engine/privacy.ts). */
  private privacy = new PrivacyIndex()
  /** Texture maps of edited media, per edit (edits are replaced, never changed in place). */
  private views = new WeakMap<MediaEdit, Affine>()
  /** Shader numbers of adjusted media, per adjustment (replaced, never changed in place). */
  private adjusts = new WeakMap<MediaAdjust, AdjustParams | null>()
  /** Preview only: sliders being dragged (not stored yet) set these values on these media. */
  adjustDraft: { ids: ReadonlySet<string>; patch: MediaAdjust } | null = null

  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    readonly mode: EngineMode
  ) {
    this.c = new Compositor(canvas, mode === 'export')
    this.images = new ImageStore(this.c, mode === 'export' ? 4096 : 2048, mode === 'export' ? 40 : 28)
    this.texts = new TextStore(this.c)
    if (mode === 'preview') this.videos = new VideoPool(this.c)
    else this.exportVideos = new ExportVideoStore(this.c)
    this.motions = new MotionStore(this.c, MOTION_BUDGET[mode])
  }

  setProject(project: Project, tl?: Timeline): Timeline {
    this.project = project
    this.tl = tl ?? buildTimeline(project)
    this.privacy.setProject(project)
    return this.tl
  }

  /**
   * Every texture of a media item carries its pixelated areas, whichever theme draws it. `time`:
   * source time of a video frame (faces followed through the clip).
   */
  private markPrivate(m: MediaItem | undefined, tex: Tex | null, time?: number, path?: string): Tex | null {
    const rects = m && tex ? this.privacy.at(m, time, !!path && path === m.stabilized) : undefined
    if (rects?.length && tex) this.c.markPrivate(tex, rects)
    return this.edited(m, tex)
  }

  /**
   * The picture as edited (rotate, straighten, crop): the same texture, sampled through an affine
   * map and with the edited size, so every theme crops and fits it like any other picture. The
   * pixelated areas stay on the texture (original coordinates) and so on the same faces. Light and
   * colour ride along as uniforms of the same draw (shared/adjust.ts).
   */
  private edited(m: MediaItem | undefined, tex: Tex | null): Tex | null {
    if (!tex || !m) return tex
    const adjust = this.adjustOf(m)
    if (!isEdited(m.edit)) return adjust ? { ...tex, adjust } : tex
    let map = this.views.get(m.edit)
    if (!map) this.views.set(m.edit, (map = editToSource(m.edit, sourceAspect(m))))
    const size = editedSize(tex.w, tex.h, m.edit)
    return { ...tex, w: size.w, h: size.h, view: { m: map, tw: tex.w, th: tex.h }, ...(adjust ? { adjust } : {}) }
  }

  /** Light and colour of a media item for the shader (a slider's draft first), undefined when there is none. */
  private adjustOf(m: MediaItem): AdjustParams | undefined {
    const stored = m.edit?.adjust
    if (this.adjustDraft?.ids.has(m.id)) return adjustParams({ ...stored, ...this.adjustDraft.patch }) ?? undefined
    if (!stored) return undefined
    let p = this.adjusts.get(stored)
    if (p === undefined) this.adjusts.set(stored, (p = adjustParams(stored)))
    return p ?? undefined
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
  /**
   * Path and source time of the video in cell `index` of a slide at slide-local time. `hold`
   * is set once a clip has reached its end and shows its last frame (it must not keep playing).
   */
  private videoSource(slide: TimelineSlide, local: number, index = 0): { path: string; time: number; hold: boolean; rate: number } | null {
    const m = slide.media[index]
    const span = slide.kind === 'video' ? slide.video : slide.clips?.[index]
    if (span && m?.playback) {
      // local is screen time; the source runs `speed` times as fast
      const end = clipSeconds(span) - 0.05 / span.speed
      // "Reduce shake": the stabilised copy has the same frames and timing as playback
      const e = slide.entries[index]
      const path = e?.type === 'video' && e.stabilize && m.stabilized ? m.stabilized : m.playback
      return { path, time: span.trimIn + Math.max(0, Math.min(local, end)) * span.speed, hold: local >= end, rate: span.speed }
    }
    // (a Loop or Bounce comes from the decoded motion part instead: motion())
    if (index === 0 && slide.live && !slide.live.effect && m?.liveVideo) {
      const end = slide.live.duration - 0.05
      return { path: m.liveVideo, time: Math.min(local, end), hold: local >= end, rate: 1 }
    }
    return null
  }

  /**
   * A looping or bouncing Live Photo at slide time `local`: its frame from the decoded motion part, at
   * a Loop's seam two frames that the shader blends. Null while the clip is decoded (the still shows
   * meanwhile, and the frame counts as missing) or when it can't be.
   */
  private motion(slide: TimelineSlide, local: number): Tex | null {
    const m = slide.media[0]
    const path = m?.liveVideo
    if (!path || !slide.live?.effect) return null
    const clip = this.motions.get(path)
    if (!clip) {
      if (!this.motions.failed(path)) this.missing++
      return null
    }
    const f = motionFrame(slide.live.effect, local, clip.frames.length, clip.fps)
    const a = this.motions.frame(path, f.a, 0)
    const b = f.b != null ? this.motions.frame(path, f.b, 1) : null
    // the pixelated areas sit on the first texture and apply to both (the motion keeps the photo's areas)
    return this.markPrivate(m, a && b ? { ...a, mix: { tex: b.tex, w: f.w ?? 0 } } : a, clip.times[f.a])
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
        // a video has no display image: its still is its thumbnail (a video print on Vintage's pile),
        // and nothing better is on its way
        if (m.kind === 'video') return this.markPrivate(m, this.images.get(m.thumb))
        const full = this.images.get(m.display, this.panoNeed(m))
        if (full) return this.markPrivate(m, full)
        this.missing++
        return this.markPrivate(m, this.images.get(m.thumb))
      },
      video: (slide, local, index) => {
        if (!index && slide.live?.effect) return this.motion(slide, local)
        const src = this.videoSource(slide, local, index)
        if (!src) return null
        const m = slide.media[index ?? 0]
        if (this.videos) return this.markPrivate(m, this.videos.frame(src.path, src.time, this.playing && !src.hold, src.rate), src.time, src.path)
        return this.markPrivate(m, this.exportVideos!.get(src.path), src.time, src.path)
      },
      text: (spec) => this.texts.get(applyTextStyle(spec, project.settings.text))
    }
  }

  /**
   * Pixels a panorama needs on its short side: it fills the frame's height (a tall one its width)
   * while it pans, so it is loaded sharper than a photo of the same long side would be; 0 for others.
   */
  private panoNeed(m: MediaItem): number {
    const axis = panoramaOf(m, this.c.W / this.c.H)
    return axis ? (axis === 'x' ? this.c.H : this.c.W) : 0
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
    await Promise.all(this.neededMedia(t, 0).map((m) => (m.kind === 'photo' ? this.images.ensure(m.display, this.panoNeed(m)) : Promise.resolve())))
    const paths = new Set<string>()
    const motions = new Set<string>()
    for (const s of this.states(t)) {
      const motion = s.slide.live?.effect ? s.slide.media[0]?.liveVideo : undefined
      if (motion) {
        motions.add(motion)
        await this.motions.ensure(motion)
      }
      for (let i = 0; i < Math.max(1, s.slide.entries.length); i++) {
        const src = this.videoSource(s.slide, s.local, i)
        if (!src) continue
        paths.add(src.path)
        await this.exportVideos?.prepare(src.path, src.time)
      }
    }
    this.exportVideos?.keepOnly(paths)
    this.motions.keepOnly(motions)
  }

  render(t: number): void {
    if (!this.tl || !this.project) return
    const c = this.c
    const theme = THEME_IMPL[this.project.settings.theme] ?? kenburns
    c.setLook({ ...NEUTRAL_LOOK, ...LOOKS[this.project.settings.look] })
    c.clearPrivate()
    const ctx = this.ctx(t)
    if (this.mode === 'preview') {
      for (const m of this.neededMedia(t, 6)) if (m.kind === 'photo') ctx.image(m)
      // open the videos of the next seconds early, so a cell doesn't start with a blank frame; a Loop's or
      // Bounce's motion part is decoded a little earlier, it takes longer
      for (const s of this.tl.slides) {
        if (s.start > t + 4) break
        if (s.start <= t) continue
        if (s.live?.effect && s.media[0]?.liveVideo) this.motions.get(s.media[0].liveVideo)
        if (s.start > t + 2.5) continue
        s.entries.forEach((_, i) => {
          const src = this.videoSource(s, 0, i)
          if (src) this.videos!.preload(src.path, src.time)
        })
      }
    }
    const states = this.states(t)
    this.missing = 0

    if (states.length === 2 && theme.mode === 'composite') {
      const [a, b] = states
      c.target(1, theme.clear)
      theme.background?.(ctx, [a])
      this.drawSlide(theme, ctx, a)
      c.target(2, theme.clear)
      theme.background?.(ctx, [b])
      this.drawSlide(theme, ctx, b)
      c.target(0, theme.clear)
      const tr = theme.transition?.(ctx, b) ?? { kind: 'dissolve', dir: [1, 0] as [number, number] }
      this.composite(tr.kind, c.targetTex(1), c.targetTex(2), b.inP, tr.dir, b.slide.id)
    } else {
      c.target(0, theme.clear)
      theme.background?.(ctx, states)
      for (const s of states) this.drawSlide(theme, ctx, s)
    }
    if (!theme.ownCaption) for (const s of states) this.caption(ctx, s, theme)
    for (const s of states) {
      const o = smooth(s.inP) * (1 - smooth(s.outP))
      for (const e of s.slide.entries) for (const ft of e.texts ?? []) drawFreeText(ctx, ft, o)
    }

    const post: PostParams = { ...NEUTRAL_POST, ...(theme.post?.(ctx) ?? {}), time: t }
    c.post(c.targetTex(0), post)
    this.images.tick()
    this.texts.tick()
    this.videos?.sweep()
    if (this.mode === 'preview') this.motions.sweep()
  }

  /** Title and chapter slides with an animated style are drawn here instead of by the theme. */
  private drawSlide(theme: Theme, ctx: Ctx, s: SlideState): void {
    if (s.slide.template?.id === 'free') return drawCollage(ctx, s, theme)
    // the show title on the first photo (themes without a title slide) takes the style too
    const overlay = s.slide.titleOverlay ? titleStyleOf(undefined, ctx.settings) : 'theme'
    if (overlay !== 'theme') {
      theme.drawSlide(ctx, { ...s, slide: { ...s.slide, titleOverlay: false } })
      drawStyledTitle(ctx, s, overlay, theme, true)
      return
    }
    const kind = s.slide.kind
    const style = kind === 'title' || kind === 'text' ? titleStyleOf(kind === 'text' ? (s.slide.entries[0] as TextEntry) : undefined, ctx.settings) : 'theme'
    if (style === 'theme') theme.drawSlide(ctx, s)
    else drawStyledTitle(ctx, s, style, theme)
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
    // a panning panorama has no framing to drag
    if (!this.project || slide.kind !== 'photos' || slide.template?.id === 'free' || slide.pano?.mode === 'pan') return []
    const theme = THEME_IMPL[this.project.settings.theme]
    return theme.boxes?.(this.c.W, this.c.H, slide, this.project.settings) ?? []
  }

  /** Cube and flip are drawn as 3D quads; everything else is a full-screen shader. */
  private composite(kind: string, a: Tex, b: Tex, linear: number, dir: [number, number], seed = ''): void {
    const c = this.c
    const { W, H } = c
    if (kind === 'shatter') {
      drawShatter(c, a, b, linear, seed)
      return
    }
    // moves start and stop gently, like Photos: at constant speed a push jumped from rest to full
    // speed in one frame and stopped just as hard; blends stay linear
    const p = MOVING.has(kind) ? smooth(linear) : linear
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

  /** Diagnostics for tests: image texture traffic, preview video state and the decoded motion parts. */
  stats(): { imageLoads: number; imageEvictions: number; videos: { path: string; seeks: number; paused: boolean; time: number }[]; motions: ReturnType<MotionStore['stats']> } {
    return { imageLoads: this.images.loads, imageEvictions: this.images.evictions, videos: this.videos?.stats() ?? [], motions: this.motions.stats() }
  }

  /** Preview only: size photos are loaded at; a lower preview quality also keeps looping Live Photos smaller. */
  setImageSize(px: number): void {
    this.images.maxSize = px
    this.motions.budget = MOTION_BUDGET.preview * Math.min(1, px / 2048) ** 2
  }

  readPixels(out: Uint8Array): void {
    this.c.readPixels(out)
  }

  /** Export: render into a texture and read frames as I420 with startYuv()/collectYuv(). */
  set yuvOutput(on: boolean) {
    this.c.offscreen = on
  }

  startYuv(): void {
    this.c.startYuv()
  }

  collectYuv(out: Uint8Array): Promise<void> {
    return this.c.collectYuv(out)
  }

  dispose(): void {
    this.images.dispose()
    this.texts.dispose()
    this.videos?.dispose()
    this.exportVideos?.dispose()
    this.motions.dispose()
    this.c.dispose()
  }
}

/** Fonts must be loaded before text textures are drawn (export renders immediately). */
export async function loadFonts(): Promise<void> {
  const specs = ['300 40px Inter', '400 40px Inter', '600 40px Inter', '700 40px Inter', '400 40px Anton', '400 40px Cinzel', '400 40px "Special Elite"', '400 40px "Playfair Display"', '500 40px "Barlow Semi Condensed"', '600 40px "Barlow Semi Condensed"', '800 40px "Nunito Sans"', '400 40px Caveat', '600 40px Caveat', '700 40px Caveat']
  await Promise.all(specs.map((s) => document.fonts.load(s).catch(() => [])))
}
