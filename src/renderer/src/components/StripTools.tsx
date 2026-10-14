// The filmstrip's tools above the cards: search (Ctrl+F) with its result list, the chapters menu and
// the zoom (−, slider, +, "show the whole slideshow"). The search field is a combobox with a listbox
// of results; Enter / Shift+Enter (and F3 / Shift+F3 anywhere in the editor) go to the next / previous
// match, and a live region says how many there are. The matching itself is in search.ts.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, ListTree, Maximize2, Search, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { Timeline, TimelineSlide } from '@shared/timeline'
import type { Project, TextEntry } from '@shared/types'
import { oneLine } from '@shared/chapters'
import { dateLocale, fill, fmtTime, localeTag, t, type StringKey } from '../i18n'
import { searchSlides, type MatchField, type SearchHit } from '../search'
import { useStore } from '../store'
import { modalOpen } from '../keys'
import { MediaThumb } from './EditedPicture'
import { Menu, MenuItem } from './Menu'
import { cardToSlider, MAX_CARD, MIN_CARD, sliderToCard, zoomStep } from './stripScale'

export interface StripSearch {
  open: boolean
  query: string
  hits: SearchHit[]
  /** Index into `hits` of the match shown last (-1: none yet). */
  current: number
  /** Slide indexes of all matches, for the filmstrip's highlight. */
  matched: ReadonlySet<number>
  setOpen(open: boolean): void
  setQuery(q: string): void
  /** Goes to match k (wrapping around) and shows it. */
  go(k: number): void
  next(): void
  prev(): void
}

/** Search state of the filmstrip; `onJump` shows a slide (select, scroll, seek). */
export function useStripSearch(tl: Timeline, project: Project, onJump: (index: number) => void): StripSearch {
  const [open, setOpenRaw] = useState(false)
  const [query, setQueryRaw] = useState('')
  // the match shown last, by its slide: the matches are found again whenever the show changes, and one
  // may be gone (its caption edited, say) or new ones may come before it
  const [shown, setShown] = useState<{ id: string; index: number } | null>(null)
  const people = project.people
  const hits = useMemo(() => (open && query.trim() ? searchSlides(tl, { people }, query, dateLocale()) : []), [open, query, tl, people])
  const matched = useMemo(() => new Set(hits.map((h) => h.index)), [hits])
  const current = shown ? hits.findIndex((h) => tl.slides[h.index]?.id === shown.id) : -1
  const jump = useRef(onJump)
  jump.current = onJump
  const go = (k: number): void => {
    if (!hits.length) return
    const i = ((k % hits.length) + hits.length) % hits.length
    setShown({ id: tl.slides[hits[i].index].id, index: hits[i].index })
    jump.current(hits[i].index)
  }
  // without the match shown last among them: the first one behind (in front of) where it was
  const after = (): number => (shown ? hits.findIndex((h) => h.index > shown.index) : 0)
  const before = (): number => (shown ? hits.findLastIndex((h) => h.index < shown.index) : -1)
  return {
    open,
    query,
    hits,
    current,
    matched,
    setOpen: (v) => {
      setOpenRaw(v)
      if (!v) setShown(null)
    },
    setQuery: (q) => {
      setQueryRaw(q)
      setShown(null)
    },
    go,
    next: () => go(current >= 0 ? current + 1 : Math.max(0, after())),
    prev: () => go(current >= 0 ? current - 1 : before())
  }
}

/** Ctrl+F opens the search (also from another field), F3 / Shift+F3 go to the next / previous match. */
export function useSearchKeys(search: StripSearch, inputRef: React.RefObject<HTMLInputElement | null>): void {
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
          inputRef.current?.focus()
          inputRef.current?.select()
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
}

const FIELD: Record<MatchField, StringKey> = {
  file: 'matchFile',
  title: 'matchTitle',
  chapter: 'matchChapter',
  text: 'matchText',
  caption: 'matchCaption',
  freeText: 'matchFreeText',
  person: 'matchPerson',
  kind: 'matchKind',
  date: 'matchDate'
}

/** "Datei: IMG_0003.JPG", "Aufnahme: Mo., 14. Juli 2025", "Art: Video". */
function hitText(h: SearchHit): string {
  const value =
    h.field === 'date' && h.time
      ? new Date(h.time).toLocaleDateString(localeTag(), { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
      : h.field === 'kind'
        ? t(h.kind === 'video' ? 'kindVideo' : h.kind === 'live' ? 'kindLive' : 'kindText')
        : oneLine(h.text)
  return `${t(FIELD[h.field])}: ${value}`
}

/** "3 von 12", "12 Treffer", "Keine Treffer". */
function countText(s: StripSearch): string {
  if (!s.query.trim()) return ''
  if (!s.hits.length) return t('searchNone')
  if (s.current >= 0) return fill('searchCount', { i: s.current + 1, n: s.hits.length })
  return s.hits.length === 1 ? t('searchOneMatch') : fill('searchMatches', { n: s.hits.length })
}

const LIST_MAX = 200

function SlideThumb({ slide }: { slide: TimelineSlide | undefined }) {
  const m = slide?.media[0]
  if (m?.thumb) return <MediaThumb m={m} className="hit-thumb" draggable={false} loading="lazy" decoding="async" />
  return <span className="hit-thumb text" aria-hidden>{slide?.kind === 'text' || slide?.kind === 'title' ? 'T' : ''}</span>
}

export function SearchBox({ search: s, tl, inputRef }: { search: StripSearch; tl: Timeline; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const id = useId()
  const listId = `${id}-list`
  const optId = (i: number): string => `${id}-opt-${i}`
  const [active, setActive] = useState(-1)
  const [focused, setFocused] = useState(false)
  const openerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const shown = s.hits.slice(0, LIST_MAX)
  const listOpen = focused && shown.length > 0

  // the highlighted option follows the match shown
  useEffect(() => setActive(s.current), [s.current])
  useEffect(() => setActive(-1), [s.query])
  useEffect(() => {
    if (active >= 0) document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const close = (): void => {
    s.setOpen(false)
    requestAnimationFrame(() => openerRef.current?.focus())
  }

  if (!s.open) {
    return (
      <button
        ref={openerRef}
        className="btn small icon ghost"
        title={`${t('searchOpen')} (${t('kbdFind')})`}
        aria-label={`${t('searchOpen')} (${t('kbdFind')})`}
        aria-keyshortcuts="Control+F"
        onClick={() => s.setOpen(true)}
      >
        <Search size={15} />
      </button>
    )
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!shown.length) return
      const d = e.key === 'ArrowDown' ? 1 : -1
      setActive((a) => (a < 0 ? (d > 0 ? 0 : shown.length - 1) : Math.min(shown.length - 1, Math.max(0, a + d))))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) s.prev()
      else if (active >= 0 && active !== s.current) s.go(active)
      else s.next()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  const count = countText(s)
  return (
    <div className="strip-search">
      <Search size={14} className="lead" aria-hidden />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={t('searchLabel')}
        aria-expanded={listOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={listOpen && active >= 0 && active < shown.length ? optId(active) : undefined}
        placeholder={t('searchPlaceholder')}
        // opened with the magnifier or Ctrl+F: typing goes here at once
        autoFocus
        value={s.query}
        spellCheck={false}
        onChange={(e) => s.setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      <span className="count" aria-hidden>
        {count}
      </span>
      <span className="sr-only" role="status">
        {count}
      </span>
      <button className="btn small icon ghost" title={t('searchPrev')} aria-label={t('searchPrev')} disabled={!s.hits.length} onClick={s.prev} onMouseDown={(e) => e.preventDefault()}>
        <ChevronUp size={14} />
      </button>
      <button className="btn small icon ghost" title={t('searchNext')} aria-label={t('searchNext')} disabled={!s.hits.length} onClick={s.next} onMouseDown={(e) => e.preventDefault()}>
        <ChevronDown size={14} />
      </button>
      <button className="btn small icon ghost" title={t('searchClose')} aria-label={t('searchClose')} onClick={close}>
        <X size={14} />
      </button>
      <ul ref={listRef} id={listId} role="listbox" aria-label={t('searchResults')} className="search-hits" hidden={!listOpen}>
        {listOpen &&
          shown.map((h, i) => {
            const slide = tl.slides[h.index]
            return (
              <li
                key={`${h.index}`}
                id={optId(i)}
                role="option"
                aria-selected={i === active}
                className={`${i === active ? 'active' : ''} ${i === s.current ? 'current' : ''}`}
                // keeps the focus in the field, so Enter goes on from here
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => s.go(i)}
              >
                <SlideThumb slide={slide} />
                <span className="what ellipsis">{hitText(h)}</span>
                <span className="where">
                  {h.index + 1} · {fmtTime(slide?.start ?? 0)}
                </span>
              </li>
            )
          })}
        {listOpen && s.hits.length > LIST_MAX && (
          <li role="presentation" className="more">
            {fill('searchMore', { n: s.hits.length - LIST_MAX })}
          </li>
        )}
      </ul>
    </div>
  )
}

/** The title, chapter and caption chapter slides of the show, for the chapters menu. */
export function chapterSlides(tl: Timeline): { index: number; title: string; start: number }[] {
  const out: { index: number; title: string; start: number }[] = []
  for (const s of tl.slides) {
    let title = ''
    if (s.kind === 'title' || s.titleOverlay) title = oneLine(s.title?.text)
    else if (s.kind === 'text') {
      const e = s.entries[0] as TextEntry
      const sub = e.titleStyle !== 'credits' ? oneLine(e.subtitle) : ''
      title = [oneLine(e.title), sub].filter(Boolean).join(' – ')
    } else if (s.captionEntryId && s.caption) title = [oneLine(s.caption.text), oneLine(s.caption.subtitle)].filter(Boolean).join(' – ')
    if (title) out.push({ index: s.index, title, start: s.start })
  }
  return out
}

export function ChaptersMenu({ tl, onJump }: { tl: Timeline; onJump: (index: number) => void }) {
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null)
  const list = at ? chapterSlides(tl) : []
  return (
    <>
      <button
        className="btn small ghost"
        title={t('chaptersHint')}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt(at ? null : { left: r.left, bottom: window.innerHeight - r.top + 4 })
        }}
      >
        <ListTree size={14} aria-hidden /> {t('chapters')}
        <ChevronDown size={12} aria-hidden />
      </button>
      {at && (
        <Menu label={t('chapters')} onClose={() => setAt(null)} style={{ left: at.left, bottom: at.bottom, maxHeight: '60vh', overflowY: 'auto' }}>
          {list.length ? (
            list.map((c) => (
              <MenuItem key={c.index} onSelect={() => onJump(c.index)}>
                <span className="chapter-item">
                  <span className="ellipsis">{c.title}</span>
                  <span className="time">{fmtTime(c.start)}</span>
                </span>
              </MenuItem>
            ))
          ) : (
            <MenuItem disabled onSelect={() => {}}>
              {t('chaptersNone')}
            </MenuItem>
          )}
        </Menu>
      )}
    </>
  )
}

/** `min`: the narrowest zoom for the show (below MIN_CARD the overview of a long show, stripScale.ts minCard). */
export function ZoomControls({ card, min, onZoom, onFit }: { card: number; min: number; onZoom: (card: number) => void; onFit: () => void }) {
  return (
    <div className="strip-zoom" role="group" aria-label={t('stripZoom')}>
      <button className="btn small icon ghost" title={`${t('stripZoomOut')} (${t('kbdCtrlWheel')})`} aria-label={t('stripZoomOut')} disabled={card <= min} onClick={() => onZoom(zoomStep(card, 1 / 1.25, min))}>
        <ZoomOut size={14} />
      </button>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={cardToSlider(card, min)}
        aria-label={t('stripZoom')}
        aria-valuetext={card < MIN_CARD ? `${t('stripOverview')}, ${card.toLocaleString(localeTag())} px` : `${card} px`}
        onChange={(e) => {
          // a step of the slider is less than a pixel on small cards: then one pixel its way
          const v = Number(e.target.value)
          const next = sliderToCard(v, min)
          onZoom(next !== card || v === cardToSlider(card, min) ? next : zoomStep(card, v > cardToSlider(card, min) ? 1.001 : 1 / 1.001, min))
        }}
      />
      <button className="btn small icon ghost" title={`${t('stripZoomIn')} (${t('kbdCtrlWheel')})`} aria-label={t('stripZoomIn')} disabled={card >= MAX_CARD} onClick={() => onZoom(zoomStep(card, 1.25, min))}>
        <ZoomIn size={14} />
      </button>
      <button className="btn small icon ghost" title={t('stripFit')} aria-label={t('stripFit')} onClick={onFit}>
        <Maximize2 size={14} />
      </button>
    </div>
  )
}
