// "Problem melden…" (Settings → Troubleshooting, About): says what goes to GitHub before the browser
// opens the bug form (.github/ISSUE_TEMPLATE/bug.yml) with the app version, Windows version and graphics
// card filled in (src/shared/reportProblem.ts); nothing else is in the link. Offers the diagnostics
// package first, whose zip can then be dragged into the form.
import { useEffect, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { bugReportUrl, type ReportFields } from '@shared/reportProblem'
import { t } from '../i18n'
import { ErrorText } from '../errors'
import { DiagnosticsDialog } from './Diagnostics'
import { Modal } from './Modal'
import './help.css'

const NONE: ReportFields = { version: '', windows: '', gpu: '' }

export function ReportProblemDialog({ onClose }: { onClose: () => void }) {
  const [fields, setFields] = useState<ReportFields | null>(null)
  const [diagnostics, setDiagnostics] = useState(false)
  const [opened, setOpened] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let alive = true
    window.api
      .reportFields()
      .then((f) => alive && setFields(f))
      .catch(() => alive && setFields(NONE))
    return () => {
      alive = false
    }
  }, [])

  const open = async (): Promise<void> => {
    if (!fields) return
    setError(null)
    try {
      await window.api.openGithub(bugReportUrl(fields))
      setOpened(true)
    } catch (e) {
      setError(e)
    }
  }

  const value = (v: string | undefined): React.ReactNode => (fields ? v || <span className="unknown">{t('reportUnknown')}</span> : '…')
  return (
    <>
      <Modal
        title={t('reportTitle')}
        onClose={onClose}
        className="report-dialog"
        testId="report-dialog"
        actions={
          <>
            <button className="btn" data-testid="report-diagnostics" onClick={() => setDiagnostics(true)}>
              {t('diagButton')}
            </button>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              {opened ? t('close') : t('cancel')}
            </button>
            <button className="btn primary" disabled={!fields} data-testid="report-open-github" onClick={() => void open()}>
              {fields ? <ExternalLink size={14} aria-hidden /> : <Loader2 size={14} className="spin" aria-hidden />} {t('reportOpen')}
            </button>
          </>
        }
      >
        <p className="hint lead">{t('reportIntro')}</p>
        <h3 className="subhead">{t('reportSent')}</h3>
        <dl className="info wide report-fields" data-testid="report-fields">
          <dt>{t('reportVersion')}</dt>
          <dd data-field="version">{value(fields?.version)}</dd>
          <dt>Windows</dt>
          <dd data-field="windows">{value(fields?.windows)}</dd>
          <dt>{t('reportGpu')}</dt>
          <dd data-field="gpu">{value(fields?.gpu)}</dd>
        </dl>
        <p className="diag-privacy">{t('reportPrivacy')}</p>
        <p className="hint">{t('reportDiagHint')}</p>
        {opened && (
          <p className="hint report-opened" role="status">
            {t('reportOpened')}
          </p>
        )}
        {error !== null && <ErrorText err={error} />}
      </Modal>
      {diagnostics && <DiagnosticsDialog onClose={() => setDiagnostics(false)} />}
    </>
  )
}
