// "Nach dem Projekt aufräumen": the dialog that lists what the app keeps for a show (face data, the
// pupils' uploads, caches, older versions, undo history, export jobs) with sizes and removes what the user picks, for
// good (src/main/cleanup.ts); the same dialog deletes a whole show from the home screen. Also the
// deletion reminder: the date picker, the hint on the project card and the banner on the home screen.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { AlertTriangle, CalendarClock, Loader2, X } from 'lucide-react'
import { addMonths, CLEANUP_CATEGORIES, DELETE_MONTHS, deletionDue, historyGoes, NOTHING, startOfDay, type CleanupCategory, type CleanupChoice, type CleanupInventory, type CleanupResult } from '@shared/cleanup'
import type { ProjectSummary } from '@shared/types'
import { forgetUndoHistory, holdSaves, saveOpenProject, useStore } from '../store'
import { holdFaceAnalysis } from '../faces'
import { forgetFaceCrops } from '../faceCrops'
import { localeTag, t, type StringKey } from '../i18n'
import { ErrorText } from '../errors'
import { Modal } from './Modal'
import { Section } from './ui'
import './cleanup.css'

type Mode = 'cleanup' | 'delete'

const useCleanup = create<{ open: { projectId: string; mode: Mode } | null }>(() => ({ open: null }))

/** Opens the clean-up dialog of a show ('delete': deleting the whole show, from the home screen). */
export function openCleanup(projectId: string, mode: Mode = 'cleanup'): void {
  useCleanup.setState({ open: { projectId, mode } })
}

/** Mounted once (App.tsx): the dialog while one is open. */
export function CleanupHost() {
  const open = useCleanup((s) => s.open)
  if (!open) return null
  const close = (): void => useCleanup.setState({ open: null })
  return open.mode === 'delete' ? <DeleteDialog projectId={open.projectId} onClose={close} /> : <CleanupDialog projectId={open.projectId} onClose={close} />
}

/** Bytes as KB, MB or GB. */
export function fmtBytes(bytes: number): string {
  const n = (v: number, digits = 0): string => v.toLocaleString(localeTag(), { maximumFractionDigits: digits })
  if (bytes >= 1e9) return `${n(bytes / 1e9, 1)} GB`
  if (bytes >= 1e6) return `${n(bytes / 1e6, bytes >= 1e8 ? 0 : 1)} MB`
  return `${n(Math.max(bytes, bytes > 0 ? 1000 : 0) / 1e3)} KB`
}

const fill = (key: StringKey, values: Record<string, string | number>): string => Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), t(key))

const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString(localeTag(), { day: 'numeric', month: 'long', year: 'numeric' })

/** yyyy-mm-dd of a local date, for <input type="date">. */
const isoDay = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Saves the open project now (with its undo history) and loads what the app keeps for a show. */
async function loadInventory(projectId: string): Promise<CleanupInventory> {
  await saveOpenProject(projectId)
  return window.api.cleanupInventory(projectId)
}

/**
 * Runs the clean-up. An open show is saved first and its own saves wait while the main process
 * rewrites the file; the background face search stops, and afterwards the cleaned show replaces the
 * open one (the undo history goes too: it still holds the removed data).
 */
export async function runCleanup(projectId: string, choice: CleanupChoice): Promise<CleanupResult> {
  const release = holdFaceAnalysis()
  const open = useStore.getState().project?.id === projectId
  let resume: (() => void) | null = null
  try {
    // also drops a save still pending for a show that was just closed (closing saved it already)
    resume = await holdSaves()
    const result = await window.api.cleanupRun(projectId, choice)
    if (choice.faces) forgetFaceCrops()
    // the stored undo history is gone: the editor's goes too (a rewritten show starts afresh below anyway)
    if (open && historyGoes(choice)) forgetUndoHistory()
    resume?.()
    resume = null
    const s = useStore.getState()
    if (open && s.project?.id === projectId) {
      if (result.project) await s.openProjectData(result.project)
      // removed caches are made again in the background
      else await s.reloadMedia()
    }
    await useStore.getState().loadProjects()
    return result
  } finally {
    resume?.()
    release()
  }
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

// ---------------------------------------------------------------- deletion reminder

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

/** Hint on a project card whose deletion date has come; opens the clean-up. */
export function DeadlineBadge({ project }: { project: ProjectSummary }) {
  if (!deletionDue(project.deleteAt)) return null
  return (
    <button className="btn small due-badge" data-testid="deadline-due" title={`${t('deleteAtOn').replace('{date}', fmtDate(project.deleteAt!))} · ${t('cleanupOpen')}`} onClick={() => openCleanup(project.id)}>
      <CalendarClock size={13} aria-hidden /> {t('deleteAtDue')}
    </button>
  )
}

/** Shown once per start, when shows have reached their deletion date: open the clean-up or postpone. */
let bannerDismissed = false

export function CleanupBanner() {
  const projects = useStore((s) => s.projects)
  const [, redraw] = useState(0)
  const due = projects.filter((p) => deletionDue(p.deleteAt))
  if (bannerDismissed || !due.length) return null
  const dismiss = (): void => {
    bannerDismissed = true
    redraw((n) => n + 1)
  }
  return (
    <div className="banner cleanup-banner" role="status" data-testid="cleanup-banner">
      <CalendarClock size={16} aria-hidden />
      <span>
        <b>{t('deleteAtBanner')}</b> {due.map((p) => p.name).join(', ')}
      </span>
      <button className="btn small" onClick={() => openCleanup(due[0].id)}>
        {t('cleanupOpen')}
      </button>
      <button
        className="btn small"
        onClick={() => {
          dismiss()
          void Promise.all(due.map((p) => setDeleteAt(p.id, addMonths(Date.now(), 1)))).catch(() => {})
        }}
      >
        {t('deleteAtLater')}
      </button>
      <button className="btn ghost icon small" title={t('close')} aria-label={t('close')} onClick={dismiss}>
        <X size={14} />
      </button>
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

/** Settings → Privacy: the clean-up of any show. */
export function CleanupSetting() {
  const projects = useStore((s) => s.projects)
  const open = useStore((s) => s.project?.id)
  const [pick, setPick] = useState('')
  const id = pick || open || projects[0]?.id || ''
  return (
    <Section title={t('privacy')}>
      {/* without slideshows there is nothing to clean up: only the explanation */}
      {projects.length > 0 && (
        <div className="row wrap">
          <select aria-label={t('cleanupTitle')} value={id} onChange={(e) => setPick(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn small" disabled={!id} data-testid="cleanup-settings-open" onClick={() => openCleanup(id)}>
            {t('cleanupMenu')}
          </button>
        </div>
      )}
      <p className="hint">{t('cleanupSettingHint')}</p>
      <HistorySetting projectId={id} />
    </Section>
  )
}

/** The note on the stored undo history, and clearing it for the chosen show (the open one by default) or all shows. */
function HistorySetting({ projectId }: { projectId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<unknown>(null)
  useEffect(() => setState('idle'), [projectId])
  const clear = async (all: boolean): Promise<void> => {
    setState('busy')
    setError(null)
    try {
      // the open show forgets its steps first, so no save brings them back
      const open = useStore.getState().project?.id
      if (open && (all || open === projectId)) forgetUndoHistory()
      await window.api.clearHistory(all ? null : projectId)
      setState('done')
    } catch (e) {
      setError(e)
      setState('idle')
    }
  }
  return (
    <div className="history-setting" data-testid="history-setting">
      <p className="hint">{t('historySettingHint')}</p>
      <div className="row wrap">
        <button className="btn small" disabled={!projectId || state === 'busy'} data-testid="history-clear" onClick={() => void clear(false)}>
          {t('historyClear')}
        </button>
        <button className="btn small" disabled={state === 'busy'} data-testid="history-clear-all" onClick={() => void clear(true)}>
          {t('historyClearAll')}
        </button>
        {state === 'done' && (
          <span className="hint" role="status">
            {t('historyCleared')}
          </span>
        )}
      </div>
      {!!error && <ErrorText err={error} context="save" />}
    </div>
  )
}

// ---------------------------------------------------------------- the dialog

function Category(props: { id: CleanupCategory; title: string; size?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <div className={`cleanup-cat ${props.disabled ? 'off' : ''}`} data-category={props.id}>
      <label className="check">
        <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
        <span className="cleanup-head">
          <b>{props.title}</b>
          {props.size && <span className="val" data-testid={`cleanup-size-${props.id}`}>{props.size}</span>}
        </span>
      </label>
      <div className="cleanup-body">{props.children}</div>
    </div>
  )
}

const TITLES: Record<CleanupCategory, StringKey> = {
  faces: 'cleanupFaces',
  uploads: 'cleanupUploads',
  caches: 'cleanupCaches',
  backups: 'backupsTitle',
  history: 'cleanupHistory',
  exports: 'cleanupExports'
}

/** Who sent the uploads, and how many of them are pictures pasted with Ctrl+V. */
function UploadsInfo({ inv }: { inv: CleanupInventory }) {
  const pasted = inv.uploads.pasted ?? 0
  const sent = inv.uploads.files - pasted
  return (
    <>
      {sent > 0 && <p className="hint">{fill('cleanupUploadsInfo', { files: sent, people: inv.uploads.uploaders })}</p>}
      {pasted > 0 && <p className="hint">{fill('cleanupPasted', { n: pasted })}</p>}
    </>
  )
}

/** What a category frees with this choice, as the dialog sums it up. */
function chosenBytes(inv: CleanupInventory, c: CleanupChoice): number {
  return (
    (c.uploads === 'all' ? inv.uploads.bytes : c.uploads === 'leftOut' ? inv.uploads.leftOut.bytes : 0) +
    (c.caches ? inv.caches.bytes : 0) +
    (c.backups ? inv.backups.bytes : 0) +
    (historyGoes(c) ? inv.history.bytes : 0) +
    (c.exports ? inv.exports.bytes : 0)
  )
}

function Summary({ result }: { result: CleanupResult }) {
  const rows = CLEANUP_CATEGORIES.filter((c) => c !== 'faces' && result.removed[c].files > 0)
  return (
    <div className="cleanup-summary" data-testid="cleanup-summary" data-freed={result.freed}>
      <p>{t('cleanupDone')}</p>
      <ul>
        {result.faces && <li>{fill('cleanupDoneFaces', { media: result.faces.media, people: result.faces.people })}</li>}
        {rows.map((c) => (
          <li key={c} data-category={c}>
            {t(TITLES[c])}: {fill('cleanupFiles', { n: result.removed[c].files })}, {fmtBytes(result.removed[c].bytes)}
          </li>
        ))}
      </ul>
      <p>
        <b>{fill('cleanupFreed', { size: fmtBytes(result.freed) })}</b>
      </p>
      {result.failed.length > 0 && <p className="callout warn">{fill('cleanupFailed', { n: result.failed.length })}</p>}
      {result.busy > 0 && <p className="hint">{fill('cleanupBusy', { n: result.busy })}</p>}
    </div>
  )
}

export function CleanupDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [inv, setInv] = useState<CleanupInventory | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [choice, setChoice] = useState<CleanupChoice>(NOTHING)
  const [phase, setPhase] = useState<'choose' | 'confirm' | 'running' | 'done'>('choose')
  const [result, setResult] = useState<CleanupResult | null>(null)

  useEffect(() => {
    let alive = true
    loadInventory(projectId).then(
      (i) => {
        if (!alive) return
        setInv(i)
        // everything that can go is ticked, except the pupils' photos: those the user decides on
        setChoice({ faces: i.faces.media + i.faces.people > 0, uploads: 'none', caches: i.caches.folders > 0 && !i.exports.unfinished, backups: i.backups.files > 0, exports: i.exports.jobs > 0, history: i.history.files > 0 })
      },
      (e) => alive && setError(e)
    )
    return () => {
      alive = false
    }
  }, [projectId])

  const anything = !!inv && (choice.faces || choice.uploads !== 'none' || choice.caches || choice.backups || choice.exports || (!!choice.history && inv.history.files > 0))
  // the undo history holds the face data and uploads too: it goes with them
  const historyForced = choice.faces || choice.uploads !== 'none'
  const blocked = !!inv?.exports.unfinished
  const set = (patch: Partial<CleanupChoice>): void => setChoice((c) => ({ ...c, ...patch }))
  const run = async (): Promise<void> => {
    setPhase('running')
    try {
      setResult(await runCleanup(projectId, choice))
      setPhase('done')
    } catch (e) {
      setError(e)
      setPhase('choose')
    }
  }
  const busy = phase === 'running'

  const actions =
    phase === 'done' ? (
      <button className="btn primary" onClick={onClose}>
        {t('close')}
      </button>
    ) : (
      <>
        <button className="btn" onClick={onClose} disabled={busy}>
          {t('cancel')}
        </button>
        <button className="btn primary" data-testid="cleanup-run" disabled={!anything || busy} onClick={() => setPhase('confirm')}>
          {t('cleanupRemove')}
        </button>
      </>
    )

  return (
    <Modal title={t('cleanupTitle')} onClose={busy ? undefined : onClose} className="wide cleanup-dialog" testId="cleanup-dialog" actions={actions}>
      {inv && <p className="cleanup-name">{inv.name}</p>}
      {phase !== 'done' && <p className="hint lead">{t('cleanupIntro')}</p>}
      {!!error && <ErrorText err={error} context="save" />}
      {!inv && !error && <p className="hint">{t('loading')}</p>}
      {inv && phase === 'done' && result && <Summary result={result} />}
      {inv && phase !== 'done' && (
        <>
          <div className="cleanup-list" aria-busy={busy}>
            <Category id="faces" title={t('cleanupFaces')} checked={choice.faces} disabled={busy || inv.faces.media + inv.faces.people === 0} onChange={(v) => set({ faces: v })}>
              {inv.faces.media + inv.faces.people === 0 ? (
                <p className="hint">{t('cleanupFacesNone')}</p>
              ) : (
                <>
                  <p className="hint">{fill('cleanupFacesInfo', { media: inv.faces.media, people: inv.faces.people, named: inv.faces.named })}</p>
                  <p className="hint">{t('cleanupFacesHint')}</p>
                </>
              )}
            </Category>
            <Category
              id="uploads"
              title={t('cleanupUploads')}
              size={inv.uploads.files ? fmtBytes(inv.uploads.bytes) : undefined}
              checked={choice.uploads !== 'none'}
              disabled={busy || !inv.uploads.files || blocked}
              // the gentler choice first: only what is not in the show, when there is such
              onChange={(v) => set({ uploads: v ? (inv.uploads.leftOut.files ? 'leftOut' : 'all') : 'none' })}
            >
              {!inv.uploads.files ? (
                <p className="hint">{t('cleanupUploadsNone')}</p>
              ) : (
                <>
                  <UploadsInfo inv={inv} />
                  {choice.uploads !== 'none' && inv.uploads.inShow.files > 0 && (
                    <div className="cleanup-radios" role="radiogroup" aria-label={t('cleanupUploads')}>
                      <label className="check">
                        <input type="radio" name="uploads" checked={choice.uploads === 'leftOut'} onChange={() => set({ uploads: 'leftOut' })} disabled={busy || !inv.uploads.leftOut.files} />
                        <span>
                          {fill('cleanupUploadsLeftOut', { n: inv.uploads.leftOut.files })} · {fmtBytes(inv.uploads.leftOut.bytes)}
                        </span>
                      </label>
                      <label className="check">
                        <input type="radio" name="uploads" checked={choice.uploads === 'all'} onChange={() => set({ uploads: 'all' })} disabled={busy} />
                        <span>
                          {t('cleanupUploadsAll')} ({inv.uploads.files}) · {fmtBytes(inv.uploads.bytes)}
                        </span>
                      </label>
                    </div>
                  )}
                  {choice.uploads === 'all' && inv.uploads.inShow.slides > 0 && (
                    <p className="callout warn">
                      <AlertTriangle size={14} aria-hidden /> <span>{fill('cleanupUploadsWarn', { n: inv.uploads.inShow.slides })}</span>
                    </p>
                  )}
                  {inv.uploads.shared > 0 && <p className="hint">{fill('cleanupUploadsShared', { n: inv.uploads.shared })}</p>}
                </>
              )}
            </Category>
            <Category id="caches" title={t('cleanupCaches')} size={fmtBytes(inv.caches.bytes)} checked={choice.caches} disabled={busy || !inv.caches.folders || blocked} onChange={(v) => set({ caches: v })}>
              <p className="hint">
                {fill('cleanupFolders', { n: inv.caches.folders })} · {t('cleanupCachesHint')}
              </p>
              {inv.caches.shared > 0 && <p className="hint">{fill('cleanupCachesShared', { n: inv.caches.shared })}</p>}
            </Category>
            <Category id="backups" title={t('backupsTitle')} size={fmtBytes(inv.backups.bytes)} checked={choice.backups} disabled={busy || !inv.backups.files} onChange={(v) => set({ backups: v })}>
              <p className="hint">
                {fill('cleanupVersions', { n: inv.backups.files })} · {t('cleanupBackupsHint')}
              </p>
              {choice.faces && !choice.backups && inv.backups.files > 0 && <p className="hint">{t('cleanupBackupsScrub')}</p>}
            </Category>
            <Category
              id="history"
              title={t('cleanupHistory')}
              size={fmtBytes(inv.history.bytes)}
              checked={inv.history.files > 0 && historyGoes(choice)}
              disabled={busy || !inv.history.files || historyForced}
              onChange={(v) => set({ history: v })}
            >
              <p className="hint">{inv.history.files ? t('cleanupHistoryHint') : t('cleanupHistoryNone')}</p>
              {inv.history.files > 0 && historyForced && <p className="hint">{t('cleanupHistoryWith')}</p>}
            </Category>
            <Category id="exports" title={t('cleanupExports')} size={fmtBytes(inv.exports.bytes)} checked={choice.exports} disabled={busy || !inv.exports.jobs} onChange={(v) => set({ exports: v })}>
              <p className="hint">
                {fill('cleanupJobs', { n: inv.exports.jobs })} · {t('cleanupExportsHint')}
              </p>
            </Category>
          </div>
          {blocked && (
            <p className="callout warn">
              <AlertTriangle size={14} aria-hidden /> <span>{fill('cleanupUnfinished', { n: inv.exports.unfinished })}</span>
            </p>
          )}
          <Section title={t('deleteAtTitle')} className="cleanup-deadline">
            <DeadlinePicker projectId={projectId} value={inv.deleteAt} />
            <p className="hint">{t('deleteAtHint')}</p>
          </Section>
          {busy && (
            <p className="busy-line" role="status">
              <Loader2 size={14} className="spin" aria-hidden /> {t('cleanupRunning')}
            </p>
          )}
        </>
      )}
      {phase === 'confirm' && inv && (
        <Modal
          title={t('cleanupConfirmTitle')}
          onClose={() => setPhase('choose')}
          testId="cleanup-confirm"
          actions={
            <>
              <button className="btn" onClick={() => setPhase('choose')}>
                {t('back')}
              </button>
              <button className="btn danger" data-testid="cleanup-confirm-run" onClick={() => void run()}>
                {t('cleanupConfirm')}
              </button>
            </>
          }
        >
          <ul className="cleanup-confirm-list">
            {choice.faces && <li>{t('cleanupFaces')}</li>}
            {choice.uploads !== 'none' && (
              <li>
                {t('cleanupUploads')}: {choice.uploads === 'all' ? inv.uploads.files : inv.uploads.leftOut.files}
              </li>
            )}
            {choice.caches && <li>{t('cleanupCaches')}</li>}
            {choice.backups && <li>{t('backupsTitle')}</li>}
            {historyGoes(choice) && inv.history.files > 0 && <li>{t('cleanupHistory')}</li>}
            {choice.exports && <li>{t('cleanupExports')}</li>}
          </ul>
          <p>
            <b>{fmtBytes(chosenBytes(inv, choice))}</b>
          </p>
          <p className="callout warn">
            <AlertTriangle size={14} aria-hidden /> <span>{t('cleanupFinal')}</span>
          </p>
        </Modal>
      )}
    </Modal>
  )
}

/** Deleting a whole show (home screen): the file and older versions, and what else is chosen. */
export function DeleteDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [inv, setInv] = useState<CleanupInventory | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [wanted, setExtras] = useState({ caches: true, uploads: false, exports: true })
  const [busy, setBusy] = useState(false)
  const name = useStore((s) => s.projects.find((p) => p.id === projectId)?.name)
  // an export still to run needs its sources
  const blocked = !!inv?.exports.unfinished
  const extras = blocked ? { ...wanted, caches: false, uploads: false } : wanted

  useEffect(() => {
    let alive = true
    window.api.cleanupInventory(projectId).then(
      (i) => alive && setInv(i),
      // a show that can't be read is still deleted with its older versions
      () => alive && setInv(null)
    )
    return () => {
      alive = false
    }
  }, [projectId])

  const size = useMemo(
    () => (inv ? inv.backups.bytes + inv.history.bytes + (extras.caches ? inv.caches.bytes : 0) + (extras.uploads ? inv.uploads.bytes : 0) + (extras.exports ? inv.exports.bytes : 0) : 0),
    [inv, extras]
  )
  const remove = async (): Promise<void> => {
    setBusy(true)
    // a save still pending for the show (just closed) must not bring its file back
    const resume = await holdSaves().catch(() => () => {})
    try {
      await window.api.deleteProject(projectId, extras)
      await useStore.getState().loadProjects()
      onClose()
    } catch (e) {
      setError(e)
      setBusy(false)
    } finally {
      resume()
    }
  }
  return (
    <Modal
      title={t('deleteShow')}
      onClose={busy ? undefined : onClose}
      className="cleanup-dialog"
      testId="delete-dialog"
      actions={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </button>
          <button className="btn danger" data-testid="delete-run" disabled={busy} onClick={() => void remove()}>
            {busy ? <Loader2 size={14} className="spin" aria-hidden /> : null} {t('deleteFinal')}
          </button>
        </>
      }
    >
      <p className="cleanup-name">{inv?.name ?? name}</p>
      <p className="hint lead">{t('deleteIntro')}</p>
      {inv && (
        <>
          <h3 className="subhead">{t('deleteAlso')}</h3>
          <div className="cleanup-list">
            <Category id="caches" title={t('cleanupCaches')} size={fmtBytes(inv.caches.bytes)} checked={extras.caches} disabled={busy || !inv.caches.folders || blocked} onChange={(v) => setExtras({ ...extras, caches: v })}>
              <p className="hint">{t('cleanupCachesHint')}</p>
            </Category>
            <Category id="uploads" title={t('cleanupUploads')} size={fmtBytes(inv.uploads.bytes)} checked={extras.uploads} disabled={busy || !inv.uploads.files || blocked} onChange={(v) => setExtras({ ...extras, uploads: v })}>
              {inv.uploads.files ? <UploadsInfo inv={inv} /> : <p className="hint">{t('cleanupUploadsNone')}</p>}
            </Category>
            <Category id="exports" title={t('cleanupExports')} size={fmtBytes(inv.exports.bytes)} checked={extras.exports} disabled={busy || !inv.exports.jobs} onChange={(v) => setExtras({ ...extras, exports: v })}>
              <p className="hint">{t('cleanupExportsHint')}</p>
            </Category>
          </div>
          {blocked && (
            <p className="callout warn">
              <AlertTriangle size={14} aria-hidden /> <span>{fill('cleanupUnfinished', { n: inv.exports.unfinished })}</span>
            </p>
          )}
          <p>
            <b>{fmtBytes(size)}</b>
          </p>
        </>
      )}
      <p className="callout warn">
        <AlertTriangle size={14} aria-hidden /> <span>{t('cleanupFinal')}</span>
      </p>
      {!!error && <ErrorText err={error} context="save" />}
    </Modal>
  )
}
