// About Diashow Studio: version, Electron/Chromium/FFmpeg versions, the MIT licence, what is bundled
// under which licence (FFmpeg's GPL notice with the source of the exact build), the full
// THIRD_PARTY_NOTICES.txt, "Check for updates" and "Problem melden…" (ReportProblem.tsx).
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { AboutInfo, UpdateStatus } from '@shared/about'
import { useStore } from '../store'
import { localeTag, t } from '../i18n'
import { checkUpdateNow } from './Updates'
import { ReportProblemDialog } from './ReportProblem'
import { Modal } from './Modal'
import { AppIcon } from './AppIcon'
import { Section } from './ui'
import './help.css'

function updateMessage(s: UpdateStatus): string {
  switch (s.state) {
    case 'newer':
      return t('updateNewer').replace('{v}', s.latest ?? '')
    case 'current':
      return t('updateCurrent')
    case 'none':
      return t('updateNone')
    default:
      return t('updateUnavailable')
  }
}

export function AboutDialog() {
  const set = useStore((s) => s.set)
  const [info, setInfo] = useState<AboutInfo | null>(null)
  const [notices, setNotices] = useState<string | null | undefined>(undefined)
  const [showNotices, setShowNotices] = useState(false)
  const [checking, setChecking] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [report, setReport] = useState(false)

  useEffect(() => {
    void window.api.aboutInfo().then(setInfo)
  }, [])

  const toggleNotices = (): void => {
    setShowNotices(!showNotices)
    if (notices === undefined) void window.api.thirdPartyNotices().then(setNotices)
  }

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      setUpdate(await checkUpdateNow())
    } finally {
      setChecking(false)
    }
  }

  const close = (): void => set({ dialog: null })
  const ff = info?.ffmpegBuild
  return (
    <Modal
      title={t('about')}
      onClose={close}
      backdropClose
      className="about"
      testId="about"
      actions={
        <>
          <button className="btn" onClick={() => set({ dialog: 'handbook' })}>
            {t('handbook')}
          </button>
          <button className="btn" data-testid="report-open" onClick={() => setReport(true)}>
            {t('reportButton')}
          </button>
          <button className="btn primary" onClick={close}>
            {t('close')}
          </button>
        </>
      }
    >
      <div className="about-head">
        <div className="logo">
          <AppIcon size={48} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="name">{t('appName')}</div>
          <div className="tag">{t('aboutTagline')}</div>
        </div>
      </div>

      <dl className="info">
        <dt>{t('aboutVersion')}</dt>
        <dd data-testid="about-version">{info?.version ?? '…'}</dd>
        <dt>Electron</dt>
        <dd>{info?.electron ?? '…'}</dd>
        <dt>Chromium</dt>
        <dd>{info?.chrome ?? '…'}</dd>
        <dt>FFmpeg</dt>
        <dd>{info?.ffmpeg ?? '…'}</dd>
        <dt>{t('aboutLicense')}</dt>
        <dd>{t('aboutLicenseText')}</dd>
        <dt>GitHub</dt>
        <dd>
          <a href={info?.repo} target="_blank" rel="noreferrer">
            {info?.repo.replace(/^https:\/\//, '') ?? '…'}
          </a>{' '}
          – {t('aboutRepo')}
        </dd>
      </dl>

      <Section title={t('updates')}>
        <div className="update-row" aria-live="polite">
          <button className="btn small" disabled={checking} onClick={() => void check()}>
            {checking && <Loader2 size={13} className="spin" aria-hidden />} {t('updateCheckNow')}
          </button>
          {checking ? (
            <span className="msg">{t('updateChecking')}</span>
          ) : (
            update && (
              <span className={`msg ${update.state === 'newer' ? 'newer' : ''}`} data-testid="update-result">
                {updateMessage(update)}{' '}
                {update.state === 'newer' && update.url && (
                  <a href={update.url} target="_blank" rel="noreferrer">
                    {t('updateOpen')}
                  </a>
                )}
                {update.checkedAt && update.state !== 'unavailable' && (
                  <span style={{ color: 'var(--text-3)' }}> · {new Date(update.checkedAt).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })}</span>
                )}
              </span>
            )
          )}
        </div>
      </Section>

      <Section title={t('aboutThirdParty')}>
        <ul className="third-party">
          <li data-testid="about-ffmpeg">
            <b>FFmpeg {info?.ffmpeg}</b> – {t('aboutFfmpeg')}
            {ff && (
              <span className="links">
                {ff.source && (
                  <a href={ff.source} target="_blank" rel="noreferrer">
                    {t('aboutFfmpegSource')}
                  </a>
                )}
                <a href={ff.release} target="_blank" rel="noreferrer">
                  {t('aboutFfmpegBuild')} (BtbN)
                </a>
                {ff.scripts && (
                  <a href={ff.scripts} target="_blank" rel="noreferrer">
                    {t('aboutFfmpegScripts')}
                  </a>
                )}
                <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noreferrer">
                  GPL 3.0
                </a>
              </span>
            )}
          </li>
          <li>{t('aboutFonts')}</li>
          <li>{t('aboutMediapipe')}</li>
          <li>{t('aboutFaceApi')}</li>
          <li>Electron (MIT) · Chromium (BSD-3-Clause, LICENSES.chromium.html)</li>
          <li>{t('aboutNpm')}</li>
        </ul>
        <button className="btn small" style={{ marginTop: 10 }} aria-expanded={showNotices} onClick={toggleNotices}>
          {showNotices ? t('aboutHideNotices') : t('aboutShowNotices')}
        </button>
        {showNotices &&
          (notices === undefined ? (
            <p className="hint">…</p>
          ) : notices === null ? (
            <p className="hint">{t('aboutNoNotices')}</p>
          ) : (
            <pre className="notices" data-testid="notices">
              {notices}
            </pre>
          ))}
      </Section>
      {report && <ReportProblemDialog onClose={() => setReport(false)} />}
    </Modal>
  )
}
