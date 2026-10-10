// Export queue in the editor: one row per job, the queue dialog, and the chip in the title bar.
import { useEffect, useState } from 'react'
import { AlertTriangle, Check, FolderOpen, ListOrdered, Loader2, Play, Trash2, X } from 'lucide-react'
import type { ExportJobInfo } from '@shared/exportQueue'
import { chapterText, type Chapter } from '@shared/chapters'
import { useStore } from '../store'
import { fmtTime, t } from '../i18n'
import { friendly } from '../errors'

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
      {copied ? <Check size={12} /> : <ListOrdered size={12} />} {t('copyChapters')}
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
      <div className="bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="row job-status">
        <span style={{ flex: 1 }} title={job.state === 'error' ? job.error : undefined}>
          {job.state === 'running' && <Loader2 size={12} className="spin" />} {status(job, waiting)}
        </span>
        {(job.state === 'paused' || job.state === 'error' || waiting) && (
          <button className="btn small" onClick={() => void window.api.queueResume(job.id)}>
            <Play size={12} /> {t('queueResume')}
          </button>
        )}
        {job.state === 'done' && !!job.chapters?.length && <CopyChaptersButton chapters={job.chapters} />}
        {job.state === 'done' && (
          <button className="btn small" onClick={() => void window.api.revealInFolder(job.outPath)}>
            <FolderOpen size={12} /> {t('showInFolder')}
          </button>
        )}
        {active(job) && (
          <button className="btn small ghost icon" title={t('cancel')} onClick={() => void window.api.queueCancel(job.id)}>
            <X size={13} />
          </button>
        )}
        {job.state !== 'running' && !active(job) && (
          <button className="btn small ghost icon" title={t('queueRemove')} onClick={() => void window.api.queueRemove(job.id)}>
            <Trash2 size={13} />
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
    <div className="overlay" onClick={() => set({ dialog: null })}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0, flex: 1 }}>{t('queue')}</h2>
          <button className="btn ghost icon" title={t('close')} onClick={() => set({ dialog: null })}>
            <X size={16} />
          </button>
        </div>
        {jobs.length === 0 && <p className="hint">{t('queueEmpty')}</p>}
        <div className="jobs">
          {[...jobs].reverse().map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </div>
        <p className="hint">{t('queueHint')}</p>
      </div>
    </div>
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
      <button className="chip queue-chip" title={running.name} onClick={open}>
        <Loader2 size={13} className="spin" /> {t('queue')} {running.phase === 'video' ? `${pct} %` : '…'}
        {queued > 0 ? ` +${queued}` : ''}
      </button>
    )
  }
  return (
    <button className="chip queue-chip warn" onClick={open}>
      <AlertTriangle size={13} /> {t('queueInterrupted').replace('{n}', String(stuck))}
    </button>
  )
}
