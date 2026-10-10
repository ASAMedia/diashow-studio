// Update hint (no auto-update): asks GitHub for the newest release, at most once a day, and says
// whether it is newer than this version. Electron-free: fetch, settings and clock are injected.
import { REPO_URL, type UpdateStatus } from '@shared/about'
import type { AppSettings } from '@shared/types'
import { isNewerVersion, parseVersion, plainVersion } from '@shared/version'

export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 6000

export interface ReleaseInfo {
  version: string
  url: string
}

interface FetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}
export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<FetchResponse>

/** The release page to open: GitHub's own link when it points into this repository's releases. */
export function releasePageUrl(htmlUrl: unknown, tag: string): string {
  if (typeof htmlUrl === 'string' && htmlUrl.startsWith(`${REPO_URL}/releases/`) && htmlUrl.length <= 512 && !/[\s"'<>]/.test(htmlUrl)) return htmlUrl
  return /^[0-9A-Za-z.+-]{1,64}$/.test(tag) ? `${REPO_URL}/releases/tag/${tag}` : `${REPO_URL}/releases/latest`
}

/**
 * The newest published release, or null when there is none (404). Throws when GitHub can't be
 * asked or answers unexpectedly: offline, timeout, rate limit (403/429), server errors.
 */
export async function fetchLatestRelease(opts: { url: string; fetch: FetchLike; userAgent: string; timeoutMs?: number }): Promise<ReleaseInfo | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? TIMEOUT_MS)
  try {
    const res = await opts.fetch(opts.url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': opts.userAgent }
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown } | null
    const tag = typeof body?.tag_name === 'string' ? body.tag_name.trim() : ''
    if (!parseVersion(tag)) throw new Error('release without a version tag')
    if (body?.draft === true || body?.prerelease === true) return null
    return { version: plainVersion(tag), url: releasePageUrl(body?.html_url, tag) }
  } finally {
    clearTimeout(timer)
  }
}

export interface UpdateCheckDeps {
  /** This app's version (package.json). */
  current: string
  settings: { get(): Promise<AppSettings>; update(patch: AppSettings): Promise<void> }
  fetch: FetchLike
  url: string
  userAgent: string
  now?: () => number
  timeoutMs?: number
}

/**
 * Automatic check (`force` false): nothing when switched off; within a day of the last check the
 * stored answer is used. `force` (About dialog) always asks GitHub. Never throws: problems end in
 * state 'unavailable', which the start-up check doesn't show.
 */
export async function checkForUpdate(deps: UpdateCheckDeps, force = false): Promise<UpdateStatus> {
  const { current } = deps
  const now = deps.now?.() ?? Date.now()
  const settings = await deps.settings.get().catch(() => ({}) as AppSettings)
  if (!force) {
    if (settings.updateCheck === false) return { state: 'off', current }
    const last = settings.updateCheckedAt ?? 0
    if (last && now >= last && now - last < UPDATE_INTERVAL_MS) {
      const known = settings.updateLatest
      if (known && isNewerVersion(known.version, current)) return { state: 'newer', current, latest: known.version, url: known.url, checkedAt: last }
      return { state: 'skipped', current, checkedAt: last }
    }
  }
  // remember the attempt first: an app that hangs or crashes during the check doesn't retry each start
  await deps.settings.update({ updateCheckedAt: now }).catch(() => {})
  let release: ReleaseInfo | null
  try {
    release = await fetchLatestRelease({ url: deps.url, fetch: deps.fetch, userAgent: deps.userAgent, timeoutMs: deps.timeoutMs })
  } catch {
    return { state: 'unavailable', current, checkedAt: now }
  }
  await deps.settings.update({ updateCheckedAt: now, updateLatest: release }).catch(() => {})
  if (!release) return { state: 'none', current, checkedAt: now }
  if (isNewerVersion(release.version, current)) return { state: 'newer', current, latest: release.version, url: release.url, checkedAt: now }
  return { state: 'current', current, latest: release.version, url: release.url, checkedAt: now }
}
