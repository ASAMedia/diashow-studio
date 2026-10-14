// Slide tab: the free text boxes of a slide (drag them in the preview, double-click to type) and the
// editor of the selected one: text, font, size, colour, bold, what is behind it, rotation.
import { Plus, Trash2 } from 'lucide-react'
import type { FreeText } from '@shared/types'
import type { TimelineSlide } from '@shared/timeline'
import { useStore } from '../store'
import { t, type StringKey } from '../i18n'
import { firstInShow, showOrder } from '../entryEdits'
import { Check, Field, FONTS, Section, Slider } from './ui'

const BOXES: FreeText['box'][] = ['none', 'shadow', 'band', 'card', 'bubble']
/** Text colours offered as swatches (the colour picker next to them takes any other). */
const SWATCHES: [string, StringKey][] = [
  ['#ffffff', 'white'],
  ['#1c1c1c', 'black'],
  ['#ffd75e', 'colorYellow'],
  ['#ff5a4f', 'colorRed'],
  ['#4d9fff', 'colorBlue']
]
const boxLabel = (b: FreeText['box']): string =>
  ({ none: t('boxNone'), shadow: t('boxShadow'), band: t('boxBand'), card: t('boxCard'), bubble: t('boxBubble') })[b]

export function FreeTextSection({ slide }: { slide: TimelineSlide }) {
  const project = useStore((s) => s.project)!
  const textSel = useStore((s) => s.textSel)
  const set = useStore((s) => s.set)
  // new boxes belong to the slide's first entry in show order (like its duration and layout)
  const owner = firstInShow(slide.entries, showOrder(project))
  if (!owner) return null
  const texts = slide.entries.flatMap((e) => (e.texts ?? []).map((ft) => ({ entryId: e.id, ft })))
  const current = texts.find((x) => x.ft.id === textSel)
  return (
    <Section title={t('freeTexts')}>
      <div className="stack">
        {texts.length > 0 && (
          <div className="text-chips">
            {texts.map(({ entryId, ft }) => {
              const label = ft.text.split('\n')[0] || '…'
              return (
                <div key={ft.id} className="text-chip">
                  <button className={`btn small ${ft.id === textSel ? 'on' : ''}`} aria-pressed={ft.id === textSel} title={label} onClick={() => set({ textSel: ft.id === textSel ? null : ft.id })}>
                    <span>{label}</span>
                  </button>
                  <button className="btn small ghost icon" title={t('deleteTextBox')} aria-label={`${t('deleteTextBox')}: ${label}`} onClick={() => useStore.getState().removeFreeText(entryId, ft.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        <button className="btn small" onClick={() => useStore.getState().addFreeText(owner.id)}>
          <Plus size={14} /> {t('addFreeText')}
        </button>
        {current && <FreeTextEditor entryId={current.entryId} ft={current.ft} />}
        {texts.length > 0 && <p className="hint">{t('freeTextHint')}</p>}
      </div>
    </Section>
  )
}

function FreeTextEditor({ entryId, ft }: { entryId: string; ft: FreeText }) {
  const setText = (patch: Partial<FreeText>): void => useStore.getState().setFreeText(entryId, ft.id, patch)
  return (
    <div className="stack text-editor">
      <textarea rows={2} aria-label={t('freeTextContent')} value={ft.text} onChange={(e) => setText({ text: e.target.value })} style={{ width: '100%', resize: 'vertical' }} />
      <Field label={t('font')}>
        <select value={ft.font} onChange={(e) => setText({ font: e.target.value as FreeText['font'] })}>
          <option value="theme">Inter</option>
          {FONTS.filter((f) => f.id !== 'sans').map((f) => (
            <option key={f.id} value={f.id} style={{ fontFamily: f.family }}>
              {f.label}
            </option>
          ))}
        </select>
      </Field>
      <Slider label={t('textSize')} value={ft.size} min={0.03} max={0.22} step={0.005} display={`${Math.round(ft.size * 1000) / 10} %`} onChange={(v) => setText({ size: v })} />
      <div className="row">
        <span className="label">{t('textColor')}</span>
        <div className="swatches" role="group" aria-label={t('textColor')}>
          {SWATCHES.map(([c, name]) => (
            <button key={c} className={ft.color.toLowerCase() === c ? 'on' : ''} style={{ background: c }} onClick={() => setText({ color: c })} title={t(name)} aria-label={t(name)} aria-pressed={ft.color.toLowerCase() === c} />
          ))}
          <input type="color" title={t('customColor')} aria-label={t('customColor')} value={ft.color} onChange={(e) => setText({ color: e.target.value })} />
        </div>
      </div>
      <Check checked={ft.bold} onChange={(v) => setText({ bold: v })}>
        {t('bold')}
      </Check>
      <Field label={t('textBox')}>
        <select value={ft.box} onChange={(e) => setText({ box: e.target.value as FreeText['box'] })}>
          {BOXES.map((b) => (
            <option key={b} value={b}>
              {boxLabel(b)}
            </option>
          ))}
        </select>
      </Field>
      <Slider label={t('rotation')} value={ft.rotation} min={-45} max={45} step={1} display={`${ft.rotation}°`} onChange={(v) => setText({ rotation: v })} />
    </div>
  )
}
