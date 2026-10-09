import { useEffect, useRef, useState } from 'react'
import type { AspectRatio, EncoderInfo, ExportProgress, ExportQuality, Project, VideoCodec } from '@shared/types'
import { aspectValue } from '@shared/timeline'
import { useStore } from '../store'
import { exportShow } from '../engine/exporter'
import { fmtTime, localeTag, pick, t } from '../i18n'

const HEIGHTS = [720, 1080, 1440, 2160]

function dims(aspect: number, short: number): { w: number; h: number } {
  const even = (v: number): number => Math.round(v / 2) * 2
  return aspect >= 1 ? { w: even(short * aspect), h: short } : { w: short, h: even(short / aspect) }
}

type Phase = 'setup' | 'running' | 'done' | 'error'

interface Preset {
  id: string
  name: { de: string; en: string }
  aspect?: AspectRatio
  short: number
  fps: number
  codec: VideoCodec
  quality: ExportQuality
}

const PRESETS: Preset[] = [
  { id: 'youtube1080', name: { de: 'YouTube 1080p', en: 'YouTube 1080p' }, aspect: '16:9', short: 1080, fps: 30, codec: 'h264', quality: 'high' },
  { id: 'youtube4k', name: { de: 'YouTube 4K', en: 'YouTube 4K' }, aspect: '16:9', short: 2160, fps: 30, codec: 'h264', quality: 'high' },
  { id: 'reel', name: { de: 'Instagram Reel / TikTok (9:16)', en: 'Instagram Reel / TikTok (9:16)' }, aspect: '9:16', short: 1080, fps: 30, codec: 'h264', quality: 'high' },
  { id: 'square', name: { de: 'Instagram Beitrag (1:1)', en: 'Instagram post (1:1)' }, aspect: '1:1', short: 1080, fps: 30, codec: 'h264', quality: 'high' },
  { id: 'whatsapp', name: { de: 'WhatsApp / E-Mail (klein)', en: 'WhatsApp / e-mail (small)' }, aspect: '16:9', short: 720, fps: 30, codec: 'h264', quality: 'standard' },
  { id: 'tv', name: { de: 'Fernseher / Beamer 1080p', en: 'TV / projector 1080p' }, aspect: '16:9', short: 1080, fps: 25, codec: 'h264', quality: 'max' }
]

export function ExportDialog() {
  const project = useStore((s) => s.project)!
  const set = useStore((s) => s.set)
  const [preset, setPreset] = useState('custom')
  const [aspectId, setAspectId] = useState<AspectRatio>(project.settings.aspect)
  const aspect = aspectValue(aspectId)
  const [short, setShort] = useState(1080)
  const [fps, setFps] = useState(30)
  const [codec, setCodec] = useState<VideoCodec>('h264')
  const [quality, setQuality] = useState<ExportQuality>('high')
  const [hardware, setHardware] = useState(true)
  const [enc, setEnc] = useState<EncoderInfo | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('setup')
  const [progress, setProgress] = useState({ frame: 0, total: 1, speed: 0 })
  const [mainPhase, setMainPhase] = useState<ExportProgress['phase'] | null>(null)
  const [prepare, setPrepare] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const abort = useRef<AbortController | null>(null)
  const busy = project.media.some((m) => m.status === 'pending' || m.status === 'processing') || project.music.some((m) => m.status === 'pending' || m.status === 'processing')

  useEffect(() => {
    void window.api.encoders().then(setEnc)
    return window.api.onExportProgress((p) => {
      setMainPhase(p.phase)
      if (p.phase === 'prepare') setPrepare(p.message ?? '')
    })
  }, [])

  const hwName = enc?.hardware[codec]
  const { w, h } = dims(aspect, short)

  const choose = async (): Promise<string | null> => {
    const p = await window.api.pickExportPath(`${project.name}.mp4`)
    if (p) setPath(p)
    return p
  }

  const start = async (): Promise<void> => {
    const out = path ?? (await choose())
    if (!out) return
    setPhase('running')
    setError('')
    abort.current = new AbortController()
    try {
      // another shape than the project: layouts are rebuilt for it
      let job: Project = aspectId === project.settings.aspect ? project : { ...project, settings: { ...project.settings, aspect: aspectId } }
      // sharp 4K: videos that only have a 1080p proxy get a high-resolution version first
      const proxied = job.media.filter((m) => m.kind === 'video' && m.proxied && Math.max(m.width, m.height) > 1920)
      if (Math.max(w, h) > 1920 && proxied.length) {
        setMainPhase('prepare')
        const paths = await window.api.prepareHires(proxied.map((m) => m.id), Math.max(w, h))
        job = { ...job, media: job.media.map((m) => (paths[m.id] ? { ...m, playback: paths[m.id] } : m)) }
      }
      const file = await exportShow(job, { outPath: out, width: w, height: h, fps, codec, quality, hardware: hardware && !!hwName }, localeTag(), setProgress, abort.current.signal)
      setResult(file)
      setPhase('done')
    } catch (e) {
      if ((e as Error).name === 'AbortError') setPhase('setup')
      else {
        setError((e as Error).message)
        setPhase('error')
      }
    }
  }

  const remaining = progress.speed * (progress.total - progress.frame)
  const pct = Math.round((progress.frame / progress.total) * 100)

  return (
    <div className="overlay">
      <div className="dialog">
        <h2>{t('exportTitle')}</h2>
        {phase === 'setup' && (
          <>
            <div className="grid">
              <span>{t('preset')}</span>
              <select
                value={preset}
                onChange={(e) => {
                  setPreset(e.target.value)
                  const pr = PRESETS.find((x) => x.id === e.target.value)
                  if (!pr) return
                  if (pr.aspect) setAspectId(pr.aspect)
                  setShort(pr.short)
                  setFps(pr.fps)
                  setCodec(pr.codec)
                  setQuality(pr.quality)
                }}
              >
                <option value="custom">{t('presetCustom')}</option>
                {PRESETS.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pick(pr.name)}
                  </option>
                ))}
              </select>
              <span>{t('file')}</span>
              <div className="row">
                <input type="text" readOnly value={path ?? ''} placeholder={`${project.name}.mp4`} style={{ flex: 1 }} />
                <button className="btn small" onClick={() => void choose()}>
                  {t('choose')}
                </button>
              </div>
              <span>{t('aspect')}</span>
              <select value={aspectId} onChange={(e) => setAspectId(e.target.value as AspectRatio)}>
                {(['16:9', '4:3', '1:1', '9:16'] as AspectRatio[]).map((a) => (
                  <option key={a} value={a}>
                    {a}
                    {a === project.settings.aspect ? ` (${t('projectAspect')})` : ''}
                  </option>
                ))}
              </select>
              <span>{t('resolution')}</span>
              <select value={short} onChange={(e) => setShort(Number(e.target.value))}>
                {HEIGHTS.map((s) => {
                  const d = dims(aspect, s)
                  return (
                    <option key={s} value={s}>
                      {s === 2160 ? '4K' : `${s}p`} · {d.w} × {d.h}
                    </option>
                  )
                })}
              </select>
              <span>{t('frameRate')}</span>
              <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                {[24, 25, 30, 50, 60].map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
              <span>{t('codec')}</span>
              <select value={codec} onChange={(e) => setCodec(e.target.value as VideoCodec)}>
                <option value="h264">H.264 (MP4)</option>
                <option value="hevc">HEVC / H.265 (MP4)</option>
              </select>
              <span>{t('quality')}</span>
              <select value={quality} onChange={(e) => setQuality(e.target.value as ExportQuality)}>
                <option value="standard">{t('qStandard')}</option>
                <option value="high">{t('qHigh')}</option>
                <option value="max">{t('qMax')}</option>
              </select>
              <span />
              <label className="check">
                <input type="checkbox" checked={hardware && !!hwName} disabled={!hwName} onChange={(e) => setHardware(e.target.checked)} />
                <span>
                  {t('hardware')}
                  {hwName ? ` (${hwName})` : ''}
                </span>
              </label>
            </div>
            {enc && !hwName && <p className="hint">{t('noHardware')}</p>}
            {aspectId !== project.settings.aspect && <p className="hint">{t('aspectRelayout')}</p>}
            {busy && <p className="warn">{t('stillProcessing')}</p>}
            <div className="actions">
              <button className="btn" onClick={() => set({ exportOpen: false })}>
                {t('cancel')}
              </button>
              <button className="btn primary" onClick={() => void start()} disabled={busy}>
                {t('startExport')}
              </button>
            </div>
          </>
        )}
        {phase === 'running' && (
          <>
            <p>
              {mainPhase === 'prepare' && progress.frame === 0
                ? `${t('preparingHires')} ${prepare}`
                : mainPhase === 'audio' && progress.frame === 0
                  ? t('mixingAudio')
                  : t('exporting')}
            </p>
            <div className="bar">
              <div style={{ width: `${pct}%` }} />
            </div>
            <div className="row" style={{ color: 'var(--text-2)', fontSize: 12, marginTop: 6 }}>
              <span style={{ flex: 1 }}>
                {progress.frame} / {progress.total} · {pct} %
              </span>
              {progress.frame > 10 && (
                <span>
                  {fmtTime(remaining)} {t('remaining')}
                </span>
              )}
            </div>
            <div className="actions">
              <button className="btn" onClick={() => abort.current?.abort()}>
                {t('cancel')}
              </button>
            </div>
          </>
        )}
        {phase === 'done' && (
          <>
            <p>{t('exportDone')}</p>
            <p className="hint" style={{ wordBreak: 'break-all' }}>
              {result}
            </p>
            <div className="actions">
              <button className="btn" onClick={() => void window.api.revealInFolder(result)}>
                {t('showInFolder')}
              </button>
              <button className="btn primary" onClick={() => set({ exportOpen: false })}>
                {t('close')}
              </button>
            </div>
          </>
        )}
        {phase === 'error' && (
          <>
            <p className="error">
              {t('exportFailed')}: {error}
            </p>
            <div className="actions">
              <button className="btn" onClick={() => setPhase('setup')}>
                {t('back')}
              </button>
              <button className="btn primary" onClick={() => set({ exportOpen: false })}>
                {t('close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
