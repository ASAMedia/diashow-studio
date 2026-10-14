// Network shares (\\host\share): a project made elsewhere may point at any host, and Windows would sign
// in there with the user's account. Files on a share are only opened when its host is trusted: hosts
// of files and folders the user picked or dropped in this app, and hosts allowed in the editor's banner.
// They are kept in the app settings. Electron-free.
import { uncHost, validHost } from '@shared/netPaths'
import type { AppSettingsStore } from './appSettings'

export interface NetTrust {
  /** A local path, or one on a trusted host (media service, dsmedia://, the archive). */
  allowPath(p: string): boolean
  /** Settles once the trusted hosts are read from the settings; until then, none are. */
  loaded: Promise<void>
  /** Shares the user picked files or folders on themselves are trusted from then on. */
  trustPaths(paths: string[]): Promise<void>
  /** The user agreed to open files on these hosts (banner in the editor). */
  trustHosts(hosts: unknown): Promise<void>
}

export function createNetTrust(settings: AppSettingsStore): NetTrust {
  const trustedHosts = new Set<string>()
  const allowPath = (p: string): boolean => {
    const host = uncHost(p)
    return !host || trustedHosts.has(host)
  }
  const loaded = settings
    .get()
    .then((s) => (s.trustedHosts ?? []).forEach((h) => trustedHosts.add(h)))
    .catch(() => {})
  return {
    allowPath,
    loaded,
    async trustPaths(paths) {
      const fresh = [...new Set(paths.map(uncHost).filter((h): h is string => !!h && !trustedHosts.has(h)))]
      if (!fresh.length) return
      fresh.forEach((h) => trustedHosts.add(h))
      await settings.update({ trustedHosts: [...trustedHosts] }).catch(() => {})
    },
    async trustHosts(hosts) {
      const list = Array.isArray(hosts) ? hosts.filter(validHost).map((h) => h.toLowerCase()) : []
      list.forEach((h) => trustedHosts.add(h))
      await settings.update({ trustedHosts: [...trustedHosts] })
    }
  }
}
