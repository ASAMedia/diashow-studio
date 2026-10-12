// Slide tab: what the selected slide holds and how it plays; several slides at once go to BatchPanel.
import { Crop as CropIcon, Film, LogOut, Maximize, Minus, Plus, ScanFace, SquarePen, Trash2, Volume2, VolumeX } from 'lucide-react'
import { themeMeta } from '@shared/themes'
import type { Entry, MediaItem, PhotoEntry, TextEntry, TitleStyle, VideoEntry } from '@shared/types'
import { titleStyleOf, type TimelineSlide } from '@shared/timeline'
import { mediaAspect, templatesFor, type Template } from '@shared/layout'
import { audibleClips } from '@shared/audioPlan'
import { showsWhole } from '../engine/draw'
import { useStore } from '../store'
import { timelineOf } from '../timeline'
import { fmtTime, localeTag, t } from '../i18n'
import { Check, Field, Section, Slider, TITLE_STYLES } from './ui'
import { BatchAdjust, BatchPanel, EditSection, FreeTextSection, PrivacySection, SpeedSelect } from './SlideTools'
import { MediaThumb } from './EditedPicture'
import { openPhotoEdit } from '../photoEdit'
import { TrimStrip } from './TrimStrip'
import { ErrorText } from '../errors'

/** Songs that play from this text slide on (a chapter of its own). */
function ChapterMusic({ entry }: { entry: TextEntry }) {
  const project = useStore((s) => s.project)!
  const assign = useStore((s) => s.assignSong)
  const own = new Set(entry.music ?? [])
  const mine = project.music.filter((m) => own.has(m.id))
  const others = project.music.filter((m) => !own.has(m.id))
  return (
    <Section title={t('chapterMusic')}>
      <div className="stack">
        {mine.map((m) => (
          <div key={m.id} className="row">
            <span className="ellipsis" style={{ flex: 1 }} title={m.title}>
              {m.title}
            </span>
            <button className="btn small ghost icon" title={t('removeFromChapter')} aria-label={`${t('removeFromChapter')}: ${m.title}`} onClick={() => assign(m.id, null)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {others.length > 0 && (
          <select value="" aria-label={t('addSong')} onChange={(e) => e.target.value && assign(e.target.value, entry.id)}>
            <option value="">{t('addSong')}</option>
            {others.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        )}
        <p className="hint">{t('chapterMusicHint')}</p>
      </div>
    </Section>
  )
}

function MediaInfo({ m }: { m: MediaItem }) {
  return (
    <div className="section media-info">
      {m.thumb && <MediaThumb className="preview-thumb" m={m} alt={m.name} />}
      <dl className="info">
        <dt>{t('file')}</dt>
        <dd title={m.path}>{m.name}</dd>
        <dt>{t('format')}</dt>
        <dd title={m.format}>{m.format}</dd>
        {m.device && (
          <>
            <dt>{t('device')}</dt>
            <dd title={m.device}>{m.device}</dd>
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
      {m.status === 'error' && <ErrorText err={m.error === 'missing' ? 'missing' : m.error ?? ''} context="import" />}
    </div>
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
        <>
          <input
            type="number"
            aria-label={`${t('customDuration')} (${t('secondsLong')})`}
            min={0.5}
            max={120}
            step={0.5}
            style={{ width: 64 }}
            value={entry.duration}
            onChange={(e) => setEntry(entry.id, { duration: Math.max(0.5, Number(e.target.value) || 0.5) })}
          />
          <span className="hint" style={{ margin: 0 }} aria-hidden>
            s
          </span>
        </>
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
  const free = first?.layout === 'free'
  if ((options.length < 2 && slide.entries.length < 2) || !first) return null
  const mini = (tpl: Template) => (
    <svg viewBox="0 0 160 90">
      {tpl.slots.map((r, i) => (
        <rect key={i} x={r.x * 156 + 3} y={r.y * 86 + 3} width={Math.max(1, r.w * 156 - 3)} height={Math.max(1, r.h * 86 - 3)} rx={2} fill="currentColor" opacity={0.55} />
      ))}
    </svg>
  )
  return (
    <Section title={t('layout')}>
      <div className="layouts" role="group" aria-label={t('layout')}>
        <button className={!first.layout ? 'on' : ''} aria-pressed={!first.layout} onClick={() => setEntry(first.id, { layout: undefined })}>
          {t('layoutAuto')}
        </button>
        {slide.entries.length > 1 && (
          <button className={free ? 'on' : ''} aria-pressed={free} title={t('collageHint')} onClick={() => setEntry(first.id, { layout: 'free' })}>
            {t('layoutFree')}
          </button>
        )}
        {options.map((tpl, i) => (
          <button
            key={tpl.id}
            className={first.layout === tpl.id ? 'on' : ''}
            aria-pressed={first.layout === tpl.id}
            title={`${t('layout')} ${i + 1}`}
            aria-label={`${t('layout')} ${i + 1}`}
            onClick={() => setEntry(first.id, { layout: tpl.id })}
          >
            {mini(tpl)}
          </button>
        ))}
      </div>
      {free && (
        <>
          <p className="hint">{t('collageHint')}</p>
          <button className="btn small" onClick={() => useStore.getState().updateEntries(slide.entries.map((e) => e.id), (e) => delete e.place)}>
            {t('collageReset')}
          </button>
        </>
      )}
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
        aria-label={t('caption')}
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
      <button className="btn small" onClick={() => update((p) => p.entries.forEach((e) => ids.has(e.id) && e.type !== 'text' && delete e.crop))}>
        {t('cropReset')}
      </button>
    </div>
  )
}

/** Crop to fill or whole picture for one photo/video; undefined follows the show setting. */
function FramingSelect({ entry }: { entry: PhotoEntry | VideoEntry }) {
  const project = useStore((s) => s.project)!
  const setEntry = useStore((s) => s.setEntry)
  if (!themeMeta(project.settings.theme).scaleOption) return null
  const value = entry.whole == null ? 'default' : entry.whole ? 'whole' : 'crop'
  const dflt = entry.type === 'video' ? t('framingAuto') : `${t('framingDefault')} (${project.settings.scaleToFill ? t('cropMode') : t('wholeMode')})`
  return (
    <Field label={t('framing')}>
      <select value={value} onChange={(e) => setEntry(entry.id, { whole: e.target.value === 'default' ? undefined : e.target.value === 'whole' } as Partial<PhotoEntry>)}>
        <option value="default">{dflt}</option>
        <option value="crop">{t('cropMode')}</option>
        <option value="whole">{t('wholeMode')}</option>
      </select>
    </Field>
  )
}

/** How many items form this slide: take the next item of the show in, or hand the last one on. */
function GroupControl({ slide }: { slide: TimelineSlide }) {
  const project = useStore((s) => s.project)!
  const meta = themeMeta(project.settings.theme)
  if (meta.maxPerSlide < 2 || (slide.kind !== 'photos' && !(slide.kind === 'video' && meta.videoInGrid))) return null
  const ids = slide.entries.map((e) => e.id)
  const n = slide.entries.length
  return (
    <div className="section">
      <div className="row">
        <span className="label">{t('items')}</span>
        <div className="stepper" role="group" aria-label={t('items')}>
          <button className="btn small icon" title={t('itemsFewer')} aria-label={t('itemsFewer')} disabled={n < 2} onClick={() => useStore.getState().resizeSlide(ids, -1)}>
            <Minus size={14} />
          </button>
          <span aria-live="polite">{n}</span>
          <button className="btn small icon" title={t('itemsMore')} aria-label={t('itemsMore')} disabled={n >= meta.maxPerSlide} onClick={() => useStore.getState().resizeSlide(ids, 1)}>
            <Plus size={14} />
          </button>
        </div>
      </div>
      <p className="hint">{t('groupHint')}</p>
    </div>
  )
}

export function SlidePanel() {
  const project = useStore((s) => s.project)!
  const selection = useStore((s) => s.selection)
  const setEntry = useStore((s) => s.setEntry)
  const kbEdit = useStore((s) => s.kbEdit)
  const set = useStore((s) => s.set)
  const entries = selection.map((id) => project.entries.find((e) => e.id === id)).filter(Boolean) as Entry[]
  if (!entries.length) return <p className="empty-note">{t('noSelection')}</p>
  const media = (e: Entry): MediaItem | undefined => (e.type === 'text' ? undefined : project.media.find((m) => m.id === e.mediaId))
  const meta = themeMeta(project.settings.theme)

  const tl = timelineOf(project)
  const slide = tl.slides.find((sl) => sl.entries.some((x) => x.id === entries[0].id))
  const want = new Set(selection)
  const slides = tl.slides.filter((sl) => sl.entries.some((x) => want.has(x.id)))
  if (slides.length > 1) return <BatchPanel entries={entries} slides={slides} />

  if (entries.length > 1) {
    const order = new Map(project.entries.map((x, i) => [x.id, i]))
    const first = [...entries].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))[0]
    const ids = entries.map((x) => x.id)
    const audible = new Set(slide ? audibleClips(slide).map((c) => c.entry.id) : [])
    const videos = entries.filter((x) => x.type === 'video' && media(x)?.hasAudio).length
    return (
      <>
        <Section title={t('itemsOnSlide').replace('{n}', String(entries.length))}>
          <div className="items">
            {entries.map((e) => {
              const m = media(e)
              const isVideo = e.type === 'video'
              return (
                <div key={e.id} className="item" title={m?.name}>
                  {m?.thumb && <MediaThumb m={m} alt={m.name} />}
                  {isVideo && (
                    <span className="badge kind">
                      <Film size={10} /> {fmtTime(m?.duration ?? 0)}
                    </span>
                  )}
                  <div className="tools">
                    {isVideo && m?.hasAudio && (
                      <button
                        title={audible.has(e.id) ? t('soundOff') : t('soundOn')}
                        aria-label={`${audible.has(e.id) ? t('soundOff') : t('soundOn')}: ${m?.name ?? ''}`}
                        onClick={() => setEntry(e.id, { muted: audible.has(e.id) } as Partial<VideoEntry>)}
                      >
                        {audible.has(e.id) ? <Volume2 size={12} /> : <VolumeX size={12} />}
                      </button>
                    )}
                    {themeMeta(project.settings.theme).scaleOption && e.type !== 'text' && (() => {
                      const whole = e.whole ?? showsWhole(e, project.settings, mediaAspect(m), mediaAspect(m))
                      return (
                        <button title={whole ? t('cropMode') : t('wholeMode')} aria-label={`${whole ? t('cropMode') : t('wholeMode')}: ${m?.name ?? ''}`} onClick={() => setEntry(e.id, { whole: !whole } as Partial<PhotoEntry>)}>
                          {whole ? <CropIcon size={12} /> : <Maximize size={12} />}
                        </button>
                      )
                    })()}
                    {e.type !== 'text' && (
                      <button title={t('peEditHint')} aria-label={`${t('peEdit')}: ${m?.name ?? ''}`} onClick={() => openPhotoEdit(e.id)}>
                        <SquarePen size={12} />
                      </button>
                    )}
                    {e.type !== 'text' && (
                      <button title={t('privacyEdit')} aria-label={`${t('privacyEdit')} ${m?.name ?? ''}`} className={e.privacy?.length || (e.type === 'video' && e.privacyTracks?.length) ? 'on' : ''} onClick={() => set({ privacyEdit: e.id, kbEdit: null, photoEdit: null })}>
                        <ScanFace size={12} />
                      </button>
                    )}
                    <button title={t('release')} aria-label={`${t('release')}: ${m?.name ?? ''}`} onClick={() => useStore.getState().releaseEntry(ids, e.id)}>
                      <LogOut size={12} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          {videos > 1 && <p className="hint">{t('multiVideoHint')}</p>}
          <button className="btn small" onClick={() => useStore.getState().splitSlide(ids)}>
            {t('split')}
          </button>
        </Section>
        <Section title={t('adjTitle')}>
          <BatchAdjust />
        </Section>
        {slide && <GroupControl slide={slide} />}
        {slide && <LayoutPicker slide={slide} />}
        {slide && <CropSection slide={slide} />}
        <CaptionField entry={first} />
        {slide && <FreeTextSection slide={slide} />}
      </>
    )
  }

  const e = entries[0]
  if (e.type === 'text') {
    const te = e as TextEntry
    return (
      <>
        <Section title={t('textSlide')}>
          <div className="stack">
            <input type="text" aria-label={t('titleText')} placeholder={t('titleText')} value={te.title} onChange={(ev) => setEntry(te.id, { title: ev.target.value })} />
            {te.titleStyle === 'credits' ? (
              <textarea rows={5} aria-label={t('subtitleText')} placeholder={t('subtitleText')} value={te.subtitle ?? ''} onChange={(ev) => setEntry(te.id, { subtitle: ev.target.value || undefined })} style={{ width: '100%', resize: 'vertical' }} />
            ) : (
              <input type="text" aria-label={t('subtitleText')} placeholder={t('subtitleText')} value={te.subtitle ?? ''} onChange={(ev) => setEntry(te.id, { subtitle: ev.target.value || undefined })} />
            )}
            <Field label={t('titleStyle')}>
              <select value={te.titleStyle ?? ''} onChange={(ev) => setEntry(te.id, { titleStyle: (ev.target.value || undefined) as TitleStyle | undefined })}>
                <option value="">{t('styleShow')}</option>
                {TITLE_STYLES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {t(s.label)}
                  </option>
                ))}
                <option value="credits">{t('styleCredits')}</option>
              </select>
            </Field>
            {te.titleStyle === 'credits' && <p className="hint">{t('creditsHint')}</p>}
            <DurationOverride entry={te} />
            {themeMeta(project.settings.theme).textAsCaption && titleStyleOf(te, project.settings) === 'theme' && <p className="hint">{t('captionOnNext')}</p>}
          </div>
        </Section>
        <ChapterMusic entry={te} />
        {slide && slide.kind === 'text' && <FreeTextSection slide={slide} />}
      </>
    )
  }

  const m = media(e)
  if (!m) return null
  if (e.type === 'video') {
    const ve = e as VideoEntry
    return (
      <>
        <MediaInfo m={m} />
        <EditSection entry={ve} media={m} />
        <Section title={t('trim')}>
          <TrimStrip entry={ve} media={m} />
          <SpeedSelect entry={ve} hasAudio={!!m.hasAudio} />
        </Section>
        <Section title={t('videoSound')}>
          {m.hasAudio ? (
            <>
              <Check checked={!!ve.muted} onChange={(v) => setEntry(ve.id, { muted: v })}>
                {t('mute')}
              </Check>
              <Slider label={t('volume')} value={ve.volume ?? 1} min={0} max={2} step={0.05} display={`${Math.round((ve.volume ?? 1) * 100)} %`} onChange={(v) => setEntry(ve.id, { volume: v })} />
              <Field label={t('duckClip')}>
                <select value={ve.duck == null ? 'default' : ve.duck ? 'on' : 'off'} onChange={(ev) => setEntry(ve.id, { duck: ev.target.value === 'default' ? undefined : ev.target.value === 'on' })}>
                  <option value="default">{t('default')}</option>
                  <option value="on">{t('on')}</option>
                  <option value="off">{t('off')}</option>
                </select>
              </Field>
            </>
          ) : (
            <p className="empty-note">{t('noVideoSound')}</p>
          )}
        </Section>
        <Section title={t('duration')}>
          <DurationOverride entry={ve} />
        </Section>
        <div className="section">
          <FramingSelect entry={ve} />
        </div>
        {slide && <GroupControl slide={slide} />}
        <CaptionField entry={ve} />
        {slide && <FreeTextSection slide={slide} />}
        <PrivacySection entry={ve} media={m} />
      </>
    )
  }

  const pe = e as PhotoEntry
  return (
    <>
      <MediaInfo m={m} />
      <EditSection entry={pe} media={m} />
      <Section title={t('duration')}>
        <DurationOverride entry={pe} />
      </Section>
      <div className="section">
        <FramingSelect entry={pe} />
      </div>
      {slide && <GroupControl slide={slide} />}
      {slide && <CropSection slide={slide} />}
      <CaptionField entry={pe} />
      {slide && <FreeTextSection slide={slide} />}
      <PrivacySection entry={pe} media={m} />
      {m.live && (
        <Section title={t('livePhotoTitle')}>
          <Field label={t('livePhoto')}>
            <select value={pe.playLive == null ? 'default' : pe.playLive ? 'on' : 'off'} onChange={(ev) => setEntry(pe.id, { playLive: ev.target.value === 'default' ? undefined : ev.target.value === 'on' })}>
              <option value="default">{t('default')}</option>
              <option value="on">{t('on')}</option>
              <option value="off">{t('off')}</option>
            </select>
          </Field>
        </Section>
      )}
      {meta.kenBurns && (
        <Section title={t('kenBurns')}>
          <div className="row">
            <button className={`btn small ${kbEdit === 'start' ? 'on' : ''}`} aria-pressed={kbEdit === 'start'} onClick={() => set({ kbEdit: 'start', photoEdit: null })}>
              {t('kbStart')}
            </button>
            <button className={`btn small ${kbEdit === 'end' ? 'on' : ''}`} aria-pressed={kbEdit === 'end'} onClick={() => set({ kbEdit: 'end', photoEdit: null })}>
              {t('kbEnd')}
            </button>
            <button className="btn small ghost" disabled={!pe.kenBurns} onClick={() => setEntry(pe.id, { kenBurns: undefined })}>
              {t('kbReset')}
            </button>
          </div>
          <p className="hint">{t('kbHint')}</p>
        </Section>
      )}
    </>
  )
}
