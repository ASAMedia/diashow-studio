// Network interfaces the share server can listen on: private IPv4 addresses of real adapters,
// Wi-Fi first (the pupils' phones are on the Wi-Fi), then Ethernet, the laptop's own mobile hotspot,
// and finally anything else (virtual adapters of VMs, WSL, VPNs).
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { ShareAddress } from '@shared/share'

/** 10/8, 172.16/12, 192.168/16 (RFC 1918). Link-local (169.254) and CGNAT (100.64/10, Tailscale) are not. */
export function isPrivateIPv4(address: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
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

/** Private IPv4 addresses of the machine, best first. */
export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): ShareAddress[] {
  const out: ShareAddress[] = []
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list ?? []) {
      // Node reports family as 'IPv4' (or 4 in some versions)
      const v4 = info.family === 'IPv4' || (info.family as unknown) === 4
      if (!v4 || info.internal || !isPrivateIPv4(info.address)) continue
      out.push({ name, address: info.address, kind: adapterKind(name, info.address) })
    }
  }
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.name.localeCompare(b.name, undefined, { numeric: true }))
}
