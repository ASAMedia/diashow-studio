// Sharing over the Wi-Fi (no internet): pupils scan a QR code and send their photos and videos into
// the open show ("Fotos einsammeln"), or download the finished video ("Video verteilen"). The server
// runs in the main process (src/main/share) only while this dialog is open.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, FolderOpen, Play, Square, Trash2, Upload } from 'lucide-react'
import { toString as qrSvg } from 'qrcode'
import type { ShareAddress, ShareStatus } from '@shared/share'
import { aspectValue } from '@shared/timeline'
import { queueExport } from '../engine/exporter'
import { useStore } from '../store'
import { localeTag, t } from '../i18n'
import { ErrorText } from '../errors'
import { Modal } from './Modal'
import { Check as CheckBox, Field, Seg } from './ui'

type Tab = 'collect' | 'distribute'
const NEWLINE = '\n'

/** Files that arrive within this time are imported together. */
const BATCH_MS = 1500
/** ... but none waits longer than this. */
const BATCH_MAX_MS = 5000

const size = (bytes: number): string =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toLocaleString(localeTag(), { maximumFractionDigits: 1 })} GB`
    : `${Math.max(1, Math.round(bytes / 1e6)).toLocaleString(localeTag())} MB`

function addressLabel(a: ShareAddress): string {
  const kind = a.kind === 'wifi' ? t('shareKindWifi') : a.kind === 'ethernet' ? t('shareKindEthernet') : a.kind === 'hotspot' ? t('shareKindHotspot') : a.kind === 'virtual' ? t('shareKindVirtual') : ''
  return `${kind ? `${kind} · ` : ''}${a.name} · ${a.address}${a.public ? ` · ${t('sharePublic')}` : ''}`
}

/** Even width × height with the short side `short` (like the export dialog). */
function dims(aspect: number, short: number): { w: number; h: number } {
  const even = (v: number): number => Math.round(v / 2) * 2
  return aspect >= 1 ? { w: even(short * aspect), h: short } : { w: short, h: even(short / aspect) }
}

const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export function ShareDialog() {
  const project = useStore((s) => s.project)
  const jobs = useStore((s) => s.exportJobs)
  const set = useStore((s) => s.set)
  const [tab, setTab] = useState<Tab>('collect')
  const [status, setStatus] = useState<ShareStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [qr, setQr] = useState('')
  const [copied, setCopied] = useState(false)
  const [mobileJob, setMobileJob] = useState<string | null>(null)
  const pending = useRef<{ paths: string[]; first: number; timer?: ReturnType<typeof setTimeout> }>({ paths: [], first: 0 })
  // where arrived files go: into their day by capture time, or behind the selected slide
  const [placement, setPlacement] = useState<'byTime' | 'selection'>('byTime')
  const placementRef = useRef(placement)
  placementRef.current = placement

  useEffect(() => {
    let alive = true
    void window.api.shareControl({ type: 'status' }).then((s) => alive && setStatus(s))
    const offUpdate = window.api.onShareUpdate((s) => alive && setStatus(s))
    // Arrived files go into the open show in batches: a class sending 200 photos is a few imports
    const flush = (): void => {
      const p = pending.current
      clearTimeout(p.timer)
      p.timer = undefined
      const paths = p.paths.splice(0)
      p.first = 0
      if (paths.length && useStore.getState().project) void useStore.getState().importMedia(paths, placementRef.current)
    }
    const offFiles = window.api.onShareFiles((ev) => {
      if (useStore.getState().project?.id !== ev.projectId) return
      const p = pending.current
      p.paths.push(...ev.paths)
      const now = Date.now()
      if (!p.first) p.first = now
      clearTimeout(p.timer)
      p.timer = setTimeout(flush, Math.max(0, Math.min(BATCH_MS, p.first + BATCH_MAX_MS - now)))
    })
    return () => {
      alive = false
      offUpdate()
      offFiles()
      flush()
      // the server only runs while the dialog is open
      void window.api.shareControl({ type: 'stop' })
    }
  }, [])

  const running = !!status?.running
  const url = tab === 'collect' ? status?.uploadUrl : status?.downloadUrl
  useEffect(() => {
    let alive = true
    setCopied(false)
    if (!url) {
      setQr('')
      return
    }
    qrSvg(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
      .then((svg) => alive && setQr(svg))
      .catch(() => alive && setQr(''))
    return () => {
      alive = false
    }
  }, [url])

  const control = async (cmd: Parameters<typeof window.api.shareControl>[0]): Promise<ShareStatus | null> => {
    setBusy(true)
    setError('')
    try {
      const s = await window.api.shareControl(cmd)
      setStatus(s)
      return s
    } catch (e) {
      setError((e as Error).message)
      return null
    } finally {
      setBusy(false)
    }
  }

  const start = async (): Promise<void> => {
    if (!project) return
    const s = await control({ type: 'start', projectId: project.id, projectName: project.name })
    // started for handing out a video: uploads stay closed until switched on
    if (s?.running && tab === 'distribute' && s.received.length === 0) await control({ type: 'collect', on: false })
  }

  // ---- distribute: finished exports and the phone-friendly version
  const offered = status?.offered ?? []
  const done = jobs.filter((j) => j.state === 'done')
  const offerable = done.filter((j) => !offered.some((o) => samePath(o.path, j.outPath)))
  const mobile = jobs.find((j) => j.id === mobileJob)
  const large = done.some((j) => Math.min(j.width, j.height) > 720)
  useEffect(() => {
    // the 720p version made from here is offered as soon as it is done
    if (mobile?.state === 'done' && running && !offered.some((o) => samePath(o.path, mobile.outPath))) {
      void window.api.shareControl({ type: 'offer', paths: [mobile.outPath] }).then(setStatus)
      setMobileJob(null)
    }
  }, [mobile?.state, mobile?.outPath, running, offered])

  const makeMobile = async (): Promise<void> => {
    if (!project) return
    setError('')
    try {
      const base = done.find((j) => Math.min(j.width, j.height) > 720)?.outPath ?? offered[0]?.path
      const out = base ? base.replace(/(\.[^.\\/]+)?$/, ' (720p).mp4') : await window.api.pickExportPath(`${project.name} (720p).mp4`)
      if (!out) return
      const { w, h } = dims(aspectValue(project.settings.aspect), 720)
      const enc = await window.api.encoders()
      const info = await queueExport(
        project,
        { outPath: out, width: w, height: h, fps: 30, codec: 'h264', quality: 'standard', hardware: !!enc.hardware.h264, locale: localeTag() },
        `${project.name} · 720p`
      )
      setMobileJob(info.id)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // ---- collect: received files per uploader, newest first
  const byUploader = useMemo(() => {
    const groups = new Map<string, NonNullable<ShareStatus['received']>>()
    for (const r of [...(status?.received ?? [])].reverse()) groups.set(r.uploader, [...(groups.get(r.uploader) ?? []), r])
    return [...groups.entries()]
  }, [status?.received])

  const limits = status?.limits
  // a public address (eduroam & co.): the server may be reachable from outside the Wi-Fi
  const publicAddress = running && !!status?.addresses.find((a) => a.address === status.address)?.public

  return (
    <Modal title={t('shareTitle')} onClose={() => set({ dialog: null })} className="wide share-dialog">
      <Seg
        label={t('shareTitle')}
        value={tab}
        options={[
          { id: 'collect', label: t('shareCollect') },
          { id: 'distribute', label: t('shareDistribute') }
        ]}
        onChange={setTab}
      />
      <p className="hint">{tab === 'collect' ? t('shareCollectIntro') : t('shareDistributeIntro')}</p>

      <div className="share-body">
        <div>
          {qr && running ? (
            <div className="share-qr" role="img" aria-label={t('shareQr')} dangerouslySetInnerHTML={{ __html: qr }} />
          ) : (
            <div className="share-qr off">{running ? '…' : t('shareStopped')}</div>
          )}
        </div>
        <div className="stack">
          {!running ? (
            <>
              <p className="share-note">{t('shareFirewall')}</p>
              <div className="row">
                <button className="btn primary share-start" disabled={busy || !project} onClick={() => void start()}>
                  <Play size={14} /> {t('shareStart')}
                </button>
              </div>
            </>
          ) : (
            <>
              {(status?.addresses.length ?? 0) > 1 && (
                <Field label={t('shareNetwork')}>
                  <select value={status?.address ?? ''} disabled={busy} onChange={(e) => void control({ type: 'address', address: e.target.value })}>
                    {status?.addresses.map((a) => (
                      <option key={a.address} value={a.address}>
                        {addressLabel(a)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <div className="share-url" data-testid={tab === 'collect' ? 'share-upload-url' : 'share-download-url'}>
                {url}
              </div>
              {publicAddress && (
                <p className="share-warning" data-testid="share-public-warning" role="alert">
                  <AlertTriangle size={14} aria-hidden /> {t('sharePublicWarning')}
                </p>
              )}
              <div className="row">
                <button
                  className="btn small"
                  onClick={() => {
                    if (!url) return
                    void navigator.clipboard.writeText(url).then(() => setCopied(true), () => {})
                  }}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? t('shareCopied') : t('shareCopy')}
                </button>
                <button className="btn small" disabled={busy} onClick={() => void control({ type: 'stop' })}>
                  <Square size={12} /> {t('shareStop')}
                </button>
              </div>
            </>
          )}
          {status?.error && <ErrorText err={status.error} context="share" />}
          {error && <ErrorText err={error} context="share" />}

          {tab === 'collect' && running && (
            <>
              <CheckBox checked={!!status?.collecting} onChange={(v) => void control({ type: 'collect', on: v })}>
                {t('shareAccept')}
              </CheckBox>
              <Field label={t('sharePlacement')}>
                <select value={placement} onChange={(e) => setPlacement(e.target.value as 'byTime' | 'selection')}>
                  <option value="byTime">{t('sharePlaceByTime')}</option>
                  <option value="selection">{t('sharePlaceSelection')}</option>
                </select>
              </Field>
              {limits && (
                <p className="hint" style={{ marginTop: 0 }}>
                  {t('shareLimits').replace('{p}', size(limits.photo)).replace('{v}', size(limits.video))} {t('shareAutoImport')}
                </p>
              )}
              <div className="share-section">
                <h3 className="subhead">
                  {t('shareReceived')} ({status?.received.length ?? 0})
                </h3>
                {!!status?.uploading && (
                  <span className="val" role="status">
                    <Upload size={12} aria-hidden /> {t('shareUploading').replace('{n}', String(status.uploading))}
                  </span>
                )}
                {status?.folder && (
                  <button className="btn small ghost" onClick={() => void window.api.revealInFolder(status.folder!)}>
                    <FolderOpen size={13} /> {t('shareOpenFolder')}
                  </button>
                )}
              </div>
              <div className="share-list" data-testid="share-received">
                {byUploader.length === 0 && <p className="hint">{t('shareNothingYet')}</p>}
                {byUploader.map(([who, files]) => (
                  <div key={who} className="share-who">
                    <div className="who" title={who}>
                      {who} · {files.length}
                    </div>
                    <div className="files" title={files.map((f) => f.name).join(NEWLINE)}>
                      {files
                        .slice(0, 12)
                        .map((f) => f.name)
                        .join(', ')}
                      {files.length > 12 ? ', …' : ''}
                    </div>
                  </div>
                ))}
              </div>
              <p className="hint">{t('shareNoConnect')}</p>
            </>
          )}

          {tab === 'distribute' && running && (
            <>
              <h3 className="subhead">{t('shareOffered')}</h3>
              <div className="share-list" data-testid="share-offered">
                {offered.length === 0 && <p className="hint">{t('shareNoOffers')}</p>}
                {offered.map((o) => (
                  <div key={o.id} className="share-row">
                    <span className="name" title={o.path}>
                      {o.name}
                    </span>
                    <span className="val">{size(o.size)}</span>
                    <span className="val">{t('shareDownloads').replace('{n}', String(o.downloads))}</span>
                    <button className="btn small ghost icon" title={t('shareUnoffer')} aria-label={`${t('shareUnoffer')}: ${o.name}`} onClick={() => void control({ type: 'unoffer', id: o.id })}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="row">
                <button className="btn small" disabled={busy} onClick={() => void control({ type: 'pickOffer' })}>
                  {t('sharePickFile')}
                </button>
              </div>
              {offerable.length > 0 && (
                <>
                  <h3 className="subhead">{t('shareFinished')}</h3>
                  <div className="share-list">
                    {offerable.map((j) => (
                      <div key={j.id} className="share-row">
                        <span className="name" title={j.outPath}>
                          {j.name}
                        </span>
                        <span className="val">
                          {j.width}×{j.height}
                        </span>
                        <button className="btn small" onClick={() => void control({ type: 'offer', paths: [j.outPath] })}>
                          {t('shareOfferIt')}
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {(large || mobile || offered.length > 0) && project && (
                <div className="share-note">
                  {t('shareMobileTip')}
                  <div className="row" style={{ marginTop: 6 }}>
                    {mobile && mobile.state !== 'done' ? (
                      <span className="val left" role="status">
                        {t('shareMaking720').replace(
                          '{s}',
                          mobile.state === 'running' ? `${Math.floor((mobile.frame / Math.max(1, mobile.totalFrames)) * 100)} %` : mobile.state === 'error' ? (mobile.error ?? t('queueError')) : t('queueQueued')
                        )}
                      </span>
                    ) : (
                      <button className="btn small" onClick={() => void makeMobile()}>
                        {t('shareMake720')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
