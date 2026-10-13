// Slide tab tools: pixelated areas, clip speed, free text boxes, and editing many slides at once.
import { Crop as CropIcon, EyeOff, Plus, RotateCcw, RotateCw, ScanFace, Trash2, Merge } from 'lucide-react'
import { isChanged, isEdited, rotateEdit } from '@shared/mediaEdit'
import { closePhotoEdit, openPhotoEdit, rotateSelection, selectedMediaIds, setMediaEdit } from '../photoEdit'
import type { AspectRatio, Entry, FreeText, MediaItem, PhotoEntry, Rect, VideoEntry } from '@shared/types'
import { themeMeta } from '@shared/themes'
import { aspectValue, MAX_SPEED, MIN_SPEED, speedHasSound, type TimelineSlide } from '@shared/timeline'
import { panoMode, panoramaOf, type PanAxis, type PanoMode } from '@shared/panorama'
import { useStore } from '../store'
import { t, type StringKey } from '../i18n'
import { requestStabilize, useStabilizeRequest } from '../stabilize'
import { allVideoTracks, faceArea, photoPersonFaces, videoPersonTracks } from '@shared/people'
import { Check, Field, FONTS, Section, Slider } from './ui'
import { PeopleList } from './PeopleList'
import { AdjustSliders } from './AdjustSliders'

/** A detected face grown to cover hair and chin, as the area to pixelate (now in @shared/people). */
export { faceArea }

const sameArea = (a: Rect, b: Rect): boolean => Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4 && Math.abs(a.w - b.w) < 1e-4

// ---------------------------------------------------------------- privacy

export function PrivacySection({ entry, media }: { entry: PhotoEntry | VideoEntry; media: MediaItem }) {
  const set = useStore((s) => s.set)
  const setEntry = useStore((s) => s.setEntry)
  const people = useStore((s) => s.project?.people)
  const editing = useStore((s) => s.privacyEdit === entry.id)
  const n = entry.privacy?.length ?? 0
  const nTracks = entry.type === 'video' ? (entry.privacyTracks?.length ?? 0) : 0
  const nPeople = entry.type === 'video' ? videoPersonTracks(media, people).length : photoPersonFaces(media, people).length
  const faces = (media.faces ?? []).map(faceArea)
  // videos: every face found in the clip, followed through it
  const all = (): void => {
    if (entry.type === 'video') setEntry(entry.id, { privacyTracks: allVideoTracks(entry, media) } as Partial<VideoEntry>)
    else setEntry(entry.id, { privacy: faces } as Partial<PhotoEntry>)
  }
  const anyFaces = entry.type === 'video' ? !!media.videoFaces?.some((s) => s.faces.length) : faces.length > 0
  return (
    <Section title={t('privacy')}>
      <div className="row wrap">
        <button className={`btn small ${editing ? 'on' : ''}`} aria-pressed={editing} onClick={() => set({ privacyEdit: editing ? null : entry.id, kbEdit: null, photoEdit: null })}>
          <ScanFace size={14} /> {t('privacyEdit')}
        </button>
        {anyFaces && (
          <button className="btn small ghost" onClick={all}>
            {t('privacyAll')}
          </button>
        )}
        {n + nTracks > 0 && (
          <button className="btn small ghost" onClick={() => setEntry(entry.id, { privacy: undefined, privacyTracks: undefined } as Partial<VideoEntry>)}>
            {t('privacyNone')}
          </button>
        )}
      </div>
      {n > 0 && <p className="hint">{t('privacyCount').replace('{n}', String(n))}</p>}
      {nTracks > 0 && <p className="hint">{t('privacyTracks').replace('{n}', String(nTracks))}</p>}
      {nPeople > 0 && <p className="hint">{t('privacyPeople').replace('{n}', String(nPeople))}</p>}
      {!!people?.length && (
        <details className="people-details">
          <summary>
            {t('peopleTitle')} ({people.length})
          </summary>
          <PeopleList />
        </details>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------- rotate, straighten, crop

/** The picture of a photo or video: the edit view over the preview, quick quarter turns, light and colour, back to the original. */
export function EditSection({ entry, media }: { entry: PhotoEntry | VideoEntry; media: MediaItem }) {
  const open = useStore((s) => s.photoEdit?.entryId === entry.id)
  const edited = isEdited(media.edit)
  return (
    <Section title={t('pePicture')}>
      <div className="row wrap">
        <button
          className={`btn small ${open ? 'on' : ''}`}
          aria-pressed={open}
          title={t('peEditHint')}
          disabled={media.status === 'error'}
          onClick={() => (open ? closePhotoEdit(false) : openPhotoEdit(entry.id))}
        >
          <CropIcon size={14} /> {t('peEdit')}
        </button>
        <button className="btn small icon" title={`${t('peRotateLeft')} (${t('kbdRotate')})`} aria-label={t('peRotateLeft')} onClick={() => setMediaEdit(media.id, rotateEdit(media.edit, -1))}>
          <RotateCcw size={14} />
        </button>
        <button className="btn small icon" title={t('peRotateRight')} aria-label={t('peRotateRight')} onClick={() => setMediaEdit(media.id, rotateEdit(media.edit, 1))}>
          <RotateCw size={14} />
        </button>
        {isChanged(media.edit) && (
          <button className="btn small ghost" onClick={() => setMediaEdit(media.id, undefined)}>
            {t('peOriginalBack')}
          </button>
        )}
      </div>
      {edited && <p className="hint">{t('peEdited')}</p>}
      <AdjustSliders media={[media]} />
    </Section>
  )
}

/** Light and colour of every selected photo and video (several slides, or several items of one slide). */
export function BatchAdjust() {
  const project = useStore((s) => s.project)!
  // the pictures of the selected slides, as the batch turn takes them (re-read when the selection changes)
  useStore((s) => s.selection)
  const ids = new Set(selectedMediaIds())
  const media = project.media.filter((m) => ids.has(m.id) && m.status !== 'error')
  if (!media.length) return null
  return (
    <>
      <AdjustSliders media={media} />
      {media.length > 1 && <p className="hint">{t('adjBatchHint')}</p>}
    </>
  )
}

// ---------------------------------------------------------------- panoramas

/** The selected photos that are panoramas in this show, with the axis they pan along (shared/panorama.ts). */
export function panoramaEntries(entries: Entry[], media: (id: string) => MediaItem | undefined, aspect: AspectRatio): { e: PhotoEntry; axis: PanAxis }[] {
  const frame = aspectValue(aspect)
  return entries.flatMap((e) => {
    const axis = e.type === 'photo' ? panoramaOf(media(e.mediaId), frame) : null
    return axis ? [{ e: e as PhotoEntry, axis }] : []
  })
}

/** How one or several panoramas are shown: pan (default), whole picture or crop to fill, and which way they pan. */
export function PanoramaControls({ entries }: { entries: { e: PhotoEntry; axis: PanAxis }[] }) {
  const updateEntries = useStore((s) => s.updateEntries)
  if (!entries.length) return null
  const ids = entries.map((x) => x.e.id)
  const mode = common(entries, (x) => panoMode(x.e))
  const dir = common(entries, (x) => (x.e.panReverse ? 'reverse' : 'forward'))
  const axes = new Set(entries.map((x) => x.axis))
  const way = (reverse: boolean): string => {
    const x = t(reverse ? 'panRightLeft' : 'panLeftRight')
    const y = t(reverse ? 'panBottomTop' : 'panTopBottom')
    return axes.size > 1 ? `${x} / ${y}` : axes.has('x') ? x : y
  }
  const mixed = <option value="mixed">{t('unchanged')}</option>
  return (
    <Section title={t('panorama')}>
      <div className="stack">
        <Field label={t('panoShow')}>
          <select
            data-testid="pano-mode"
            value={mode}
            onChange={(ev) => {
              const v = ev.target.value as PanoMode | 'mixed'
              if (v === 'mixed') return
              // the crop / whole-picture setting of the photo; panning is a panorama's default
              updateEntries(ids, (x) => {
                if (x.type !== 'photo') return
                if (v === 'pan') delete x.whole
                else x.whole = v === 'whole'
              })
            }}
          >
            {mode === 'mixed' && mixed}
            <option value="pan">{t('panMode')}</option>
            <option value="whole">{t('wholeMode')}</option>
            <option value="crop">{t('panCrop')}</option>
          </select>
        </Field>
        {mode !== 'whole' && mode !== 'crop' && (
          <Field label={t('direction')}>
            <select
              data-testid="pano-dir"
              value={dir}
              onChange={(ev) => {
                const v = ev.target.value
                if (v === 'mixed') return
                updateEntries(ids, (x) => {
                  if (x.type !== 'photo') return
                  if (v === 'reverse') x.panReverse = true
                  else delete x.panReverse
                })
              }}
            >
              {dir === 'mixed' && mixed}
              <option value="forward">{way(false)}</option>
              <option value="reverse">{way(true)}</option>
            </select>
          </Field>
        )}
        <p className="hint">{t('panHint')}</p>
      </div>
    </Section>
  )
}

/** Toggles an area: removes it when present, adds it otherwise. */
export function togglePrivacy(entry: PhotoEntry | VideoEntry, area: Rect): Rect[] | undefined {
  const cur = entry.privacy ?? []
  const next = cur.some((r) => sameArea(r, area)) ? cur.filter((r) => !sameArea(r, area)) : [...cur, area]
  return next.length ? next : undefined
}

// ---------------------------------------------------------------- speed

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8]

const speedLabel = (v: number): string => {
  const x = `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}×`
  return v < 1 ? `${x} · ${t('speedSlow')}` : v > 1 ? `${x} · ${t('speedFast')}` : `${x} · ${t('speedNormal')}`
}

export function SpeedSelect({ entry, hasAudio }: { entry: VideoEntry; hasAudio: boolean }) {
  const setEntry = useStore((s) => s.setEntry)
  const v = Math.min(MAX_SPEED, Math.max(MIN_SPEED, entry.speed ?? 1))
  return (
    <>
      <Field label={t('clipSpeed')}>
        <select value={v} onChange={(e) => setEntry(entry.id, { speed: Number(e.target.value) === 1 ? undefined : Number(e.target.value) } as Partial<VideoEntry>)}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {speedLabel(s)}
            </option>
          ))}
        </select>
      </Field>
      {hasAudio && !speedHasSound(v) && <p className="hint">{t('speedSilent')}</p>}
      <StabilizeToggle entry={entry} />
    </>
  )
}

// ---------------------------------------------------------------- stabilise

/** "Reduce shake": plays the clip's stabilised version (made in the background on first use). */
export function StabilizeToggle({ entry }: { entry: VideoEntry }) {
  const setEntry = useStore((s) => s.setEntry)
  const media = useStore((s) => s.project?.media.find((m) => m.id === entry.mediaId))
  const request = useStabilizeRequest(entry.mediaId)
  if (!media || media.kind !== 'video') return null
  const on = !!entry.stabilize
  const progress = media.stabilizing
  return (
    <div className="stabilize">
      <Check
        checked={on}
        onChange={(v) => {
          setEntry(entry.id, { stabilize: v || undefined } as Partial<VideoEntry>)
          if (v && !media.stabilized && media.status === 'ready') requestStabilize(media.id, true)
        }}
      >
        {t('stabilize')}
      </Check>
      {on && progress !== undefined && (
        <>
          <p className="hint">{t('stabilizing').replace('{p}', String(Math.floor(progress * 100)))}</p>
          <div className="bar" role="progressbar" aria-label={t('stabilize')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </>
      )}
      {on && progress === undefined && !media.stabilized && request === 'asked' && <p className="hint">{t('stabilizeQueued')}</p>}
      {on && progress === undefined && !media.stabilized && request === 'failed' && <p className="hint error">{t('stabilizeFailed')}</p>}
      {on && media.stabilized && <p className="hint">{t('stabilizeHint')}</p>}
    </div>
  )
}

// ---------------------------------------------------------------- free text

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
  const order = new Map(project.entries.map((e, i) => [e.id, i]))
  const owner = [...slide.entries].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))[0]
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

// ---------------------------------------------------------------- several slides

type Tri = 'mixed' | string

/** The common value of all items, or 'mixed'. */
function common<T>(items: T[], get: (x: T) => string): Tri {
  const vals = new Set(items.map(get))
  return vals.size === 1 ? [...vals][0] : 'mixed'
}

export function BatchPanel({ entries, slides }: { entries: Entry[]; slides: TimelineSlide[] }) {
  const project = useStore((s) => s.project)!
  const updateEntries = useStore((s) => s.updateEntries)
  const meta = themeMeta(project.settings.theme)
  const media = new Map(project.media.map((m) => [m.id, m]))
  const ids = entries.map((e) => e.id)
  const visual = entries.filter((e): e is PhotoEntry | VideoEntry => e.type !== 'text')
  const videos = visual.filter((e): e is VideoEntry => e.type === 'video')
  const lives = visual.filter((e): e is PhotoEntry => e.type === 'photo' && !!media.get(e.mediaId)?.live)
  // a slide's own time lives on its first entry
  const order = new Map(project.entries.map((e, i) => [e.id, i]))
  const firsts = slides.map((s) => [...s.entries].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))[0]).filter(Boolean)
  const duration = common(firsts, (e) => (e.duration == null ? 'auto' : String(e.duration)))
  const framing = common(visual, (e) => (e.whole == null ? 'default' : e.whole ? 'whole' : 'crop'))
  const speed = common(videos, (e) => String(e.speed ?? 1))
  const sound = common(videos, (e) => (e.muted ? 'off' : 'on'))
  const live = common(lives, (e) => (e.playLive == null ? 'default' : e.playLive ? 'on' : 'off'))
  const withFaces = visual.filter((e) => media.get(e.mediaId)?.faces?.length || media.get(e.mediaId)?.videoFaces?.some((s) => s.faces.length))
  const pixelated = visual.filter((e) => e.privacy?.length || (e.type === 'video' && e.privacyTracks?.length)).length
  const panos = panoramaEntries(visual, (id) => media.get(id), project.settings.aspect)
  // a panorama always keeps a slide of its own
  const mergeable = meta.maxPerSlide > 1 && slides.length > 1 && slides.every((s) => (s.kind === 'photos' && !s.pano) || s.kind === 'video') && visual.length <= meta.maxPerSlide

  const mixed = <option value="mixed">{t('unchanged')}</option>
  return (
    <>
      <Section title={t('batchTitle').replace('{n}', String(slides.length))}>
        <p className="hint" style={{ marginTop: 0 }}>
          {t('batchHint')}
        </p>
        <div className="stack">
          <div className="row">
            <label htmlFor="batch-duration">{t('duration')}</label>
            <select
              id="batch-duration"
              value={duration === 'auto' || duration === 'mixed' ? duration : 'custom'}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'mixed') return
                const want = new Set(firsts.map((x) => x.id))
                updateEntries([...want], (x) => (x.duration = v === 'auto' ? undefined : (x.duration ?? 4)))
              }}
            >
              {duration === 'mixed' && mixed}
              <option value="auto">{t('automatic')}</option>
              <option value="custom">{t('customDuration')}</option>
            </select>
            {duration !== 'auto' && duration !== 'mixed' && (
              <input
                type="number"
                aria-label={`${t('customDuration')} (${t('secondsLong')})`}
                min={0.5}
                max={120}
                step={0.5}
                style={{ width: 64 }}
                value={duration}
                onChange={(e) => {
                  const sec = Math.max(0.5, Number(e.target.value) || 0.5)
                  updateEntries(firsts.map((x) => x.id), (x) => (x.duration = sec), 'batch:duration')
                }}
              />
            )}
          </div>
          {meta.scaleOption && visual.length > 0 && (
            <div className="row">
              <label htmlFor="batch-framing">{t('framing')}</label>
              <select
                id="batch-framing"
                value={framing}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'mixed') return
                  updateEntries(ids, (x) => x.type !== 'text' && (x.whole = v === 'default' ? undefined : v === 'whole'))
                }}
              >
                {framing === 'mixed' && mixed}
                <option value="default">{t('framingDefault')}</option>
                <option value="crop">{t('cropMode')}</option>
                <option value="whole">{t('wholeMode')}</option>
              </select>
            </div>
          )}
          {videos.length > 0 && (
            <>
              <div className="row">
                <label htmlFor="batch-speed">{t('clipSpeed')}</label>
                <select
                  id="batch-speed"
                  value={speed}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === 'mixed') return
                    updateEntries(videos.map((x) => x.id), (x) => x.type === 'video' && (x.speed = Number(v) === 1 ? undefined : Number(v)))
                  }}
                >
                  {speed === 'mixed' && mixed}
                  {SPEEDS.map((s) => (
                    <option key={s} value={String(s)}>
                      {speedLabel(s)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="row">
                <label htmlFor="batch-sound">{t('videoSound')}</label>
                <select
                  id="batch-sound"
                  value={sound}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === 'mixed') return
                    updateEntries(videos.map((x) => x.id), (x) => x.type === 'video' && (x.muted = v === 'off' ? true : undefined))
                  }}
                >
                  {sound === 'mixed' && mixed}
                  <option value="on">{t('on')}</option>
                  <option value="off">{t('off')}</option>
                </select>
              </div>
            </>
          )}
          {lives.length > 0 && (
            <div className="row">
              <label htmlFor="batch-live">{t('livePhoto')}</label>
              <select
                id="batch-live"
                value={live}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'mixed') return
                  updateEntries(lives.map((x) => x.id), (x) => x.type === 'photo' && (x.playLive = v === 'default' ? undefined : v === 'on'))
                }}
              >
                {live === 'mixed' && mixed}
                <option value="default">{t('default')}</option>
                <option value="on">{t('on')}</option>
                <option value="off">{t('off')}</option>
              </select>
            </div>
          )}
        </div>
      </Section>
      <PanoramaControls entries={panos} />
      {visual.length > 0 && (
        <Section title={t('pePicture')}>
          <div className="row wrap">
            <button className="btn small" title={`${t('peRotateLeft')} (${t('kbdRotate')})`} onClick={() => rotateSelection(-1)}>
              <RotateCcw size={14} /> {t('peRotateLeft')}
            </button>
            <button className="btn small" onClick={() => rotateSelection(1)}>
              <RotateCw size={14} /> {t('peRotateRight')}
            </button>
          </div>
          <BatchAdjust />
        </Section>
      )}
      {visual.length > 0 && (
        <Section title={t('privacy')}>
          <div className="row wrap">
            {withFaces.length > 0 && (
              <button
                className="btn small"
                onClick={() =>
                  updateEntries(withFaces.map((x) => x.id), (x) => {
                    if (x.type === 'text') return
                    const m = media.get(x.mediaId)
                    // videos: every face followed through the clip
                    if (x.type === 'video' && m) x.privacyTracks = allVideoTracks(x, m)
                    else x.privacy = (m?.faces ?? []).map(faceArea)
                  })
                }
              >
                <ScanFace size={14} /> {t('privacyBatchOn')}
              </button>
            )}
            {pixelated > 0 && (
              <button className="btn small ghost" onClick={() => updateEntries(ids, (x) => x.type !== 'text' && delete x.privacy && (x.type !== 'video' || delete x.privacyTracks))}>
                {t('privacyBatchOff')}
              </button>
            )}
          </div>
          {pixelated > 0 && <p className="hint">{t('privacyCount').replace('{n}', String(visual.reduce((n, x) => n + (x.privacy?.length ?? 0), 0)))}</p>}
        </Section>
      )}
      <div className="section">
        <div className="stack">
          {mergeable && (
            <button className="btn small" onClick={() => useStore.getState().mergeEntries(ids)}>
              <Merge size={14} /> {t('merge')}
            </button>
          )}
          <button
            className="btn small"
            onClick={() => {
              updateEntries(ids, (x) => (x.excluded = true))
              useStore.getState().select([])
            }}
          >
            <EyeOff size={14} /> {t('excludeSel')}
          </button>
          <button className="btn small danger" onClick={() => useStore.getState().removeEntries(ids)}>
            <Trash2 size={14} /> {t('deleteSlides')}
          </button>
        </div>
      </div>
    </>
  )
}
