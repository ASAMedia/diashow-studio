import type { MediaItem, Project, ProjectSettings } from '@shared/types'
import type { Timeline, TimelineSlide } from '@shared/timeline'
import type { Box } from './draw'
import type { Compositor, PostParams, Tex } from './gl'
import type { TextSpec } from './text'

export interface SlideState {
  slide: TimelineSlide
  /** Seconds since the slide started. */
  local: number
  /** local / duration */
  p: number
  /** Incoming transition progress, 1 once complete. */
  inP: number
  /** Outgoing transition progress, 0 until it starts. */
  outP: number
}

export interface Ctx {
  c: Compositor
  W: number
  H: number
  t: number
  project: Project
  tl: Timeline
  settings: ProjectSettings
  /** Display texture of a photo (null while loading). */
  image(m: MediaItem | undefined): Tex | null
  /** Current frame of a video slide or the motion part of a live photo, at slide-local time. */
  video(slide: TimelineSlide, local: number, index?: number): Tex | null
  text(spec: TextSpec): Tex | null
}

export interface Theme {
  /**
   * 'composite': each slide is drawn into its own buffer and the two are blended by a
   * transition shader. 'scene': the theme animates both slides itself on a shared background.
   */
  mode: 'composite' | 'scene'
  clear: [number, number, number]
  background?(ctx: Ctx, states: SlideState[]): void
  drawSlide(ctx: Ctx, s: SlideState): void
  /** Composite mode: transition shader and direction (uv space) for the incoming slide. */
  transition?(ctx: Ctx, incoming: SlideState): { kind: string; dir: [number, number] }
  post?(ctx: Ctx): Partial<PostParams>
  /** Resting cell rectangles of a photo slide in canvas pixels (crop editing in the viewer). */
  boxes?(W: number, H: number, slide: TimelineSlide, settings: ProjectSettings): Box[]
  /** The theme draws slide captions itself; otherwise the engine adds a lower-third caption. */
  ownCaption?: boolean
}
