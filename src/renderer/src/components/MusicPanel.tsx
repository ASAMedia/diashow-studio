// Music tab: the playlist (order, song sections, chapters), music levels and fades, video sound and ducking.
import { useState } from 'react'
import { GripVertical, Plus, Scissors, Trash2 } from 'lucide-react'
import type { TextEntry } from '@shared/types'
import { trackSpan } from '@shared/timeline'
import { useStore } from '../store'
import { timelineOf } from '../timeline'
import { fmtSeconds, fmtTime, t } from '../i18n'
import { friendly } from '../errors'
import { Check, Section, Slider } from './ui'
import { MusicTrim } from './MusicTrim'

export function MusicPanel() {
  const project = useStore((s) => s.project)!
  const update = useStore((s) => s.update)
  const setSettings = useStore((s) => s.setSettings)
  const a = project.settings.audio
  const setAudio = (patch: Partial<typeof a>): void => setSettings({ audio: { ...a, ...patch } })
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const [trimming, setTrimming] = useState<string | null>(null)
  const total = timelineOf(project).musicDuration
  // text slides can start a chapter with its own songs
  const chapters = project.entries.filter((e): e is TextEntry => e.type === 'text' && !e.excluded)
  const chapterOf = new Map(chapters.flatMap((c) => (c.music ?? []).map((id) => [id, c.id] as const)))
  const db = (g: number): string => (g <= 0 ? '−∞ dB' : `${(20 * Math.log10(g)).toFixed(0)} dB`)
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= project.music.length || from === to) return
    update((p) => {
      const [m] = p.music.splice(from, 1)
      p.music.splice(to, 0, m)
    })
  }

  return (
    <>
      <Section title={t('selectedMusic')}>
        {project.music.length === 0 && <p className="empty-note">{t('noMusic')}</p>}
        <div className="tracks">
          {project.music.map((tr, i) => (
            <div key={tr.id}>
              <div
                className={`track ${overIdx === i ? 'drag-over' : ''}`}
                draggable
                onDragStart={() => setDragIdx(i)}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOverIdx(i)
                }}
                onDragEnd={() => {
                  setDragIdx(null)
                  setOverIdx(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragIdx == null || dragIdx === i) return
                  move(dragIdx, i)
                  setDragIdx(null)
                  setOverIdx(null)
                }}
              >
                <button
                  className="n"
                  title={t('moveSong')}
                  aria-label={`${tr.title}: ${t('moveSong')}`}
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
                    e.preventDefault()
                    const to = i + (e.key === 'ArrowUp' ? -1 : 1)
                    move(i, to)
                    // the focus moves along with the song
                    requestAnimationFrame(() => document.querySelectorAll<HTMLElement>('.track button.n')[to]?.focus())
                  }}
                >
                  {tr.status === 'ready' ? i + 1 : <GripVertical size={12} />}
                </button>
                <span className="tt" title={tr.path}>
                  {tr.title}
                  {tr.artist && <span className="ar">{tr.artist}</span>}
                  {tr.status === 'error' && (
                    <span className="ar err" title={tr.error}>
                      {friendly(tr.error ?? '', 'music').text}
                    </span>
                  )}
                  {chapters.length > 0 && (
                    <select className="chapter-pick" title={t('playsIn')} aria-label={`${tr.title}: ${t('playsIn')}`} value={chapterOf.get(tr.id) ?? ''} onChange={(e) => useStore.getState().assignSong(tr.id, e.target.value || null)}>
                      <option value="">{t('wholeShow')}</option>
                      {chapters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {t('fromChapter').replace('{t}', c.title)}
                        </option>
                      ))}
                    </select>
                  )}
                </span>
                <span className="d">
                  {tr.status === 'ready' ? fmtTime(trackSpan(tr).length) : '…'}
                  {tr.bpm ? <span className="ar">{Math.round(tr.bpm)} BPM</span> : null}
                </span>
                <button
                  title={t('musicTrim')}
                  aria-label={`${t('musicTrim')}: ${tr.title}`}
                  aria-expanded={trimming === tr.id}
                  disabled={tr.status !== 'ready'}
                  className={trimming === tr.id || tr.trimIn != null || tr.trimOut != null ? 'on' : ''}
                  onClick={() => setTrimming(trimming === tr.id ? null : tr.id)}
                >
                  <Scissors size={14} />
                </button>
                <button title={t('removeSong')} aria-label={`${t('removeSong')}: ${tr.title}`} onClick={() => update((p) => (p.music = p.music.filter((m) => m.id !== tr.id)))}>
                  <Trash2 size={14} />
                </button>
              </div>
              {trimming === tr.id && <MusicTrim track={tr} />}
            </div>
          ))}
        </div>
        <div className="row">
          <button className="btn small" onClick={async () => useStore.getState().addMusic(await window.api.pickMusic())}>
            <Plus size={14} /> {t('addMusic')}
          </button>
          <span className="spacer" />
          {total > 0 && <span className="val" title={t('musicTotal')}>{fmtTime(total)}</span>}
        </div>
        {chapterOf.size > 0 && project.settings.timing.mode === 'fitToMusic' && <p className="hint">{t('chapterFit')}</p>}
      </Section>
      <Section title={t('music')}>
        <Slider label={t('musicVolume')} value={a.musicVolume} min={0} max={1} step={0.01} display={`${Math.round(a.musicVolume * 100)} %`} onChange={(v) => setAudio({ musicVolume: v })} />
        <Slider label={t('fadeIn')} value={a.fadeIn} min={0} max={6} step={0.5} display={fmtSeconds(a.fadeIn)} onChange={(v) => setAudio({ fadeIn: v })} />
        <Slider label={t('fadeOut')} value={a.fadeOut} min={0} max={10} step={0.5} display={fmtSeconds(a.fadeOut)} onChange={(v) => setAudio({ fadeOut: v })} />
        <Slider label={t('crossfade')} value={a.crossfade} min={0} max={8} step={0.5} display={fmtSeconds(a.crossfade)} onChange={(v) => setAudio({ crossfade: v })} />
        <Check checked={a.repeatMusic} onChange={(v) => setAudio({ repeatMusic: v })}>
          {t('repeatMusic')}
        </Check>
        <Check checked={a.normalize ?? true} onChange={(v) => setAudio({ normalize: v })}>
          {t('normalize')}
        </Check>
      </Section>
      <Section title={t('videoSound')}>
        <Check checked={a.videoSound} onChange={(v) => setAudio({ videoSound: v })}>
          {t('playVideoSound')}
        </Check>
        <Check checked={a.duck} onChange={(v) => setAudio({ duck: v })}>
          {t('duck')}
        </Check>
        {a.duck && a.videoSound && (
          <>
            <Slider label={t('duckLevel')} value={a.duckLevel} min={0} max={1} step={0.01} display={`${Math.round(a.duckLevel * 100)} % · ${db(a.duckLevel)}`} onChange={(v) => setAudio({ duckLevel: v })} />
            <Slider label={t('duckFade')} value={a.duckFade} min={0.1} max={3} step={0.1} display={fmtSeconds(a.duckFade)} onChange={(v) => setAudio({ duckFade: v })} />
          </>
        )}
      </Section>
    </>
  )
}
