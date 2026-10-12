// Light and colour sliders (shared/adjust.ts) for one or several photos and videos, in the edit view and in
// the Slide tab. Several pictures all get the value the slider is set to (the others keep theirs).
// - Dragging shows a draft: in the preview (the engine) and through `onDraft` (the edit view's own
//   picture); it is stored as one undo step when the pointer lets go.
// - Keys: the arrows move by 1 (Shift: by 10), Home/End/Page keys as usual; a run of presses is one undo
//   step. A double-click or the reset button next to it sets 0. There is no "Auto": every change is by hand.
import { useId, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { ADJUST_KEYS, ADJUST_MAX, type AdjustKey } from '@shared/adjust'
import type { MediaAdjust, MediaItem } from '@shared/types'
import { previewAdjust, setMediaAdjust } from '../photoEdit'
import { t, type StringKey } from '../i18n'
import './photoEdit.css'

const LABELS: Record<AdjustKey, [StringKey, StringKey]> = {
  brightness: ['adjBrightness', 'adjBrightnessReset'],
  contrast: ['adjContrast', 'adjContrastReset'],
  warmth: ['adjWarmth', 'adjWarmthReset'],
  saturation: ['adjSaturation', 'adjSaturationReset']
}
const BIG_STEP = 10

/** "+20", "−20" or "0". */
export const adjustText = (v: number): string => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0')

export function AdjustSliders(props: { media: MediaItem[]; onDraft?: (patch: MediaAdjust | null) => void; className?: string }) {
  const ids = props.media.map((m) => m.id)
  return (
    <div className={`adjust ${props.className ?? ''}`} role="group" aria-label={t('adjTitle')}>
      {ADJUST_KEYS.map((k) => {
        const values = props.media.map((m) => m.edit?.adjust?.[k] ?? 0)
        return <AdjustSlider key={k} name={k} ids={ids} value={values[0] ?? 0} mixed={values.some((v) => v !== values[0])} onDraft={props.onDraft} />
      })}
    </div>
  )
}

function AdjustSlider(props: { name: AdjustKey; ids: string[]; value: number; mixed: boolean; onDraft?: (patch: MediaAdjust | null) => void }) {
  const { name, ids, onDraft } = props
  const id = useId()
  const [draft, setDraftState] = useState<number | null>(null)
  const draftRef = useRef<number | null>(null)
  const dragging = useRef(false)
  const shown = draft ?? props.value
  const [label, resetLabel] = LABELS[name]
  // several pictures with different values: the slider starts at the first one's
  const text = props.mixed && draft == null ? t('adjMixed') : adjustText(shown)

  const setDraft = (v: number | null): void => {
    draftRef.current = v
    setDraftState(v)
  }
  const store = (v: number, key?: string): void => setMediaAdjust(ids, { [name]: v }, key)
  // a drag ends with the pointer: stored as one step (or dropped when the pointer was taken away)
  const end = (keep: boolean): void => {
    if (!dragging.current) return
    dragging.current = false
    const v = draftRef.current
    setDraft(null)
    onDraft?.(null)
    if (keep && v != null) store(v)
    else previewAdjust(null)
  }

  return (
    <div className="adj-row">
      <label htmlFor={id}>{t(label)}</label>
      <input
        id={id}
        type="range"
        min={-ADJUST_MAX}
        max={ADJUST_MAX}
        step={1}
        value={shown}
        aria-valuetext={text}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          dragging.current = true
          // the pointer may be let go outside the slider
          const ac = new AbortController()
          const done = (keep: boolean): void => {
            ac.abort()
            end(keep)
          }
          window.addEventListener('pointerup', () => done(true), { signal: ac.signal })
          window.addEventListener('pointercancel', () => done(false), { signal: ac.signal })
        }}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (!dragging.current) return store(v, name)
          setDraft(v)
          previewAdjust({ ids, patch: { [name]: v } })
          onDraft?.({ [name]: v })
        }}
        onKeyDown={(e) => {
          const dir = ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 } as Record<string, number>)[e.key]
          if (!dir || !e.shiftKey || e.ctrlKey || e.altKey) return
          // Shift: bigger steps (the range input itself only knows steps of 1 and the Page keys)
          e.preventDefault()
          store(Math.max(-ADJUST_MAX, Math.min(ADJUST_MAX, props.value + dir * BIG_STEP)), name)
        }}
        onDoubleClick={() => store(0)}
      />
      <span className="val" aria-hidden>
        {text}
      </span>
      <button className="btn small ghost icon" title={t(resetLabel)} aria-label={t(resetLabel)} disabled={!props.mixed && props.value === 0} onClick={() => store(0)}>
        <RotateCcw size={13} />
      </button>
    </div>
  )
}
