// The filmstrip under the preview: a card per slide in show order (SlideCard.tsx) over the audio lane,
// and the playhead; a show too long for the smallest cards zooms out into an overview of thin bars
// (StripOverview.tsx). Click, Shift+click and Ctrl+click select; on a focused card the keyboard goes
// through the cards and moves slides. Drag and drop is in stripDrop.ts, the zoom and the cards rendered
// in stripView.ts, search, chapters and zoom controls in StripTools.tsx, the menus in StripMenu.tsx.
import { useRef, useState, useEffect, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { EyeOff, LayoutGrid, Plus } from 'lucide-react'
import type { Timeline, TimelineSlide } from '@shared/timeline'
import { themeMeta } from '@shared/themes'
import { playerRef, useStore } from '../store'
import { useTimeline } from '../timeline'
import { t } from '../i18n'
import { isFixed } from '../entryEdits'
import { moveSlide as moveSlideTo } from '../insertAt'
import { AudioLane } from './AudioLane'
import { addWidth, numberEvery, STRIP_PAD, stripWidth, timeToX } from './stripScale'
import { ChaptersMenu, SearchBox, useSearchKeys, useStripSearch, ZoomControls } from './StripTools'
import { reducedMotion } from '../appearance'
import { SlideCard } from './SlideCard'
import { StripMenu, type StripMenuAt } from './StripMenu'
import { OverviewCard, StripOverview } from './StripOverview'
import { useStripDrop } from './stripDrop'
import { useStripView } from './stripView'

/** Card width a double-click on the overview zooms in to (small cards with pictures). */
const ZOOM_IN_CARD = 24

export function Filmstrip() {
  const project = useStore((s) => s.project)!
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const update = useStore((s) => s.update)
  const tl = useTimeline()!
  const [menu, setMenu] = useState<StripMenuAt | null>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const sel = new Set(selection)
  // the zoom (every size follows from the card width) and the cards rendered
  const { scale, min, view, first, last, manualUntil, zoomTo, fitAll, revealIndex } = useStripView(scrollRef, tl, sel)
  const { step, gap } = scale
  const overview = scale.detail === 'overview'
  const n = tl.slides.length
  const width = Math.max(stripWidth(n, scale), 200)
  // the overview's slide the keyboard went to last (its card has the focus while that slide is selected)
  const [keyAt, setKeyAt] = useState<number | null>(null)

  const moveSlide = (from: number, to: number): void => {
    const src = tl.slides[from]
    if (!src || src.kind === 'title') return
    update((p) => moveSlideTo(p, tl, from, to))
  }

  // Shift+click selects the range from the last clicked slide, Ctrl+click adds or removes one
  const anchor = useRef<number | null>(null)
  const clickSlide = (s: TimelineSlide, e: React.MouseEvent): void => {
    if (s.kind === 'title') {
      select([])
      useStore.getState().set({ tab: 'themes' })
      playerRef.current?.seek(s.start)
      return
    }
    const ids = s.entries.map((x) => x.id)
    if (e.shiftKey && anchor.current != null) {
      const [a, b] = [Math.min(anchor.current, s.index), Math.max(anchor.current, s.index)]
      select(tl.slides.slice(a, b + 1).flatMap((x) => x.entries.map((y) => y.id)))
    } else if (e.ctrlKey || e.shiftKey) {
      const on = s.entries.some((x) => sel.has(x.id))
      select(on ? selection.filter((id) => !ids.includes(id)) : [...new Set([...selection, ...ids])])
      anchor.current = s.index
    } else {
      select(ids)
      anchor.current = s.index
    }
    useStore.getState().set({ tab: 'slide' })
  }
  // a right click (or the menu key) selects the slide unless it is among the selected ones, and opens its menu
  const openMenu = (s: TimelineSlide, e: React.MouseEvent): void => {
    e.preventDefault()
    if (s.kind !== 'title' && !s.entries.some((x) => sel.has(x.id))) select(s.entries.map((x) => x.id))
    setMenu({ x: e.clientX, y: e.clientY, slide: s })
  }
  const excluded = project.entries.filter((x) => x.excluded).length
  const maxPer = themeMeta(project.settings.theme).maxPerSlide
  // slides whose photos were fixed by hand: the theme can group them again (after a theme change, say)
  const fixedSlides = maxPer > 1 ? tl.slides.filter((s) => s.entries.some(isFixed)).length : 0
  const drop = useStripDrop({ innerRef, tl, project, scale, maxPer, moveSlide })
  const selectedSlides = tl.slides.filter((sl) => sl.entries.some((e) => sel.has(e.id)))

  // ---- search and chapters: a match is selected, scrolled to and shown in the preview
  const jumpTo = (index: number): void => {
    const s = tl.slides[index]
    if (!s) return
    if (s.kind === 'title') {
      select([])
      useStore.getState().set({ tab: 'themes' })
    } else {
      select(s.entries.map((e) => e.id))
      useStore.getState().set({ tab: 'slide' })
      anchor.current = index
    }
    revealIndex(index)
    playerRef.current?.seek(s.start + Math.min(s.transIn + 0.05, s.duration / 2))
  }
  const search = useStripSearch(tl, project, jumpTo)
  useSearchKeys(search, searchInput)

  // The filmstrip is one stop in the tab order: the selected card (or the first), or the nearest card
  // rendered while that one is scrolled out of the page (else Tab would skip the filmstrip). Focus a card
  // by index, scrolling it into the rendered part first.
  const tabIndexAt = Math.min(Math.max(Math.max(0, tl.slides.findIndex((sl) => sl.entries.some((e) => sel.has(e.id)))), first), last)
  // in the overview the one card goes where the keyboard went (Shift+arrows: the end of the range)
  const overviewAt = keyAt != null && tl.slides[keyAt]?.entries.some((e) => sel.has(e.id)) ? keyAt : tabIndexAt
  const focusCard = (index: number, tries = 6): void => {
    // the overview's card moves to that slide now, so the next key press already reaches it
    if (overview && tries === 6) flushSync(() => setKeyAt(index))
    const el = scrollRef.current
    if (el) {
      // where the card sits in the scrolled strip, past its left padding (as revealIndex and the playhead)
      const x = index * step + STRIP_PAD
      if (x < el.scrollLeft || x + scale.card > el.scrollLeft + el.clientWidth - 32) el.scrollLeft = Math.max(0, x - el.clientWidth / 2)
    }
    // right away when the card is rendered (quick key presses go to the new card), else after a frame
    const cardEl = document.querySelector<HTMLElement>(`.card[data-index="${index}"]`)
    if (cardEl) cardEl.focus()
    else if (tries > 0) requestAnimationFrame(() => focusCard(index, tries - 1))
  }

  // keyboard on a focused card: Enter selects (Ctrl/Shift as with the mouse), the arrow keys (after
  // Tab, not after a click) go to the next card and select it, the menu key opens its menu, Alt+arrows
  // move the slide
  const cardKey = (s: TimelineSlide, e: React.KeyboardEvent<HTMLDivElement>): void => {
    const nav = e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End'
    if (nav && !e.altKey && !e.ctrlKey && e.currentTarget.matches(':focus-visible')) {
      e.preventDefault()
      e.stopPropagation()
      const to = e.key === 'Home' ? 0 : e.key === 'End' ? tl.slides.length - 1 : s.index + (e.key === 'ArrowLeft' ? -1 : 1)
      const next = tl.slides[to]
      if (!next) return
      clickSlide(next, e as unknown as React.MouseEvent)
      focusCard(to)
    } else if (e.key === 'Enter' && !e.altKey) {
      e.preventDefault()
      clickSlide(s, e as unknown as React.MouseEvent)
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      if (s.kind !== 'title' && !s.entries.some((x) => sel.has(x.id))) select(s.entries.map((x) => x.id))
      setMenu({ x: r.left + 8, y: r.top - 8, slide: s })
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && s.kind !== 'title') {
      e.preventDefault()
      e.stopPropagation()
      const to = e.key === 'ArrowLeft' ? s.index - 1 : s.index + 2
      if (to < 0 || to > tl.slides.length || tl.slides[to - (e.key === 'ArrowLeft' ? 0 : 1)]?.kind === 'title') return
      moveSlide(s.index, to)
      focusCard(e.key === 'ArrowLeft' ? s.index - 1 : s.index + 1)
    }
  }

  const every = numberEvery(scale)
  const current = search.current >= 0 ? search.hits[search.current]?.index : undefined
  const vars = { '--card-w': `${scale.card}px`, '--card-h': `${scale.height}px`, '--gap': `${gap}px` } as CSSProperties
  return (
    <section className={`strip zoom-${scale.detail} ${drop.filesOver ? 'files-over' : ''}`} aria-label={t('filmstrip')} style={vars}>
      {excluded > 0 && (
        <button className="excluded-chip" title={t('cullTitle')} onClick={() => useStore.getState().set({ view: 'cull' })}>
          <EyeOff size={12} aria-hidden /> {t('excludedCount').replace('{n}', String(excluded))}
        </button>
      )}
      <div className="strip-bar" role="group" aria-label={t('stripTools')}>
        <SearchBox search={search} tl={tl} inputRef={searchInput} />
        <ChaptersMenu tl={tl} onJump={jumpTo} />
        {fixedSlides > 0 && (
          <button className="fixed-chip" title={t('autoGroupHint')} onClick={() => useStore.getState().autoGroup()}>
            <LayoutGrid size={12} aria-hidden />{fixedSlides === 1 ? t('autoGroupChip1') : t('autoGroupChip').replace('{n}', String(fixedSlides))}
          </button>
        )}
        <span className="grow" />
        <ZoomControls card={scale.card} min={min} onZoom={(c) => zoomTo(c)} onFit={fitAll} />
      </div>
      <div
        className="strip-scroll"
        ref={scrollRef}
        onWheel={(e) => {
          if (e.ctrlKey) return
          manualUntil.current = performance.now() + 4000
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
        }}
        onPointerDown={(e) => {
          // grabbing the scrollbar (below the content) counts as manual scrolling
          if (e.target === e.currentTarget) manualUntil.current = performance.now() + 4000
        }}
      >
        <div className="strip-inner" ref={innerRef} style={{ width }} {...drop.handlers}>
          {overview && (
            <StripOverview
              tl={tl}
              step={step}
              height={scale.height}
              view={view}
              selection={selection}
              matched={search.matched}
              current={current}
              every={every}
              onSlide={clickSlide}
              onMenu={openMenu}
              onZoomIn={(clientX) => zoomTo(ZOOM_IN_CARD, clientX)}
            />
          )}
          <div className="cards">
            {overview && <div style={{ flex: '0 0 auto', width: n * step }} />}
            {overview && tl.slides[overviewAt] && (
              <OverviewCard key={tl.slides[overviewAt].id} slide={tl.slides[overviewAt]} step={step} selected={tl.slides[overviewAt].entries.some((e) => sel.has(e.id))} onKeyDown={(e) => cardKey(tl.slides[overviewAt], e)} />
            )}
            {!overview && first > 0 && <div style={{ flex: '0 0 auto', width: first * step - gap }} />}
            {!overview && tl.slides.slice(first, last + 1).map((s) => (
              <SlideCard
                key={s.id}
                slide={s}
                detail={scale.detail}
                showNum={every === 1 || s.index === 0 || (s.index + 1) % every === 0}
                tabbable={s.index === tabIndexAt}
                selected={s.entries.some((e) => sel.has(e.id))}
                captionSelected={!!s.captionEntryId && sel.has(s.captionEntryId)}
                match={search.matched.has(s.index) ? (s.index === current ? 'current' : 'match') : null}
                onCaption={() => {
                  select([s.captionEntryId!])
                  useStore.getState().set({ tab: 'slide' })
                }}
                dragging={drop.drag === s.index}
                mergeTarget={drop.mergeAt === s.index}
                onDuration={(sec) => useStore.getState().setSlideDuration(s.entries.map((e) => e.id), sec)}
                onClick={(e) => clickSlide(s, e)}
                onKeyDown={(e) => cardKey(s, e)}
                onMenu={(e) => openMenu(s, e)}
                onDragStart={() => drop.start(s.index)}
                onDragEnd={drop.end}
              />
            ))}
            {!overview && last < n - 1 && <div style={{ flex: '0 0 auto', width: (n - 1 - last) * step - gap }} />}
            <button
              className="card add"
              style={overview ? { width: addWidth(scale) - 4, marginLeft: 4 } : { width: addWidth(scale) }}
              title={t('addToShow')}
              aria-label={t('addToShow')}
              aria-haspopup="menu"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu({ x: r.left, y: r.top - 120, add: true })
              }}
            >
              <Plus size={20} />
            </button>
          </div>
          {drop.dropAt != null && <div className="drop-indicator" style={{ left: drop.dropAt * step - gap / 2 - 1 }} />}
          <AudioLane tl={tl} width={width} step={step} from={view.left - STRIP_PAD - 200} to={view.left - STRIP_PAD + view.width + 200} />
          <Playhead tl={tl} step={step} scrollRef={scrollRef} manualUntil={manualUntil} />
        </div>
      </div>
      {menu && <StripMenu menu={menu} tl={tl} project={project} selectedSlides={selectedSlides} onClose={() => setMenu(null)} />}
    </section>
  )
}

function Playhead({ tl, step, scrollRef, manualUntil }: { tl: Timeline; step: number; scrollRef: React.RefObject<HTMLDivElement | null>; manualUntil: React.RefObject<number> }) {
  const playhead = useStore((s) => s.playhead)
  const playing = useStore((s) => s.playing)
  const x = timeToX(tl, playhead, step)
  // keep the playhead inside the visible part of the filmstrip
  useEffect(() => {
    const el = scrollRef.current
    if (!el || performance.now() < manualUntil.current) return
    const px = x + STRIP_PAD
    if (px < el.scrollLeft + 40 || px > el.scrollLeft + el.clientWidth - 80) {
      el.scrollTo({ left: Math.max(0, px - el.clientWidth * 0.25), behavior: playing && !reducedMotion() ? 'smooth' : 'auto' })
    }
  }, [x, playing, scrollRef, manualUntil])
  return <div className="playhead" style={{ left: x - 1 }} />
}
