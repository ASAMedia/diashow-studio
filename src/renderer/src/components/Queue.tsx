// Export queue in the editor: one row per job, the queue dialog, and the chip in the title bar.
import { useEffect, useState } from 'react'
import { AlertTriangle, Check, FolderOpen, ListOrdered, Loader2, Play, Trash2, X } from 'lucide-react'
import type { ExportJobInfo } from '@shared/exportQueue'
import { chapterText, type Chapter } from '@shared/chapters'
import { useStore } from '../store'
import { fmtTime, t } from '../i18n'
import { friendly } from '../errors'
import { Modal } from './Modal'

const active = (j: ExportJobInfo): boolean => j.state === 'queued' || j.state === 'running'

function status(j: ExportJobInfo, waiting: boolean): string {
  const pct = Math.floor((j.frame / Math.max(1, j.totalFrames)) * 100)
  switch (j.state) {
    case 'running':
      if (j.phase === 'prepare') return t('queuePreparing')
      if (j.phase === 'finishing') return t('queueFinishing')
      return j.fps ? `${pct} % · ${fmtTime((j.totalFrames - j.frame) / j.fps)} ${t('remaining')}` : `${pct} %`
    case 'queued':
      return waiting ? t('queuePaused') : t('queueQueued')
    case 'paused':
      return `${t('queuePaused')} · ${pct} %`
    case 'done':
      return t('queueDone')
    case 'cancelled':
      return t('queueCancelled')
    case 'error':
      // what to do instead of FFmpeg's last line (that stays in the tooltip and the log)
      return `${t('queueError')}: ${friendly(j.error ?? '', 'export').text}`
  }
}

/** Puts the chapters on the clipboard as "0:00 Title" lines, e.g. for a YouTube description. */
export function CopyChaptersButton({ chapters }: { chapters: Chapter[] }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      className="btn small copy-chapters"
      title={copied ? t('chaptersCopied') : chapterText(chapters)}
      onClick={() => void navigator.clipboard.writeText(chapterText(chapters)).then(() => setCopied(true), () => {})}
    >
      {copied ? <Check size={13} /> : <ListOrdered size={13} />} {t('copyChapters')}
      <span className="sr-only" role="status">
        {copied ? t('chaptersCopied') : ''}
      </span>
    </button>
  )
}

/** A job with progress and the actions that fit its state. */
export function JobRow({ job }: { job: ExportJobInfo }) {
  const jobs = useStore((s) => s.exportJobs)
  // queued jobs only run while a worker runs, i.e. while some job is running (else after a restart)
  const waiting = job.state === 'queued' && !jobs.some((j) => j.state === 'running')
  const pct = job.state === 'done' ? 100 : (job.frame / Math.max(1, job.totalFrames)) * 100
  return (
    <div className={`job ${job.state}`}>
      <div className="row">
        <span className="job-name" title={job.outPath}>
          {job.name}
        </span>
        <span className="job-size">
          {job.width}×{job.height} · {job.codec === 'hevc' ? 'HEVC' : 'H.264'}
        </span>
      </div>
      <div className="bar" role="progressbar" aria-label={job.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="row job-status">
        <span className="text" title={job.state === 'error' ? job.error : undefined}>
          {job.state === 'running' && <Loader2 size={12} className="spin" aria-hidden />} {status(job, waiting)}
        </span>
        {(job.state === 'paused' || job.state === 'error' || waiting) && (
          <button className="btn small" onClick={() => void window.api.queueResume(job.id)}>
            <Play size={13} /> {t('queueResume')}
          </button>
        )}
        {job.state === 'done' && !!job.chapters?.length && <CopyChaptersButton chapters={job.chapters} />}
        {job.state === 'done' && (
          <button className="btn small" onClick={() => void window.api.revealInFolder(job.outPath)}>
            <FolderOpen size={13} /> {t('showInFolder')}
          </button>
        )}
        {active(job) && (
          <button className="btn small ghost icon" title={t('queueCancelJob')} aria-label={t('queueCancelJob')} onClick={() => void window.api.queueCancel(job.id)}>
            <X size={14} />
          </button>
        )}
        {job.state !== 'running' && !active(job) && (
          <button className="btn small ghost icon" title={t('queueRemove')} aria-label={t('queueRemove')} onClick={() => void window.api.queueRemove(job.id)}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

export function QueueDialog() {
  const jobs = useStore((s) => s.exportJobs)
  const set = useStore((s) => s.set)
  return (
    <Modal title={t('queue')} onClose={() => set({ dialog: null })} backdropClose className="wide">
      <p className="hint lead">{t('queueHint')}</p>
      {jobs.length === 0 ? (
        <p className="empty-note">{t('queueEmpty')}</p>
      ) : (
        <div className="jobs">
          {[...jobs].reverse().map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </div>
      )}
    </Modal>
  )
}

/** Title bar: progress of the running export, or a hint about interrupted ones. */
export function QueueChip() {
  const jobs = useStore((s) => s.exportJobs)
  const set = useStore((s) => s.set)
  const running = jobs.find((j) => j.state === 'running')
  const stuck = jobs.filter((j) => j.state === 'paused' || (j.state === 'queued' && !running)).length
  const queued = jobs.filter((j) => j.state === 'queued').length
  if (!running && !stuck) return null
  const open = (): void => set({ dialog: 'queue' })
  if (running) {
    const pct = Math.floor((running.frame / Math.max(1, running.totalFrames)) * 100)
    return (
      <button className="chip queue-chip" title={`${t('queue')}: ${running.name}`} onClick={open}>
        <Loader2 size={13} className="spin" aria-hidden /> {t('queue')} {running.phase === 'video' ? `${pct} %` : '…'}
        {queued > 0 ? ` +${queued}` : ''}
      </button>
    )
  }
  return (
    <button className="chip queue-chip warn" onClick={open}>
      <AlertTriangle size={13} aria-hidden /> {t('queueInterrupted').replace('{n}', String(stuck))}
    </button>
  )
}
