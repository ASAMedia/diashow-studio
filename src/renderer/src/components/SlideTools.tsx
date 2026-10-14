// Slide tab tools for photos and videos (SlidePanel.tsx, BatchPanel.tsx): pixelated areas, the picture
// (rotate, straighten, crop, light and colour), panoramas, Live Photos, clip speed and stabilising.
// Free text boxes are in FreeTextSection.tsx.
import { Crop as CropIcon, RotateCcw, RotateCw, ScanFace } from 'lucide-react'
import { isChanged, isEdited, rotateEdit } from '@shared/mediaEdit'
import { closePhotoEdit, openPhotoEdit, selectedMediaIds, setMediaEdit } from '../photoEdit'
import type { AspectRatio, Entry, LiveEffect, MediaItem, PhotoEntry, VideoEntry } from '@shared/types'
import { liveEffectOf } from '@shared/livePhoto'
import { aspectValue, MAX_SPEED, MIN_SPEED, speedHasSound } from '@shared/timeline'
import { panoMode, panoramaOf, type PanAxis, type PanoMode } from '@shared/panorama'
import { useStore } from '../store'
import { t } from '../i18n'
import { requestStabilize, useStabilizeRequest } from '../stabilize'
import { allVideoTracks, faceArea, photoPersonFaces, videoPersonTracks } from '@shared/people'
import { Check, Field, Section } from './ui'
import { PeopleList } from './PeopleList'
import { AdjustSliders } from './AdjustSliders'

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

// ---------------------------------------------------------------- Live Photos

type LiveChoice = 'default' | 'off' | 'on' | LiveEffect

/** A photo's motion as one choice: the show's "Play Live Photos", off, once, or an effect. */
const liveChoice = (e: PhotoEntry): LiveChoice => (e.playLive == null ? 'default' : !e.playLive ? 'off' : (liveEffectOf(e) ?? 'on'))

/** How one or several Live Photos play: as the show says, still, once, as a Loop or as a Bounce (shared/livePhoto.ts). */
export function LivePhotoControls({ entries }: { entries: PhotoEntry[] }) {
  const updateEntries = useStore((s) => s.updateEntries)
  const showPlays = useStore((s) => !!s.project?.settings.playLivePhotos)
  if (!entries.length) return null
  const value = common(entries, liveChoice)
  return (
    <Section title={t('livePhotoTitle')}>
      <div className="stack">
        <Field label={t('livePhoto')}>
          <select
            data-testid="live-mode"
            value={value}
            onChange={(ev) => {
              const v = ev.target.value as LiveChoice | 'mixed'
              if (v === 'mixed') return
              // an effect plays the motion: older versions then play it once
              updateEntries(entries.map((x) => x.id), (x) => {
                if (x.type !== 'photo') return
                if (v === 'default') delete x.playLive
                else x.playLive = v !== 'off'
                if (v === 'loop' || v === 'bounce') x.liveEffect = v
                else delete x.liveEffect
              })
            }}
          >
            {value === 'mixed' && <option value="mixed">{t('unchanged')}</option>}
            <option value="default">{`${t('default')} (${showPlays ? 'Live' : t('off')})`}</option>
            <option value="off">{t('liveOff')}</option>
            <option value="on">{t('liveOnce')}</option>
            <option value="loop">{t('liveLoop')}</option>
            <option value="bounce">{t('liveBounce')}</option>
          </select>
        </Field>
        <p className="hint">{t('liveHint')}</p>
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------- speed

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8]

export const speedLabel = (v: number): string => {
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

// ---------------------------------------------------------------- one choice for several items

type Tri = 'mixed' | string

/** The common value of all items, or 'mixed'. */
export function common<T>(items: T[], get: (x: T) => string): Tri {
  const vals = new Set(items.map(get))
  return vals.size === 1 ? [...vals][0] : 'mixed'
}
