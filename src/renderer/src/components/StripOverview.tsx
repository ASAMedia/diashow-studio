// The filmstrip's overview (Filmstrip.tsx): a show too long for the smallest cards zooms out further,
// and every slide becomes a thin bar in the average colour of its picture (stripColors.ts), text slides
// dark and missing files red. One canvas draws the bars in view with a mark at each chapter, the
// selection, the search matches and a slide number every few slides; the playhead and the audio lane
// keep the cards' time-to-x mapping. A click selects a slide (the preview shows it), a double-click
// zooms in around the mouse, a right click opens the slide's menu. For the keyboard and screen readers
// the slide the keyboard is on gets a card of its own over its bar (OverviewCard): the filmstrip's one
// Tab stop, moved by the arrow keys like the cards.
import { useEffect, useLayoutEffect, useReducer, useRef } from 'react'
import type { Timeline, TimelineSlide } from '@shared/timeline'
import type { MediaItem } from '@shared/types'
import { averageColor, onColors, wantColors } from './stripColors'
import { slideLabel } from './SlideCard'
import { STRIP_PAD } from './stripScale'

/** The band above the bars for numbers and marks, as above the cards (.cards is 22 px taller than a card). */
const BAND = 22
/** Text slides look like the text cards; a picture that can't be shown is red. */
const TEXT_BAR = '#0f0f10'
const FAILED_BAR = '#8c2f2f'
/** Drawn beyond the view on each side (px). */
const MARGIN = 200

const isChapter = (s: TimelineSlide): boolean => s.kind === 'text' || s.kind === 'title' || !!s.captionEntryId

/** A bar's colour; a picture whose colour isn't known yet goes into `unknown` (to be read). */
function barColor(s: TimelineSlide, empty: string, unknown: MediaItem[]): string {
  if (s.kind === 'text' || s.kind === 'title') return TEXT_BAR
  if (s.media.some((m) => m.status === 'error')) return FAILED_BAR
  const m = s.media[0]
  const color = m ? averageColor(m) : ''
  if (color === undefined && m?.thumb) unknown.push(m)
  return color || empty
}

export function StripOverview(props: {
  tl: Timeline
  step: number
  /** Height of a bar (the cards' height). */
  height: number
  /** The scrolled part of the filmstrip (stripView.ts). */
  view: { left: number; width: number }
  selection: readonly string[]
  /** Slide indexes of the search matches, and the one shown last. */
  matched: ReadonlySet<number>
  current?: number
  /** A number every n slides. */
  every: number
  onSlide: (s: TimelineSlide, e: React.MouseEvent) => void
  onMenu: (s: TimelineSlide, e: React.MouseEvent) => void
  onZoomIn: (clientX: number) => void
}) {
  const { tl, step, height, view, selection, matched, current, every } = props
  const ref = useRef<HTMLCanvasElement>(null)
  // drawn again when colours arrive and when the light or dark theme changes
  const [colors, colorsArrived] = useReducer((x: number) => x + 1, 0)
  const [theme, themeChanged] = useReducer((x: number) => x + 1, 0)
  useEffect(() => onColors(colorsArrived), [])
  useEffect(() => {
    const watch = new MutationObserver(themeChanged)
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => watch.disconnect()
  }, [])

  const n = tl.slides.length
  // the canvas covers the part of the strip in view and a margin: the view follows a scroll a frame later
  const left = Math.max(0, Math.min(n * step, view.left - STRIP_PAD - MARGIN))
  const width = Math.max(1, Math.min(view.width + 2 * MARGIN, n * step - left))
  const h = BAND + height

  useLayoutEffect(() => {
    const c = ref.current
    const g = c?.getContext('2d')
    if (!c || !g) return
    const dpr = window.devicePixelRatio || 1
    const W = Math.round(width * dpr)
    const H = Math.round(h * dpr)
    if (c.width !== W) c.width = W
    if (c.height !== H) c.height = H
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, W, H)
    g.setTransform(dpr, 0, 0, dpr, -left * dpr, 0)
    const css = getComputedStyle(c)
    const token = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
    const accent = token('--accent', '#4d9fff')
    const i0 = Math.max(0, Math.floor(left / step))
    const i1 = Math.min(n - 1, Math.ceil((left + width) / step))
    // bars, with a hairline between them when there is room
    const gap = step >= 3 ? 1 : 0
    const empty = token('--thumb-empty', '#2b2b2f')
    const unknown: MediaItem[] = []
    for (let i = i0; i <= i1; i++) {
      g.fillStyle = barColor(tl.slides[i], empty, unknown)
      g.fillRect(i * step, BAND, step - gap, height)
    }
    if (unknown.length) wantColors(unknown)
    // a thin line at each chapter, from above the bar down (as on small cards)
    g.fillStyle = accent
    for (let i = i0; i <= i1; i++) if (isChapter(tl.slides[i])) g.fillRect(i * step, BAND - 9, Math.min(2, Math.max(1, step)), height + 9)
    // search matches: a yellow mark above the bar, a taller one for the match shown last
    g.fillStyle = token('--warn', '#ffc861')
    for (let i = i0; i <= i1; i++) {
      if (!matched.has(i)) continue
      if (i === current) g.fillRect(i * step - 1, BAND - 6, Math.max(step, 2) + 2, 4)
      else g.fillRect(i * step, BAND - 5, Math.max(step, 1), 3)
    }
    // the selection: an outline around each run of selected slides
    const sel = new Set(selection)
    const on = (s: TimelineSlide): boolean => s.entries.some((e) => sel.has(e.id)) || (!!s.captionEntryId && sel.has(s.captionEntryId))
    g.strokeStyle = accent
    g.lineWidth = 2
    let run = -1
    for (let i = i0; i <= i1 + 1; i++) {
      const selected = i <= i1 && on(tl.slides[i])
      if (selected && run < 0) run = i
      if (!selected && run >= 0) {
        g.strokeRect(run * step - 1, BAND - 1, (i - run) * step - gap + 2, height + 2)
        run = -1
      }
    }
    // slide numbers every few slides
    g.fillStyle = token('--text-3', '#8e8e93')
    g.font = `10px ${css.fontFamily}`
    for (let i = i0; i <= i1; i++) if (i === 0 || (i + 1) % every === 0) g.fillText(String(i + 1), i * step, 10)
  }, [tl, step, height, left, width, h, n, selection, matched, current, every, colors, theme])

  const slideAt = (clientX: number): TimelineSlide | undefined => {
    const r = ref.current!.getBoundingClientRect()
    return tl.slides[Math.min(n - 1, Math.max(0, Math.floor((clientX - r.left + left) / step)))]
  }
  return (
    <canvas
      ref={ref}
      className="strip-overview"
      style={{ left, width, height: h }}
      data-step={step}
      aria-hidden
      onClick={(e) => {
        const s = slideAt(e.clientX)
        if (s) props.onSlide(s, e)
      }}
      onDoubleClick={(e) => props.onZoomIn(e.clientX)}
      onContextMenu={(e) => {
        const s = slideAt(e.clientX)
        if (s) props.onMenu(s, e)
      }}
      onPointerMove={(e) => {
        // the slide under the mouse as a tooltip, without drawing anything again
        const s = slideAt(e.clientX)
        e.currentTarget.title = s ? slideLabel(s) : ''
      }}
    />
  )
}

/**
 * The card of the slide the keyboard is on in the overview: invisible over its bar until it has the
 * focus, named like a card ("Folie 12: IMG_0003.JPG") and handling the same keys (Filmstrip.tsx cardKey).
 */
export function OverviewCard({ slide: s, step, selected, onKeyDown }: { slide: TimelineSlide; step: number; selected: boolean; onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void }) {
  const w = Math.max(4, step)
  return (
    <div
      className="card overview-card"
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-keys="app"
      data-index={s.index}
      data-entry={s.entries[0]?.id}
      aria-label={slideLabel(s)}
      style={{ left: s.index * step + step / 2 - w / 2, width: w }}
      onKeyDown={onKeyDown}
    />
  )
}
