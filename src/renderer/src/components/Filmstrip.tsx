import { useMemo, useRef, useState, useEffect } from 'react'
import { Clock, Film, FolderPlus, ImagePlus, Plus, Type, Volume2, VolumeX, Trash2, Split, Merge, Move } from 'lucide-react'
import { mediaUrl } from '@shared/api'
import { buildAudioPlan, gainAt } from '@shared/audioPlan'
import type { Timeline, TimelineSlide } from '@shared/timeline'
import type { VideoEntry } from '@shared/types'
import { themeMeta } from '@shared/themes'
import { playerRef, useStore } from '../store'
import { useTimeline } from '../timeline'
import { fmtTime, t } from '../i18n'

const CARD = 96
const GAP = 6
const STEP = CARD + GAP

function timeToX(tl: Timeline, time: number): number {
  const s = tl.slides
  for (let i = 0; i < s.length; i++) {
    const end = i + 1 < s.length ? s[i + 1].start : s[i].start + s[i].duration
    if (time < end || i === s.length - 1) {
      const span = Math.max(0.001, end - s[i].start)
      return i * STEP + Math.min(1, Math.max(0, (time - s[i].start) / span)) * STEP
    }
  }
  return 0
}

function xToTime(tl: Timeline, x: number): number {
  const i = Math.min(tl.slides.length - 1, Math.max(0, Math.floor(x / STEP)))
  const s = tl.slides[i]
  if (!s) return 0
  const end = i + 1 < tl.slides.length ? tl.slides[i + 1].start : s.start + s.duration
  return s.start + ((x - i * STEP) / STEP) * (end - s.start)
}

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

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

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

  const clickSlide = (s: TimelineSlide, e: React.MouseEvent): void => {
    if (s.kind === 'title') {
      select([])
      useStore.getState().set({ tab: 'themes' })
      playerRef.current?.seek(s.start)
      return
    }
    const ids = s.entries.map((x) => x.id)
    if (e.ctrlKey || e.shiftKey) select([...new Set([...selection, ...ids])])
    else select(ids)
    useStore.getState().set({ tab: 'slide' })
  }

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

  return (
    <div className="strip">
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
            <div className="card add" title={t('addMedia')} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY - 120, add: true })}>
              <Plus size={20} />
            </div>
          </div>
          {dropAt != null && <div className="drop-indicator" style={{ left: dropAt * STEP - GAP / 2 - 1 }} />}
          <AudioLane tl={tl} width={width} />
          <Playhead tl={tl} scrollRef={scrollRef} manualUntil={manualUntil} />
        </div>
      </div>
      {menu && (
        <div className="menu" style={{ left: menu.x, top: Math.max(8, menu.y - (menu.add ? 0 : 10)) }} onPointerDown={(e) => e.stopPropagation()}>
          {menu.add && (
            <>
              <button onClick={async () => { setMenu(null); await useStore.getState().importMedia(await window.api.pickMedia()) }}>
                <ImagePlus size={14} /> {t('addMedia')}
              </button>
              <button onClick={async () => { setMenu(null); await useStore.getState().importMedia(await window.api.pickFolder()) }}>
                <FolderPlus size={14} /> {t('addFolder')}
              </button>
              <button onClick={() => { setMenu(null); useStore.getState().addText() }}>
                <Type size={14} /> {t('addText')}
              </button>
            </>
          )}
          {menu.slide && menu.slide.kind !== 'title' && (
            <>
              <button onClick={() => { setMenu(null); useStore.getState().addText() }}>
                <Type size={14} /> {t('addText')}
              </button>
              {selectedSlides.length > 1 && maxPer > 1 && selectedSlides.reduce((n, x) => n + x.entries.length, 0) <= maxPer && (
                <button onClick={() => {
                  useStore.getState().mergeEntries(selectedSlides.flatMap((x) => x.entries.map((e) => e.id)))
                  setMenu(null)
                }}>
                  <Merge size={14} /> {t('merge')}
                </button>
              )}
              {menu.slide.entries.length > 1 && (
                <button onClick={() => {
                  useStore.getState().splitSlide(menu.slide!.entries.map((e) => e.id))
                  setMenu(null)
                }}>
                  <Split size={14} /> {t('split')}
                </button>
              )}
              {menu.slide.kind !== 'text' && maxPer > 1 && menu.slide.index > 0 && ['photos', 'video'].includes(tl.slides[menu.slide.index - 1]?.kind) && (
                <button onClick={() => {
                  const prev = tl.slides[menu.slide!.index - 1]
                  useStore.getState().mergeEntries([...prev.entries, ...menu.slide!.entries].map((e) => e.id))
                  setMenu(null)
                }}>
                  <Merge size={14} /> {t('joinPrev')}
                </button>
              )}
              {menu.slide.kind === 'photos' && themeMeta(project.settings.theme).kenBurns && (
                <button onClick={() => { setMenu(null); useStore.getState().set({ tab: 'slide', kbEdit: 'start' }) }}>
                  <Move size={14} /> {t('kbEdit')}
                </button>
              )}
              <hr />
              <button onClick={() => { setMenu(null); useStore.getState().removeEntries(menu.slide!.entries.map((e) => e.id)) }}>
                <Trash2 size={14} /> {t('delete')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function SlideCard(props: {
  slide: TimelineSlide
  selected: boolean
  captionSelected: boolean
  onCaption: () => void
  dragging: boolean
  mergeTarget: boolean
  /** Drag on the right edge sets the slide's time; undefined = automatic again. */
  onDuration: (seconds: number | undefined) => void
  onClick: (e: React.MouseEvent) => void
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
  return (
    <div
      className={`card ${props.selected ? 'selected' : ''} ${props.captionSelected ? 'cap-selected' : ''} ${props.dragging ? 'dragging' : ''} ${props.mergeTarget ? 'merge-target' : ''}`}
      draggable={s.kind !== 'title'}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', s.id)
        props.onDragStart()
      }}
      onDragEnd={props.onDragEnd}
      onClick={props.onClick}
      onContextMenu={props.onMenu}
      title={s.kind === 'text' || s.kind === 'title' ? s.title?.text : s.media.map((m) => m.name).join(', ')}
    >
      {s.kind === 'title' || s.kind === 'text' ? (
        <div className="text-card">T</div>
      ) : (
        <div className="tiles">
          {s.media.map((m, i) => (m.thumb ? <img key={i} src={mediaUrl(m.thumb)} alt="" draggable={false} loading="lazy" decoding="async" /> : <div key={i} style={{ flex: 1, background: '#2b2b2f' }} />))}
        </div>
      )}
      <div className="badges">
        <span style={{ display: 'flex', gap: 4 }}>
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
        <span style={{ display: 'flex', gap: 4 }}>
          {s.customDuration && (
            <span className="badge">
              <Clock size={10} />
            </span>
          )}
          {ve && m0?.hasAudio && <span className="badge">{ve.muted ? <VolumeX size={10} /> : <Volume2 size={10} />}</span>}
        </span>
      </div>
      {s.captionEntryId && (
        <span
          className="cap-badge"
          title={s.caption?.text}
          onClick={(e) => {
            e.stopPropagation()
            props.onCaption()
          }}
        >
          T
        </span>
      )}
      {(s.kind === 'photos' || s.kind === 'text' || s.kind === 'video') && <DurationHandle slide={s} onDuration={props.onDuration} />}
      {busy && <div className="progress" style={{ width: `${Math.round((busy.progress ?? 0.05) * 100)}%` }} />}
      {failed && <div className="err">{failed.error === 'missing' ? t('missing') : failed.format}</div>}
      <span className="num">{s.index + 1}</span>
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

function AudioLane({ tl, width }: { tl: Timeline; width: number }) {
  const project = useStore((s) => s.project)!
  const plan = useMemo(() => buildAudioPlan(project, tl), [project, tl])
  const H = 30
  const music = plan.clips.filter((c) => c.kind === 'music')
  const videos = plan.clips.filter((c) => c.kind === 'video')
  const vol = Math.max(0.01, project.settings.audio.musicVolume)
  const points = useMemo(() => {
    if (!music.length) return ''
    const pts: string[] = []
    const n = Math.min(600, Math.max(40, Math.round(width / 3)))
    for (let i = 0; i <= n; i++) {
      const time = (tl.duration * i) / n
      const g = music.reduce((sum, c) => sum + (time >= c.start && time <= c.start + c.duration ? gainAt(c.gain, time) : 0), 0)
      pts.push(`${timeToX(tl, time).toFixed(1)},${(4 + (1 - Math.min(1, g / vol)) * (H - 10)).toFixed(1)}`)
    }
    return pts.join(' ')
  }, [music, tl, width, vol])
  const titles = new Map(project.music.map((m) => [m.playback, m.title]))
  return (
    <svg
      className="lane"
      width={width}
      height={H}
      onClick={(e) => {
        const r = (e.currentTarget as SVGElement).getBoundingClientRect()
        playerRef.current?.seek(xToTime(tl, e.clientX - r.left))
      }}
    >
      {music.map((c, i) => {
        const x0 = timeToX(tl, c.start)
        const x1 = timeToX(tl, c.start + c.duration)
        return (
          <g key={c.id}>
            <rect x={x0} y={3} width={Math.max(1, x1 - x0)} height={H - 8} rx={4} fill={i % 2 ? 'rgba(77,159,255,0.13)' : 'rgba(77,159,255,0.2)'} />
            <text x={x0 + 6} y={H - 9} fontSize={10} fill="#8fb8e8">
              {titles.get(c.src) ?? ''}
            </text>
          </g>
        )
      })}
      {videos.map((c) => {
        const x0 = timeToX(tl, c.start)
        const x1 = timeToX(tl, c.start + c.duration)
        return <rect key={c.id} x={x0} y={H - 5} width={Math.max(1, x1 - x0)} height={4} rx={2} fill="var(--video)" />
      })}
      {points && <polyline points={points} fill="none" stroke="#4d9fff" strokeWidth={1.5} />}
    </svg>
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
      el.scrollTo({ left: Math.max(0, px - el.clientWidth * 0.25), behavior: playing ? 'smooth' : 'auto' })
    }
  }, [x, playing, scrollRef, manualUntil])
  return <div className="playhead" style={{ left: x - 1 }} />
}
