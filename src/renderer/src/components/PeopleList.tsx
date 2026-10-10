// The people marked "pixelate this person everywhere": name, how often they were recognised, their
// matches (click one to edit that slide, ✕ on a wrong one corrects it), and "stop pixelating".
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Trash2, X } from 'lucide-react'
import type { MediaItem, Person, Project } from '@shared/types'
import { faceSearchProgress, peopleMatches, type PersonMatch } from '@shared/people'
import { faceCropUrl, useAsyncUrl } from '../faceCrops'
import { notThisPerson, openPrivacyEditor, personLabel, removePerson, renamePerson } from '../personActions'
import { useStore } from '../store'
import { t } from '../i18n'
import './people.css'

/** First entry of the show that uses a media item. */
const entryOf = (project: Project, mediaId: string): string | undefined => project.entries.find((e) => e.type !== 'text' && e.mediaId === mediaId)?.id

function FaceTile({ m, match, person, project }: { m: MediaItem; match: PersonMatch; person: Person; project: Project }) {
  const url = useAsyncUrl(() => faceCropUrl(m, match.r, match.t, 96), [m.id, match.t, match.r.x, match.r.y])
  const entryId = entryOf(project, m.id)
  return (
    <div className="people-match" title={`${m.name} · ${match.d.toFixed(2)}`}>
      <button className="open" aria-label={`${t('privacyEdit')} ${m.name}`} onClick={() => entryId && openPrivacyEditor(entryId, match.t)}>
        {url && <img src={url} alt="" draggable={false} />}
      </button>
      {match.t !== undefined && <span className="video-tag">{`${match.t.toFixed(1)} s`}</span>}
      <button
        className="wrong"
        title={t('peopleWrong')}
        aria-label={t('peopleWrong')}
        onClick={(e) => {
          e.stopPropagation()
          notThisPerson(person.id, match.desc)
        }}
      >
        <X size={11} />
      </button>
    </div>
  )
}

function Avatar({ m, match }: { m?: MediaItem; match?: PersonMatch }) {
  const url = useAsyncUrl(m && match ? () => faceCropUrl(m, match.r, match.t, 80) : null, [m?.id, match?.t, match?.r.x, match?.r.y])
  return url ? <img className="people-avatar" src={url} alt="" draggable={false} /> : <div className="people-avatar" />
}

export function PeopleList() {
  const project = useStore((s) => s.project)!
  const people = project.people ?? []
  const matches = useMemo(() => peopleMatches(project), [project.media, project.people, project.entries]) // eslint-disable-line react-hooks/exhaustive-deps
  const progress = useMemo(() => faceSearchProgress(project), [project.media, project.entries]) // eslint-disable-line react-hooks/exhaustive-deps
  const media = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media])
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className="people-list">
      {progress.done < progress.total && (
        <p className="hint" style={{ margin: 0 }}>
          {t('peopleProgress').replace('{done}', String(progress.done)).replace('{total}', String(progress.total))}
        </p>
      )}
      {!people.length && (
        <p className="empty-note" style={{ padding: 0 }}>
          {t('peopleEmpty')}
        </p>
      )}
      {people.map((p) => {
        const list = [...(matches.get(p.id) ?? [])].sort((a, b) => a.d - b.d)
        const nPhotos = list.filter((x) => x.t === undefined).length
        const first = list.find((x) => x.t === undefined) ?? list[0]
        const shown = open === p.id
        return (
          <div key={p.id} className="people-person">
            <div className="people-row">
              <Avatar m={first && media.get(first.mediaId)} match={first} />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <input type="text" value={p.name ?? ''} aria-label={`${personLabel(p, people)} – ${t('peopleName')}`} placeholder={`${personLabel(p, people)} – ${t('peopleName')}`} onChange={(e) => renamePerson(p.id, e.target.value)} />
                <span className="people-meta">
                  {t('peopleMatches').replace('{p}', String(nPhotos)).replace('{v}', String(list.length - nPhotos))} · {t('peopleSamples').replace('{n}', String(p.desc.length))}
                </span>
              </div>
              <button className="btn small ghost" disabled={!list.length} aria-expanded={shown} onClick={() => setOpen(shown ? null : p.id)}>
                {shown ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {shown ? t('peopleHide') : t('peopleShow')}
              </button>
              <button className="btn small ghost icon" title={t('peopleRemove')} aria-label={`${t('peopleRemove')}: ${personLabel(p, people)}`} onClick={() => removePerson(p.id)}>
                <Trash2 size={14} />
              </button>
            </div>
            {shown && (
              <div className="people-matches">
                {list.slice(0, 80).map((x, i) => {
                  const m = media.get(x.mediaId)
                  return m ? <FaceTile key={`${x.mediaId}-${i}`} m={m} match={x} person={p} project={project} /> : null
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
