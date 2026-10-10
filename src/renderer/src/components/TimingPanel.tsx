// Timing tab: show length, beat sync, the theme's transition and video options, aspect ratio.
import type { ReactNode } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react'
import { TRANSITIONS, themeMeta } from '@shared/themes'
import type { AspectRatio, Direction, TransitionId } from '@shared/types'
import { MAX_PHOTO_SECONDS } from '@shared/timeline'
import { useStore } from '../store'
import { timelineOf } from '../timeline'
import { fmtSeconds, fmtTime, pick, t } from '../i18n'
import { Check, Section, Slider } from './ui'

const DIRS: { id: Direction; icon: ReactNode }[] = [
  { id: 'left', icon: <ArrowLeft size={13} /> },
  { id: 'right', icon: <ArrowRight size={13} /> },
  { id: 'up', icon: <ArrowUp size={13} /> },
  { id: 'down', icon: <ArrowDown size={13} /> }
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
        <label className="check">
          <input type="radio" checked={st.timing.mode === 'fitToMusic'} onChange={() => setSettings({ timing: { ...st.timing, mode: 'fitToMusic' } })} />
          <span>{t('fitToMusic')}</span>
        </label>
        <p className="hint" style={{ marginLeft: 22, marginTop: 0 }}>
          {hasMusic ? t('fitToMusicHint') : t('noMusic')}
        </p>
        <label className="check">
          <input type="radio" checked={st.timing.mode === 'custom'} onChange={() => setSettings({ timing: { mode: 'custom', customTotal: Math.round(tl.duration) || st.timing.customTotal } })} />
          <span>{t('custom')}</span>
          <span className="val" style={{ marginLeft: 'auto' }}>{fmtTime(st.timing.mode === 'custom' ? st.timing.customTotal : tl.duration)}</span>
        </label>
        {st.timing.mode === 'custom' && (
          <input type="range" min={5} max={1800} step={1} value={st.timing.customTotal} onChange={(e) => setSettings({ timing: { mode: 'custom', customTotal: Number(e.target.value) } })} />
        )}
        <p className="hint">
          ≈ {fmtSeconds(tl.photoSeconds)} {t('perPhoto')}
          {tl.photoSeconds >= MAX_PHOTO_SECONDS ? ' (max.)' : ''}
        </p>
        <Check checked={!!st.timing.beatSync} onChange={(v) => setSettings({ timing: { ...st.timing, beatSync: v } })}>
          {t('beatSync')}
        </Check>
        {st.timing.beatSync && !project.music.some((m) => m.beats?.length) && <p className="hint">{t('beatSyncHint')}</p>}
      </Section>
      <Section title={t('themeOptions')}>
        {meta.freeTransition ? (
          <div className="stack">
            <div className="row">
              <label>{t('transition')}</label>
              <select value={st.transition.type} onChange={(e) => setSettings({ transition: { ...st.transition, type: e.target.value as TransitionId } })}>
                {TRANSITIONS.map((x) => (
                  <option key={x.id} value={x.id}>
                    {pick(x.name)}
                  </option>
                ))}
              </select>
            </div>
            <Slider label={t('speed')} value={st.transition.speed} min={0} max={1} step={0.05} display={fmtSeconds(2.2 - 1.9 * st.transition.speed)} onChange={(v) => setSettings({ transition: { ...st.transition, speed: v } })} />
            {tr?.directional && (
              <div className="row">
                <label>{t('direction')}</label>
                <div className="seg">
                  {DIRS.map((d) => (
                    <button key={d.id} className={st.transition.direction === d.id ? 'on' : ''} onClick={() => setSettings({ transition: { ...st.transition, direction: d.id } })}>
                      {d.icon}
                    </button>
                  ))}
                </div>
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
        <div className="row">
          <label>{t('maxVideo')}</label>
          <select value={st.maxVideoSeconds ?? 0} onChange={(e) => setSettings({ maxVideoSeconds: Number(e.target.value) || undefined })}>
            <option value={0}>{t('maxVideoOff')}</option>
            {[5, 10, 15, 20, 30, 60].map((n) => (
              <option key={n} value={n}>
                {n} s
              </option>
            ))}
          </select>
        </div>
        <Check checked={st.playLivePhotos} onChange={(v) => setSettings({ playLivePhotos: v })}>
          {t('playLivePhotos')}
        </Check>
      </Section>
      <Section title={t('aspect')}>
        <div className="seg">
          {(['16:9', '4:3', '1:1', '9:16'] as AspectRatio[]).map((a) => (
            <button key={a} className={st.aspect === a ? 'on' : ''} onClick={() => setSettings({ aspect: a })}>
              {a}
            </button>
          ))}
        </div>
      </Section>
    </>
  )
}
