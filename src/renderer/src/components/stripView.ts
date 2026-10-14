// The filmstrip's view (Filmstrip.tsx): only the cards in view (plus a margin) are rendered, as big
// shows have hundreds of slides; the zoom keeps a point in place; a slide is scrolled into view when it
// is shown (a search match, a chapter, inserted slides). Sizes and positions follow stripScale.ts.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Timeline } from '@shared/timeline'
import { useStore } from '../store'
import { timelineOf } from '../timeline'
import { prioritize } from '../priority'
import { stripReveal } from '../insert'
import { anchoredScroll, clampCard, fitCard, loadZoom, saveZoom, STRIP_PAD, stripScale, timeToX, zoomStep, type StripScale } from './stripScale'

export interface StripView {
  scale: StripScale
  /** The cards rendered: indices `first` to `last`. */
  first: number
  last: number
  /** Until then (performance.now()) the playhead's autoscroll leaves the filmstrip alone: the user scrolled or zoomed it. */
  manualUntil: RefObject<number>
  /** New card width; `clientX`: around the mouse (Ctrl+wheel), else the selected slide or the playhead stays in place. */
  zoomTo: (next: number, clientX?: number) => void
  /** "Show the whole slideshow": every slide fits. */
  fitAll: () => void
  /** Scrolls a slide into view (centred when it was outside). */
  revealIndex: (index: number) => void
}

/** `sel`: the selected entry ids. */
export function useStripView(scrollRef: RefObject<HTMLDivElement | null>, tl: Timeline, sel: ReadonlySet<string>): StripView {
  // autoscroll pauses for a moment after the user scrolls the filmstrip by hand
  const manualUntil = useRef(0)
  // zoom: the card width, remembered per user; every size below follows from it
  const [card, setCard] = useState(loadZoom)
  const scale = stripScale(card)
  const { step } = scale
  const n = tl.slides.length

  // Only the cards in view (plus a margin) are rendered; big shows have hundreds of slides.
  const [view, setView] = useState({ left: 0, width: 2000 })
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      setView((v) => (v.left === el.scrollLeft && v.width === el.clientWidth ? v : { left: el.scrollLeft, width: el.clientWidth }))
    }
    const onScroll = (): void => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    el.addEventListener('scroll', onScroll)
    const ro = new ResizeObserver(onScroll)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])
  const margin = Math.max(8, Math.ceil(200 / step))
  const first = Math.max(0, Math.floor((view.left - STRIP_PAD) / step) - margin)
  const last = Math.min(n - 1, Math.ceil((view.left + view.width) / step) + margin)
  // the cards in view are processed first during an import
  const visibleIds = tl.slides.slice(first, last + 1).flatMap((s) => s.media.map((m) => m.id)).join(',')
  useEffect(() => prioritize('filmstrip', visibleIds ? visibleIds.split(',') : []), [visibleIds])

  // ---- zoom: keeps a point in place, the mouse (Ctrl+wheel) or else the selected slide / the playhead
  const pendingZoom = useRef<{ scroll: number } | null>(null)
  const zoomTo = (next: number, clientX?: number): void => {
    const el = scrollRef.current
    const c = clampCard(next)
    if (!el || c === card) return
    const to = stripScale(c)
    let anchorX: number
    let from = el.scrollLeft
    if (clientX != null) anchorX = clientX - el.getBoundingClientRect().left
    else {
      const selIdx = tl.slides.findIndex((sl) => sl.entries.some((e) => sel.has(e.id)))
      const playX = timeToX(tl, useStore.getState().playhead, step)
      const x = selIdx >= 0 && Math.abs(selIdx * step - playX) > step ? selIdx * step + scale.card / 2 : playX
      const onScreen = x + STRIP_PAD - el.scrollLeft
      // in view: it stays where it is; else it comes to the middle
      anchorX = onScreen >= 0 && onScreen <= el.clientWidth ? onScreen : el.clientWidth / 2
      from = x + STRIP_PAD - anchorX
    }
    pendingZoom.current = { scroll: anchoredScroll(from, anchorX, step, to.step) }
    // the playhead's autoscroll leaves the new view alone for a moment
    manualUntil.current = Math.max(manualUntil.current, performance.now() + 1500)
    setCard(c)
    saveZoom(c)
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    const z = pendingZoom.current
    if (!el || !z) return
    pendingZoom.current = null
    el.scrollLeft = z.scroll
    // the rendered range follows before the next paint
    setView({ left: el.scrollLeft, width: el.clientWidth })
  }, [step])
  const fitAll = (): void => {
    const el = scrollRef.current
    if (el) zoomTo(fitCard(n, el.clientWidth - 2 * STRIP_PAD))
  }
  // Ctrl+wheel (and a touchpad pinch) zooms around the mouse; a passive React handler can't stop the page zoom
  const zoomRef = useRef({ zoomTo, card })
  zoomRef.current = { zoomTo, card }
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const wheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      manualUntil.current = performance.now() + 4000
      const { zoomTo: zoom, card: c } = zoomRef.current
      zoom(zoomStep(c, Math.exp(-Math.max(-300, Math.min(300, e.deltaY)) * 0.0025)), e.clientX)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])

  // ---- showing a slide: scroll it into view (centred when it was outside)
  const revealIndex = (index: number): void => {
    const el = scrollRef.current
    if (!el) return
    const x = index * step + STRIP_PAD
    if (x < el.scrollLeft + 8 || x + scale.card > el.scrollLeft + el.clientWidth - 8) {
      el.scrollLeft = Math.max(0, x + scale.card / 2 - el.clientWidth / 2)
      setView({ left: el.scrollLeft, width: el.clientWidth })
    }
    manualUntil.current = Math.max(manualUntil.current, performance.now() + 1500)
  }
  // inserted slides (insert.ts): shown once the filmstrip has drawn them
  const revealRef = useRef<string | null>(null)
  const revealNow = useRef(revealIndex)
  revealNow.current = revealIndex
  useEffect(() => {
    stripReveal.current = (entryId) => {
      revealRef.current = entryId
      requestAnimationFrame(() => {
        const id = revealRef.current
        const p = useStore.getState().project
        if (!id || !p) return
        revealRef.current = null
        const s = timelineOf(p).slides.find((x) => x.entries.some((e) => e.id === id))
        if (s) revealNow.current(s.index)
      })
    }
    return () => {
      stripReveal.current = null
    }
  }, [])

  return { scale, first, last, manualUntil, zoomTo, fitAll, revealIndex }
}
