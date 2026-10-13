import { useRef, useState, useEffect, useLayoutEffect, type CSSProperties } from 'react'
import { Clock, Film, FolderPlus, ImagePlus, Plus, Type, Volume2, VolumeX, Trash2, Split, Merge, Move, EyeOff, Crop as CropIcon, RotateCcw, SlidersHorizontal, LayoutGrid, MoveHorizontal, MoveVertical, Repeat, ArrowLeftRight } from 'lucide-react'
import { isChanged } from '@shared/mediaEdit'
import type { Timeline, TimelineSlide } from '@shared/timeline'
import { prioritize } from '../priority'
import type { VideoEntry } from '@shared/types'
import { themeMeta } from '@shared/themes'
import { playerRef, useStore } from '../store'
import { timelineOf, useTimeline } from '../timeline'
import { fmtTime, t } from '../i18n'
import { friendly } from '../errors'
import { modalOpen } from '../keys'
import { handledDrops, insertFiles, placeAt, stripReveal } from '../insert'
import { anchorAt, canJoin } from '../insertAt'
import { isFixed } from '../entryEdits'
import { AudioLane } from './AudioLane'
import { addWidth, anchoredScroll, clampCard, fitCard, loadZoom, numberEvery, saveZoom, STRIP_PAD, stripScale, stripWidth, timeToX, zoomStep, type StripDetail } from './stripScale'
import { ChaptersMenu, SearchBox, useStripSearch, ZoomControls } from './StripTools'
import { Menu, MenuItem, MenuSeparator } from './Menu'
import { reducedMotion } from '../appearance'
import { MediaThumb } from './EditedPicture'
import { openPhotoEdit, rotateSelection } from '../photoEdit'
import { followPointer } from '../pointerDrag'

interface Menu {
  x: number
  y: number
  slide?: TimelineSlide
  add?: boolean
}

/** Cards narrower than this take no "drop onto the card" (combine): the middle would be too small to hit. */
const MIN_MERGE_CARD = 40

export function Filmstrip() {
  const project = useStore((s) => s.project)!
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const update = useStore((s) => s.update)
  const tl = useTimeline()!
  const [menu, setMenu] = useState<Menu | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [mergeAt, setMergeAt] = useState<number | null>(null)
  // files from Explorer over the filmstrip (the window's "drop here" overlay steps aside)
  const [filesOver, setFilesOver] = useState(false)
  const filesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // drag events can arrive faster than React re-renders, so the handlers read refs
  const dragRef = useRef<number | null>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  // autoscroll pauses for a moment after the user scrolls the filmstrip by hand
  const manualUntil = useRef(0)
  const sel = new Set(selection)
  // zoom: the card width, remembered per user; every size below follows from it
  const [card, setCard] = useState(loadZoom)
  const scale = stripScale(card)
  const { step, gap } = scale
  const n = tl.slides.length
  const width = Math.max(stripWidth(n, scale), 200)

  const moveSlide = (from: number, to: number): void => {
    const src = tl.slides[from]
    if (!src || src.kind === 'title') return
    const ids = new Set(src.entries.map((e) => e.id))
    const target = tl.slides.slice(to).find((s) => s.kind !== 'title' && !s.entries.some((e) => ids.has(e.id)))
    update((p) => {
      const moving = p.entries.filter((e) => ids.has(e.id))
      p.entries = p.entries.filter((e) => !ids.has(e.id))
      const idx = target ? p.entries.findIndex((e) => e.id === target.entries[0].id) : p.entries.length
      p.entries.splice(idx < 0 ? p.entries.length : idx, 0, ...moving)
    })
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
  const excluded = project.entries.filter((x) => x.excluded).length
  const maxPer = themeMeta(project.settings.theme).maxPerSlide
  // slides whose photos were fixed by hand: the theme can group them again (after a theme change, say)
  const fixedSlides = maxPer > 1 ? tl.slides.filter((s) => s.entries.some(isFixed)).length : 0

  /** Files dragged from Explorer: can they join slide `target` (same rule as dragging a slide onto another)? */
  const filesFit = (target: TimelineSlide | undefined, items: DataTransferItemList): boolean => {
    // a panorama keeps its slide to itself
    if (!target || target.pano) return false
    const list = [...items].filter((it) => it.kind === 'file')
    // folders and unknown types (HEIC, RAW) are only known after the import: they go between slides
    if (!list.length || !list.every((it) => /^(image|video)\//.test(it.type))) return false
    return canJoin(target, list.map((it) => ({ kind: it.type.startsWith('video/') ? 'video' : 'photo' })), project.settings)
  }

  // Dropping on the middle of another slide combines both; near the edges it reorders (or inserts files).
  const dropTarget = (e: React.DragEvent, files: boolean): { merge?: number; insert?: number } => {
    const rect = innerRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const i = Math.floor(x / step)
    const within = (x - i * step) / scale.card
    const target = tl.slides[i]
    const source = dragRef.current != null ? tl.slides[dragRef.current] : undefined
    const canMerge = files
      ? filesFit(target, e.dataTransfer.items)
      : maxPer > 1 && !!target && !!source && i !== dragRef.current && target.kind !== 'title' && target.kind !== 'text' && source.kind !== 'text' &&
        target.entries.length + source.entries.length <= maxPer && !target.pano && !source.pano
    if (canMerge && scale.card >= MIN_MERGE_CARD && within > 0.25 && within < 0.75) return { merge: i }
    return { insert: Math.max(0, Math.min(n, Math.round(x / step))) }
  }
  const isFiles = (e: React.DragEvent): boolean => dragRef.current == null && e.dataTransfer.types.includes('Files')
  const clearMarks = (): void => {
    clearTimeout(filesTimer.current)
    setFilesOver(false)
    setDropAt(null)
    setMergeAt(null)
  }
  // dragover, and dragenter alike: when the element under the pointer has just changed (an edge between
  // two cards or pictures), Chromium fires no dragover in that step and decides on the drop by the
  // dragenter, so it is accepted (with the same effect) and shows the same mark
  const onDragOver = (e: React.DragEvent): void => {
    const files = isFiles(e)
    if (dragRef.current == null && !files) return
    e.preventDefault()
    e.dataTransfer.dropEffect = files ? 'copy' : 'move'
    if (files) {
      setFilesOver(true)
      clearTimeout(filesTimer.current)
      // dragover repeats while the files hover; when it stops, they left (or were dropped)
      filesTimer.current = setTimeout(clearMarks, 250)
    }
    const target = dropTarget(e, files)
    setMergeAt(target.merge ?? null)
    setDropAt(target.insert ?? null)
  }
  // the dragleave of a picture inside a card bubbles up here: only leaving the filmstrip (or the
  // window, or Esc: nowhere to go) clears the marks, or a card's mark would flicker at the edge
  // between its pictures
  const onDragLeave = (e: React.DragEvent): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) clearMarks()
  }
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const drag = dragRef.current
    const files = isFiles(e)
    // where it is dropped, not where the last dragover was: the drop can follow a dragenter at once
    const { merge, insert } = dropTarget(e, files)
    if (files) {
      // files from Explorer go in right here, as one undo step; the window's drop handler leaves them
      handledDrops.add(e.nativeEvent)
      const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean)
      const at = merge != null ? merge + 1 : (insert ?? n)
      const into = merge != null ? tl.slides[merge].entries.map((x) => x.id) : undefined
      if (paths.length) void insertFiles(paths, { before: anchorAt(tl, project.entries, at), ...(into ? { into } : {}) })
    } else if (drag != null && merge != null) {
      const ids = [...tl.slides[merge].entries, ...tl.slides[drag].entries].map((x) => x.id)
      useStore.getState().mergeEntries(ids)
      select(ids)
    } else if (drag != null && insert != null && insert !== drag && insert !== drag + 1) moveSlide(drag, insert)
    dragRef.current = null
    setDrag(null)
    clearMarks()
  }
  const selectedSlides = tl.slides.filter((sl) => sl.entries.some((e) => sel.has(e.id)))

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
  // Ctrl+F opens the search (also from another field), F3 / Shift+F3 go to the next / previous match
  const searchRef = useRef(search)
  searchRef.current = search
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      const st = useStore.getState()
      if (st.view !== 'editor' || st.fullscreen || st.exportOpen || st.presenting || st.dialog || modalOpen()) return
      const s = searchRef.current
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        s.setOpen(true)
        requestAnimationFrame(() => {
          searchInput.current?.focus()
          searchInput.current?.select()
        })
      } else if (e.key === 'F3' && s.open && s.hits.length) {
        e.preventDefault()
        if (e.shiftKey) s.prev()
        else s.next()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  // The filmstrip is one stop in the tab order: the selected card (or the first). Focus a card by index,
  // scrolling it into the rendered part first.
  const tabIndexAt = Math.max(0, tl.slides.findIndex((sl) => sl.entries.some((e) => sel.has(e.id))))
  const focusCard = (index: number, tries = 6): void => {
    const el = scrollRef.current
    if (el) {
      const x = index * step
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
    <section className={`strip zoom-${scale.detail} ${filesOver ? 'files-over' : ''}`} aria-label={t('filmstrip')} style={vars}>
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
        <ZoomControls card={scale.card} onZoom={(c) => zoomTo(c)} onFit={fitAll} />
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
        <div className="strip-inner" ref={innerRef} style={{ width }} onDragEnter={onDragOver} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
          <div className="cards">
            {first > 0 && <div style={{ flex: '0 0 auto', width: first * step - gap }} />}
            {tl.slides.slice(first, last + 1).map((s) => (
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
                dragging={drag === s.index}
                mergeTarget={mergeAt === s.index}
                onDuration={(sec) => useStore.getState().setSlideDuration(s.entries.map((e) => e.id), sec)}
                onClick={(e) => clickSlide(s, e)}
                onKeyDown={(e) => cardKey(s, e)}
                onMenu={(e) => {
                  e.preventDefault()
                  if (s.kind !== 'title' && !s.entries.some((x) => sel.has(x.id))) select(s.entries.map((x) => x.id))
                  setMenu({ x: e.clientX, y: e.clientY, slide: s })
                }}
                onDragStart={() => {
                  dragRef.current = s.index
                  setDrag(s.index)
                }}
                onDragEnd={() => {
                  dragRef.current = null
                  setDrag(null)
                  clearMarks()
                }}
              />
            ))}
            {last < n - 1 && <div style={{ flex: '0 0 auto', width: (n - 1 - last) * step - gap }} />}
            <button
              className="card add"
              style={{ width: addWidth(scale) }}
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
          {dropAt != null && <div className="drop-indicator" style={{ left: dropAt * step - gap / 2 - 1 }} />}
          <AudioLane tl={tl} width={width} step={step} />
          <Playhead tl={tl} step={step} scrollRef={scrollRef} manualUntil={manualUntil} />
        </div>
      </div>
      {menu && (menu.add || (menu.slide && menu.slide.kind !== 'title')) && (
        <Menu label={menu.add ? t('addToShow') : t('slideMenu')} onClose={() => setMenu(null)} style={{ left: menu.x, top: Math.max(8, menu.y - (menu.add ? 0 : 10)) }}>
          {menu.add && (
            <>
              <MenuItem icon={<ImagePlus size={15} />} onSelect={async () => useStore.getState().importMedia(await window.api.pickMedia())}>
                {t('addMedia')}
              </MenuItem>
              <MenuItem icon={<FolderPlus size={15} />} onSelect={async () => useStore.getState().importMedia(await window.api.pickFolder())}>
                {t('addFolder')}
              </MenuItem>
              <MenuItem icon={<Type size={15} />} onSelect={() => useStore.getState().addText()}>
                {t('addText')}
              </MenuItem>
            </>
          )}
          {menu.slide && menu.slide.kind !== 'title' && (
            <>
              <MenuItem
                icon={<ImagePlus size={15} />}
                onSelect={async () => {
                  // behind this slide, wherever it is by the time the dialog closes
                  const place = placeAt(menu.slide!.index + 1)
                  const paths = await window.api.pickMedia()
                  if (paths.length) await insertFiles(paths, place)
                }}
              >
                {t('insertHere')}
              </MenuItem>
              <MenuItem icon={<Type size={15} />} onSelect={() => useStore.getState().addText()}>
                {t('addText')}
              </MenuItem>
              {selectedSlides.length > 1 && maxPer > 1 && !selectedSlides.some((x) => x.pano) && selectedSlides.reduce((k, x) => k + x.entries.length, 0) <= maxPer && (
                <MenuItem icon={<Merge size={15} />} onSelect={() => useStore.getState().mergeEntries(selectedSlides.flatMap((x) => x.entries.map((e) => e.id)))}>
                  {t('merge')}
                </MenuItem>
              )}
              {menu.slide.entries.length > 1 && (
                <MenuItem icon={<Split size={15} />} onSelect={() => useStore.getState().splitSlide(menu.slide!.entries.map((e) => e.id))}>
                  {t('split')}
                </MenuItem>
              )}
              {menu.slide.kind !== 'text' && !menu.slide.pano && maxPer > 1 && menu.slide.index > 0 && ['photos', 'video'].includes(tl.slides[menu.slide.index - 1]?.kind) && !tl.slides[menu.slide.index - 1]?.pano && (
                <MenuItem
                  icon={<Merge size={15} />}
                  onSelect={() => {
                    const prev = tl.slides[menu.slide!.index - 1]
                    useStore.getState().mergeEntries([...prev.entries, ...menu.slide!.entries].map((e) => e.id))
                  }}
                >
                  {t('joinPrev')}
                </MenuItem>
              )}
              {maxPer > 1 &&
                (() => {
                  // the selected slides, or the one clicked when it isn't among them
                  const targets = selectedSlides.some((x) => x.index === menu.slide!.index) ? selectedSlides : [menu.slide!]
                  const ids = new Set(targets.flatMap((x) => x.entries.map((e) => e.id)))
                  if (!project.entries.some((e) => ids.has(e.id) && isFixed(e))) return null
                  return (
                    <MenuItem icon={<LayoutGrid size={15} />} onSelect={() => useStore.getState().autoGroup([...ids])}>
                      {t('autoGroup')}
                    </MenuItem>
                  )
                })()}
              <MenuItem
                icon={<EyeOff size={15} />}
                onSelect={() => {
                  const ids = (selectedSlides.length ? selectedSlides : [menu.slide!]).flatMap((x) => x.entries.map((y) => y.id))
                  useStore.getState().updateEntries(ids, (x) => (x.excluded = true))
                  select([])
                }}
              >
                {t('excludeSel')}
              </MenuItem>
              {(menu.slide.kind === 'photos' || menu.slide.kind === 'video') && (
                <>
                  <MenuItem icon={<CropIcon size={15} />} onSelect={() => openPhotoEdit(menu.slide!.entries[0].id)}>
                    {t('peEdit')}
                  </MenuItem>
                  <MenuItem icon={<RotateCcw size={15} />} onSelect={() => rotateSelection(-1)}>
                    {`${t('peRotateLeft')} (${t('kbdRotate')})`}
                  </MenuItem>
                </>
              )}
              {menu.slide.kind === 'photos' && themeMeta(project.settings.theme).kenBurns && (
                <MenuItem icon={<Move size={15} />} onSelect={() => useStore.getState().set({ tab: 'slide', kbEdit: 'start' })}>
                  {t('kbEdit')}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem icon={<Trash2 size={15} />} onSelect={() => useStore.getState().removeEntries(menu.slide!.entries.map((e) => e.id))}>
                {t('deleteSlide')}
              </MenuItem>
            </>
          )}
        </Menu>
      )}
    </section>
  )
}

function SlideCard(props: {
  slide: TimelineSlide
  /** How much the card shows at the filmstrip's zoom. */
  detail: StripDetail
  /** Small cards number only every few slides. */
  showNum: boolean
  /** The card the Tab key reaches (one per filmstrip). */
  tabbable: boolean
  selected: boolean
  captionSelected: boolean
  /** A search match ('current': the one shown last). */
  match: 'match' | 'current' | null
  onCaption: () => void
  dragging: boolean
  mergeTarget: boolean
  /** Drag on the right edge sets the slide's time; undefined = automatic again. */
  onDuration: (seconds: number | undefined) => void
  onClick: (e: React.MouseEvent) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
  onMenu: (e: React.MouseEvent) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const s = props.slide
  const m0 = s.media[0]
  const full = props.detail === 'full'
  const busy = s.media.find((m) => m.status === 'pending' || m.status === 'processing')
  const failed = s.media.find((m) => m.status === 'error')
  const ve = s.kind === 'video' ? (s.entries[0] as VideoEntry) : null
  const gridVideos = s.kind === 'photos' ? s.entries.filter((e) => e.type === 'video').length : 0
  const name = s.kind === 'text' || s.kind === 'title' ? s.title?.text : s.media.map((m) => m.name).join(', ')
  // small cards show fewer pictures: one, or two side by side
  const tiles = full ? s.media : s.media.slice(0, props.detail === 'compact' ? 2 : 1)
  const chapter = s.kind === 'text' || s.kind === 'title' || !!s.captionEntryId
  const classes = [
    'card',
    props.selected && 'selected',
    props.captionSelected && 'cap-selected',
    props.dragging && 'dragging',
    props.mergeTarget && 'merge-target',
    chapter && 'chapter',
    props.match && 'match',
    props.match === 'current' && 'match-current',
    !props.showNum && 'no-num'
  ]
  return (
    <div
      className={classes.filter(Boolean).join(' ')}
      role="button"
      tabIndex={props.tabbable ? 0 : -1}
      aria-pressed={props.selected}
      data-keys="app"
      data-index={s.index}
      aria-label={`${t('slide')} ${s.index + 1}: ${name || (s.kind === 'title' ? t('title') : t('textSlide'))}${failed ? ` – ${failed.error === 'missing' ? t('missing') : t('errUnreadable')}` : ''}`}
      data-entry={s.entries[0]?.id}
      onKeyDown={props.onKeyDown}
      draggable={s.kind !== 'title'}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', s.id)
        // dragend comes to this card, also when it scrolled out of the filmstrip during the drag: then it
        // is no longer in the page, React doesn't see the event, and the drag never ended for the filmstrip
        e.currentTarget.addEventListener('dragend', props.onDragEnd, { once: true })
        props.onDragStart()
      }}
      onClick={props.onClick}
      onContextMenu={props.onMenu}
      title={name}
    >
      {s.kind === 'title' || s.kind === 'text' ? (
        <div className="text-card">T</div>
      ) : (
        <div className="tiles">
          {tiles.map((m, i) => (m.thumb ? <MediaThumb key={i} m={m} draggable={false} loading="lazy" decoding="async" /> : <div key={i} className="empty" />))}
        </div>
      )}
      {full && (
        <div className="badges" aria-hidden>
          <span>
            {s.kind === 'video' && (
              <span className="badge">
                <Film size={10} /> {fmtTime(s.duration)}
              </span>
            )}
            {gridVideos > 0 && (
              <span className="badge">
                <Film size={10} /> {gridVideos}
              </span>
            )}
            {m0?.live && (
              <span className="badge live-mark" data-effect={s.live?.effect ?? (s.live ? 'live' : 'off')} title={s.live?.effect ? t(s.live.effect === 'loop' ? 'liveLoop' : 'liveBounce') : undefined}>
                LIVE
                {s.live?.effect === 'loop' && <Repeat size={10} />}
                {s.live?.effect === 'bounce' && <ArrowLeftRight size={10} />}
              </span>
            )}
            {s.pano && (
              <span className="badge pano-mark" title={t('panorama')}>
                {s.pano.axis === 'x' ? <MoveHorizontal size={10} /> : <MoveVertical size={10} />}
              </span>
            )}
          </span>
          <span>
            {s.media.some((m) => isChanged(m.edit)) && (
              <span className="badge edited-mark" title={t('peEditedMark')}>
                <SlidersHorizontal size={10} />
              </span>
            )}
            {s.customDuration && (
              <span className="badge">
                <Clock size={10} />
              </span>
            )}
            {ve && m0?.hasAudio && <span className="badge">{ve.muted ? <VolumeX size={10} /> : <Volume2 size={10} />}</span>}
          </span>
        </div>
      )}
      {full && s.captionEntryId && (
        <button
          className="cap-badge"
          tabIndex={-1}
          title={`${t('captionSlide')}: ${s.caption?.text ?? ''}`}
          aria-label={`${t('captionSlide')}: ${s.caption?.text ?? ''}`}
          onClick={(e) => {
            e.stopPropagation()
            props.onCaption()
          }}
        >
          T
        </button>
      )}
      {full && (s.kind === 'photos' || s.kind === 'text' || s.kind === 'video') && <DurationHandle slide={s} onDuration={props.onDuration} />}
      {busy && <div className="progress" style={{ width: `${Math.round((busy.progress ?? 0.05) * 100)}%` }} />}
      {failed && (
        <div className="err" title={friendly(failed.error ?? '', 'import').text} aria-hidden>
          {full && (failed.error === 'missing' ? t('missing') : failed.format)}
        </div>
      )}
      <span className="num" aria-hidden>
        {s.index + 1}
      </span>
    </div>
  )
}

function DurationHandle({ slide, onDuration }: { slide: TimelineSlide; onDuration: (s: number | undefined) => void }) {
  const [live, setLive] = useState<number | null>(null)
  return (
    <div
      className={`dur-handle ${live != null ? 'active' : ''}`}
      title={t('durationDrag')}
      onMouseDown={(e) => {
        // keeps the card's own drag-and-drop from starting
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onDuration(undefined)
      }}
      onPointerDown={(e) => {
        e.stopPropagation()
        const x0 = e.clientX
        const d0 = slide.duration
        followPointer(
          e,
          (ev) => {
            const v = Math.round(Math.min(120, Math.max(0.5, d0 + (ev.clientX - x0) * 0.05)) * 10) / 10
            setLive(v)
            onDuration(v)
          },
          () => setLive(null)
        )
      }}
    >
      {live != null && <span className="dur-tip">{live.toLocaleString(undefined, { minimumFractionDigits: 1 })} s</span>}
    </div>
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
