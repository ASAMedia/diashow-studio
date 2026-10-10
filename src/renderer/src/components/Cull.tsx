// Review grid: go through all photos and videos with the keyboard, leave the weak ones out of the
// show (they stay in the project and can come back) and give stars.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, EyeOff, Film, Star, X } from 'lucide-react'
import { mediaUrl } from '@shared/api'
import type { Entry, MediaItem } from '@shared/types'
import { useStore } from '../store'
import { fmtTime, t } from '../i18n'
import { findRejects, rejectLabel } from './Dialogs'
import { prioritize } from '../priority'

type Filter = 'all' | 'in' | 'out' | 'stars' | 'suggest'
interface Item {
  e: Exclude<Entry, { type: 'text' }>
  m: MediaItem
}

const TILE = 190
const GAP = 8

export function Cull() {
  const project = useStore((s) => s.project)!
  const updateEntries = useStore((s) => s.updateEntries)
  const [filter, setFilter] = useState<Filter>('all')
  const [minStars, setMinStars] = useState(3)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [large, setLarge] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 800, h: 600, top: 0 })

  const media = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media])
  const all = useMemo<Item[]>(
    () => project.entries.flatMap((e) => (e.type === 'text' || !media.get(e.mediaId) ? [] : [{ e, m: media.get(e.mediaId)! }])),
    [project.entries, media]
  )
  const suggestions = useMemo(() => new Map(findRejects(project, 0.35).map((r) => [r.entryId, r])), [project])
  const items = all.filter(({ e }) =>
    filter === 'in' ? !e.excluded : filter === 'out' ? e.excluded : filter === 'stars' ? (e.rating ?? 0) >= minStars : filter === 'suggest' ? suggestions.has(e.id) : true
  )
  const index = Math.max(0, items.findIndex((x) => x.e.id === focusId))
  const focused = items[index]
  const cols = Math.max(1, Math.floor((box.w - GAP) / (TILE + GAP)))
  const rows = Math.ceil(items.length / cols)
  const rowH = TILE * 0.75 + 26 + GAP

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setBox({ w: el.clientWidth, h: el.clientHeight, top: el.scrollTop })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    el.addEventListener('scroll', measure)
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', measure)
    }
  }, [])

  // keep the focused tile in view
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !focused) return
    const row = Math.floor(index / cols)
    const top = row * rowH
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight
  }, [index, cols, rowH, focused])

  const move = (d: number): void => {
    const next = items[Math.min(items.length - 1, Math.max(0, index + d))]
    if (next) setFocusId(next.e.id)
  }
  const toggleOut = (it: Item | undefined): void => {
    if (it) updateEntries([it.e.id], (x) => (x.excluded = x.excluded ? undefined : true), undefined)
  }
  const rate = (it: Item | undefined, n: number): void => {
    if (it) updateEntries([it.e.id], (x) => (x.rating = n || undefined))
  }

  useEffect(() => {
    const key = (ev: KeyboardEvent): void => {
      if ((ev.target as HTMLElement).closest('input, textarea, select')) return
      const s = useStore.getState()
      if (s.dialog || s.fullscreen || s.exportOpen) return
      if (ev.ctrlKey && (ev.key === 'z' || ev.key === 'Z' || ev.key === 'y' || ev.key === 'Y')) {
        ev.preventDefault()
        if (ev.key.toLowerCase() === 'y' || ev.shiftKey) s.redo()
        else s.undo()
        return
      }
      const k = ev.key
      if (k === 'ArrowRight') move(1)
      else if (k === 'ArrowLeft') move(-1)
      else if (k === 'ArrowDown') move(large ? 1 : cols)
      else if (k === 'ArrowUp') move(large ? -1 : -cols)
      else if (k === 'Home') move(-items.length)
      else if (k === 'End') move(items.length)
      else if (k === ' ' || k === 'Enter') setLarge(!large)
      else if (k === 'Escape') {
        if (large) setLarge(false)
        else s.set({ view: 'editor' })
      } else if (k === 'x' || k === 'X' || k === 'Delete' || k === 'Backspace') toggleOut(focused)
      else if (k === 'p' || k === 'P') focused?.e.excluded && toggleOut(focused)
      else if (/^[0-5]$/.test(k)) rate(focused, Number(k))
      else return
      ev.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const first = Math.max(0, Math.floor(box.top / rowH) - 2)
  const last = Math.min(rows - 1, Math.ceil((box.top + box.h) / rowH) + 2)
  const shown = items.slice(first * cols, (last + 1) * cols)
  const shownIds = [focused?.m.id, ...shown.map((x) => x.m.id)].filter(Boolean).join(',')
  useEffect(() => prioritize('cull', shownIds ? shownIds.split(',') : []), [shownIds])
  useEffect(() => () => prioritize('cull', []), [])
  const counts = { all: all.length, in: all.filter((x) => !x.e.excluded).length, out: all.filter((x) => x.e.excluded).length }

  const stars = (n: number, it?: Item) => (
    <span className="stars">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          size={12}
          fill={i <= n ? 'currentColor' : 'none'}
          className={i <= n ? 'on' : ''}
          onClick={
            it
              ? (ev) => {
                  ev.stopPropagation()
                  rate(it, i === n ? 0 : i)
                }
              : undefined
          }
        />
      ))}
    </span>
  )

  return (
    <div className="cull">
      <div className="cull-bar">
        <button className="btn" onClick={() => useStore.getState().set({ view: 'editor' })}>
          <ArrowLeft size={15} /> {t('done')}
        </button>
        <div className="seg">
          {(['all', 'in', 'out', 'stars', 'suggest'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'all'
                ? `${t('cullAll')} ${counts.all}`
                : f === 'in'
                  ? `${t('cullIn')} ${counts.in}`
                  : f === 'out'
                    ? `${t('cullOut')} ${counts.out}`
                    : f === 'stars'
                      ? t('cullStars').replace('{n}', String(minStars))
                      : `${t('cullSuggest')} ${suggestions.size}`}
            </button>
          ))}
        </div>
        {filter === 'stars' && (
          <>
            <select value={minStars} onChange={(e) => setMinStars(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {'★'.repeat(n)}
                </option>
              ))}
            </select>
            <button
              className="btn small"
              onClick={() => updateEntries(all.map((x) => x.e.id), (x) => (x.excluded = (x.rating ?? 0) >= minStars ? undefined : true))}
            >
              {t('cullKeepStars').replace('{n}', String(minStars))}
            </button>
          </>
        )}
        <span className="hint cull-hint">{t('cullHint')}</span>
      </div>
      <div className="cull-scroll" ref={scrollRef}>
        {items.length === 0 && <p className="hint" style={{ padding: 20 }}>{t('cullNone')}</p>}
        <div style={{ height: rows * rowH, position: 'relative' }}>
          {shown.map((it, k) => {
            const i = first * cols + k
            const sug = suggestions.get(it.e.id)
            return (
              <div
                key={it.e.id}
                className={`cull-tile ${it.e.excluded ? 'out' : ''} ${focused?.e.id === it.e.id ? 'focus' : ''}`}
                style={{ left: GAP + (i % cols) * (TILE + GAP), top: Math.floor(i / cols) * rowH, width: TILE }}
                onClick={() => setFocusId(it.e.id)}
                onDoubleClick={() => {
                  setFocusId(it.e.id)
                  setLarge(true)
                }}
              >
                <div className="pic">
                  {it.m.thumb && <img src={mediaUrl(it.m.thumb)} alt="" loading="lazy" draggable={false} />}
                  {it.m.kind === 'video' && (
                    <span className="badge kind">
                      <Film size={10} /> {fmtTime(it.m.duration ?? 0)}
                    </span>
                  )}
                  {it.e.excluded && (
                    <span className="out-mark">
                      <EyeOff size={14} />
                    </span>
                  )}
                  {sug && <span className="sug" title={rejectLabel(sug)}>{sug.reason === 'blurry' ? t('blurry') : rejectLabel(sug)}</span>}
                  <button className="out-toggle" title={it.e.excluded ? t('includeSel') : t('excludeSel')} onClick={(ev) => { ev.stopPropagation(); toggleOut(it) }}>
                    <X size={13} />
                  </button>
                </div>
                <div className="meta">
                  {stars(it.e.rating ?? 0, it)}
                  <span className="name" title={it.m.name}>{it.m.name}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {large && focused && (
        <div className="cull-large" onClick={() => setLarge(false)}>
          {focused.m.kind === 'video' && focused.m.playback ? (
            <video key={focused.m.id} src={mediaUrl(focused.m.playback)} autoPlay controls onClick={(e) => e.stopPropagation()} />
          ) : (
            <img key={focused.m.id} src={mediaUrl(focused.m.display ?? focused.m.thumb ?? '')} alt="" />
          )}
          <button className="nav prev" onClick={(e) => { e.stopPropagation(); move(-1) }}>
            <ChevronLeft size={28} />
          </button>
          <button className="nav next" onClick={(e) => { e.stopPropagation(); move(1) }}>
            <ChevronRight size={28} />
          </button>
          <div className="cull-large-bar" onClick={(e) => e.stopPropagation()}>
            <span>
              {index + 1} / {items.length} · {focused.m.name}
            </span>
            {stars(focused.e.rating ?? 0, focused)}
            <button className={`btn small ${focused.e.excluded ? 'on' : ''}`} onClick={() => toggleOut(focused)}>
              <EyeOff size={13} /> {focused.e.excluded ? t('includeSel') : t('excludeSel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
