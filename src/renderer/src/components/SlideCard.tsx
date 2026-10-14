// A card of the filmstrip (Filmstrip.tsx): the slide's pictures, its badges (video, Live Photo, panorama,
// edited, own time, sound), the caption mark, the handle that sets its time, and its processing state.
import { useState } from 'react'
import { ArrowLeftRight, Clock, Film, MoveHorizontal, MoveVertical, Repeat, SlidersHorizontal, Volume2, VolumeX } from 'lucide-react'
import { isChanged } from '@shared/mediaEdit'
import type { TimelineSlide } from '@shared/timeline'
import type { VideoEntry } from '@shared/types'
import { fmtTime, t } from '../i18n'
import { friendly } from '../errors'
import { followPointer } from '../pointerDrag'
import { MediaThumb } from './EditedPicture'
import type { StripDetail } from './stripScale'

export function SlideCard(props: {
  slide: TimelineSlide
  /** How much the card shows at the filmstrip's zoom. */
  detail: StripDetail
  /** Small cards number only every few slides. */
  showNum: boolean
  /** The card the Tab key reaches (one per filmstrip). */
  tabbable: boolean
  selected: boolean
  captionSelected: boolean
  /** A search match ('current': the one shown last). */
  match: 'match' | 'current' | null
  onCaption: () => void
  dragging: boolean
  mergeTarget: boolean
  /** Drag on the right edge sets the slide's time; undefined = automatic again. */
  onDuration: (seconds: number | undefined) => void
  onClick: (e: React.MouseEvent) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
  onMenu: (e: React.MouseEvent) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const s = props.slide
  const m0 = s.media[0]
  const full = props.detail === 'full'
  const busy = s.media.find((m) => m.status === 'pending' || m.status === 'processing')
  const failed = s.media.find((m) => m.status === 'error')
  const ve = s.kind === 'video' ? (s.entries[0] as VideoEntry) : null
  const gridVideos = s.kind === 'photos' ? s.entries.filter((e) => e.type === 'video').length : 0
  const name = s.kind === 'text' || s.kind === 'title' ? s.title?.text : s.media.map((m) => m.name).join(', ')
  // small cards show fewer pictures: one, or two side by side
  const tiles = full ? s.media : s.media.slice(0, props.detail === 'compact' ? 2 : 1)
  const chapter = s.kind === 'text' || s.kind === 'title' || !!s.captionEntryId
  const classes = [
    'card',
    props.selected && 'selected',
    props.captionSelected && 'cap-selected',
    props.dragging && 'dragging',
    props.mergeTarget && 'merge-target',
    chapter && 'chapter',
    props.match && 'match',
    props.match === 'current' && 'match-current',
    !props.showNum && 'no-num'
  ]
  return (
    <div
      className={classes.filter(Boolean).join(' ')}
      role="button"
      tabIndex={props.tabbable ? 0 : -1}
      aria-pressed={props.selected}
      data-keys="app"
      data-index={s.index}
      aria-label={`${t('slide')} ${s.index + 1}: ${name || (s.kind === 'title' ? t('title') : t('textSlide'))}${failed ? ` – ${failed.error === 'missing' ? t('missing') : t('errUnreadable')}` : ''}`}
      data-entry={s.entries[0]?.id}
      onKeyDown={props.onKeyDown}
      draggable={s.kind !== 'title'}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', s.id)
        // dragend comes to this card, also when it scrolled out of the filmstrip during the drag: then it
        // is no longer in the page, React doesn't see the event, and the drag never ended for the filmstrip
        e.currentTarget.addEventListener('dragend', props.onDragEnd, { once: true })
        props.onDragStart()
      }}
      onClick={props.onClick}
      onContextMenu={props.onMenu}
      title={name}
    >
      {s.kind === 'title' || s.kind === 'text' ? (
        <div className="text-card">T</div>
      ) : (
        <div className="tiles">
          {tiles.map((m, i) => (m.thumb ? <MediaThumb key={i} m={m} draggable={false} loading="lazy" decoding="async" /> : <div key={i} className="empty" />))}
        </div>
      )}
      {full && (
        <div className="badges" aria-hidden>
          <span>
            {s.kind === 'video' && (
              <span className="badge">
                <Film size={10} /> {fmtTime(s.duration)}
              </span>
            )}
            {gridVideos > 0 && (
              <span className="badge">
                <Film size={10} /> {gridVideos}
              </span>
            )}
            {m0?.live && (
              <span className="badge live-mark" data-effect={s.live?.effect ?? (s.live ? 'live' : 'off')} title={s.live?.effect ? t(s.live.effect === 'loop' ? 'liveLoop' : 'liveBounce') : undefined}>
                LIVE
                {s.live?.effect === 'loop' && <Repeat size={10} />}
                {s.live?.effect === 'bounce' && <ArrowLeftRight size={10} />}
              </span>
            )}
            {s.pano && (
              <span className="badge pano-mark" title={t('panorama')}>
                {s.pano.axis === 'x' ? <MoveHorizontal size={10} /> : <MoveVertical size={10} />}
              </span>
            )}
          </span>
          <span>
            {s.media.some((m) => isChanged(m.edit)) && (
              <span className="badge edited-mark" title={t('peEditedMark')}>
                <SlidersHorizontal size={10} />
              </span>
            )}
            {s.customDuration && (
              <span className="badge">
                <Clock size={10} />
              </span>
            )}
            {ve && m0?.hasAudio && <span className="badge">{ve.muted ? <VolumeX size={10} /> : <Volume2 size={10} />}</span>}
          </span>
        </div>
      )}
      {full && s.captionEntryId && (
        <button
          className="cap-badge"
          tabIndex={-1}
          title={`${t('captionSlide')}: ${s.caption?.text ?? ''}`}
          aria-label={`${t('captionSlide')}: ${s.caption?.text ?? ''}`}
          onClick={(e) => {
            e.stopPropagation()
            props.onCaption()
          }}
        >
          T
        </button>
      )}
      {full && (s.kind === 'photos' || s.kind === 'text' || s.kind === 'video') && <DurationHandle slide={s} onDuration={props.onDuration} />}
      {busy && <div className="progress" style={{ width: `${Math.round((busy.progress ?? 0.05) * 100)}%` }} />}
      {failed && (
        <div className="err" title={friendly(failed.error ?? '', 'import').text} aria-hidden>
          {full && (failed.error === 'missing' ? t('missing') : failed.format)}
        </div>
      )}
      <span className="num" aria-hidden>
        {s.index + 1}
      </span>
    </div>
  )
}

function DurationHandle({ slide, onDuration }: { slide: TimelineSlide; onDuration: (s: number | undefined) => void }) {
  const [live, setLive] = useState<number | null>(null)
  return (
    <div
      className={`dur-handle ${live != null ? 'active' : ''}`}
      title={t('durationDrag')}
      onMouseDown={(e) => {
        // keeps the card's own drag-and-drop from starting
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onDuration(undefined)
      }}
      onPointerDown={(e) => {
        e.stopPropagation()
        const x0 = e.clientX
        const d0 = slide.duration
        followPointer(
          e,
          (ev) => {
            const v = Math.round(Math.min(120, Math.max(0.5, d0 + (ev.clientX - x0) * 0.05)) * 10) / 10
            setLive(v)
            onDuration(v)
          },
          () => setLive(null)
        )
      }}
    >
      {live != null && <span className="dur-tip">{live.toLocaleString(undefined, { minimumFractionDigits: 1 })} s</span>}
    </div>
  )
}
