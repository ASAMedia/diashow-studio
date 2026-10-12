import { useEffect, useState } from 'react'
import { FolderSearch, Lightbulb } from 'lucide-react'
import type { BackupInfo, CacheInfo, GpuChoiceInfo } from '@shared/types'
import { useStore } from '../store'
import { localeTag, t, type StringKey } from '../i18n'
import { appearance, setAppearance, type Appearance } from '../appearance'
import { UpdateSetting } from './Updates'
import { DiagnosticsDialog } from './Diagnostics'
import { CleanupSetting } from './Cleanup'
import { ReportProblemDialog } from './ReportProblem'
import { Modal } from './Modal'
import { Field, Section, Seg } from './ui'

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

function AppearanceSetting() {
  const [value, setValue] = useState<Appearance>(appearance())
  return (
    <Section title={t('appearance')}>
      <Seg
        label={t('appearance')}
        value={value}
        options={[
          { id: 'system', label: t('appearanceSystem') },
          { id: 'light', label: t('appearanceLight') },
          { id: 'dark', label: t('appearanceDark') }
        ]}
        onChange={(v) => {
          setValue(v)
          setAppearance(v)
        }}
      />
      <p className="hint">{t('appearanceHint')}</p>
    </Section>
  )
}

/** Laptops with two graphics chips: render on the stronger one (default) or save power. Next start. */
function GpuChoiceSetting() {
  const [info, setInfo] = useState<GpuChoiceInfo | null>(null)
  const [choice, setChoice] = useState<'performance' | 'saving'>('performance')
  useEffect(() => {
    void window.api.gpuChoice().then((i) => {
      setInfo(i)
      setChoice(i.running)
    })
    void window.api.getAppSettings().then((s) => setChoice(s.gpuPreference ?? 'performance'))
  }, [])
  if (!info || info.chips < 2 || info.override) return null
  return (
    <Section title={t('gpuChoiceTitle')}>
      <Seg
        label={t('gpuChoiceTitle')}
        value={choice}
        options={[
          { id: 'performance', label: t('gpuPerformance') },
          { id: 'saving', label: t('gpuSaving') }
        ]}
        onChange={(v) => {
          setChoice(v)
          void window.api.setAppSettings({ gpuPreference: v })
        }}
      />
      <p className="hint">
        {t('gpuChoiceHint')}
        {choice !== info.running && <> {t('gpuChoiceRestart')}</>}
      </p>
    </Section>
  )
}

export function SettingsDialog() {
  const set = useStore((s) => s.set)
  const projects = useStore((s) => s.projects)
  const [quality, setQuality] = useState<PreviewQuality>(previewQuality())
  const [cache, setCache] = useState<CacheInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [kiosk, setKiosk] = useState<string>('')
  const [diagnostics, setDiagnostics] = useState(false)
  const [report, setReport] = useState(false)

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

  const close = (): void => set({ dialog: null })
  return (
    <Modal
      title={t('settings')}
      onClose={close}
      className="wide settings-dialog"
      actions={
        <>
          <button className="btn" onClick={() => set({ dialog: 'help' })}>
            {t('shortcuts')}
          </button>
          <button className="btn" onClick={() => set({ dialog: 'handbook' })}>
            {t('handbook')}
          </button>
          <button className="btn" onClick={() => set({ dialog: 'about' })}>
            {t('about')}
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={close}>
            {t('close')}
          </button>
        </>
      }
    >
      <AppearanceSetting />

      <Section title={t('previewQualityTitle')}>
        <Seg
          label={t('previewQualityTitle')}
          value={quality}
          options={(['high', 'medium', 'low'] as PreviewQuality[]).map((q) => ({ id: q, label: t(q === 'high' ? 'qualityHigh' : q === 'medium' ? 'qualityMedium' : 'qualityLow') }))}
          onChange={(q) => {
            setQuality(q)
            try {
              localStorage.setItem('previewQuality', q)
            } catch {
              // private window: the choice lasts for this session only
            }
            window.dispatchEvent(new Event('previewquality'))
          }}
        />
        <p className="hint">{t('previewQualityHint')}</p>
      </Section>

      <GpuChoiceSetting />

      <Section title={t('storage')}>
        {!cache ? (
          <p className="hint">{t('loading')}</p>
        ) : (
          <>
            <dl className="info wide">
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
            <div className="row wrap">
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
      </Section>

      <CleanupSetting />

      <Section title={t('kiosk')}>
        <Field label={t('kioskProject')}>
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
        </Field>
        <p className="hint">{t('kioskHint')}</p>
      </Section>

      <UpdateSetting />

      <Section title={t('troubleshooting')}>
        <div className="row wrap">
          <button className="btn small" onClick={() => set({ dialog: 'systemcheck' })}>
            {t('systemCheck')}
          </button>
          <button className="btn small" data-testid="diagnostics-open" onClick={() => setDiagnostics(true)}>
            {t('diagButton')}
          </button>
          <button className="btn small" data-testid="report-open" onClick={() => setReport(true)}>
            {t('reportButton')}
          </button>
        </div>
        <p className="hint">{t('troubleshootingHint')}</p>
      </Section>
      {diagnostics && <DiagnosticsDialog onClose={() => setDiagnostics(false)} />}
      {report && <ReportProblemDialog onClose={() => setReport(false)} />}
    </Modal>
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

/** Keys of the shortcut list, written the way the keyboard labels them in the UI language. */
const SHORTCUTS: [StringKey[], StringKey][] = [
  [['kbdSpace'], 'scPlay'],
  [['kbdLeftRight'], 'scStep'],
  [['kbdAltArrows'], 'scMove'],
  [['kbdUndo', 'kbdRedo'], 'scUndo'],
  [['kbdDelete'], 'scDelete'],
  [['kbdCtrlClick'], 'scMulti'],
  [['kbdShiftClick'], 'scRange'],
  [['kbdSelectAll'], 'scAll'],
  [['kbdRotate'], 'scRotate'],
  [['kbdAltEnter'], 'scFullscreen'],
  [['kbdEsc'], 'scEsc'],
  [['kbdF1'], 'scHelp'],
  [['kbdTab'], 'scTab'],
  [['kbdEnter'], 'scEnter'],
  [['kbdMenu'], 'scMenu']
]

export function HelpDialog() {
  const set = useStore((s) => s.set)
  const close = (): void => set({ dialog: null })
  return (
    <Modal
      title={t('shortcuts')}
      onClose={close}
      backdropClose
      className="help-dialog"
      actions={
        <button className="btn primary" onClick={close}>
          {t('close')}
        </button>
      }
    >
      <dl className="info wide shortcuts">
        {SHORTCUTS.map(([keys, label]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt>
              {keys.map((k, i) => (
                <span key={k}>
                  {i > 0 && ' / '}
                  <kbd>{t(k)}</kbd>
                </span>
              ))}
            </dt>
            <dd>{t(label)}</dd>
          </div>
        ))}
      </dl>
      <h3 className="subhead">{t('mouseTitle')}</h3>
      <ul className="hint tips">
        <li>{t('tipDrag')}</li>
        <li>{t('tipMerge')}</li>
        <li>{t('tipCrop')}</li>
        <li>{t('tipDuration')}</li>
      </ul>
      <h3 className="subhead">{t('cull')}</h3>
      <p className="hint">{t('cullHint')}</p>
    </Modal>
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
    <div className="tip" role="note">
      <Lightbulb size={16} aria-hidden />
      <span>{children}</span>
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
    <div className="banner" role="status">
      <FolderSearch size={16} aria-hidden />
      <span>
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
