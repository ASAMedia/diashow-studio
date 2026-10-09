import { useState, type CSSProperties, type ReactNode } from 'react'
import { Clock, LayoutTemplate, Music, Plus, SlidersHorizontal, Trash2, GripVertical, ArrowLeft, ArrowRight, ArrowUp, ArrowDown } from 'lucide-react'
import { mediaUrl } from '@shared/api'
import { LOOKS, THEMES, TRANSITIONS, themeMeta } from '@shared/themes'
import type { AspectRatio, Direction, Entry, LookId, MediaItem, PhotoEntry, TextEntry, ThemeId, TransitionId, VideoEntry } from '@shared/types'
import { MAX_PHOTO_SECONDS, type TimelineSlide } from '@shared/timeline'
import { templatesFor, type Template } from '@shared/layout'
import { useStore, type InspectorTab } from '../store'
import { timelineOf } from '../timeline'
import { fmtSeconds, fmtTime, localeTag, pick, t } from '../i18n'

export function Inspector() {
  const tab = useStore((s) => s.tab)
  const set = useStore((s) => s.set)
  const tabs: { id: InspectorTab; icon: ReactNode; label: string }[] = [
    { id: 'themes', icon: <LayoutTemplate size={19} />, label: t('themes') },
    { id: 'music', icon: <Music size={19} />, label: t('music') },
    { id: 'timing', icon: <Clock size={19} />, label: t('timing') },
    { id: 'slide', icon: <SlidersHorizontal size={19} />, label: t('slide') }
  ]
  return (
    <>
      <div className="inspector">
        {tab === 'themes' && <ThemesPanel />}
        {tab === 'music' && <MusicPanel />}
        {tab === 'timing' && <TimingPanel />}
        {tab === 'slide' && <SlidePanel />}
      </div>
      <div className="rail">
        {tabs.map((x) => (
          <button key={x.id} className={tab === x.id ? 'on' : ''} title={x.label} aria-label={x.label} onClick={() => set({ tab: x.id })}>
            {x.icon}
          </button>
        ))}
      </div>
    </>
  )
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <div className="section">
      <h3>{props.title}</h3>
      {props.children}
    </div>
  )
}

function Check(props: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.children}</span>
    </label>
  )
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void }) {
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

// ---------------------------------------------------------------- Themes

function ThemeThumb({ id, thumbs }: { id: ThemeId; thumbs: string[] }) {
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
    case 'retro':
      return (
        <div className="thumb" style={{ background: '#000' }}>
          {img(0, { ...abs(0, 0, 100, 100), filter: 'sepia(.55) contrast(.9) brightness(.95)' })}
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle, transparent 45%, rgba(0,0,0,.65))' }} />
        </div>
      )
  }
}

function ThemesPanel() {
  const project = useStore((s) => s.project)!
  const setTheme = useStore((s) => s.setTheme)
  const setSettings = useStore((s) => s.setSettings)
  const st = project.settings
  const thumbs = project.media.filter((m) => m.kind === 'photo' && m.thumb).slice(0, 3).map((m) => m.thumb!)
  return (
    <>
      <Section title={t('themes')}>
        <div className="themes">
          {THEMES.map((th) => (
            <button key={th.id} className={`theme-card ${st.theme === th.id ? 'on' : ''}`} title={pick(th.description)} onClick={() => setTheme(th.id)}>
              <ThemeThumb id={th.id} thumbs={thumbs} />
              <span>{pick(th.name)}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section title={t('look')}>
        <select style={{ width: '100%' }} value={st.look} onChange={(e) => setSettings({ look: e.target.value as LookId })}>
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
            <input type="text" placeholder={project.name} value={st.titleText ?? ''} onChange={(e) => setSettings({ titleText: e.target.value || undefined })} />
            <input type="text" placeholder={t('subtitleText')} value={st.subtitleText ?? ''} onChange={(e) => setSettings({ subtitleText: e.target.value || undefined })} />
          </div>
        )}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Music

function MusicPanel() {
  const project = useStore((s) => s.project)!
  const update = useStore((s) => s.update)
  const setSettings = useStore((s) => s.setSettings)
  const a = project.settings.audio
  const setAudio = (patch: Partial<typeof a>): void => setSettings({ audio: { ...a, ...patch } })
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const total = timelineOf(project).musicDuration
  const db = (g: number): string => (g <= 0 ? '−∞ dB' : `${(20 * Math.log10(g)).toFixed(0)} dB`)

  return (
    <>
      <Section title={t('selectedMusic')}>
        {project.music.length === 0 && <p className="hint">{t('noMusic')}</p>}
        <div className="tracks">
          {project.music.map((tr, i) => (
            <div
              key={tr.id}
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
                update((p) => {
                  const [m] = p.music.splice(dragIdx, 1)
                  p.music.splice(i, 0, m)
                })
                setDragIdx(null)
                setOverIdx(null)
              }}
            >
              <span className="n">{tr.status === 'ready' ? i + 1 : <GripVertical size={12} />}</span>
              <span className="tt" title={tr.path}>
                {tr.title}
                {tr.artist && <span className="ar">{tr.artist}</span>}
                {tr.status === 'error' && <span className="ar" style={{ color: 'var(--danger)' }}>{tr.error}</span>}
              </span>
              <span className="d">{tr.status === 'ready' ? fmtTime(tr.duration) : '…'}</span>
              <button title={t('delete')} onClick={() => update((p) => (p.music = p.music.filter((m) => m.id !== tr.id)))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="row">
          <button className="btn small" onClick={async () => useStore.getState().addMusic(await window.api.pickMusic())}>
            <Plus size={13} /> {t('addMusic')}
          </button>
          {total > 0 && <span className="val">{fmtTime(total)}</span>}
        </div>
      </Section>
      <Section title={t('music')}>
        <Slider label={t('musicVolume')} value={a.musicVolume} min={0} max={1} step={0.01} display={`${Math.round(a.musicVolume * 100)} %`} onChange={(v) => setAudio({ musicVolume: v })} />
        <Slider label={t('fadeIn')} value={a.fadeIn} min={0} max={6} step={0.5} display={fmtSeconds(a.fadeIn)} onChange={(v) => setAudio({ fadeIn: v })} />
        <Slider label={t('fadeOut')} value={a.fadeOut} min={0} max={10} step={0.5} display={fmtSeconds(a.fadeOut)} onChange={(v) => setAudio({ fadeOut: v })} />
        <Slider label={t('crossfade')} value={a.crossfade} min={0} max={8} step={0.5} display={fmtSeconds(a.crossfade)} onChange={(v) => setAudio({ crossfade: v })} />
        <Check checked={a.repeatMusic} onChange={(v) => setAudio({ repeatMusic: v })}>
          {t('repeatMusic')}
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

// ---------------------------------------------------------------- Timing

const DIRS: { id: Direction; icon: ReactNode }[] = [
  { id: 'left', icon: <ArrowLeft size={13} /> },
  { id: 'right', icon: <ArrowRight size={13} /> },
  { id: 'up', icon: <ArrowUp size={13} /> },
  { id: 'down', icon: <ArrowDown size={13} /> }
]

function TimingPanel() {
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

// ---------------------------------------------------------------- Slide

function MediaInfo({ m }: { m: MediaItem }) {
  return (
    <>
      {m.thumb && <img className="preview-thumb" src={mediaUrl(m.thumb)} alt="" />}
      <dl className="info">
        <dt>{t('file')}</dt>
        <dd title={m.path}>{m.name}</dd>
        <dt>{t('format')}</dt>
        <dd>{m.format}</dd>
        {m.device && (
          <>
            <dt>{t('device')}</dt>
            <dd>{m.device}</dd>
          </>
        )}
        <dt>{t('size')}</dt>
        <dd>
          {m.width} × {m.height}
          {m.duration ? ` · ${fmtTime(m.duration)}` : ''}
          {m.fps ? ` · ${Math.round(m.fps)} fps` : ''}
        </dd>
        <dt>{t('date')}</dt>
        <dd>{new Date(m.captureTime).toLocaleString(localeTag(), { dateStyle: 'medium', timeStyle: 'short' })}</dd>
      </dl>
      {m.proxied && <p className="hint">{t('proxyNote')}</p>}
      {m.status === 'error' && <p className="error">{m.error === 'missing' ? t('missing') : m.error}</p>}
    </>
  )
}

function DurationOverride({ entry }: { entry: Entry }) {
  const setEntry = useStore((s) => s.setEntry)
  return (
    <div className="row">
      <Check checked={entry.duration != null} onChange={(v) => setEntry(entry.id, { duration: v ? 4 : undefined })}>
        {t('customDuration')}
      </Check>
      {entry.duration != null && (
        <input type="number" min={0.5} max={120} step={0.5} style={{ width: 70 }} value={entry.duration} onChange={(e) => setEntry(entry.id, { duration: Math.max(0.5, Number(e.target.value) || 0.5) })} />
      )}
    </div>
  )
}

function LayoutPicker({ slide }: { slide: TimelineSlide }) {
  const project = useStore((s) => s.project)!
  const setEntry = useStore((s) => s.setEntry)
  const options = templatesFor(project.settings.theme, slide.entries.length)
  // the override lives on the slide's first entry in filmstrip order
  const order = new Map(project.entries.map((e, i) => [e.id, i]))
  const first = [...slide.entries].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))[0]
  if (options.length < 2 || !first) return null
  const mini = (tpl: Template) => (
    <svg viewBox="0 0 160 90">
      {tpl.slots.map((r, i) => (
        <rect key={i} x={r.x * 156 + 3} y={r.y * 86 + 3} width={Math.max(1, r.w * 156 - 3)} height={Math.max(1, r.h * 86 - 3)} rx={2} fill="currentColor" opacity={0.55} />
      ))}
    </svg>
  )
  return (
    <Section title={t('layout')}>
      <div className="layouts">
        <button className={!first.layout ? 'on' : ''} onClick={() => setEntry(first.id, { layout: undefined })}>
          {t('layoutAuto')}
        </button>
        {options.map((tpl) => (
          <button key={tpl.id} className={first.layout === tpl.id ? 'on' : ''} title={tpl.id} onClick={() => setEntry(first.id, { layout: tpl.id })}>
            {mini(tpl)}
          </button>
        ))}
      </div>
    </Section>
  )
}

function CaptionField({ entry }: { entry: Entry }) {
  const setEntry = useStore((s) => s.setEntry)
  return (
    <Section title={t('caption')}>
      <textarea
        rows={2}
        style={{ width: '100%', resize: 'vertical' }}
        placeholder={t('captionPlaceholder')}
        value={entry.caption ?? ''}
        onChange={(e) => setEntry(entry.id, { caption: e.target.value || undefined })}
      />
    </Section>
  )
}

function CropSection({ slide }: { slide: TimelineSlide }) {
  const project = useStore((s) => s.project)!
  const update = useStore((s) => s.update)
  if (!themeMeta(project.settings.theme).cropEdit || slide.kind !== 'photos') return null
  const ids = new Set(slide.entries.map((e) => e.id))
  return (
    <div className="section">
      <p className="hint" style={{ marginTop: 0 }}>
        {t('cropHint')}
      </p>
      <button className="btn small" onClick={() => update((p) => p.entries.forEach((e) => ids.has(e.id) && e.type === 'photo' && delete e.crop))}>
        {t('cropReset')}
      </button>
    </div>
  )
}

function SlidePanel() {
  const project = useStore((s) => s.project)!
  const selection = useStore((s) => s.selection)
  const setEntry = useStore((s) => s.setEntry)
  const kbEdit = useStore((s) => s.kbEdit)
  const set = useStore((s) => s.set)
  const entries = selection.map((id) => project.entries.find((e) => e.id === id)).filter(Boolean) as Entry[]
  if (!entries.length) return <p className="hint">{t('noSelection')}</p>
  const media = (e: Entry): MediaItem | undefined => (e.type === 'text' ? undefined : project.media.find((m) => m.id === e.mediaId))
  const meta = themeMeta(project.settings.theme)

  const slide = timelineOf(project).slides.find((sl) => sl.entries.some((x) => x.id === entries[0].id))

  if (entries.length > 1) {
    const order = new Map(project.entries.map((x, i) => [x.id, i]))
    const first = [...entries].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))[0]
    const split = (): void =>
      useStore.getState().update((p) =>
        entries.forEach((x) => {
          const e = p.entries.find((y) => y.id === x.id)
          if (e && x.id !== first.id) e.groupBreak = 'force'
        })
      )
    return (
      <>
        <Section title={`${entries.length} ${t('photos')}`}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
            {entries.map((e) => {
              const m = media(e)
              return m?.thumb ? <img key={e.id} src={mediaUrl(m.thumb)} style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', borderRadius: 4 }} alt="" /> : null
            })}
          </div>
          <button className="btn small" onClick={split}>
            {t('split')}
          </button>
        </Section>
        {slide && <LayoutPicker slide={slide} />}
        {slide && <CropSection slide={slide} />}
        <CaptionField entry={first} />
      </>
    )
  }

  const e = entries[0]
  if (e.type === 'text') {
    const te = e as TextEntry
    return (
      <Section title={t('textSlide')}>
        <div className="stack">
          <input type="text" value={te.title} onChange={(ev) => setEntry(te.id, { title: ev.target.value })} />
          <input type="text" placeholder={t('subtitleText')} value={te.subtitle ?? ''} onChange={(ev) => setEntry(te.id, { subtitle: ev.target.value || undefined })} />
          <DurationOverride entry={te} />
          {themeMeta(project.settings.theme).textAsCaption && <p className="hint">{t('captionOnNext')}</p>}
        </div>
      </Section>
    )
  }

  const m = media(e)
  if (!m) return null
  if (e.type === 'video') {
    const ve = e as VideoEntry
    const len = m.duration ?? 0
    const tin = ve.trimIn ?? 0
    const tout = ve.trimOut ?? len
    return (
      <>
        <MediaInfo m={m} />
        <Section title={t('trim')}>
          <Slider label={t('kbStart')} value={tin} min={0} max={Math.max(0, len - 0.5)} step={0.1} display={fmtSeconds(tin)} onChange={(v) => setEntry(ve.id, { trimIn: Math.min(v, tout - 0.5) })} />
          <Slider label={t('kbEnd')} value={tout} min={0.5} max={len} step={0.1} display={fmtSeconds(tout)} onChange={(v) => setEntry(ve.id, { trimOut: Math.max(v, tin + 0.5) })} />
        </Section>
        <Section title={t('videoSound')}>
          {m.hasAudio ? (
            <>
              <Check checked={!!ve.muted} onChange={(v) => setEntry(ve.id, { muted: v })}>
                {t('mute')}
              </Check>
              <Slider label={t('volume')} value={ve.volume ?? 1} min={0} max={2} step={0.05} display={`${Math.round((ve.volume ?? 1) * 100)} %`} onChange={(v) => setEntry(ve.id, { volume: v })} />
              <div className="row">
                <label>{t('duckClip')}</label>
                <select value={ve.duck == null ? 'default' : ve.duck ? 'on' : 'off'} onChange={(ev) => setEntry(ve.id, { duck: ev.target.value === 'default' ? undefined : ev.target.value === 'on' })}>
                  <option value="default">{t('default')}</option>
                  <option value="on">{t('on')}</option>
                  <option value="off">{t('off')}</option>
                </select>
              </div>
            </>
          ) : (
            <p className="hint">—</p>
          )}
        </Section>
        <Section title={t('duration')}>
          <DurationOverride entry={ve} />
        </Section>
        <CaptionField entry={ve} />
      </>
    )
  }

  const pe = e as PhotoEntry
  return (
    <>
      <MediaInfo m={m} />
      <Section title={t('duration')}>
        <DurationOverride entry={pe} />
      </Section>
      {slide && <CropSection slide={slide} />}
      <CaptionField entry={pe} />
      {m.live && (
        <Section title="Live">
          <div className="row">
            <label>{t('livePhoto')}</label>
            <select value={pe.playLive == null ? 'default' : pe.playLive ? 'on' : 'off'} onChange={(ev) => setEntry(pe.id, { playLive: ev.target.value === 'default' ? undefined : ev.target.value === 'on' })}>
              <option value="default">{t('default')}</option>
              <option value="on">{t('on')}</option>
              <option value="off">{t('off')}</option>
            </select>
          </div>
        </Section>
      )}
      {meta.kenBurns && (
        <Section title={t('kenBurns')}>
          <div className="row">
            <button className={`btn small ${kbEdit === 'start' ? 'on' : ''}`} onClick={() => set({ kbEdit: 'start' })}>
              {t('kbStart')}
            </button>
            <button className={`btn small ${kbEdit === 'end' ? 'on' : ''}`} onClick={() => set({ kbEdit: 'end' })}>
              {t('kbEnd')}
            </button>
            <button className="btn small ghost" onClick={() => setEntry(pe.id, { kenBurns: undefined })}>
              {t('kbReset')}
            </button>
          </div>
          <p className="hint">{t('kbHint')}</p>
        </Section>
      )}
    </>
  )
}
