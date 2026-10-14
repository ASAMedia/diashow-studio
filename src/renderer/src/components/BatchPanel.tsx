// Slide tab with several slides selected: their time, framing, clip speed and sound, panoramas and
// Live Photos, turning and light and colour, pixelated faces, combining, leaving out and deleting them,
// all at once.
import { EyeOff, Merge, RotateCcw, RotateCw, ScanFace, Trash2 } from 'lucide-react'
import type { Entry, PhotoEntry, VideoEntry } from '@shared/types'
import { themeMeta } from '@shared/themes'
import type { TimelineSlide } from '@shared/timeline'
import { allVideoTracks, faceArea } from '@shared/people'
import { useStore } from '../store'
import { count, t } from '../i18n'
import { firstInShow, showOrder } from '../entryEdits'
import { rotateSelection } from '../photoEdit'
import { Section } from './ui'
import { BatchAdjust, common, LivePhotoControls, PanoramaControls, panoramaEntries, SPEEDS, speedLabel } from './SlideTools'

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
  const order = showOrder(project)
  const firsts = slides.map((s) => firstInShow(s.entries, order)).filter(Boolean)
  const duration = common(firsts, (e) => (e.duration == null ? 'auto' : String(e.duration)))
  const framing = common(visual, (e) => (e.whole == null ? 'default' : e.whole ? 'whole' : 'crop'))
  const speed = common(videos, (e) => String(e.speed ?? 1))
  const sound = common(videos, (e) => (e.muted ? 'off' : 'on'))
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
        </div>
      </Section>
      <PanoramaControls entries={panos} />
      <LivePhotoControls entries={lives} />
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
          {pixelated > 0 && (
            <p className="hint">
              {/* drawn areas, and in videos the faces followed through the clip */}
              {count('privacyCount', visual.reduce((n, x) => n + (x.privacy?.length ?? 0) + (x.type === 'video' ? (x.privacyTracks?.length ?? 0) : 0), 0))}
            </p>
          )}
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
