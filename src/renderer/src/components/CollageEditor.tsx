// Free collage in the preview: drag an item to move it, the corner to resize it (its shape
// stays), the knob above it to turn it; clicking brings it to the front, double-click levels it.
import { useRef, useState } from 'react'
import type { CollagePlace, PhotoEntry } from '@shared/types'
import type { TimelineSlide } from '@shared/timeline'
import { useStore } from '../store'
import { t } from '../i18n'

type Mode = 'move' | 'size' | 'turn'

export function CollageEditor({ slide, w, h }: { slide: TimelineSlide; w: number; h: number }) {
  const setEntry = useStore((s) => s.setEntry)
  const [active, setActive] = useState<string | null>(null)
  const frame = useRef(0)
  const places = slide.places
  if (!places) return null
  const top = Math.max(...places.map((p) => p.z))

  const save = (id: string, place: CollagePlace): void => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => setEntry(id, { place } as Partial<PhotoEntry>))
  }

  const start = (i: number, mode: Mode) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const id = slide.entries[i].id
    const p0 = { ...places[i], z: places[i].z < top ? top + 1 : places[i].z }
    setActive(id)
    if (p0.z !== places[i].z) save(id, p0)
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const rect = el.closest('.collage-edit')!.getBoundingClientRect()
    const cx = rect.left + (p0.x + p0.w / 2) * w
    const cy = rect.top + (p0.y + p0.h / 2) * h
    const sx = e.clientX
    const sy = e.clientY
    const d0 = Math.hypot(sx - cx, sy - cy) || 1
    const move = (pe: PointerEvent): void => {
      if (mode === 'move') {
        save(id, { ...p0, x: p0.x + (pe.clientX - sx) / w, y: p0.y + (pe.clientY - sy) / h })
      } else if (mode === 'size') {
        // scale around the centre, the shape stays
        const k = Math.min(4, Math.max(0.2, Math.hypot(pe.clientX - cx, pe.clientY - cy) / d0))
        const nw = Math.min(1.2, Math.max(0.06, p0.w * k))
        const nh = (p0.h * nw) / p0.w
        save(id, { ...p0, x: p0.x + (p0.w - nw) / 2, y: p0.y + (p0.h - nh) / 2, w: nw, h: nh })
      } else {
        // the knob sits above the centre: 0 degrees points straight up
        const a = (Math.atan2(pe.clientY - cy, pe.clientX - cx) * 180) / Math.PI + 90
        const rot = Math.round((((a + 540) % 360) - 180) * 10) / 10
        save(id, { ...p0, rot: Math.abs(rot) < 2 ? 0 : rot })
      }
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      setActive(null)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div className="collage-edit">
      {places.map((p, i) => {
        const id = slide.entries[i].id
        return (
          <div
            key={id}
            className={`collage-item ${active === id ? 'active' : ''}`}
            style={{ left: p.x * w, top: p.y * h, width: p.w * w, height: p.h * h, transform: `rotate(${p.rot}deg)`, zIndex: 10 + p.z }}
            title={t('collageHint')}
            onPointerDown={start(i, 'move')}
            onDoubleClick={() => setEntry(id, { place: { ...p, rot: 0 } } as Partial<PhotoEntry>)}
          >
            <span className="collage-turn" onPointerDown={start(i, 'turn')} />
            <span className="collage-size" onPointerDown={start(i, 'size')} />
          </div>
        )
      })}
    </div>
  )
}
