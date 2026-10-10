// Small building blocks shared by the inspector panels.
import type { ReactNode } from 'react'
import type { TextFont } from '@shared/types'

export function Section(props: { title: string; children: ReactNode }) {
  return (
    <div className="section">
      <h3>{props.title}</h3>
      {props.children}
    </div>
  )
}

export function Check(props: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.children}</span>
    </label>
  )
}

export function Slider(props: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="row">
        <label>{props.label}</label>
        <span className="val">{props.display}</span>
      </div>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </div>
  )
}

export const FONTS: { id: TextFont; label: string; family: string }[] = [
  { id: 'sans', label: 'Inter', family: 'Inter' },
  { id: 'rounded', label: 'Nunito Sans', family: 'Nunito Sans' },
  { id: 'caption', label: 'Barlow Semi Condensed', family: 'Barlow Semi Condensed' },
  { id: 'display', label: 'Anton', family: 'Anton' },
  { id: 'serif', label: 'Cinzel', family: 'Cinzel' },
  { id: 'editorial', label: 'Playfair Display', family: 'Playfair Display' },
  { id: 'type', label: 'Special Elite', family: 'Special Elite' },
  { id: 'hand', label: 'Caveat', family: 'Caveat' }
]
