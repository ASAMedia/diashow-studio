// Deleting a whole show from the home screen (Cleanup.tsx's CleanupHost opens it): it goes into the
// trash (Trash.tsx) with what belongs to it, listed with sizes; src/main/cleanup.ts does the work.
import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import type { CleanupInventory } from '@shared/cleanup'
import { holdSaves, useStore } from '../store'
import { fill, fmtBytes, t } from '../i18n'
import { ErrorText } from '../errors'
import { Modal } from './Modal'
import { loadTrash } from './Trash'

/**
 * Deleting a whole show (home screen): it goes into the trash with its older versions, undo history,
 * uploads and finished export jobs, listed with their sizes; its cache is deleted (src/main/cleanup.ts).
 */
export function DeleteDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [inv, setInv] = useState<CleanupInventory | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [refused, setRefused] = useState<{ unfinished?: number; gone?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const name = useStore((s) => s.projects.find((p) => p.id === projectId)?.name)
  // an export still to run needs the show's files
  const unfinished = refused?.unfinished ?? inv?.exports.unfinished ?? 0

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

  // what goes into the trash with it (the uploads another show uses stay with that one)
  const parts = inv
    ? [
        { id: 'backups', title: t('backupsTitle'), n: inv.backups.files ? fill('cleanupVersions', { n: inv.backups.files }) : '', bytes: inv.backups.bytes },
        { id: 'history', title: t('cleanupHistory'), n: '', bytes: inv.history.files ? inv.history.bytes : 0 },
        { id: 'uploads', title: t('cleanupUploads'), n: inv.uploads.files ? fill('cleanupFiles', { n: inv.uploads.files }) : '', bytes: inv.uploads.bytes },
        { id: 'exports', title: t('cleanupExports'), n: inv.exports.jobs ? fill('cleanupJobs', { n: inv.exports.jobs }) : '', bytes: inv.exports.bytes }
      ].filter((x) => x.bytes > 0 || x.n)
    : []
  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    // a save still pending for the show (just closed) must not bring its file back
    const resume = await holdSaves().catch(() => () => {})
    try {
      const r = await window.api.deleteProject(projectId)
      if ('refused' in r) {
        setRefused(r.refused === 'export-pending' ? { unfinished: r.unfinished ?? 1 } : { gone: true })
        setBusy(false)
        return
      }
      await useStore.getState().loadProjects()
      void loadTrash()
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
          <button className="btn danger" data-testid="delete-run" disabled={busy || unfinished > 0 || !!refused?.gone} onClick={() => void remove()}>
            {busy ? <Loader2 size={14} className="spin" aria-hidden /> : null} {t('deleteRun')}
          </button>
        </>
      }
    >
      <p className="cleanup-name">{inv?.name ?? name}</p>
      <p className="hint lead">{t('deleteIntro')}</p>
      {inv && (
        <>
          {parts.length > 0 && (
            <>
              <h3 className="subhead">{t('deleteAlso')}</h3>
              <ul className="cleanup-confirm-list trash-goes">
                {parts.map((x) => (
                  <li key={x.id} data-category={x.id}>
                    {x.title}
                    {x.n ? `: ${x.n}` : ''} · {fmtBytes(x.bytes)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {inv.uploads.shared > 0 && <p className="hint">{fill('cleanupUploadsShared', { n: inv.uploads.shared })}</p>}
          {inv.caches.folders > 0 && <p className="hint">{fill('deleteCache', { size: fmtBytes(inv.caches.bytes) })}</p>}
        </>
      )}
      {unfinished > 0 && (
        <p className="callout warn" data-testid="delete-blocked">
          <AlertTriangle size={14} aria-hidden /> <span>{fill('deleteBlocked', { n: unfinished })}</span>
        </p>
      )}
      {refused?.gone && <p className="callout warn">{t('deleteGone')}</p>}
      {!!error && <ErrorText err={error} context="save" />}
    </Modal>
  )
}
