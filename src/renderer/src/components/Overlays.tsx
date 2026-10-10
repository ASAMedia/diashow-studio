// Editing layers over the preview: free text boxes (drag, double-click to type) and the editor
// for pixelated areas (click detected faces, drag out areas).
import { useEffect, useRef, useState } from 'react'
import { mediaUrl } from '@shared/api'
import type { FreeText, PhotoEntry, Rect, VideoEntry } from '@shared/types'
import type { TimelineSlide } from '@shared/timeline'
import { FONT_FAMILY } from '../engine/media'
import { FONT_ROLE } from '../engine/freeText'
import { detectFaces } from '../faces'
import { useStore } from '../store'
import { t } from '../i18n'
import { faceArea, togglePrivacy } from './SlideTools'

// ---------------------------------------------------------------- free text

export function FreeTextLayer({ slide, w, h }: { slide: TimelineSlide; w: number; h: number }) {
  const textSel = useStore((s) => s.textSel)
  const [editing, setEditing] = useState<string | null>(null)
  const texts = slide.entries.flatMap((e) => (e.texts ?? []).map((ft) => ({ entryId: e.id, ft })))
  if (!texts.length) return null

  const focus = (ft: FreeText): void => {
    const s = useStore.getState()
    if (!slide.entries.some((e) => s.selection.includes(e.id))) s.select(slide.entries.map((e) => e.id))
    s.set({ textSel: ft.id, tab: 'slide' })
  }

  return (
    <div className="free-texts">
      {texts.map(({ entryId, ft }) => {
        const role = FONT_ROLE[ft.font] ?? 'sans'
        const size = ft.size * h
        const pad = size * 0.35
        const style: React.CSSProperties = {
          left: ft.x * w,
          top: ft.y * h,
          fontSize: size,
          fontFamily: FONT_FAMILY[role],
          fontWeight: ft.bold ? 700 : role === 'sans' ? 600 : 400,
          padding: pad,
          maxWidth: w * 0.9 + pad * 2,
          transform: `translate(-50%, -50%) rotate(${ft.rotation}deg)`
        }
        if (editing === ft.id) {
          return (
            <textarea
              key={ft.id}
              className="free-text editing"
              style={{ ...style, width: Math.min(w * 0.9, Math.max(size * 4, ft.text.length * size * 0.6)) }}
              autoFocus
              defaultValue={ft.text}
              onBlur={(e) => {
                const v = e.target.value
                if (v.trim()) useStore.getState().setFreeText(entryId, ft.id, { text: v })
                else useStore.getState().removeFreeText(entryId, ft.id)
                setEditing(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) (e.target as HTMLTextAreaElement).blur()
                e.stopPropagation()
              }}
            />
          )
        }
        return (
          <div
            key={ft.id}
            className={`free-text ${textSel === ft.id ? 'on' : ''}`}
            style={style}
            onDoubleClick={() => setEditing(ft.id)}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              focus(ft)
              const el = e.currentTarget
              el.setPointerCapture(e.pointerId)
              const sx = e.clientX
              const sy = e.clientY
              const x0 = ft.x
              const y0 = ft.y
              let frame = 0
              const move = (pe: PointerEvent): void => {
                const x = Math.min(1, Math.max(0, x0 + (pe.clientX - sx) / w))
                const y = Math.min(1, Math.max(0, y0 + (pe.clientY - sy) / h))
                cancelAnimationFrame(frame)
                frame = requestAnimationFrame(() => useStore.getState().setFreeText(entryId, ft.id, { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }))
              }
              const up = (): void => {
                el.removeEventListener('pointermove', move)
                el.removeEventListener('pointerup', up)
              }
              el.addEventListener('pointermove', move)
              el.addEventListener('pointerup', up)
            }}
          >
            {ft.text}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- pixelated areas

/** Photos searched with the fine tile grid in this session (the result is stored with the media). */
const searched = new Set<string>()

export function PrivacyEditor({ entryId, w, h }: { entryId: string; w: number; h: number }) {
  const project = useStore((s) => s.project)!
  const setEntry = useStore((s) => s.setEntry)
  const found = project.entries.find((e) => e.id === entryId)
  const entry: PhotoEntry | VideoEntry | undefined = found && found.type !== 'text' ? found : undefined
  const media = entry ? project.media.find((m) => m.id === entry.mediaId) : undefined
  const [still, setStill] = useState<string | undefined>()
  const [videoFaces, setVideoFaces] = useState<Rect[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [draft, setDraft] = useState<Rect | null>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const isVideo = media?.kind === 'video'

  // videos: a sharp frame from the middle of the clip, with faces detected on demand
  useEffect(() => {
    if (!media || media.kind !== 'video') return
    let alive = true
    window.api
      .videoStrip(media.playback ?? media.path, 1, 720)
      .then(async ([f]) => {
        if (!alive || !f) return
        setStill(f)
        const found = await detectFaces(f, true).catch(() => [])
        if (alive) setVideoFaces(found)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [media?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // photos: the background detection skips tiny faces; look again closely before pixelating
  useEffect(() => {
    if (!media || media.kind !== 'photo' || !media.display || searched.has(media.id)) return
    let alive = true
    const id = media.id
    setSearching(true)
    detectFaces(media.display, true)
      .then((faces) => {
        searched.add(id)
        const p = useStore.getState().project
        if (p) useStore.setState({ project: { ...p, media: p.media.map((m) => (m.id === id ? { ...m, faces } : m)) } })
        void window.api.setFaces(id, faces).catch(() => {})
      })
      .catch(() => {})
      .finally(() => alive && setSearching(false))
    return () => {
      alive = false
    }
  }, [media?.id, media?.display]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!entry || !media) return null
  const src = isVideo ? (still ?? media.thumb) : (media.display ?? media.thumb)
  const aspect = media.width / media.height
  const iw = Math.min(w * 0.94, h * 0.84 * aspect)
  const ih = iw / aspect
  const ix = (w - iw) / 2
  const iy = (h - ih) / 2 - 16
  const areas = entry.privacy ?? []
  const detected = (isVideo ? videoFaces : media.faces)?.map(faceArea)
  const pending = detected == null || searching
  const free = (detected ?? []).filter((f) => !areas.some((a) => Math.abs(a.x - f.x) < 1e-4 && Math.abs(a.y - f.y) < 1e-4))
  const save = (next: Rect[] | undefined): void => setEntry(entry.id, { privacy: next } as Partial<PhotoEntry>)
  const box = (r: Rect): React.CSSProperties => ({ left: ix + r.x * iw, top: iy + r.y * ih, width: r.w * iw, height: r.h * ih })

  const startDraw = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const rect = areaRef.current!.getBoundingClientRect()
    const fx = (e.clientX - rect.left) / rect.width
    const fy = (e.clientY - rect.top) / rect.height
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const at = (pe: PointerEvent): Rect => {
      const x = Math.min(1, Math.max(0, (pe.clientX - rect.left) / rect.width))
      const y = Math.min(1, Math.max(0, (pe.clientY - rect.top) / rect.height))
      return { x: Math.min(fx, x), y: Math.min(fy, y), w: Math.abs(x - fx), h: Math.abs(y - fy) }
    }
    const move = (pe: PointerEvent): void => setDraft(at(pe))
    const up = (pe: PointerEvent): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      const r = at(pe)
      setDraft(null)
      if (r.w > 0.02 && r.h > 0.02) save([...areas, { x: +r.x.toFixed(4), y: +r.y.toFixed(4), w: +r.w.toFixed(4), h: +r.h.toFixed(4) }])
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div className="privacy-edit">
      {src && <img src={mediaUrl(src)} style={{ left: ix, top: iy, width: iw, height: ih }} alt="" draggable={false} />}
      <div ref={areaRef} className="privacy-area" style={{ left: ix, top: iy, width: iw, height: ih }} onPointerDown={startDraw} />
      {free.map((f, i) => (
        <button key={`f${i}`} className="privacy-face" style={box(f)} title={t('privacyEdit')} onClick={() => save(togglePrivacy(entry, f))} />
      ))}
      {areas.map((a, i) => (
        <button key={`a${i}`} className="privacy-face on" style={box(a)} title={t('privacyNone')} onClick={() => save(togglePrivacy(entry, a))} />
      ))}
      {draft && <div className="privacy-face draft" style={box(draft)} />}
      <div className="kb-bar">
        <span className="hint" style={{ margin: 0, flex: 1 }}>
          {pending ? t('facesPending') : detected!.length === 0 ? t('noFacesFound') : t('privacyHint')}
          {isVideo ? ` ${t('privacyVideoHint')}` : ''}
        </span>
        {!!detected?.length && (
          <button className="btn small" onClick={() => save([...areas, ...free])}>
            {t('privacyAll')}
          </button>
        )}
        {areas.length > 0 && (
          <button className="btn small ghost" onClick={() => save(undefined)}>
            {t('privacyNone')}
          </button>
        )}
        <button className="btn small primary" onClick={() => useStore.getState().set({ privacyEdit: null })}>
          {t('done')}
        </button>
      </div>
    </div>
  )
}
