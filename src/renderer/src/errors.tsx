// Friendly error messages in the UI: a technical failure becomes a short text that says what to do
// (src/shared/friendlyError.ts decides the kind), with the technical message kept as detail. Errors
// that have no place of their own (saving, opening a project, importing) appear as notices at the
// bottom of the window; a damaged project's notice offers "Repair…".
import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { create } from 'zustand'
import type { ProjectRef } from '@shared/diagnostics'
import { classifyError, errorMessage, type ErrorContext, type ErrorKind } from '@shared/friendlyError'
import { t, type StringKey } from './i18n'

const TEXT: Record<ErrorKind, StringKey> = {
  ffmpegMissing: 'errFfmpegMissing',
  diskFull: 'errDiskFull',
  fileTooLarge: 'errFileTooLarge',
  outOfMemory: 'errOutOfMemory',
  fileLocked: 'errFileLocked',
  fileMissing: 'errFileMissing',
  networkBlocked: 'errNetworkBlocked',
  unsupportedFile: 'errUnsupportedFile',
  encoderFailed: 'errEncoderFailed',
  gpuLost: 'errGpuLost',
  portBlocked: 'errPortBlocked',
  noNetwork: 'shareNoNetwork',
  projectDamaged: 'errProjectDamaged',
  projectTooNew: 'errProjectTooNew',
  openedFromZip: 'errOpenedFromZip'
}

export interface Friendly {
  kind: ErrorKind | null
  /** What happened and what to do, in the UI language. */
  text: string
  /** The technical message (for the tooltip, "Details" and the diagnostics package). */
  detail: string
}

/** The friendly text for an error; unknown failures keep their own message plus a hint. */
export function friendly(err: unknown, context?: ErrorContext): Friendly {
  const detail = err === 'missing' ? t('missing') : errorMessage(err)
  const kind = err === 'missing' ? 'fileMissing' : classifyError(err, context)
  if (kind) return { kind, text: t(TEXT[kind]), detail }
  return { kind: null, text: detail ? `${detail} – ${t('errReportHint')}` : t('errUnknown'), detail }
}

/** An error as the user sees it: the friendly text, with the technical message one click away. */
export function ErrorText({ err, context, className = 'error' }: { err: unknown; context?: ErrorContext; className?: string }) {
  const [open, setOpen] = useState(false)
  const f = friendly(err, context)
  const showDetail = !!f.kind && !!f.detail && f.detail !== f.text
  return (
    <div className={`${className} friendly-error`} data-kind={f.kind ?? 'other'}>
      <span>{f.text}</span>
      {showDetail && (
        <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('errHideDetails') : t('errDetails')}
        </button>
      )}
      {open && <code className="detail">{f.detail}</code>}
    </div>
  )
}

// ---- notices at the bottom of the window

export interface Notice {
  id: number
  title: string
  err: unknown
  context?: ErrorContext
  /** A damaged project: the notice offers to repair it. */
  repair?: ProjectRef
}

interface NoticeState {
  notices: Notice[]
  /** The repair dialog's project (src/renderer/src/components/ProjectRepair.tsx). */
  repair: ProjectRef | null
}

export const useNotices = create<NoticeState>(() => ({ notices: [], repair: null }))
let seq = 0

const TITLES: Record<ErrorContext, StringKey> = {
  import: 'errImportTitle',
  music: 'errImportTitle',
  export: 'errExportTitle',
  share: 'errShareTitle',
  project: 'errOpenTitle',
  save: 'errSaveTitle'
}

/**
 * Shows an error as a notice (at most 3; the same message is not repeated) and reports it for the log.
 * `repair`: the project the error belongs to, offered for repair when it is damaged.
 */
export function notifyError(err: unknown, context: ErrorContext, repair?: ProjectRef): void {
  const msg = errorMessage(err)
  if (!msg || msg === 'cancelled') return
  try {
    window.api.logError({ kind: 'error', message: `${context}: ${msg}`, stack: err instanceof Error ? err.stack : undefined })
  } catch {
    // no log: the notice still shows
  }
  const kind = classifyError(err, context)
  const notice: Notice = { id: ++seq, title: t(TITLES[context]), err, context, ...(repair && kind === 'projectDamaged' ? { repair } : {}) }
  useNotices.setState((s) => {
    if (s.notices.some((n) => errorMessage(n.err) === msg && n.context === context)) return s
    return { notices: [...s.notices, notice].slice(-3) }
  })
}

export function dismissNotice(id: number): void {
  useNotices.setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }))
}

export function openRepair(ref: ProjectRef): void {
  useNotices.setState({ repair: ref })
}

export function ErrorNotices() {
  const notices = useNotices((s) => s.notices)
  if (!notices.length) return null
  return (
    <div className="notice-stack" role="alert">
      {notices.map((n) => (
        <div key={n.id} className="notice" data-testid="error-notice">
          <AlertTriangle size={16} className="notice-icon" aria-hidden />
          <div className="notice-body">
            <b>{n.title}</b>
            <ErrorText err={n.err} context={n.context} className="notice-text" />
            {n.repair && (
              <button
                className="btn small"
                onClick={() => {
                  openRepair(n.repair!)
                  dismissNotice(n.id)
                }}
              >
                {t('repairOpen')}
              </button>
            )}
          </div>
          <button className="btn ghost icon small" title={t('close')} aria-label={t('close')} onClick={() => dismissNotice(n.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
