// About Diashow Studio: version, Electron/Chromium/FFmpeg versions, the MIT licence, what is bundled
// under which licence (FFmpeg's GPL notice with the source of the exact build), the full
// THIRD_PARTY_NOTICES.txt and "Check for updates".
import { useEffect, useState } from 'react'
import { Images, Loader2, X } from 'lucide-react'
import type { AboutInfo, UpdateStatus } from '@shared/about'
import { useStore } from '../store'
import { localeTag, t } from '../i18n'
import { checkUpdateNow } from './Updates'
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
    <div className="overlay" onClick={close}>
      <div className="dialog about" data-testid="about" onClick={(e) => e.stopPropagation()}>
        <div className="about-head">
          <div className="logo">
            <Images size={24} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>{t('appName')}</h2>
            <div className="tag">{t('aboutTagline')}</div>
          </div>
          <button className="btn ghost icon" title={t('close')} onClick={close}>
            <X size={16} />
          </button>
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

        <div className="section">
          <h3>{t('updates')}</h3>
          <div className="update-row">
            <button className="btn small" disabled={checking} onClick={() => void check()}>
              {checking && <Loader2 size={13} className="spin" />} {t('updateCheckNow')}
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
        </div>

        <div className="section">
          <h3>{t('aboutThirdParty')}</h3>
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
          <button className="btn small" style={{ marginTop: 10 }} onClick={toggleNotices}>
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
        </div>

        <div className="actions">
          <button className="btn" onClick={() => set({ dialog: 'handbook' })}>
            {t('handbook')}
          </button>
          <button className="btn primary" onClick={close}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  )
}
