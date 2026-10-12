import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ImagePlus, FolderPlus, Pause, Play, Repeat } from 'lucide-react'
import { mediaUrl } from '@shared/api'
import type { Crop, MediaItem, PhotoEntry, Rect, VideoEntry } from '@shared/types'
import type { TimelineSlide } from '@shared/timeline'
import { themeMeta } from '@shared/themes'
import { aspectValue } from '@shared/timeline'
import { Player } from '../engine/player'
import { coverRect, kenBurnsOf, photoUv, showsWhole, type Box } from '../engine/draw'
import { shownAspect, sourceAspect } from '@shared/mediaEdit'
import { EditedPicture } from './EditedPicture'
import { PhotoEditor } from './PhotoEditor'
import { Crop as CropIcon, Maximize } from 'lucide-react'
import { playerRef, useStore } from '../store'
import { timelineOf, useTimeline } from '../timeline'
import { fmtTime, localeTag, t } from '../i18n'
import { previewQuality, QUALITY } from './Settings'
import { FreeTextLayer, PrivacyEditor } from './Overlays'
import { CollageEditor } from './CollageEditor'
import { prioritize } from '../priority'
import { Seg } from './ui'

function useBox(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return box
}

export function Viewer() {
  const project = useStore((s) => s.project)!
  const selection = useStore((s) => s.selection)
  const playing = useStore((s) => s.playing)
  const kbEdit = useStore((s) => s.kbEdit)
  const privacyEdit = useStore((s) => s.privacyEdit)
  const photoEdit = useStore((s) => s.photoEdit)
  const fullscreen = useStore((s) => s.fullscreen)
  const tl = useTimeline()
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const box = useBox(stageRef)
  const aspect = aspectValue(project.settings.aspect)
  const fw = Math.max(0, Math.min(box.w, box.h * aspect))
  const fh = fw / aspect

  useEffect(() => {
    const player = new Player(canvasRef.current!, localeTag())
    playerRef.current = player
    let last = 0
    player.onTime = (time) => {
      const now = performance.now()
      // throttled while playing; a seek always lands (the editing layers follow the playhead)
      if (!player.playing || now - last > 66) {
        last = now
        useStore.setState({ playhead: time })
      }
    }
    player.onState = (p) => useStore.setState({ playing: p, playhead: player.t })
    return () => {
      player.dispose()
      playerRef.current = null
    }
  }, [])

  // the theme songs arrive once at start (store.themeTracks): the timeline is rebuilt with them
  const themeTracks = useStore((s) => s.themeTracks)
  useEffect(() => {
    playerRef.current?.setProject(project, timelineOf(project))
  }, [project, themeTracks])

  // The fullscreen player has its own engine; keep the preview quiet meanwhile.
  useEffect(() => {
    if (fullscreen) playerRef.current?.pause()
  }, [fullscreen])

  const [quality, setQuality] = useState(previewQuality())
  useEffect(() => {
    const on = (): void => setQuality(previewQuality())
    window.addEventListener('previewquality', on)
    return () => window.removeEventListener('previewquality', on)
  }, [])

  useEffect(() => {
    const p = playerRef.current
    if (!p || !fw) return
    const q = QUALITY[quality]
    const dpr = Math.min(window.devicePixelRatio || 1, q.dpr)
    const scale = Math.min(dpr, q.maxWidth / fw)
    const c = canvasRef.current!
    c.width = Math.round(fw * scale)
    c.height = Math.round(fh * scale)
    p.engine.setImageSize(q.images)
    p.resize(c.width, c.height)
  }, [fw, fh, quality])

  // Selecting a slide shows it (fully visible, after its incoming transition).
  useEffect(() => {
    const p = playerRef.current
    if (!p || p.playing || !selection.length) return
    const slide = timelineOf(project).slides.find((s) => s.entries.some((e) => e.id === selection[0]))
    if (slide) p.seek(slide.start + Math.min(slide.transIn + 0.05, slide.duration / 2))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection])

  const playhead = useStore((s) => s.playhead)
  const duration = tl?.duration ?? 0
  const empty = project.entries.length === 0

  const editSlide: TimelineSlide | undefined =
    themeMeta(project.settings.theme).cropEdit && selection.length
      ? timelineOf(project).slides.find((s) => s.kind === 'photos' && s.entries.some((e) => e.id === selection[0]))
      : undefined

  // the slide at the playhead (the later one during a transition) carries the free texts shown
  const atPlayhead = tl ? tl.slides.filter((s) => s.start <= playhead + 1e-3 && playhead < s.start + s.duration).pop() : undefined
  // the slide on screen and the next one are processed first during an import
  const nextSlide = atPlayhead && tl ? tl.slides[atPlayhead.index + 1] : undefined
  const viewIds = [...(atPlayhead?.media ?? []), ...(nextSlide?.media ?? [])].map((m) => m.id).join(',')
  useEffect(() => prioritize('viewer', viewIds ? viewIds.split(',') : []), [viewIds])

  const selectedPhoto = (() => {
    if (selection.length !== 1) return null
    const e = project.entries.find((x) => x.id === selection[0])
    if (!e || e.type !== 'photo') return null
    const m = project.media.find((x) => x.id === e.mediaId)
    return m ? { e, m } : null
  })()

  return (
    <section className="viewer" aria-label={t('preview')}>
      <div className="stage" ref={stageRef} data-theme="dark">
        <div className="frame" style={{ width: fw, height: fh, visibility: empty ? 'hidden' : 'visible' }}>
          <canvas ref={canvasRef} />
          {!playing && !kbEdit && !privacyEdit && !photoEdit && editSlide && <CropEditor slide={editSlide} scale={fw / (canvasRef.current?.width || fw)} />}
          {!playing && !kbEdit && !privacyEdit && !photoEdit && atPlayhead?.template?.id === 'free' && <CollageEditor slide={atPlayhead} w={fw} h={fh} />}
          {!playing && !kbEdit && !privacyEdit && !photoEdit && atPlayhead && <FreeTextLayer slide={atPlayhead} w={fw} h={fh} />}
          {privacyEdit && !playing && <PrivacyEditor entryId={privacyEdit} w={fw} h={fh} />}
          {kbEdit && selectedPhoto && <KenBurnsEditor entry={selectedPhoto.e} display={selectedPhoto.m.display} mediaAspect={shownAspect(selectedPhoto.m)} frameAspect={aspect} w={fw} h={fh} />}
          {photoEdit && !playing && fw > 0 && <PhotoEditor w={fw} h={fh} />}
        </div>
        {empty && (
          <div className="empty-stage">
            <p>{t('emptyShow')}</p>
            <div className="row">
              <button className="btn" onClick={async () => useStore.getState().importMedia(await window.api.pickMedia())}>
                <ImagePlus size={16} /> {t('addMedia')}
              </button>
              <button className="btn" onClick={async () => useStore.getState().importMedia(await window.api.pickFolder())}>
                <FolderPlus size={16} /> {t('addFolder')}
              </button>
            </div>
          </div>
        )}
      </div>
      <input
        className="scrub"
        type="range"
        aria-label={t('position')}
        aria-valuetext={`${fmtTime(playhead)} / ${fmtTime(duration)}`}
        min={0}
        max={Math.max(0.01, duration)}
        step={0.01}
        value={Math.min(playhead, duration)}
        disabled={empty}
        onChange={(e) => playerRef.current?.seek(Number(e.target.value))}
      />
      <div className="controls">
        <div className="left">
          <button
            className={`btn small icon ${project.settings.loop ? 'on' : ''}`}
            title={t('loop')}
            aria-label={t('loop')}
            aria-pressed={!!project.settings.loop}
            onClick={() => useStore.getState().setSettings({ loop: !project.settings.loop })}
          >
            <Repeat size={15} />
          </button>
        </div>
        <button className="playbtn" title={`${playing ? t('pause') : t('playPreview')} (${t('kbdSpace')})`} aria-label={playing ? t('pause') : t('playPreview')} onClick={() => playerRef.current?.toggle()} disabled={empty}>
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />}
        </button>
        <div className="right">
          <span aria-hidden>
            {fmtTime(playhead)} / {fmtTime(duration)}
          </span>
        </div>
      </div>
    </section>
  )
}

function KenBurnsEditor(props: { entry: PhotoEntry; display?: string; mediaAspect: number; frameAspect: number; w: number; h: number }) {
  const { entry, mediaAspect, frameAspect, w, h } = props
  const kbEdit = useStore((s) => s.kbEdit)!
  const setEntry = useStore((s) => s.setEntry)
  const media = useStore((s) => s.project?.media.find((m) => m.id === entry.mediaId))
  // the frames are drawn on the edited picture (as the engine draws them)
  const kb = kenBurnsOf(entry, media, frameAspect)
  const full = coverRect(mediaAspect, frameAspect)
  // image area inside the editor (contain)
  const iw = Math.min(w * 0.92, (h * 0.86) * mediaAspect)
  const ih = iw / mediaAspect
  const ix = (w - iw) / 2
  const iy = (h - ih) / 2 - 12

  const clampRect = (r: Rect): Rect => {
    const ww = Math.min(full.w, Math.max(full.w * 0.15, r.w))
    const hh = (ww * full.h) / full.w
    return { x: Math.min(1 - ww, Math.max(0, r.x)), y: Math.min(1 - hh, Math.max(0, r.y)), w: ww, h: hh }
  }
  const save = (r: Rect): void => setEntry(entry.id, { kenBurns: { ...kb, [kbEdit]: clampRect(r) } } as Partial<PhotoEntry>)

  const drag = (e: React.PointerEvent, r: Rect): void => {
    const sx = e.clientX
    const sy = e.clientY
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => save({ ...r, x: r.x + (ev.clientX - sx) / iw, y: r.y + (ev.clientY - sy) / ih })
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  const zoom = (r: Rect, factor: number): void => {
    const ww = r.w * factor
    const hh = r.h * factor
    save({ x: r.x + (r.w - ww) / 2, y: r.y + (r.h - hh) / 2, w: ww, h: hh })
  }

  const rect = (which: 'start' | 'end') => {
    const r = kb[which]
    const active = which === kbEdit
    return (
      <div
        key={which}
        className={`rect ${which} ${active ? '' : 'inactive'}`}
        style={{ left: ix + r.x * iw, top: iy + r.y * ih, width: r.w * iw, height: r.h * ih }}
        onPointerDown={active ? (e) => drag(e, r) : undefined}
        onWheel={active ? (e) => zoom(r, e.deltaY > 0 ? 1.05 : 0.95) : undefined}
      >
        <span>{which === 'start' ? t('kbStart') : t('kbEnd')}</span>
      </div>
    )
  }
  const cur = kb[kbEdit]
  return (
    <div className="kb">
      {props.display && <EditedPicture src={mediaUrl(props.display)} edit={media?.edit} aspect={sourceAspect(media)} box={{ x: ix, y: iy, w: iw, h: ih }} />}
      {rect(kbEdit === 'start' ? 'end' : 'start')}
      {rect(kbEdit)}
      <div className="kb-bar">
        <Seg
          label={t('kenBurns')}
          value={kbEdit}
          options={[
            { id: 'start', label: t('kbStart') },
            { id: 'end', label: t('kbEnd') }
          ]}
          onChange={(k) => useStore.getState().set({ kbEdit: k })}
        />
        <input
          type="range"
          className="zoom"
          min={0}
          max={0.85}
          step={0.01}
          title={t('zoom')}
          aria-label={t('zoom')}
          value={1 - cur.w / full.w}
          onChange={(e) => zoom(cur, (full.w * (1 - Number(e.target.value))) / cur.w)}
        />
        <span className="hint">{t('kbHint')}</span>
        <button className="btn small primary" onClick={() => useStore.getState().set({ kbEdit: null })}>
          {t('done')}
        </button>
      </div>
    </div>
  )
}

/** Drag a photo inside its cell to move the framing, scroll to zoom, double-click to reset. */
function CropEditor({ slide, scale }: { slide: TimelineSlide; scale: number }) {
  const setEntry = useStore((s) => s.setEntry)
  const settings = useStore((s) => s.project!.settings)
  const [active, setActive] = useState<string | null>(null)
  const frame = useRef(0)
  const engine = playerRef.current?.engine
  const boxes: Box[] = engine ? engine.editBoxes(slide) : []
  // one project update per animation frame while dragging
  const write = (id: string, crop: Crop): void => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => setEntry(id, { crop } as Partial<PhotoEntry>))
  }
  const center = (e: PhotoEntry | VideoEntry, m: MediaItem, b: Box) => {
    const uv = photoUv(e, m, b.w / b.h)
    return { uv, x: uv.x + uv.w / 2, y: uv.y + uv.h / 2, zoom: e.crop?.zoom ?? 1 }
  }
  return (
    <>
      {boxes.map((b, i) => {
        const e = slide.entries[i]
        const m = slide.media[i]
        if (!e || e.type === 'text' || !m) return null
        const whole = showsWhole(e, settings, shownAspect(m), b.w / b.h)
        return (
          <div
            key={e.id}
            className={`crop-cell ${active === e.id ? 'active' : ''} ${whole ? 'whole' : ''}`}
            style={{ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale }}
            title={t('cropHint')}
            onPointerDown={(ev) => {
              if (ev.button !== 0 || whole) return
              const el = ev.currentTarget
              el.setPointerCapture(ev.pointerId)
              setActive(e.id)
              const c0 = center(e, m, b)
              const sx = ev.clientX
              const sy = ev.clientY
              const move = (pe: PointerEvent): void => {
                const dx = (pe.clientX - sx) / scale / b.w
                const dy = (pe.clientY - sy) / scale / b.h
                write(e.id, { x: c0.x - dx * c0.uv.w, y: c0.y - dy * c0.uv.h, zoom: c0.zoom })
              }
              const up = (): void => {
                el.removeEventListener('pointermove', move)
                el.removeEventListener('pointerup', up)
                setActive(null)
              }
              el.addEventListener('pointermove', move)
              el.addEventListener('pointerup', up)
            }}
            onWheel={(ev) => {
              if (whole) return
              const c = center(e, m, b)
              const zoom = Math.min(4, Math.max(1, c.zoom * (ev.deltaY < 0 ? 1.08 : 1 / 1.08)))
              write(e.id, { x: c.x, y: c.y, zoom })
            }}
            onDoubleClick={() => setEntry(e.id, { crop: undefined } as Partial<PhotoEntry>)}
          >
            <button
              className="cell-toggle"
              title={whole ? t('cropMode') : t('wholeMode')}
              aria-label={`${whole ? t('cropMode') : t('wholeMode')}: ${m.name}`}
              onPointerDown={(ev) => ev.stopPropagation()}
              onDoubleClick={(ev) => ev.stopPropagation()}
              onClick={() => setEntry(e.id, { whole: !whole } as Partial<PhotoEntry>)}
            >
              {whole ? <CropIcon size={13} /> : <Maximize size={13} />}
            </button>
          </div>
        )
      })}
    </>
  )
}
