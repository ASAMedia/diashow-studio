import { useRef, useState, useEffect } from 'react'
import { Clock, Film, FolderPlus, ImagePlus, Plus, Type, Volume2, VolumeX, Trash2, Split, Merge, Move, EyeOff, Crop as CropIcon, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { isChanged } from '@shared/mediaEdit'
import type { Timeline, TimelineSlide } from '@shared/timeline'
import { prioritize } from '../priority'
import type { VideoEntry } from '@shared/types'
import { themeMeta } from '@shared/themes'
import { playerRef, useStore } from '../store'
import { useTimeline } from '../timeline'
import { fmtTime, t } from '../i18n'
import { friendly } from '../errors'
import { AudioLane } from './AudioLane'
import { CARD, GAP, STEP, timeToX } from './stripScale'
import { Menu, MenuItem, MenuSeparator } from './Menu'
import { reducedMotion } from '../appearance'
import { MediaThumb } from './EditedPicture'
import { openPhotoEdit, rotateSelection } from '../photoEdit'

interface Menu {
  x: number
  y: number
  slide?: TimelineSlide
  add?: boolean
}

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
  // drag events can arrive faster than React re-renders, so the handlers read refs
  const dragRef = useRef<number | null>(null)
  const dropRef = useRef<{ merge?: number; insert?: number }>({})
  const innerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // autoscroll pauses for a moment after the user scrolls the filmstrip by hand
  const manualUntil = useRef(0)
  const sel = new Set(selection)
  const width = Math.max(tl.slides.length * STEP + CARD, 200)

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

  // Dropping on the middle of another slide combines both; near the edges it reorders.
  const onDragOver = (e: React.DragEvent): void => {
    const drag = dragRef.current
    if (drag == null) return
    e.preventDefault()
    const rect = innerRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const i = Math.floor(x / STEP)
    const within = (x - i * STEP) / CARD
    const target = tl.slides[i]
    const source = tl.slides[drag]
    const canMerge =
      maxPer > 1 && target && source && i !== drag && target.kind !== 'title' && target.kind !== 'text' && source.kind !== 'text' &&
      target.entries.length + source.entries.length <= maxPer
    if (canMerge && within > 0.25 && within < 0.75) {
      dropRef.current = { merge: i }
      setMergeAt(i)
      setDropAt(null)
    } else {
      const insert = Math.max(0, Math.min(tl.slides.length, Math.round(x / STEP)))
      dropRef.current = { insert }
      setMergeAt(null)
      setDropAt(insert)
    }
  }
  const maxPer = themeMeta(project.settings.theme).maxPerSlide
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
  const n = tl.slides.length
  const first = Math.max(0, Math.floor((view.left - 16) / STEP) - 8)
  const last = Math.min(n - 1, Math.ceil((view.left + view.width) / STEP) + 8)
  // the cards in view are processed first during an import
  const visibleIds = tl.slides.slice(first, last + 1).flatMap((s) => s.media.map((m) => m.id)).join(',')
  useEffect(() => prioritize('filmstrip', visibleIds ? visibleIds.split(',') : []), [visibleIds])

  // The filmstrip is one stop in the tab order: the selected card (or the first). Focus a card by index,
  // scrolling it into the rendered part first.
  const tabIndexAt = Math.max(0, tl.slides.findIndex((sl) => sl.entries.some((e) => sel.has(e.id))))
  const focusCard = (index: number, tries = 6): void => {
    const el = scrollRef.current
    if (el) {
      const x = index * STEP
      if (x < el.scrollLeft || x + CARD > el.scrollLeft + el.clientWidth - 32) el.scrollLeft = Math.max(0, x - el.clientWidth / 2)
    }
    // right away when the card is rendered (quick key presses go to the new card), else after a frame
    const card = document.querySelector<HTMLElement>(`.card[data-index="${index}"]`)
    if (card) card.focus()
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

  return (
    <section className="strip" aria-label={t('filmstrip')}>
      {excluded > 0 && (
        <button className="excluded-chip" title={t('cullTitle')} onClick={() => useStore.getState().set({ view: 'cull' })}>
          <EyeOff size={12} aria-hidden /> {t('excludedCount').replace('{n}', String(excluded))}
        </button>
      )}
      <div
        className="strip-scroll"
        ref={scrollRef}
        onWheel={(e) => {
          manualUntil.current = performance.now() + 4000
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
        }}
        onPointerDown={(e) => {
          // grabbing the scrollbar (below the content) counts as manual scrolling
          if (e.target === e.currentTarget) manualUntil.current = performance.now() + 4000
        }}
      >
        <div className="strip-inner" ref={innerRef} style={{ width }} onDragOver={onDragOver} onDragLeave={() => setMergeAt(null)} onDrop={(e) => {
          e.preventDefault()
          const drag = dragRef.current
          const { merge, insert } = dropRef.current
          if (drag != null && merge != null) {
            const ids = [...tl.slides[merge].entries, ...tl.slides[drag].entries].map((x) => x.id)
            useStore.getState().mergeEntries(ids)
            select(ids)
          } else if (drag != null && insert != null && insert !== drag && insert !== drag + 1) moveSlide(drag, insert)
          dragRef.current = null
          dropRef.current = {}
          setDrag(null)
          setDropAt(null)
          setMergeAt(null)
        }}>
          <div className="cards">
            {first > 0 && <div style={{ flex: '0 0 auto', width: first * STEP - GAP }} />}
            {tl.slides.slice(first, last + 1).map((s) => (
              <SlideCard
                key={s.id}
                slide={s}
                tabbable={s.index === tabIndexAt}
                selected={s.entries.some((e) => sel.has(e.id))}
                captionSelected={!!s.captionEntryId && sel.has(s.captionEntryId)}
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
                  setDropAt(null)
                  setMergeAt(null)
                }}
              />
            ))}
            {last < n - 1 && <div style={{ flex: '0 0 auto', width: (n - 1 - last) * STEP - GAP }} />}
            <button
              className="card add"
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
          {dropAt != null && <div className="drop-indicator" style={{ left: dropAt * STEP - GAP / 2 - 1 }} />}
          <AudioLane tl={tl} width={width} />
          <Playhead tl={tl} scrollRef={scrollRef} manualUntil={manualUntil} />
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
              <MenuItem icon={<Type size={15} />} onSelect={() => useStore.getState().addText()}>
                {t('addText')}
              </MenuItem>
              {selectedSlides.length > 1 && maxPer > 1 && selectedSlides.reduce((n, x) => n + x.entries.length, 0) <= maxPer && (
                <MenuItem icon={<Merge size={15} />} onSelect={() => useStore.getState().mergeEntries(selectedSlides.flatMap((x) => x.entries.map((e) => e.id)))}>
                  {t('merge')}
                </MenuItem>
              )}
              {menu.slide.entries.length > 1 && (
                <MenuItem icon={<Split size={15} />} onSelect={() => useStore.getState().splitSlide(menu.slide!.entries.map((e) => e.id))}>
                  {t('split')}
                </MenuItem>
              )}
              {menu.slide.kind !== 'text' && maxPer > 1 && menu.slide.index > 0 && ['photos', 'video'].includes(tl.slides[menu.slide.index - 1]?.kind) && (
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
  /** The card the Tab key reaches (one per filmstrip). */
  tabbable: boolean
  selected: boolean
  captionSelected: boolean
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
  const busy = s.media.find((m) => m.status === 'pending' || m.status === 'processing')
  const failed = s.media.find((m) => m.status === 'error')
  const ve = s.kind === 'video' ? (s.entries[0] as VideoEntry) : null
  const gridVideos = s.kind === 'photos' ? s.entries.filter((e) => e.type === 'video').length : 0
  const name = s.kind === 'text' || s.kind === 'title' ? s.title?.text : s.media.map((m) => m.name).join(', ')
  return (
    <div
      className={`card ${props.selected ? 'selected' : ''} ${props.captionSelected ? 'cap-selected' : ''} ${props.dragging ? 'dragging' : ''} ${props.mergeTarget ? 'merge-target' : ''}`}
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
        props.onDragStart()
      }}
      onDragEnd={props.onDragEnd}
      onClick={props.onClick}
      onContextMenu={props.onMenu}
      title={name}
    >
      {s.kind === 'title' || s.kind === 'text' ? (
        <div className="text-card">T</div>
      ) : (
        <div className="tiles">
          {s.media.map((m, i) => (m.thumb ? <MediaThumb key={i} m={m} draggable={false} loading="lazy" decoding="async" /> : <div key={i} className="empty" />))}
        </div>
      )}
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
          {m0?.live && <span className="badge">LIVE</span>}
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
      {s.captionEntryId && (
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
      {(s.kind === 'photos' || s.kind === 'text' || s.kind === 'video') && <DurationHandle slide={s} onDuration={props.onDuration} />}
      {busy && <div className="progress" style={{ width: `${Math.round((busy.progress ?? 0.05) * 100)}%` }} />}
      {failed && (
        <div className="err" title={friendly(failed.error ?? '', 'import').text} aria-hidden>
          {failed.error === 'missing' ? t('missing') : failed.format}
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
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        const x0 = e.clientX
        const d0 = slide.duration
        const move = (ev: PointerEvent): void => {
          const v = Math.round(Math.min(120, Math.max(0.5, d0 + (ev.clientX - x0) * 0.05)) * 10) / 10
          setLive(v)
          onDuration(v)
        }
        const up = (): void => {
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
          setLive(null)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
      }}
    >
      {live != null && <span className="dur-tip">{live.toLocaleString(undefined, { minimumFractionDigits: 1 })} s</span>}
    </div>
  )
}

function Playhead({ tl, scrollRef, manualUntil }: { tl: Timeline; scrollRef: React.RefObject<HTMLDivElement | null>; manualUntil: React.RefObject<number> }) {
  const playhead = useStore((s) => s.playhead)
  const playing = useStore((s) => s.playing)
  const x = timeToX(tl, playhead)
  // keep the playhead inside the visible part of the filmstrip
  useEffect(() => {
    const el = scrollRef.current
    if (!el || performance.now() < manualUntil.current) return
    const px = x + 16
    if (px < el.scrollLeft + 40 || px > el.scrollLeft + el.clientWidth - 80) {
      el.scrollTo({ left: Math.max(0, px - el.clientWidth * 0.25), behavior: playing && !reducedMotion() ? 'smooth' : 'auto' })
    }
  }, [x, playing, scrollRef, manualUntil])
  return <div className="playhead" style={{ left: x - 1 }} />
}
