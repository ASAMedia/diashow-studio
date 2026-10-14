// Check before export: every slide item with detected faces that are not pixelated (not in an
// area, not followed, not a marked person), faces circled. A click opens the pixelation editor for
// it; "All fine" goes on. Offered in the export dialog (never forced) and as a dialog of its own
// (store dialog 'privacyReview').
import { useMemo } from 'react'
import { Film } from 'lucide-react'
import { mediaUrl } from '@shared/api'
import { faceSearchProgress, openFacesInShow, type OpenFaces } from '@shared/people'
import type { Rect } from '@shared/types'
import { frameUrl, useAsyncUrl } from '../faceCrops'
import { openPrivacyEditor } from '../personActions'
import { useStore } from '../store'
import { count, t } from '../i18n'
import { PeopleList } from './PeopleList'
import { useEditedUrl } from './EditedPicture'
import { rectToEdit, shownAspect, sourceAspect } from '@shared/mediaEdit'
import { Modal } from './Modal'
import './people.css'

function Tile({ item }: { item: OpenFaces }) {
  const { media: m, entry } = item
  // videos: the sampled frame with the most open faces
  const sample = item.samples.reduce((a, b) => (b.faces.length > a.faces.length ? b : a), item.samples[0] ?? { t: 0, faces: [] })
  const frame = useAsyncUrl(m.kind === 'video' ? () => frameUrl(m, sample.t, 480) : null, [m.id, sample.t])
  const src = m.kind === 'video' ? frame : m.thumb ? mediaUrl(m.thumb) : m.display ? mediaUrl(m.display) : undefined
  // the picture as it is shown, with the faces where they sit on it (they are kept for the original)
  const shown = useEditedUrl(src, m.edit, sourceAspect(m), 480)
  const faces: Rect[] = (m.kind === 'video' ? sample.faces : item.faces).map((f) => rectToEdit(f, m.edit, sourceAspect(m)))
  const nFaces = m.kind === 'video' ? Math.max(...item.samples.map((s) => s.faces.length)) : item.faces.length
  return (
    <button className="review-tile" onClick={() => openPrivacyEditor(entry.id, m.kind === 'video' ? sample.t : undefined)} title={m.name}>
      <div className="review-pic" style={{ aspectRatio: String(shownAspect(m)), overflow: 'hidden' }}>
        {shown && <img src={shown} alt="" draggable={false} />}
        {faces.map((f, i) => (
          <span key={i} className="review-face" style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }} />
        ))}
      </div>
      <div className="review-caption">
        <span className="name">
          {m.kind === 'video' && <Film size={11} style={{ verticalAlign: -1, marginRight: 3 }} aria-hidden />}
          {m.name}
        </span>
        <span className="n">{count('reviewFaces', nFaces)}</span>
      </div>
    </button>
  )
}

/** The review itself; `onDone` is "All fine". */
export function PrivacyReview({ onDone, doneLabel }: { onDone: () => void; doneLabel?: string }) {
  const project = useStore((s) => s.project)!
  const items = useMemo(() => openFacesInShow(project), [project])
  const progress = useMemo(() => faceSearchProgress(project), [project.media, project.entries]) // eslint-disable-line react-hooks/exhaustive-deps
  const pending = progress.total - progress.done
  return (
    <div className="privacy-review">
      <div className="review-people">
        <h3 className="subhead">{t('peopleTitle')}</h3>
        <PeopleList />
      </div>
      {project.faceDataRemovedAt && !project.people?.length ? (
        <p className="callout info">{t('cleanupFacesRemoved')}</p>
      ) : items.length > 0 ? (
        <p className="hint lead">{t('reviewIntro')}</p>
      ) : (
        <p className="review-ok">{t('reviewNone')}</p>
      )}
      {pending > 0 && <p className="callout warn">{count('reviewPending', pending)}</p>}
      {items.length > 0 && (
        <div className="review-grid">
          {items.map((it) => (
            <Tile key={it.entry.id} item={it} />
          ))}
        </div>
      )}
      <div className="actions inline">
        <button className="btn primary" onClick={onDone}>
          {doneLabel ?? t('reviewOk')}
        </button>
      </div>
    </div>
  )
}

/** Standalone dialog (store dialog 'privacyReview'), e.g. from the "⋯" menu. */
export function PrivacyReviewDialog() {
  const set = useStore((s) => s.set)
  return (
    <Modal title={t('reviewTitle')} onClose={() => set({ dialog: null })} backdropClose className="wide">
      <PrivacyReview onDone={() => set({ dialog: null })} />
    </Modal>
  )
}
