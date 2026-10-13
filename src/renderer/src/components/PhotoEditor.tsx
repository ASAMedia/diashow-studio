// The edit view over the preview, like the one of macOS Photos, with two tools:
// - Crop: turn a photo (or video) by quarters, straighten it (it zooms so no corner stays empty) and
//   crop it, freely or to an aspect preset.
// - Light and colour: brightness, contrast, warmth and saturation sliders (AdjustSliders), on the
//   picture as it is cropped.
// - Every finished gesture is one undo step (photoEdit.ts); a drag only shows a draft until it ends.
// - Cancel puts back the edit the view opened with; Reset sets the current tool's part back to the original.
// - Keys: Esc cancels, Enter applies, the arrow keys move the crop frame (Shift: its size), Ctrl+R turns
//   left, Ctrl+Z / Ctrl+Y undo and redo. The bar's controls are labelled buttons, sliders and a select.
import { useEffect, useId, useRef, useState } from 'react'
import { RectangleHorizontal, RectangleVertical, RotateCcw, RotateCw } from 'lucide-react'
import { mediaUrl } from '@shared/api'
import type { MediaAdjust, MediaEdit, Rect } from '@shared/types'
import {
  CROP_PRESETS, cropToRatio, dragCrop, editedAspect, editKey, isEdited, MAX_STRAIGHTEN, presetOf, presetRatio, rotateEdit, sourceAspect, type CropHandle, type CropPreset
} from '@shared/mediaEdit'
import { isAdjusted } from '@shared/adjust'
import { useStore } from '../store'
import { closePhotoEdit, setMediaEdit } from '../photoEdit'
import { followPointer } from '../pointerDrag'
import { localeTag, t } from '../i18n'
import { EditedPicture } from './EditedPicture'
import { AdjustSliders } from './AdjustSliders'
import { stillTime } from './PrivacyEditor'
import { Seg } from './ui'
import './photoEdit.css'

const NONE: MediaEdit = { rotate: 0, straighten: 0 }
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 }
/** Least room for the tool bar under the picture (it wraps to two rows in a narrow preview; more when taller). */
const BAR = 104
const HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** The picture under the edit view: a photo's display image, or a frame from the middle of a clip. */
function useStill(): string | undefined {
  const open = useStore((s) => s.photoEdit)
  const media = useStore((s) => s.project?.media.find((m) => m.id === open?.mediaId))
  const entry = useStore((s) => s.project?.entries.find((e) => e.id === open?.entryId))
  const isVideo = media?.kind === 'video'
  const time = isVideo && entry?.type === 'video' ? stillTime(entry, media) : 0
  const [frame, setFrame] = useState<{ id: string; url: string } | null>(null)
  useEffect(() => {
    if (!media || !isVideo) return
    let alive = true
    let url = ''
    window.api
      .videoFrames(media.playback ?? media.path, [time], 1280)
      .then(([jpeg]) => {
        if (!alive || !jpeg?.length) return
        url = URL.createObjectURL(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }))
        setFrame({ id: media.id, url })
      })
      .catch(() => {})
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [media?.id, time]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!media) return undefined
  if (isVideo && frame?.id === media.id) return frame.url
  const path = isVideo ? media.thumb : (media.display ?? media.thumb)
  return path ? mediaUrl(path) : undefined
}

export function PhotoEditor({ w, h }: { w: number; h: number }) {
  const open = useStore((s) => s.photoEdit)
  const media = useStore((s) => s.project?.media.find((m) => m.id === open?.mediaId))
  const src = useStill()
  const hintId = useId()
  const straightenId = useId()
  const aspectId = useId()
  const [draft, setDraftState] = useState<MediaEdit | null>(null)
  const draftRef = useRef<MediaEdit | null>(null)
  const setDraft = (d: MediaEdit | null): void => {
    draftRef.current = d
    setDraftState(d)
  }
  // the rule-of-thirds grid while a drag or the slider is held
  const [guides, setGuides] = useState(false)
  const sliding = useRef(false)
  const cropRef = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<'crop' | 'adjust'>('crop')
  // a light and colour slider being dragged (stored when it is let go)
  const [adjDraft, setAdjDraft] = useState<MediaAdjust | null>(null)
  // the bar's height: the picture fits above it
  const barRef = useRef<HTMLDivElement>(null)
  const [barH, setBarH] = useState(BAR)
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBarH(Math.max(BAR, el.offsetHeight + 18)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [!!media]) // eslint-disable-line react-hooks/exhaustive-deps

  const aspect = sourceAspect(media)
  const edit: MediaEdit = draft ?? media?.edit ?? NONE
  // the straightened frame has the shape of the turned picture
  const fa = edit.rotate === 90 || edit.rotate === 270 ? 1 / aspect : aspect
  const [ratio, setRatio] = useState<{ preset: CropPreset; swap: boolean }>(() => presetOf(media?.edit?.crop, fa, fa))
  const lock = presetRatio(ratio.preset, fa, ratio.swap)

  // the keys go to the crop frame when the view opens; the focus goes back afterwards
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cropRef.current?.focus({ preventScroll: true })
    return () => {
      const now = document.activeElement
      if (opener?.isConnected && (!now || now === document.body || !now.isConnected)) opener.focus({ preventScroll: true })
    }
  }, [])

  // after an undo the crop may no longer have the chosen shape: show what it is
  const stored = editKey(media?.edit)
  useEffect(() => {
    const c = media?.edit?.crop
    if (lock && c && Math.abs(Math.log(((c.w / c.h) * fa) / lock)) > 0.01) setRatio(presetOf(c, fa, fa))
  }, [stored]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !media) return null

  const commit = (next: MediaEdit, key?: string): void => setMediaEdit(media.id, next, key)
  const crop = edit.crop ?? FULL
  const adjusting = tool === 'adjust'
  const shown: MediaEdit = adjDraft ? { ...edit, adjust: { ...edit.adjust, ...adjDraft } } : edit

  // the frame, fitted above the bar: the straightened picture with the crop on top, or (light and
  // colour) the picture as it is cropped
  const shape = adjusting ? editedAspect(aspect, edit) : fa
  const maxW = Math.max(40, w - 32)
  const maxH = Math.max(40, h - barH - 16)
  const fw = Math.min(maxW, maxH * shape)
  const fh = fw / shape
  const frame = { x: (w - fw) / 2, y: 8 + (maxH - fh) / 2, w: fw, h: fh }
  const cropBox = { left: frame.x + crop.x * fw, top: frame.y + crop.y * fh, width: crop.w * fw, height: crop.h * fh }

  const rotate = (dir: -1 | 1): void => {
    commit(rotateEdit(edit, dir))
    // a fixed shape turns with the picture (4:3 becomes 3:4); 'original' and 1:1 stay what they are
    if (ratio.preset !== 'free' && ratio.preset !== 'original' && ratio.preset !== '1:1') setRatio((r) => ({ ...r, swap: !r.swap }))
  }

  const choose = (preset: CropPreset, swap: boolean): void => {
    setRatio({ preset, swap })
    const r = presetRatio(preset, fa, swap)
    if (r) commit({ ...edit, crop: cropToRatio(edit.crop, r, fa) })
  }

  /** Dragging a handle (or the frame itself): a draft while the pointer moves, one undo step at the end. */
  const drag = (handle: CropHandle, ev: React.PointerEvent): void => {
    if (ev.button !== 0) return
    ev.preventDefault()
    ev.stopPropagation()
    cropRef.current?.focus({ preventScroll: true })
    const base = edit
    const start = crop
    const sx = ev.clientX
    const sy = ev.clientY
    const at = (pe: PointerEvent): MediaEdit => ({ ...base, crop: dragCrop(start, handle, (pe.clientX - sx) / fw, (pe.clientY - sy) / fh, lock, fa) })
    setGuides(true)
    followPointer(
      ev,
      (pe) => setDraft(at(pe)),
      (kept, pe) => {
        setGuides(false)
        setDraft(null)
        if (kept) commit(at(pe))
      }
    )
  }

  const nudge = (e: React.KeyboardEvent): void => {
    const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key]
    if (!d || e.ctrlKey || e.altKey) return
    e.preventDefault()
    e.stopPropagation()
    const step = 0.01
    // Shift: the right edge (left/right) or the bottom edge (up/down) moves, the shape kept when locked
    const next = e.shiftKey ? dragCrop(crop, d[0] ? 'e' : 's', d[0] * step, d[1] * step, lock, fa) : dragCrop(crop, 'move', d[0] * step, d[1] * step, null, fa)
    commit({ ...edit, crop: next }, e.shiftKey ? 'size' : 'move')
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'F1') return
    // the editor's own shortcuts (play, step, delete…) wait while this view has the keys
    e.stopPropagation()
    const target = e.target as HTMLElement
    if (e.key === 'Escape') {
      e.preventDefault()
      closePhotoEdit(true)
    } else if (e.key === 'Enter' && !target.closest('button, select')) {
      e.preventDefault()
      closePhotoEdit(false)
    } else if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'r') {
      e.preventDefault()
      rotate(-1)
    } else if (e.ctrlKey && !e.altKey && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      e.preventDefault()
      if (draftRef.current) return
      if (e.key.toLowerCase() === 'y' || e.shiftKey) useStore.getState().redo()
      else useStore.getState().undo()
    } else if (e.code === 'Space' && !target.closest('button, input, select')) e.preventDefault()
  }

  const degrees = `${edit.straighten.toLocaleString(localeTag(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}°`
  const isVideo = media.kind === 'video'
  return (
    <div className="photo-edit" role="dialog" aria-modal="false" aria-label={isVideo ? t('peTitleVideo') : t('peTitle')} onKeyDown={onKey}>
      <EditedPicture src={src} edit={shown} aspect={aspect} box={frame} crop={adjusting} className="pe-picture" />
      <div className="pe-dim" hidden={adjusting} style={{ left: frame.x, top: frame.y, width: fw, height: fh }} aria-hidden>
        <div className="pe-hole" style={{ left: crop.x * fw, top: crop.y * fh, width: crop.w * fw, height: crop.h * fh }} />
      </div>
      <div
        ref={cropRef}
        hidden={adjusting}
        className={`pe-crop ${guides ? 'guides' : ''}`}
        style={cropBox}
        tabIndex={0}
        role="group"
        aria-label={`${t('peCrop')}: ${Math.round(crop.w * 100)} × ${Math.round(crop.h * 100)} %`}
        aria-describedby={hintId}
        data-crop={`${crop.x.toFixed(4)},${crop.y.toFixed(4)},${crop.w.toFixed(4)},${crop.h.toFixed(4)}`}
        onPointerDown={(ev) => drag('move', ev)}
        onKeyDown={nudge}
      >
        <div className="pe-grid" aria-hidden />
        {HANDLES.map((hd) => (
          <div key={hd} className={`pe-handle ${hd}`} data-handle={hd} aria-hidden onPointerDown={(ev) => drag(hd, ev)} />
        ))}
      </div>
      <p id={hintId} className="sr-only">
        {t('peHint')}
      </p>
      <div className="pe-bar" ref={barRef}>
        <Seg
          className="pe-tools"
          label={t('peModes')}
          value={tool}
          options={[
            { id: 'crop', label: t('peModeCrop') },
            { id: 'adjust', label: t('adjTitle') }
          ]}
          onChange={setTool}
        />
        {adjusting && <AdjustSliders media={[media]} onDraft={setAdjDraft} className="pe-adjust" />}
        <div className="pe-group" hidden={adjusting} role="group" aria-label={t('peRotate')}>
          <button className="btn small icon" title={`${t('peRotateLeft')} (${t('kbdRotate')})`} aria-label={t('peRotateLeft')} aria-keyshortcuts="Control+R" onClick={() => rotate(-1)}>
            <RotateCcw size={15} />
          </button>
          <button className="btn small icon" title={t('peRotateRight')} aria-label={t('peRotateRight')} onClick={() => rotate(1)}>
            <RotateCw size={15} />
          </button>
        </div>
        <div className="pe-group pe-straighten" hidden={adjusting}>
          <label htmlFor={straightenId}>{t('peStraighten')}</label>
          <input
            id={straightenId}
            type="range"
            min={-MAX_STRAIGHTEN}
            max={MAX_STRAIGHTEN}
            step={0.1}
            value={edit.straighten}
            aria-valuetext={degrees}
            onPointerDown={() => {
              sliding.current = true
              setGuides(true)
            }}
            onChange={(e) => {
              const next = { ...edit, straighten: Number(e.target.value) }
              // held with the mouse: a draft until it is let go; keys: one step per run of presses
              if (sliding.current) setDraft(next)
              else commit(next, 'straighten')
            }}
            onPointerUp={() => {
              sliding.current = false
              setGuides(false)
              const d = draftRef.current
              setDraft(null)
              if (d) commit(d)
            }}
            onLostPointerCapture={() => {
              if (!sliding.current) return
              sliding.current = false
              setGuides(false)
              const d = draftRef.current
              setDraft(null)
              if (d) commit(d)
            }}
            onDoubleClick={() => commit({ ...edit, straighten: 0 })}
          />
          <span className="pe-val" aria-hidden>
            {degrees}
          </span>
        </div>
        <div className="pe-group" hidden={adjusting}>
          <label htmlFor={aspectId}>{t('peAspect')}</label>
          <select id={aspectId} value={ratio.preset} onChange={(e) => choose(e.target.value as CropPreset, ratio.swap)}>
            {CROP_PRESETS.map((p) => (
              <option key={p} value={p}>
                {p === 'free' ? t('peFree') : p === 'original' ? t('peOriginal') : ratio.swap && p !== '1:1' ? p.split(':').reverse().join(':') : p}
              </option>
            ))}
          </select>
          <button
            className="btn small icon"
            title={t('peSwap')}
            aria-label={t('peSwap')}
            aria-pressed={ratio.swap}
            disabled={ratio.preset === 'free' || ratio.preset === '1:1'}
            onClick={() => choose(ratio.preset, !ratio.swap)}
          >
            {(lock ?? fa) >= 1 ? <RectangleHorizontal size={15} /> : <RectangleVertical size={15} />}
          </button>
        </div>
        <div className="pe-group pe-actions">
          <button
            className="btn small ghost"
            disabled={adjusting ? !isAdjusted(edit.adjust) : !isEdited(edit)}
            onClick={() => {
              // each tool resets its own part: the turn, tilt and crop, or the light and colour
              if (adjusting) return commit({ ...edit, adjust: undefined })
              setRatio({ preset: 'free', swap: false })
              commit({ ...NONE, adjust: edit.adjust })
            }}
          >
            {t('peReset')}
          </button>
          <button className="btn small" onClick={() => closePhotoEdit(true)}>
            {t('cancel')}
          </button>
          <button className="btn small primary" onClick={() => closePhotoEdit(false)}>
            {t('done')}
          </button>
        </div>
      </div>
    </div>
  )
}
