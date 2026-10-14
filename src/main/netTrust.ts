// Network shares (\\host\share): a project made elsewhere may point at any host, and Windows would sign
// in there with the user's account. Files on a share are only opened when its host is trusted: hosts
// of files and folders the user picked or dropped in this app, and hosts allowed in the editor's banner.
// They are kept in the app settings. The device-namespace spellings of a share (\\.\UNC\host\…,
// \??\UNC\host\…) count as that host; other device paths (\\?\GLOBALROOT\…) are refused. Electron-free.
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

/** Win32 device namespaces: \\?\…, \\.\… and the NT prefix \??\… (also with forward slashes). */
const DEVICE = /^(?:[\\/]{2}[?.]|[\\/]\?\?)[\\/]/
/** A drive in the device namespace (\\?\C:\…): a long local path. */
const DEVICE_DRIVE = /^(?:[\\/]{2}[?.]|[\\/]\?\?)[\\/][a-z]:[\\/]/i
/** A share in the device namespace (\\.\UNC\host\…, \??\UNC\host\…): Windows signs in there like at \\host. */
const DEVICE_UNC = /^(?:[\\/]{2}[?.]|[\\/]\?\?)[\\/]UNC[\\/]([^\\/]+)[\\/]/i

/**
 * The network host a path leads to, '' for a local path, or null when it can't be told: a device path
 * other than a drive or a share (\\?\GLOBALROOT\Device\Mup\host\…, pipes, volumes) may reach any host.
 */
export function pathHost(p: unknown): string | null {
  if (typeof p !== 'string') return null
  const host = uncHost(p) ?? DEVICE_UNC.exec(p)?.[1]?.toLowerCase()
  if (host) return host
  return DEVICE.test(p) && !DEVICE_DRIVE.test(p) ? null : ''
}

export function createNetTrust(settings: AppSettingsStore): NetTrust {
  const trustedHosts = new Set<string>()
  const allowPath = (p: string): boolean => {
    const host = pathHost(p)
    return host === '' || (host !== null && trustedHosts.has(host))
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
