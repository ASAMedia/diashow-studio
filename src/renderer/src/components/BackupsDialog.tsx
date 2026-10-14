// "Restore an older version…" ("⋯" menu): the automatic backups of the open show (projects.ts) and
// restoring one of them.
import { useEffect, useState } from 'react'
import type { BackupInfo } from '@shared/types'
import { useStore } from '../store'
import { localeTag, t } from '../i18n'
import { Modal } from './Modal'

export function BackupsDialog() {
  const project = useStore((s) => s.project)!
  const set = useStore((s) => s.set)
  const [list, setList] = useState<BackupInfo[] | null>(null)
  useEffect(() => {
    void window.api.listBackups(project.id).then(setList)
  }, [project.id])
  const fmt = new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' })
  const close = (): void => set({ dialog: null })
  return (
    <Modal
      title={t('backupsTitle')}
      onClose={close}
      actions={
        <button className="btn primary" onClick={close}>
          {t('close')}
        </button>
      }
    >
      <p className="hint lead">{t('backupsHint')}</p>
      {!list ? (
        <p className="hint">{t('loading')}</p>
      ) : list.length === 0 ? (
        <p className="empty-note">{t('noBackups')}</p>
      ) : (
        <div className="stack">
          {list.map((b) => (
            <div key={b.file} className="row backup">
              <span className="when">{fmt.format(b.savedAt)}</span>
              <span className="val">
                {b.slideCount} {t('entries')}
              </span>
              <button
                className="btn small"
                onClick={async () => {
                  const p = await window.api.restoreBackup(b.file)
                  set({ dialog: null })
                  await useStore.getState().openProjectData(p)
                }}
              >
                {t('restore')}
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
