// Timing tab: show length, beat sync, the theme's transition and video options, aspect ratio.
import type { ReactNode } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react'
import { TRANSITIONS, themeMeta } from '@shared/themes'
import type { AspectRatio, Direction, TransitionId } from '@shared/types'
import { MAX_PHOTO_SECONDS } from '@shared/timeline'
import { useStore } from '../store'
import { timelineOf } from '../timeline'
import { fmtSeconds, fmtTime, pick, t, type StringKey } from '../i18n'
import { Check, Field, Section, Seg, Slider } from './ui'

const DIRS: { id: Direction; icon: ReactNode; label: StringKey }[] = [
  { id: 'left', icon: <ArrowLeft size={14} />, label: 'dirLeft' },
  { id: 'right', icon: <ArrowRight size={14} />, label: 'dirRight' },
  { id: 'up', icon: <ArrowUp size={14} />, label: 'dirUp' },
  { id: 'down', icon: <ArrowDown size={14} />, label: 'dirDown' }
]

export function TimingPanel() {
  const project = useStore((s) => s.project)!
  const setSettings = useStore((s) => s.setSettings)
  const st = project.settings
  const meta = themeMeta(st.theme)
  const tl = timelineOf(project)
  const hasMusic = tl.musicDuration > 0
  const tr = TRANSITIONS.find((x) => x.id === st.transition.type)
  return (
    <>
      <Section title={t('duration')}>
        <div role="radiogroup" aria-label={t('duration')}>
          <label className="check">
            <input type="radio" name="timing-mode" checked={st.timing.mode === 'fitToMusic'} onChange={() => setSettings({ timing: { ...st.timing, mode: 'fitToMusic' } })} />
            <span>{t('fitToMusic')}</span>
          </label>
          <p className="hint" style={{ marginLeft: 22, marginTop: 0 }}>
            {hasMusic ? t('fitToMusicHint') : tl.themeSong ? t('fitToMusicTheme') : t('fitToMusicNoMusic')}
          </p>
          <label className="check">
            <input type="radio" name="timing-mode" checked={st.timing.mode === 'custom'} onChange={() => setSettings({ timing: { mode: 'custom', customTotal: Math.round(tl.duration) || st.timing.customTotal } })} />
            <span>{t('custom')}</span>
            <span className="val" style={{ marginLeft: 'auto' }}>
              {fmtTime(st.timing.mode === 'custom' ? st.timing.customTotal : tl.duration)}
            </span>
          </label>
        </div>
        {st.timing.mode === 'custom' && (
          <input
            type="range"
            aria-label={t('custom')}
            aria-valuetext={fmtTime(st.timing.customTotal)}
            min={5}
            max={1800}
            step={1}
            value={st.timing.customTotal}
            onChange={(e) => setSettings({ timing: { mode: 'custom', customTotal: Number(e.target.value) } })}
          />
        )}
        <p className="hint">
          ≈ {fmtSeconds(tl.photoSeconds)} {t('perPhoto')}
          {tl.photoSeconds >= MAX_PHOTO_SECONDS ? ' (max.)' : ''}
        </p>
        <Check checked={!!st.timing.beatSync} onChange={(v) => setSettings({ timing: { ...st.timing, beatSync: v } })}>
          {t('beatSync')}
        </Check>
        {st.timing.beatSync && !tl.music.some((m) => m.beats?.length) && <p className="hint">{t('beatSyncHint')}</p>}
      </Section>
      <Section title={t('themeOptions')}>
        {meta.freeTransition ? (
          <div className="stack">
            <Field label={t('transition')}>
              <select value={st.transition.type} onChange={(e) => setSettings({ transition: { ...st.transition, type: e.target.value as TransitionId } })}>
                {TRANSITIONS.map((x) => (
                  <option key={x.id} value={x.id}>
                    {pick(x.name)}
                  </option>
                ))}
              </select>
            </Field>
            <Slider label={t('speed')} value={st.transition.speed} min={0} max={1} step={0.05} display={fmtSeconds(2.2 - 1.9 * st.transition.speed)} onChange={(v) => setSettings({ transition: { ...st.transition, speed: v } })} />
            {tr?.directional && (
              <div className="row">
                <span className="label">{t('direction')}</span>
                <Seg
                  label={t('direction')}
                  value={st.transition.direction}
                  options={DIRS.map((d) => ({ id: d.id, label: d.icon, title: t(d.label) }))}
                  onChange={(v) => setSettings({ transition: { ...st.transition, direction: v } })}
                />
              </div>
            )}
          </div>
        ) : (
          <p className="hint">{pick(meta.description)}</p>
        )}
        {meta.scaleOption && (
          <Check checked={st.scaleToFill} onChange={(v) => setSettings({ scaleToFill: v })}>
            {t('scaleToFill')}
          </Check>
        )}
        <Check checked={st.playFullVideos} onChange={(v) => setSettings({ playFullVideos: v })}>
          {t('playFullVideos')}
        </Check>
        <Field label={t('maxVideo')}>
          <select value={st.maxVideoSeconds ?? 0} onChange={(e) => setSettings({ maxVideoSeconds: Number(e.target.value) || undefined })}>
            <option value={0}>{t('maxVideoOff')}</option>
            {[5, 10, 15, 20, 30, 60].map((n) => (
              <option key={n} value={n}>
                {n} s
              </option>
            ))}
          </select>
        </Field>
        <Check checked={st.playLivePhotos} onChange={(v) => setSettings({ playLivePhotos: v })}>
          {t('playLivePhotos')}
        </Check>
      </Section>
      <Section title={t('aspect')}>
        <Seg label={t('aspect')} value={st.aspect} options={(['16:9', '4:3', '1:1', '9:16'] as AspectRatio[]).map((a) => ({ id: a, label: a }))} onChange={(a) => setSettings({ aspect: a })} />
      </Section>
    </>
  )
}
