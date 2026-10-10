// Network interfaces the share server can listen on: IPv4 addresses of real adapters, Wi-Fi first (the
// pupils' phones are on the Wi-Fi), then Ethernet, the laptop's own mobile hotspot, and finally
// anything else (virtual adapters of VMs, WSL, VPNs).
//
// Private addresses (RFC 1918) come first. Some school and university networks (eduroam) give every
// device a public address instead; those are offered after the private ones and marked `public`, since
// the server may then be reachable from outside the Wi-Fi (the dialog warns; the token still protects).
// Virtual adapters only count with private addresses.
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { ShareAddress } from '@shared/share'

function octets(address: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.some((n) => n > 255) ? null : parts
}

/** 10/8, 172.16/12, 192.168/16 (RFC 1918). Link-local (169.254) and CGNAT (100.64/10, Tailscale) are not. */
export function isPrivateIPv4(address: string): boolean {
  const o = octets(address)
  if (!o) return false
  const [a, b] = o
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * Any other unicast address a phone could reach: not private, not "this network" (0/8), loopback
 * (127/8), link-local (169.254/16), multicast (224/4) or reserved (240/4, broadcast), and not the
 * documentation ranges. CGNAT (100.64/10) counts: some campus networks use it.
 */
export function isPublicIPv4(address: string): boolean {
  const o = octets(address)
  if (!o || isPrivateIPv4(address)) return false
  const [a, b, c] = o
  if (a === 0 || a === 127 || a >= 224) return false
  if (a === 169 && b === 254) return false
  // TEST-NET-1/2/3 and the benchmark range never belong to a real network
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  return true
}

const VIRTUAL = /vethernet|virtualbox|vmware|vmnet|hyper-v|wsl|docker|loopback|bluetooth|tailscale|zerotier|wireguard|openvpn|vpn|npcap|tap-|\btun\b|radmin|hamachi/i
const WIFI = /wi-?fi|wlan|wireless|802\.11/i
const ETHERNET = /ethernet|^lan\b|lan-verbindung(?!\*)|local area connection(?!\*)/i

/** What kind of adapter this is, by its Windows name and address. */
export function adapterKind(name: string, address: string): ShareAddress['kind'] {
  if (VIRTUAL.test(name)) return 'virtual'
  // Windows "Mobile hotspot" always uses 192.168.137.1 on a "Local Area Connection* n" adapter
  if (address.startsWith('192.168.137.')) return 'hotspot'
  if (WIFI.test(name)) return 'wifi'
  if (ETHERNET.test(name)) return 'ethernet'
  return 'other'
}

const RANK: Record<ShareAddress['kind'], number> = { wifi: 0, ethernet: 1, hotspot: 2, other: 3, virtual: 4 }

/** IPv4 addresses of the machine the server can use, best first: private ones, then public ones. */
export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): ShareAddress[] {
  const out: ShareAddress[] = []
  const seen = new Set<string>()
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list ?? []) {
      // Node reports family as 'IPv4' (or 4 in some versions)
      const v4 = info.family === 'IPv4' || (info.family as unknown) === 4
      if (!v4 || info.internal || seen.has(info.address)) continue
      const kind = adapterKind(name, info.address)
      if (isPrivateIPv4(info.address)) out.push({ name, address: info.address, kind })
      else if (kind !== 'virtual' && isPublicIPv4(info.address)) out.push({ name, address: info.address, kind, public: true })
      else continue
      seen.add(info.address)
    }
  }
  return out.sort(
    (a, b) => Number(!!a.public) - Number(!!b.public) || RANK[a.kind] - RANK[b.kind] || a.name.localeCompare(b.name, undefined, { numeric: true })
  )
}
