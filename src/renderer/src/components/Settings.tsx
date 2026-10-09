import { useEffect, useState } from 'react'
import { FolderSearch, X } from 'lucide-react'
import type { BackupInfo, CacheInfo } from '@shared/types'
import { useStore } from '../store'
import { localeTag, t } from '../i18n'

export type PreviewQuality = 'high' | 'medium' | 'low'

export function previewQuality(): PreviewQuality {
  try {
    const v = localStorage.getItem('previewQuality')
    return v === 'medium' || v === 'low' ? v : 'high'
  } catch {
    return 'high'
  }
}

/** Canvas pixel ratio cap, longest canvas edge and photo texture size per quality. */
export const QUALITY: Record<PreviewQuality, { dpr: number; maxWidth: number; images: number }> = {
  high: { dpr: 2, maxWidth: 1920, images: 2048 },
  medium: { dpr: 1, maxWidth: 1280, images: 1600 },
  low: { dpr: 1, maxWidth: 854, images: 1024 }
}

const mb = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toLocaleString(localeTag(), { maximumFractionDigits: 1 })} GB` : `${Math.round(bytes / 1e6).toLocaleString(localeTag())} MB`

export function SettingsDialog() {
  const set = useStore((s) => s.set)
  const projects = useStore((s) => s.projects)
  const [quality, setQuality] = useState<PreviewQuality>(previewQuality())
  const [cache, setCache] = useState<CacheInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [kiosk, setKiosk] = useState<string>('')

  useEffect(() => {
    void window.api.cacheInfo().then(setCache)
    void window.api.getAppSettings().then((s) => setKiosk(s.kioskProjectId ?? ''))
    void useStore.getState().loadProjects()
  }, [])

  const clean = async (what: 'unused' | 'hires' | 'proxies'): Promise<void> => {
    setBusy(true)
    try {
      setCache(await window.api.cleanCache(what))
      // removed proxies/live clips of the open project are rebuilt in the background
      const p = useStore.getState().project
      if (p && what !== 'hires') {
        const media = await window.api.restoreMedia(p.media)
        const byId = new Map(media.map((m) => [m.id, m]))
        const cur = useStore.getState().project
        if (cur?.id === p.id) useStore.setState({ project: { ...cur, media: cur.media.map((m) => byId.get(m.id) ?? m) } })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay">
      <div className="dialog wide">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0, flex: 1 }}>{t('settings')}</h2>
          <button className="btn ghost icon" title={t('close')} onClick={() => set({ dialog: null })}>
            <X size={16} />
          </button>
        </div>

        <div className="section">
          <h3>{t('previewQualityTitle')}</h3>
          <div className="seg">
            {(['high', 'medium', 'low'] as PreviewQuality[]).map((q) => (
              <button
                key={q}
                className={quality === q ? 'on' : ''}
                onClick={() => {
                  setQuality(q)
                  try {
                    localStorage.setItem('previewQuality', q)
                  } catch {
                    // private window: the choice lasts for this session only
                  }
                  window.dispatchEvent(new Event('previewquality'))
                }}
              >
                {t(q === 'high' ? 'qualityHigh' : q === 'medium' ? 'qualityMedium' : 'qualityLow')}
              </button>
            ))}
          </div>
          <p className="hint">{t('previewQualityHint')}</p>
        </div>

        <div className="section">
          <h3>{t('storage')}</h3>
          {!cache ? (
            <p className="hint">…</p>
          ) : (
            <>
              <dl className="info" style={{ gridTemplateColumns: '170px 1fr' }}>
                <dt>{t('storageTotal')}</dt>
                <dd>{mb(cache.total)}</dd>
                <dt>{t('storageProxies')}</dt>
                <dd>{mb(cache.parts.proxies)}</dd>
                <dt>{t('storageHires')}</dt>
                <dd>{mb(cache.parts.hires)}</dd>
                <dt>{t('storageImages')}</dt>
                <dd>{mb(cache.parts.display + cache.parts.thumbs)}</dd>
                <dt>{t('storageAudio')}</dt>
                <dd>{mb(cache.parts.audio + cache.parts.other)}</dd>
                <dt>{t('storageUnused')}</dt>
                <dd>
                  {mb(cache.unused)} ({cache.unusedItems})
                </dd>
              </dl>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button className="btn small" disabled={busy || !cache.unused} onClick={() => void clean('unused')}>
                  {t('cleanUnused')}
                </button>
                <button className="btn small" disabled={busy || !cache.parts.hires} onClick={() => void clean('hires')}>
                  {t('cleanHires')}
                </button>
                <button className="btn small" disabled={busy || !cache.parts.proxies} onClick={() => void clean('proxies')}>
                  {t('cleanProxies')}
                </button>
                <button className="btn small ghost" onClick={() => void window.api.revealInFolder(cache.dir)}>
                  {t('showInFolder')}
                </button>
              </div>
              <p className="hint">{t('storageHint')}</p>
            </>
          )}
        </div>

        <div className="section">
          <h3>{t('kiosk')}</h3>
          <div className="row">
            <label>{t('kioskProject')}</label>
            <select
              value={kiosk}
              onChange={(e) => {
                setKiosk(e.target.value)
                void window.api.setAppSettings({ kioskProjectId: e.target.value || null })
              }}
            >
              <option value="">{t('off')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <p className="hint">{t('kioskHint')}</p>
        </div>

        <div className="actions">
          <button className="btn" onClick={() => set({ dialog: 'help' })}>
            {t('shortcuts')}
          </button>
          <button className="btn primary" onClick={() => set({ dialog: null })}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function BackupsDialog() {
  const project = useStore((s) => s.project)!
  const set = useStore((s) => s.set)
  const [list, setList] = useState<BackupInfo[] | null>(null)
  useEffect(() => {
    void window.api.listBackups(project.id).then(setList)
  }, [project.id])
  const fmt = new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div className="overlay">
      <div className="dialog">
        <h2>{t('backupsTitle')}</h2>
        {!list ? (
          <p className="hint">…</p>
        ) : list.length === 0 ? (
          <p className="hint">{t('noBackups')}</p>
        ) : (
          <div className="stack" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
            {list.map((b) => (
              <div key={b.file} className="row backup">
                <span style={{ flex: 1 }}>{fmt.format(b.savedAt)}</span>
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
        <p className="hint">{t('backupsHint')}</p>
        <div className="actions">
          <button className="btn primary" onClick={() => set({ dialog: null })}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  )
}

const SHORTCUTS: [string, string][] = [
  ['Leertaste', 'scPlay'],
  ['← / →', 'scStep'],
  ['Strg+Z / Strg+Y', 'scUndo'],
  ['Entf', 'scDelete'],
  ['Strg+Klick', 'scMulti'],
  ['Alt+Enter', 'scFullscreen'],
  ['Esc', 'scEsc'],
  ['F1', 'scHelp']
]

export function HelpDialog() {
  const set = useStore((s) => s.set)
  return (
    <div className="overlay" onClick={() => set({ dialog: null })}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{t('shortcuts')}</h2>
        <dl className="info" style={{ gridTemplateColumns: '140px 1fr', fontSize: 13, gap: '6px 12px' }}>
          {SHORTCUTS.map(([k, label]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{t(label as never)}</dd>
            </div>
          ))}
        </dl>
        <h3 style={{ fontSize: 13, marginTop: 14 }}>{t('mouseTitle')}</h3>
        <ul className="hint" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li>{t('tipDrag')}</li>
          <li>{t('tipMerge')}</li>
          <li>{t('tipCrop')}</li>
          <li>{t('tipDuration')}</li>
        </ul>
        <div className="actions">
          <button className="btn primary" onClick={() => set({ dialog: null })}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One-time hint card; `id` remembers that it was dismissed. */
export function Tip({ id, children }: { id: string; children: React.ReactNode }) {
  const key = `tip:${id}`
  const [open, setOpen] = useState(() => {
    try {
      return !localStorage.getItem(key)
    } catch {
      return true
    }
  })
  if (!open) return null
  return (
    <div className="tip">
      <div style={{ flex: 1 }}>{children}</div>
      <button
        className="btn small"
        onClick={() => {
          setOpen(false)
          try {
            localStorage.setItem(key, '1')
          } catch {
            // ignore
          }
        }}
      >
        {t('gotIt')}
      </button>
    </div>
  )
}

/** Banner while originals are missing (moved or renamed folders). */
export function MissingBanner() {
  const project = useStore((s) => s.project)!
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const missing = project.media.filter((m) => m.status === 'error' && m.error === 'missing')
  if (!missing.length) return null
  return (
    <div className="banner">
      <FolderSearch size={16} />
      <span style={{ flex: 1 }}>
        {t('missingFiles').replace('{n}', String(missing.length))} {result}
      </span>
      <button
        className="btn small"
        disabled={busy}
        onClick={async () => {
          const [folder] = await window.api.pickFolder()
          if (!folder) return
          setBusy(true)
          try {
            const found = await window.api.relinkMedia(missing, folder)
            const n = Object.keys(found).length
            setResult(t('relinked').replace('{n}', String(n)))
            if (n) {
              useStore.getState().update((p) => {
                for (const e of p.entries) if (e.type !== 'text' && found[e.mediaId]) e.mediaId = found[e.mediaId].id
                p.media = p.media.map((m) => found[m.id] ?? m)
              })
            }
          } finally {
            setBusy(false)
          }
        }}
      >
        {t('relink')}
      </button>
    </div>
  )
}
