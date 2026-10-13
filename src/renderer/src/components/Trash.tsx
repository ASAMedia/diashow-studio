// The trash for slideshows (src/main/trash.ts): "Papierkorb (n)" on the home screen, the dialog that
// lists the deleted shows with their dates and sizes (restore, delete permanently, empty the trash),
// the reminder for shows in the trash whose deletion date has come, and the trash in Settings → Privacy.
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { AlertTriangle, CalendarClock, Loader2, RotateCcw, ScanFace, Trash2, X } from 'lucide-react'
import { deletionDue } from '@shared/cleanup'
import type { TrashContents, TrashEntry } from '@shared/trash'
import { useStore } from '../store'
import { localeTag, t, type StringKey } from '../i18n'
import { ErrorText } from '../errors'
import { Modal } from './Modal'
import { fmtBytes } from './Cleanup'

interface TrashState {
  contents: TrashContents | null
  open: boolean
  /** To delete permanently once confirmed: these keys, or everything ('all': emptying the trash). */
  ask: string[] | 'all' | null
}

const useTrash = create<TrashState>(() => ({ contents: null, open: false, ask: null }))

const fill = (key: StringKey, values: Record<string, string | number>): string => Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), t(key))

const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString(localeTag(), { day: 'numeric', month: 'long', year: 'numeric' })

/** Reads the trash again (after a delete, a restore, or when it changed by itself). */
export async function loadTrash(): Promise<void> {
  try {
    useTrash.setState({ contents: await window.api.trashList() })
  } catch {
    // the home screen works without it
  }
}

/** Opens the trash dialog; `ask`: what is to be deleted permanently, after the confirmation (the reminder banner, Settings → Privacy). */
export function openTrash(ask: string[] | 'all' | null = null): void {
  useTrash.setState({ open: true, ask })
  void loadTrash()
}

const countOf = (c: TrashContents | null): number => (c ? c.entries.length + c.problems.length : 0)

/** Home screen: "Papierkorb (n)" while it isn't empty. */
export function TrashButton() {
  const contents = useTrash((s) => s.contents)
  const projects = useStore((s) => s.projects)
  // a show deleted or restored changes the project list
  useEffect(() => void loadTrash(), [projects])
  useEffect(
    () =>
      window.api.onTrashChanged(() => {
        void loadTrash()
      }),
    []
  )
  const n = countOf(contents)
  if (!n) return null
  return (
    <div className="trash-link">
      <button className="btn ghost" data-testid="trash-open" onClick={() => openTrash()}>
        <Trash2 size={15} aria-hidden /> {fill('trashCount', { n })}
      </button>
    </div>
  )
}

/** Shown once per start, when shows in the trash have reached their deletion date: delete them permanently now. */
let dueDismissed = false

export function TrashDueBanner() {
  const contents = useTrash((s) => s.contents)
  const [, redraw] = useState(0)
  const due = (contents?.entries ?? []).filter((e) => deletionDue(e.deleteAt))
  if (dueDismissed || !due.length) return null
  return (
    <div className="banner cleanup-banner" role="status" data-testid="trash-due-banner">
      <CalendarClock size={16} aria-hidden />
      <span>
        <b>{t('trashDueBanner')}</b> {due.map((e) => e.name).join(', ')}
      </span>
      <button className="btn small" data-testid="trash-due-purge" onClick={() => openTrash(due.map((e) => e.id))}>
        {t('trashPurgeDots')}
      </button>
      <button
        className="btn ghost icon small"
        title={t('close')}
        aria-label={t('close')}
        onClick={() => {
          dueDismissed = true
          redraw((n) => n + 1)
        }}
      >
        <X size={14} />
      </button>
    </div>
  )
}

/** Settings → Privacy: how much the trash holds; open or empty it. */
export function TrashSetting() {
  const contents = useTrash((s) => s.contents)
  useEffect(() => void loadTrash(), [])
  const n = countOf(contents)
  return (
    <div className="trash-setting" data-testid="trash-setting">
      <p className="hint">{t('trashSettingHint')}</p>
      <div className="row wrap">
        <span className="trash-size" data-testid="trash-setting-size" data-bytes={contents?.bytes ?? 0}>
          {n ? fill('trashSettingInfo', { n, size: fmtBytes(contents!.bytes) }) : t('trashNone')}
        </span>
        <button className="btn small" disabled={!n} data-testid="trash-setting-open" onClick={() => openTrash()}>
          {t('trashOpen')}
        </button>
        <button className="btn small" disabled={!n} data-testid="trash-setting-empty" onClick={() => openTrash('all')}>
          {t('trashEmpty')}
        </button>
      </div>
    </div>
  )
}

/** Mounted once (Cleanup.tsx's CleanupHost): the dialog while it is open. */
export function TrashHost() {
  const open = useTrash((s) => s.open)
  return open ? <TrashDialog onClose={() => useTrash.setState({ open: false, ask: null })} /> : null
}

function TrashRow({ entry, busy, onRestore, onPurge }: { entry: TrashEntry; busy: boolean; onRestore: () => void; onPurge: () => void }) {
  return (
    <div className="trash-entry" data-testid="trash-entry" data-id={entry.id} data-deleted-at={entry.deletedAt} data-purge-at={entry.purgeAt} data-bytes={entry.bytes}>
      <div className="grow">
        <b title={entry.name}>{entry.name}</b>
        <span className="hint">
          {fill('trashDeletedOn', { date: fmtDate(entry.deletedAt) })} · {fill('trashPurgeOn', { date: fmtDate(entry.purgeAt) })}
        </span>
        <span className="hint">
          {entry.slideCount} {t('slides')} · {fmtBytes(entry.bytes)}
          {deletionDue(entry.deleteAt) && (
            <span className="chip due" title={t('deleteAtOn').replace('{date}', fmtDate(entry.deleteAt!))}>
              <CalendarClock size={12} aria-hidden /> {t('deleteAtDue')}
            </span>
          )}
          {entry.faces && (
            <span className="chip">
              <ScanFace size={12} aria-hidden /> {t('cleanupFaces')}
            </span>
          )}
        </span>
      </div>
      <button className="btn small" data-testid="trash-restore" disabled={busy} onClick={onRestore}>
        <RotateCcw size={13} aria-hidden /> {t('restore')}
      </button>
      <button className="btn small" data-testid="trash-purge" disabled={busy} onClick={onPurge}>
        {t('trashPurge')}
      </button>
    </div>
  )
}

function TrashDialog({ onClose }: { onClose: () => void }) {
  const contents = useTrash((s) => s.contents)
  const ask = useTrash((s) => s.ask)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<{ text: string; warn?: boolean } | null>(null)
  const entries = contents?.entries ?? []
  const problems = contents?.problems ?? []
  const n = entries.length + problems.length
  // what the confirmation is about (entries gone meanwhile left out)
  const all = ask === 'all' && n > 0
  const asked = all ? [] : Array.isArray(ask) ? ask.filter((k) => entries.some((e) => e.id === k) || problems.some((p) => p.key === k)) : []

  const restore = async (e: TrashEntry): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await window.api.trashRestore(e.id)
      if ('refused' in r) setNotice({ text: t(r.refused === 'id-taken' ? 'trashIdTaken' : 'trashNotFound'), warn: true })
      else setNotice({ text: `${fill('trashRestored', { name: r.name })}${r.renamed ? ` ${fill('trashRenamed', { n: r.renamed })}` : ''}` })
      await useStore.getState().loadProjects()
    } catch (err) {
      setError(err)
    } finally {
      await loadTrash()
      setBusy(false)
    }
  }

  const purge = async (keys: string[]): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      let failed = 0
      if (all) failed = (await window.api.trashEmpty()).failed.length
      else for (const key of keys) failed += (await window.api.trashPurge(key)).failed.length
      if (failed) setNotice({ text: fill('cleanupFailed', { n: failed }), warn: true })
    } catch (err) {
      setError(err)
    } finally {
      useTrash.setState({ ask: null })
      await loadTrash()
      setBusy(false)
    }
  }

  const askFor = (keys: string[] | 'all'): void => useTrash.setState({ ask: keys })
  const askedBytes = all ? (contents?.bytes ?? 0) : asked.reduce((sum, k) => sum + (entries.find((e) => e.id === k)?.bytes ?? problems.find((p) => p.key === k)?.bytes ?? 0), 0)
  const askedNames = asked.map((k) => entries.find((e) => e.id === k)?.name ?? t('trashDamaged'))

  return (
    <Modal
      title={t('trash')}
      onClose={busy ? undefined : onClose}
      className="wide trash-dialog"
      testId="trash-dialog"
      actions={
        <>
          <button className="btn" data-testid="trash-empty" disabled={busy || !n} onClick={() => askFor('all')}>
            <Trash2 size={14} aria-hidden /> {t('trashEmpty')}
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose} disabled={busy}>
            {t('close')}
          </button>
        </>
      }
    >
      <p className="hint lead">{t('trashIntro')}</p>
      {!!error && <ErrorText err={error} context="save" />}
      {notice && (
        <p className={notice.warn ? 'callout warn' : 'callout info'} role="status" data-testid="trash-notice">
          {notice.warn && <AlertTriangle size={14} aria-hidden />} <span>{notice.text}</span>
        </p>
      )}
      {!contents && <p className="hint">{t('loading')}</p>}
      {contents && !n && <p className="hint" data-testid="trash-none">{t('trashNone')}</p>}
      {n > 0 && (
        <div className="trash-list" aria-busy={busy}>
          {entries.map((e) => (
            <TrashRow key={e.id} entry={e} busy={busy} onRestore={() => void restore(e)} onPurge={() => askFor([e.id])} />
          ))}
          {problems.map((p) => (
            <div key={p.key} className="trash-entry damaged" data-testid="trash-problem">
              <AlertTriangle size={16} className="notice-icon" aria-hidden />
              <div className="grow">
                <b>{t('trashDamaged')}</b>
                <span className="hint">
                  {t('trashDamagedHint')} · {fmtBytes(p.bytes)}
                </span>
              </div>
              <button className="btn small" disabled={busy} onClick={() => askFor([p.key])}>
                {t('trashPurge')}
              </button>
            </div>
          ))}
        </div>
      )}
      {busy && (
        <p className="busy-line" role="status">
          <Loader2 size={14} className="spin" aria-hidden />
        </p>
      )}
      {(all || asked.length > 0) && (
        <Modal
          title={t('trashConfirmTitle')}
          onClose={busy ? undefined : () => useTrash.setState({ ask: null })}
          testId="trash-confirm"
          actions={
            <>
              <button className="btn" disabled={busy} onClick={() => useTrash.setState({ ask: null })}>
                {t('back')}
              </button>
              <button className="btn danger" data-testid="trash-confirm-run" disabled={busy} onClick={() => void purge(asked)}>
                {busy ? <Loader2 size={14} className="spin" aria-hidden /> : null} {t('trashPurge')}
              </button>
            </>
          }
        >
          {all ? (
            <p>{fill('trashConfirmAll', { n, size: fmtBytes(askedBytes) })}</p>
          ) : (
            <>
              <ul className="cleanup-confirm-list">
                {askedNames.map((name, i) => (
                  <li key={asked[i]}>{name}</li>
                ))}
              </ul>
              <p>
                <b>{fmtBytes(askedBytes)}</b>
              </p>
            </>
          )}
          <p className="callout warn">
            <AlertTriangle size={14} aria-hidden /> <span>{t('trashFinal')}</span>
          </p>
        </Modal>
      )}
    </Modal>
  )
}
