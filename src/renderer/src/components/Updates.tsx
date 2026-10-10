// Update hint: a small chip in the title bar when GitHub has a newer release (no auto-update).
// The main process asks GitHub at most once a day (src/main/about.ts); "Check for updates" in the
// About dialog asks right away.
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { ArrowUpCircle, X } from 'lucide-react'
import type { UpdateStatus } from '@shared/about'
import { t } from '../i18n'
import './help.css'

export const useUpdate = create<{ status: UpdateStatus | null }>(() => ({ status: null }))

let started = false

/** The start-up check: once per app start, never blocking, silent on any problem. */
export function startUpdateCheck(): void {
  if (started) return
  started = true
  void window.api
    .checkUpdate(false)
    .then((status) => useUpdate.setState({ status }))
    .catch(() => {})
}

/** Asks GitHub now (About dialog); the chip follows the answer. */
export async function checkUpdateNow(): Promise<UpdateStatus> {
  const status = await window.api.checkUpdate(true)
  useUpdate.setState({ status })
  return status
}

/** Settings section: the start-up check on or off (AppSettings.updateCheck). */
export function UpdateSetting() {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    void window.api.getAppSettings().then((s) => setOn(s.updateCheck !== false))
  }, [])
  return (
    <div className="section">
      <h3>{t('updates')}</h3>
      <label className="check">
        <input
          type="checkbox"
          data-testid="update-setting"
          checked={on ?? true}
          disabled={on === null}
          onChange={(e) => {
            const v = e.target.checked
            setOn(v)
            void window.api.setAppSettings({ updateCheck: v })
            if (!v) useUpdate.setState({ status: null })
          }}
        />
        <span>{t('updateSetting')}</span>
      </label>
      <p className="hint">{t('updateSettingHint')}</p>
    </div>
  )
}

const DISMISSED = 'update:dismissed'

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED)
  } catch {
    return null
  }
}

export function UpdateChip() {
  const status = useUpdate((s) => s.status)
  const [dismissed, setDismissed] = useState(readDismissed)
  useEffect(() => startUpdateCheck(), [])
  if (status?.state !== 'newer' || !status.latest || !status.url || dismissed === status.latest) return null
  const version = status.latest
  return (
    <span className="update-chip" data-testid="update-chip">
      <a href={status.url} target="_blank" rel="noreferrer" title={t('updateChipHint').replace('{v}', version)}>
        <ArrowUpCircle size={13} /> {t('updateChip').replace('{v}', version)}
      </a>
      <button
        title={t('updateDismiss')}
        onClick={() => {
          setDismissed(version)
          try {
            localStorage.setItem(DISMISSED, version)
          } catch {
            // the hint comes back next start
          }
        }}
      >
        <X size={12} />
      </button>
    </span>
  )
}
