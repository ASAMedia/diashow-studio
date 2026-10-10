// Semantic version compare for the update hint: "v1.2.3", "1.2.3-beta.1" and "1.2" are understood.
// Pure TypeScript, used by the main process (update check) and the tests.

export interface Version {
  major: number
  minor: number
  patch: number
  /** Pre-release identifiers ("beta", 1); empty for a release. */
  pre: (string | number)[]
}

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parses a version or tag name; null when it isn't one. Build metadata (+…) is ignored. */
export function parseVersion(text: string): Version | null {
  const m = VERSION_RE.exec(String(text ?? '').trim())
  if (!m) return null
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : []
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), pre }
}

function comparePre(a: (string | number)[], b: (string | number)[]): number {
  // a release ranks above its pre-releases
  if (!a.length || !b.length) return a.length ? -1 : b.length ? 1 : 0
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1
    if (i >= b.length) return 1
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    // numeric identifiers rank below alphanumeric ones
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** -1, 0 or 1 like a sort comparator; versions that can't be parsed rank lowest. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return x ? 1 : y ? -1 : 0
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  return comparePre(x.pre, y.pre)
}

/** True when `latest` is a newer version than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  return !!parseVersion(latest) && compareVersions(latest, current) > 0
}

/** "v1.2.0" → "1.2.0" (for display); other text unchanged. */
export function plainVersion(tag: string): string {
  return String(tag ?? '').trim().replace(/^v(?=\d)/, '')
}
