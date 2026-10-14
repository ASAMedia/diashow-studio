import { useEffect, useState } from 'react'
import type { CacheInfo, GpuChoiceInfo } from '@shared/types'
import { useStore } from '../store'
import { localeTag, t } from '../i18n'
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
