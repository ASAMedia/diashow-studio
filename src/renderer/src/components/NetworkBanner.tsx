// A project made elsewhere that points to network shares: the app asks before Windows signs in there.
import { useState } from 'react'
import { Network } from 'lucide-react'
import { uncHost } from '@shared/netPaths'
import { useStore } from '../store'
import { t } from '../i18n'

export function NetworkBanner() {
  const project = useStore((s) => s.project)
  const [busy, setBusy] = useState(false)
  if (!project) return null
  const blocked = [...project.media, ...project.music].filter((m) => m.status === 'error' && m.error === 'network-blocked')
  const hosts = [...new Set(blocked.map((m) => uncHost(m.path)).filter((h): h is string => !!h))]
  if (!hosts.length) return null
  return (
    <div className="banner" role="alert">
      <Network size={16} aria-hidden />
      <span style={{ flex: 1 }}>{t('networkBlockedBanner').replace('{hosts}', hosts.map((h) => `\\\\${h}`).join(', '))}</span>
      <button
        className="btn small"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await window.api.trustNetworkHosts(hosts)
            await useStore.getState().reloadMedia()
          } finally {
            setBusy(false)
          }
        }}
      >
        {t('networkAllow')}
      </button>
    </div>
  )
}
