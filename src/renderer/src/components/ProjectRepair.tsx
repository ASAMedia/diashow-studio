// Damaged projects: the list on the home screen (files that cannot be opened), the repair dialog
// (rescue what is readable, or go back to a backup) and the notice after a project had to be repaired
// when it was opened. DiagnosticsHost puts the notices and the dialog into the window and logs export
// and import failures.
import { useEffect, useState } from 'react'
import { AlertTriangle, Info, Loader2, Wrench, X } from 'lucide-react'
import type { DamagedProject, ProjectRef, ProjectReportEvent, RepairPlan, RepairReport } from '@shared/diagnostics'
import { useStore } from '../store'
import { count, localeTag, t, type StringKey } from '../i18n'
import { ErrorNotices, ErrorText, notifyError, openRepair, useNotices } from '../errors'
import { logEvent } from '../diagnostics'
import { Modal } from './Modal'
import { RepeatNotice } from './RepeatNotice'
import { Section } from './ui'

const REPORT_TEXT: Record<RepairReport['changes'][number]['code'], StringKey> = {
  truncated: 'repTruncated',
  migrated: 'repMigrated',
  basics: 'repBasics',
  listsMissing: 'repListsMissing',
  settings: 'repSettings',
  entriesDropped: 'repEntriesDropped',
  entriesMissingMedia: 'repEntriesMissingMedia',
  entriesRepaired: 'repEntriesRepaired',
  mediaDropped: 'repMediaDropped',
  mediaRepaired: 'repMediaRepaired',
  musicDropped: 'repMusicDropped',
  musicRepaired: 'repMusicRepaired',
  peopleDropped: 'repPeopleDropped'
}

/** One line per change of a repair report. */
export function reportLines(report: RepairReport): string[] {
  return report.changes.map((c) => count(REPORT_TEXT[c.code], c.count, { v: report.fromVersion ?? '?' }))
}

const fmtDate = (ms: number): string => new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(ms)

/** Project files on the home screen that cannot be opened as they are. */
export function DamagedProjects() {
  const projects = useStore((s) => s.projects)
  const [list, setList] = useState<DamagedProject[]>([])
  const repair = useNotices((s) => s.repair)
  useEffect(() => {
    let alive = true
    window.api
      .damagedProjects()
      .then((l) => alive && setList(l))
      .catch(() => {})
    return () => {
      alive = false
    }
    // a finished repair changes the project list
  }, [projects, repair])
  if (!list.length) return null
  return (
    <div className="damaged-projects" data-testid="damaged-projects">
      {list.map((d) => (
        <div key={d.id} className="damaged-project">
          <AlertTriangle size={16} className="notice-icon" aria-hidden />
          <div className="grow">
            <b title={d.name || d.id}>{d.name || d.id}</b>
            <span className="hint">
              {d.reason === 'too-new' ? t('damagedTooNew') : t('damagedHint')} · {fmtDate(d.modifiedAt)}
            </span>
          </div>
          {d.reason === 'damaged' && (
            <button className="btn small" onClick={() => openRepair({ id: d.id })}>
              <Wrench size={13} /> {t('repairOpen')}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export function RepairDialog({ target }: { target: ProjectRef }) {
  const [plan, setPlan] = useState<RepairPlan | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const close = (): void => useNotices.setState({ repair: null })

  useEffect(() => {
    let alive = true
    window.api
      .inspectRepair(target)
      .then((p) => alive && setPlan(p))
      .catch((e) => alive && setError(e))
    return () => {
      alive = false
    }
  }, [target])

  const run = async (choice: Parameters<typeof window.api.repairProject>[1]): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const p = await window.api.repairProject(target, choice)
      close()
      await useStore.getState().openProjectData(p)
      void useStore.getState().loadProjects()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const usable = plan?.backups.filter((b) => !b.damaged) ?? []
  return (
    <Modal
      title={t('repairTitle')}
      onClose={close}
      className="wide repair-dialog"
      testId="repair-dialog"
      actions={
        <button className="btn" onClick={close}>
          {t('cancel')}
        </button>
      }
    >
      <p className="hint lead">{t('repairIntro')}</p>
      {!plan && !error && (
        <p className="hint busy-line" role="status">
          <Loader2 size={13} className="spin" aria-hidden /> {t('loading')}
        </p>
      )}
      {plan && (
        <>
          <Section title={t('repairSalvage')}>
            {plan.salvage ? (
              <>
                <p className="repair-name">
                  <b>{plan.salvage.name}</b>
                  <span>
                    {t('repairCounts')
                      .replace('{s}', String(plan.salvage.slides))
                      .replace('{m}', String(plan.salvage.media))
                      .replace('{t}', String(plan.salvage.music))}
                  </span>
                </p>
                {plan.salvage.report.changes.length > 0 && (
                  <ul className="repair-report">
                    {reportLines(plan.salvage.report).map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                )}
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn primary" disabled={busy} onClick={() => void run({ kind: 'salvage' })} data-testid="repair-salvage">
                    {t('repairUseSalvage')}
                  </button>
                </div>
              </>
            ) : (
              <p className="empty-note">{t('repairNothing')}</p>
            )}
          </Section>
          {'id' in target && (
            <Section title={t('repairBackups')}>
              {plan.backups.length === 0 ? (
                <p className="empty-note">{t('noBackups')}</p>
              ) : (
                <div className="stack">
                  {plan.backups.map((b) => (
                    <div key={b.file} className="row backup">
                      <span className="when">{fmtDate(b.savedAt)}</span>
                      <span className="val">{b.damaged ? t('repairBackupDamaged') : count('slideCount', b.slideCount)}</span>
                      <button className="btn small" disabled={busy || !!b.damaged} onClick={() => void run({ kind: 'backup', file: b.file })}>
                        {t('restore')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {usable.length > 0 && plan.salvage && <p className="hint">{t('repairCompare')}</p>}
            </Section>
          )}
          <p className="hint">{t('repairKept')}</p>
        </>
      )}
      {error !== null && <ErrorText err={error} context="project" />}
    </Modal>
  )
}

/** "This project was repaired when it was opened": what changed, with the way back (older versions). */
function ReportNotice({ event, onClose }: { event: ProjectReportEvent; onClose: () => void }) {
  const set = useStore((s) => s.set)
  return (
    <div className="notice info" data-testid="project-report" role="status">
      <Info size={16} className="notice-icon" aria-hidden />
      <div className="notice-body">
        <b>{event.source === 'repair' ? t('repReportRepaired') : t('repReportTitle')}</b>
        <ul className="repair-report">
          {reportLines(event.report).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {event.source !== 'repair' && (
          <button
            className="btn small"
            onClick={() => {
              set({ dialog: 'backups' })
              onClose()
            }}
          >
            {t('backups')}
          </button>
        )}
      </div>
      <button className="btn ghost icon small" title={t('close')} aria-label={t('close')} onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  )
}

/**
 * Notices, the repair dialog and the log watch for the editor window: rendered once in App.
 * Reports arrive before the project they belong to is open; they wait for it.
 */
export function DiagnosticsHost() {
  const repair = useNotices((s) => s.repair)
  const projectId = useStore((s) => s.project?.id)
  const [reports, setReports] = useState<ProjectReportEvent[]>([])

  useEffect(() => {
    const off = window.api.onProjectReport((ev) => setReports((list) => [...list.filter((r) => r.projectId !== ev.projectId), ev].slice(-5)))
    // failures worth a line in the log: exports that end in an error, files that cannot be read
    const seenJobs = new Set<string>()
    const seenMedia = new Set<string>()
    const unsub = useStore.subscribe((s, prev) => {
      if (s.exportJobs !== prev.exportJobs) {
        for (const j of s.exportJobs) {
          if (j.state === 'error' && !seenJobs.has(j.id)) {
            seenJobs.add(j.id)
            logEvent('export', `export ${j.width}x${j.height} ${j.codec} failed: ${j.error ?? '?'}`)
          }
        }
      }
      if (s.project && s.project.media !== prev.project?.media) {
        for (const m of s.project.media) {
          if (m.status === 'error' && m.error && m.error !== 'missing' && m.error !== 'cancelled' && !seenMedia.has(m.id)) {
            seenMedia.add(m.id)
            logEvent('media', `${m.kind} (${m.format || '?'}) could not be processed: ${m.error}`)
          }
        }
      }
    })
    return () => {
      off()
      unsub()
    }
  }, [])

  const shown = reports.filter((r) => r.projectId === projectId)
  return (
    <>
      {shown.length > 0 && (
        <div className="notice-stack upper">
          {shown.map((r) => (
            <ReportNotice key={r.projectId} event={r} onClose={() => setReports((list) => list.filter((x) => x !== r))} />
          ))}
        </div>
      )}
      <ErrorNotices>
        <RepeatNotice />
      </ErrorNotices>
      {repair && <RepairDialog target={repair} />}
    </>
  )
}

/** Opens a project and shows a friendly error (with "Repair…" for a damaged one) when it fails. */
export async function openProjectSafely(id: string): Promise<void> {
  try {
    await useStore.getState().openProject(id)
  } catch (e) {
    notifyError(e, 'project', { id })
  }
}

/** Imports a .dshow file (open dialog, double click) with the same error handling. */
export async function importProjectSafely(path: string | null): Promise<void> {
  try {
    // the path is known before anything is read: a damaged file can be offered for repair
    const file = path ?? (await window.api.pickProjectFile())
    if (!file) return
    path = file
    await useStore.getState().openProjectData(await window.api.importProjectFile(file))
  } catch (e) {
    notifyError(e, 'project', path ? { path } : undefined)
  }
}
