// Small building blocks shared by the inspector panels and dialogs.
import { cloneElement, useId, type ReactElement, type ReactNode } from 'react'
import type { TextFont, TitleStyle } from '@shared/types'
import type { StringKey } from '../i18n'

export function Section(props: { title: string; children: ReactNode; className?: string }) {
  const id = useId()
  return (
    <section className={`section ${props.className ?? ''}`} aria-labelledby={id}>
      <h3 id={id}>{props.title}</h3>
      {props.children}
    </section>
  )
}

export function Check(props: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean; className?: string; testId?: string }) {
  return (
    <label className={`check ${props.className ?? ''}`}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} data-testid={props.testId} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.children}</span>
    </label>
  )
}

/** A label and one control (select, input) in a row; the label is tied to the control. */
export function Field(props: { label: ReactNode; children: ReactElement<{ id?: string }>; extra?: ReactNode; className?: string }) {
  const id = useId()
  return (
    <div className={`row ${props.className ?? ''}`}>
      <label htmlFor={id}>{props.label}</label>
      {cloneElement(props.children, { id })}
      {props.extra}
    </div>
  )
}

export function Slider(props: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void }) {
  const id = useId()
  return (
    <div className="slider">
      <div className="row">
        <label htmlFor={id}>{props.label}</label>
        <span className="val" aria-hidden>
          {props.display}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        aria-valuetext={props.display}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  )
}

/** Segmented buttons for one choice (aria-pressed on the chosen one). */
export function Seg<T extends string | number>(props: { label: string; value: T; options: { id: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={`seg ${props.className ?? ''}`} role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={String(o.id)}
          type="button"
          className={props.value === o.id ? 'on' : ''}
          aria-pressed={props.value === o.id}
          title={o.title}
          aria-label={o.title}
          onClick={() => props.onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
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

export const TITLE_STYLES: { id: TitleStyle; label: StringKey }[] = [
  { id: 'theme', label: 'styleTheme' },
  { id: 'handwriting', label: 'styleHandwriting' },
  { id: 'typewriter', label: 'styleTypewriter' },
  { id: 'bigDate', label: 'styleBigDate' }
]
