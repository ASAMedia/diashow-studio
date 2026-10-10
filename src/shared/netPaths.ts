// Network shares (UNC paths). Opening \\host\share makes Windows sign in to that host with the
// user's account (NTLM), so paths that come from a project made elsewhere are only touched once
// the user trusts the host. Hosts the user imported from or picked a folder on count as trusted.

/** Host of a UNC path (\\host\share\…, //host/share/…, \\?\UNC\host\…), lower case; null for local paths. */
export function uncHost(path: unknown): string | null {
  if (typeof path !== 'string') return null
  const m = /^(?:[\\/]{2}\?[\\/]UNC[\\/]|[\\/]{2}(?![?.][\\/]))([^\\/]+)[\\/]/i.exec(path)
  return m ? m[1].toLowerCase() : null
}

/** A host name that can be stored as trusted: DNS name, NetBIOS name or IPv4 address. */
export function validHost(host: unknown): host is string {
  return typeof host === 'string' && host.length <= 253 && /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(host)
}
