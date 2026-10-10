// Themes tab: the theme gallery, colour look, show title and the text style of titles and captions.
import type { CSSProperties, ReactNode } from 'react'
import { mediaUrl } from '@shared/api'
import { LOOKS, THEMES } from '@shared/themes'
import type { LookId, TextFont, TextPosition, TextStyle, ThemeId, TitleStyle } from '@shared/types'
import { DEFAULT_TEXT_STYLE } from '@shared/types'
import { useStore } from '../store'
import { pick, t } from '../i18n'
import { Check, Field, FONTS, Section, Seg, Slider, TITLE_STYLES } from './ui'

export function ThemeThumb({ id, thumbs }: { id: ThemeId; thumbs: string[] }) {
  const img = (i: number, style: CSSProperties): ReactNode =>
    thumbs.length ? (
      <img src={mediaUrl(thumbs[i % thumbs.length])} style={{ position: 'absolute', objectFit: 'cover', ...style }} alt="" />
    ) : (
      <div style={{ position: 'absolute', background: ['#5b8fc9', '#6fbf9b', '#d99a6c'][i % 3], ...style }} />
    )
  const abs = (l: number, t: number, w: number, h: number): CSSProperties => ({ left: `${l}%`, top: `${t}%`, width: `${w}%`, height: `${h}%` })
  switch (id) {
    case 'kenburns':
      return <div className="thumb">{img(0, { ...abs(-10, -10, 120, 120) })}</div>
    case 'classic':
      return <div className="thumb" style={{ background: '#000' }}>{img(0, { ...abs(20, 0, 60, 100), objectFit: 'contain' })}</div>
    case 'origami':
      return (
        <div className="thumb" style={{ background: '#0d0d0e' }}>
          {img(0, abs(0, 0, 59, 100))}
          {img(1, abs(60, 0, 40, 49.5))}
          {img(2, abs(60, 50.5, 40, 49.5))}
        </div>
      )
    case 'reflections':
      return (
        <div className="thumb" style={{ background: 'radial-gradient(circle at 50% 45%, #fbfbfa, #e4e4e1 55%, #a9a9a5)', perspective: 300 }}>
          {img(0, { ...abs(14, 22, 34, 40), transform: 'rotateY(22deg)' })}
          {img(0, { ...abs(14, 63, 34, 40), transform: 'rotateY(22deg) scaleY(-1)', opacity: 0.25, maskImage: 'linear-gradient(transparent 55%, #000)' })}
          {img(1, { ...abs(53, 22, 34, 40), transform: 'rotateY(-22deg)' })}
          {img(1, { ...abs(53, 63, 34, 40), transform: 'rotateY(-22deg) scaleY(-1)', opacity: 0.25, maskImage: 'linear-gradient(transparent 55%, #000)' })}
        </div>
      )
    case 'panels':
      return (
        <div className="thumb" style={{ background: '#000' }}>
          {img(0, abs(0, 0, 32.6, 100))}
          {img(1, abs(33.6, 0, 32.8, 100))}
          {img(2, abs(67.4, 0, 32.6, 100))}
        </div>
      )
    case 'vintage':
      return (
        <div className="thumb" style={{ background: '#211d19' }}>
          {img(1, { ...abs(5, 10, 60, 80), filter: 'blur(3px) brightness(0.45)', transform: 'rotate(-9deg)' })}
          <div style={{ position: 'absolute', ...abs(26, 14, 50, 72), background: '#f2efe6', transform: 'rotate(4deg)', boxShadow: '0 4px 10px rgba(0,0,0,.6)' }}>
            {img(0, { ...abs(5, 6, 90, 88), filter: 'sepia(.35)' })}
          </div>
        </div>
      )
    case 'magazine':
      return (
        <div className="thumb" style={{ background: '#edf2ee' }}>
          {img(0, abs(3.5, 6, 57, 88))}
          {img(1, abs(63, 6, 33.5, 42.5))}
          {img(2, abs(63, 51.5, 33.5, 42.5))}
          <div style={{ position: 'absolute', right: '43%', bottom: '11%', fontFamily: "'Nunito Sans'", fontWeight: 800, fontSize: 9, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,.5)' }}>
            TITEL
          </div>
        </div>
      )
    case 'scrapbook':
      return (
        <div className="thumb" style={{ background: '#c4a173' }}>
          <div style={{ position: 'absolute', ...abs(8, 14, 44, 66), background: '#f7f5ee', transform: 'rotate(-4deg)', boxShadow: '0 3px 8px rgba(0,0,0,.35)' }}>{img(0, abs(6, 6, 88, 88))}</div>
          <div style={{ position: 'absolute', ...abs(52, 20, 40, 60), background: '#f7f5ee', transform: 'rotate(5deg)', boxShadow: '0 3px 8px rgba(0,0,0,.35)' }}>{img(1, abs(6, 6, 88, 88))}</div>
          <div style={{ position: 'absolute', left: '14%', top: '10%', width: '18%', height: '9%', background: 'rgba(240,230,195,.8)', transform: 'rotate(-20deg)' }} />
        </div>
      )
    case 'snapshots':
      return (
        <div className="thumb" style={{ background: 'linear-gradient(135deg,#4a2f1d,#2e1c11)' }}>
          <div style={{ position: 'absolute', ...abs(10, 30, 26, 48), background: '#f7f5ee', transform: 'rotate(-18deg)', opacity: 0.9 }}>{img(1, abs(7, 6, 86, 64))}</div>
          <div style={{ position: 'absolute', ...abs(34, 10, 34, 80), background: '#f7f5ee', transform: 'rotate(4deg)', boxShadow: '0 4px 10px rgba(0,0,0,.5)' }}>
            {img(0, abs(7, 5, 86, 64))}
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: '6%', textAlign: 'center', fontFamily: 'Caveat', fontSize: 10, color: '#333' }}>Sonntag</div>
          </div>
        </div>
      )
    case 'shatter':
      return (
        <div className="thumb" style={{ background: '#000' }}>
          {img(1, abs(0, 0, 100, 100))}
          <div style={{ position: 'absolute', inset: 0, clipPath: 'polygon(0 0, 55% 0, 40% 45%, 0 70%)' }}>{img(0, abs(0, 0, 100, 100))}</div>
          <div style={{ position: 'absolute', inset: 0, clipPath: 'polygon(62% 8%, 100% 0, 100% 40%, 70% 38%)', transform: 'translate(6px,-4px) rotate(8deg)' }}>{img(0, abs(0, 0, 100, 100))}</div>
          <div style={{ position: 'absolute', inset: 0, clipPath: 'polygon(30% 75%, 55% 60%, 60% 100%, 25% 100%)', transform: 'translate(-3px,6px) rotate(-10deg)' }}>{img(0, abs(0, 0, 100, 100))}</div>
        </div>
      )
    case 'retro':
      return (
        <div className="thumb" style={{ background: '#000' }}>
          {img(0, { ...abs(0, 0, 100, 100), filter: 'sepia(.55) contrast(.9) brightness(.95)' })}
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle, transparent 45%, rgba(0,0,0,.65))' }} />
        </div>
      )
  }
}

export function ThemesPanel() {
  const project = useStore((s) => s.project)!
  const setTheme = useStore((s) => s.setTheme)
  const setSettings = useStore((s) => s.setSettings)
  const st = project.settings
  const thumbs = project.media.filter((m) => m.kind === 'photo' && m.thumb).slice(0, 3).map((m) => m.thumb!)
  return (
    <>
      <Section title={t('themes')}>
        <div className="themes" role="group" aria-label={t('themes')}>
          {THEMES.map((th) => (
            <button key={th.id} className={`theme-card ${st.theme === th.id ? 'on' : ''}`} aria-pressed={st.theme === th.id} title={pick(th.description)} onClick={() => setTheme(th.id)}>
              <ThemeThumb id={th.id} thumbs={thumbs} />
              <span>{pick(th.name)}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section title={t('look')}>
        <select style={{ width: '100%' }} aria-label={t('look')} value={st.look} onChange={(e) => setSettings({ look: e.target.value as LookId })}>
          {LOOKS.map((l) => (
            <option key={l.id} value={l.id}>
              {pick(l.name)}
            </option>
          ))}
        </select>
      </Section>
      <Section title={t('title')}>
        <Check checked={st.showTitle} onChange={(v) => setSettings({ showTitle: v })}>
          {t('showTitle')}
        </Check>
        {st.showTitle && (
          <div className="stack" style={{ marginTop: 6 }}>
            <input type="text" aria-label={t('titleText')} placeholder={project.name} value={st.titleText ?? ''} onChange={(e) => setSettings({ titleText: e.target.value || undefined })} />
            <input type="text" aria-label={t('subtitleText')} placeholder={t('subtitleText')} value={st.subtitleText ?? ''} onChange={(e) => setSettings({ subtitleText: e.target.value || undefined })} />
          </div>
        )}
      </Section>
      <TextStyleSection />
    </>
  )
}

const COLORS: Record<string, string> = { theme: '', white: '#ffffff', black: '#1c1c1c', custom: '#ffd75e' }

function TextStyleSection() {
  const project = useStore((s) => s.project)!
  const setSettings = useStore((s) => s.setSettings)
  const ts = { ...DEFAULT_TEXT_STYLE, ...project.settings.text }
  const set = (patch: Partial<TextStyle>): void => setSettings({ text: { ...ts, ...patch } })
  const colorMode = ts.color === '' ? 'theme' : ts.color === '#ffffff' ? 'white' : ts.color === '#1c1c1c' ? 'black' : 'custom'
  return (
    <Section title={t('textStyle')}>
      <div className="stack">
        <Field label={t('titleStyle')}>
          <select value={project.settings.titleStyle ?? 'theme'} onChange={(e) => setSettings({ titleStyle: e.target.value as TitleStyle })}>
            {TITLE_STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {t(s.label)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('font')}>
          <select value={ts.font} onChange={(e) => set({ font: e.target.value as TextFont })}>
            <option value="theme">{t('themeDefault')}</option>
            {FONTS.map((f) => (
              <option key={f.id} value={f.id} style={{ fontFamily: f.family }}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
        <Slider label={t('textSize')} value={ts.scale} min={0.6} max={1.8} step={0.05} display={`${Math.round(ts.scale * 100)} %`} onChange={(v) => set({ scale: v })} />
        <Field
          label={t('textColor')}
          extra={colorMode === 'custom' && <input type="color" className="color-pick" aria-label={t('customColor')} value={ts.color} onChange={(e) => set({ color: e.target.value })} />}
        >
          <select value={colorMode} onChange={(e) => set({ color: COLORS[e.target.value] ?? '' })}>
            <option value="theme">{t('themeDefault')}</option>
            <option value="white">{t('white')}</option>
            <option value="black">{t('black')}</option>
            <option value="custom">{t('customColor')}</option>
          </select>
        </Field>
        <Field label={t('textPosition')}>
          <select value={ts.position} onChange={(e) => set({ position: e.target.value as TextPosition })}>
            <option value="theme">{t('themeDefault')}</option>
            <option value="bottom-left">{t('posBL')}</option>
            <option value="bottom-center">{t('posBC')}</option>
            <option value="bottom-right">{t('posBR')}</option>
            <option value="top-left">{t('posTL')}</option>
            <option value="center">{t('posC')}</option>
          </select>
        </Field>
        <div className="row stacked">
          <span className="label">{t('uppercase')}</span>
          <Seg
            label={t('uppercase')}
            value={ts.uppercase}
            options={[
              { id: 'theme', label: t('themeDefault') },
              { id: 'on', label: t('on') },
              { id: 'off', label: t('off') }
            ]}
            onChange={(v) => set({ uppercase: v })}
          />
        </div>
      </div>
    </Section>
  )
}
