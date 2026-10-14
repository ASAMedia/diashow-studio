// The deletion date of a show ("Löschfrist"): the picker (in the clean-up dialog, and offered after an
// export) and setting it, also for a show that is not open. When the date has come, the home screen's
// badge and banner open the clean-up (Cleanup.tsx).
import { useEffect, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { addMonths, DELETE_MONTHS, deletionDue, startOfDay } from '@shared/cleanup'
import { useStore } from '../store'
import { fill, fmtDate, t } from '../i18n'

/** yyyy-mm-dd of a local date, for <input type="date">. */
const isoDay = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Sets or clears a show's deletion reminder (an open show through the editor, as an edit). */
export async function setDeleteAt(projectId: string, at: number | null): Promise<void> {
  const s = useStore.getState()
  if (s.project?.id === projectId) {
    s.update((p) => {
      if (at === null) delete p.deleteAt
      else p.deleteAt = startOfDay(at)
    })
  } else await window.api.setDeleteAt(projectId, at === null ? null : startOfDay(at))
  await useStore.getState().loadProjects()
}

/** The deletion date of a show: none, in 1 / 3 / 6 / 12 months, or a date. */
export function DeadlinePicker({ projectId, value, onChange }: { projectId: string; value?: number; onChange?: (at: number | null) => void }) {
  const [at, setAt] = useState<number | undefined>(value)
  useEffect(() => setAt(value), [value])
  const apply = (next: number | null): void => {
    setAt(next ?? undefined)
    onChange?.(next)
    void setDeleteAt(projectId, next)
  }
  return (
    <div className="deadline" data-testid="deadline">
      <div className="row wrap">
        <select
          aria-label={t('deleteAtTitle')}
          value={at ? 'date' : ''}
          onChange={(e) => {
            const v = e.target.value
            if (!v) apply(null)
            else if (v !== 'date') apply(addMonths(Date.now(), Number(v)))
            else if (!at) apply(addMonths(Date.now(), 3))
          }}
        >
          <option value="">{t('deleteAtNone')}</option>
          {DELETE_MONTHS.map((n) => (
            <option key={n} value={n}>
              {n === 1 ? t('deleteAtMonth') : fill('deleteAtMonths', { n })}
            </option>
          ))}
          <option value="date">{at ? fmtDate(at) : t('deleteAtPick')}</option>
        </select>
        {at !== undefined && (
          <input
            type="date"
            aria-label={t('deleteAtPick')}
            value={isoDay(at)}
            onChange={(e) => {
              const [y, m, d] = e.target.value.split('-').map(Number)
              if (y && m && d) apply(new Date(y, m - 1, d).getTime())
            }}
          />
        )}
        {at !== undefined && deletionDue(at) && (
          <span className="chip due">
            <CalendarClock size={13} aria-hidden /> {t('deleteAtDue')}
          </span>
        )}
      </div>
    </div>
  )
}

/** After an export was queued: the show is probably finished, so offer the deletion date. */
export function DeadlineNudge() {
  const project = useStore((s) => s.project)
  if (!project || project.deleteAt) return null
  return (
    <div className="deadline-nudge">
      <p className="hint">{t('deleteAtNudge')}</p>
      <DeadlinePicker projectId={project.id} />
    </div>
  )
}
