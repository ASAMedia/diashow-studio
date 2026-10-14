// Editing layers over the preview: free text boxes (drag, double-click to type) and the editor
// for pixelated areas (click detected faces, drag out areas).
import { useState } from 'react'
import type { FreeText } from '@shared/types'
import type { TimelineSlide } from '@shared/timeline'
import { FONT_FAMILY } from '../engine/text'
import { FONT_ROLE } from '../engine/freeText'
import { useStore } from '../store'
import { followPointer } from '../pointerDrag'

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
              const sx = e.clientX
              const sy = e.clientY
              const x0 = ft.x
              const y0 = ft.y
              let frame = 0
              followPointer(e, (pe) => {
                const x = Math.min(1, Math.max(0, x0 + (pe.clientX - sx) / w))
                const y = Math.min(1, Math.max(0, y0 + (pe.clientY - sy) / h))
                cancelAnimationFrame(frame)
                frame = requestAnimationFrame(() => useStore.getState().setFreeText(entryId, ft.id, { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }))
              })
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

// The editor moved to its own file (faces followed through videos, marked people).
export { PrivacyEditor } from './PrivacyEditor'
