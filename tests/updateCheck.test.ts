import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { REPO_URL } from '@shared/about'
import type { AppSettings } from '@shared/types'
import { createAppSettingsStore } from '../src/main/appSettings'
import { checkForUpdate, fetchLatestRelease, releasePageUrl, UPDATE_INTERVAL_MS, type FetchLike } from '../src/main/updateCheck'

const dir = mkdtempSync(join(tmpdir(), 'diashow-update-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const store = (initial: AppSettings = {}) => {
  const s = createAppSettingsStore(join(dir, `settings-${n++}.json`))
  return { s, ready: s.set(initial) }
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, html_url: `${REPO_URL}/releases/tag/${tag}`, draft: false, prerelease: false, ...extra })

/** A fetch that answers with `status` and `body`, counting calls. */
function mockFetch(status: number, body: unknown = {}): FetchLike & { calls: number; headers?: Record<string, string> } {
  const f = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
    f.headers = init.headers
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }) as unknown as FetchLike & { calls: number; headers?: Record<string, string>; mock: { calls: unknown[] } }
  Object.defineProperty(f, 'calls', { get: () => (f as unknown as { mock: { calls: unknown[] } }).mock.calls.length })
  return f
}

const URL = 'https://api.github.com/repos/ASAMedia/diashow-studio/releases/latest'
const NOW = Date.UTC(2026, 9, 10, 12)

describe('update check', () => {
  it('reports a newer release with its page, and asks GitHub politely', async () => {
    const { s, ready } = store()
    await ready
    const fetch = mockFetch(200, release('v1.2.0'))
    const r = await checkForUpdate({ current: '1.0.0', settings: s, fetch, url: URL, userAgent: 'DiashowStudio/1.0.0', now: () => NOW })
    expect(r).toEqual({ state: 'newer', current: '1.0.0', latest: '1.2.0', url: `${REPO_URL}/releases/tag/v1.2.0`, checkedAt: NOW })
    expect(fetch.headers?.['User-Agent']).toBe('DiashowStudio/1.0.0')
    expect(fetch.headers?.Accept).toBe('application/vnd.github+json')
    const saved = await s.get()
    expect(saved.updateCheckedAt).toBe(NOW)
    expect(saved.updateLatest).toEqual({ version: '1.2.0', url: `${REPO_URL}/releases/tag/v1.2.0` })
  })

  it('is quiet when this is the newest version', async () => {
    const { s, ready } = store()
    await ready
    const r = await checkForUpdate({ current: '1.2.0', settings: s, fetch: mockFetch(200, release('v1.2.0')), url: URL, userAgent: 'x', now: () => NOW })
    expect(r.state).toBe('current')
  })

  it('asks at most once a day and keeps showing a known newer release meanwhile', async () => {
    const { s, ready } = store({ updateCheckedAt: NOW - 3600_000, updateLatest: { version: '1.1.0', url: `${REPO_URL}/releases/tag/v1.1.0` } })
    await ready
    const fetch = mockFetch(200, release('v9.0.0'))
    const deps = { current: '1.0.0', settings: s, fetch, url: URL, userAgent: 'x', now: () => NOW }
    expect(await checkForUpdate(deps)).toMatchObject({ state: 'newer', latest: '1.1.0' })
    expect(fetch.calls).toBe(0)
    // once updated to that version, nothing is shown until the next check
    expect(await checkForUpdate({ ...deps, current: '1.1.0' })).toMatchObject({ state: 'skipped' })
    expect(fetch.calls).toBe(0)
    // a day later GitHub is asked again
    expect(await checkForUpdate({ ...deps, now: () => NOW - 3600_000 + UPDATE_INTERVAL_MS })).toMatchObject({ state: 'newer', latest: '9.0.0' })
    expect(fetch.calls).toBe(1)
    // "check now" in the About dialog always asks
    await checkForUpdate({ ...deps, now: () => NOW + UPDATE_INTERVAL_MS + 1000 }, true)
    expect(fetch.calls).toBe(2)
  })

  it('a clock set back does not stop the checks', async () => {
    const { s, ready } = store({ updateCheckedAt: NOW + 10 * UPDATE_INTERVAL_MS })
    await ready
    const fetch = mockFetch(200, release('v1.0.0'))
    await checkForUpdate({ current: '1.0.0', settings: s, fetch, url: URL, userAgent: 'x', now: () => NOW })
    expect(fetch.calls).toBe(1)
  })

  it('does nothing when switched off, unless asked in the About dialog', async () => {
    const { s, ready } = store({ updateCheck: false })
    await ready
    const fetch = mockFetch(200, release('v2.0.0'))
    const deps = { current: '1.0.0', settings: s, fetch, url: URL, userAgent: 'x', now: () => NOW }
    expect(await checkForUpdate(deps)).toEqual({ state: 'off', current: '1.0.0' })
    expect(fetch.calls).toBe(0)
    expect((await checkForUpdate(deps, true)).state).toBe('newer')
  })

  it('handles no release, rate limits, server errors, offline and timeouts silently', async () => {
    const run = async (fetch: FetchLike, timeoutMs?: number) => {
      const { s, ready } = store()
      await ready
      const r = await checkForUpdate({ current: '1.0.0', settings: s, fetch, url: URL, userAgent: 'x', now: () => NOW, timeoutMs })
      return { r, saved: await s.get() }
    }
    expect((await run(mockFetch(404, { message: 'Not Found' }))).r.state).toBe('none')
    expect((await run(mockFetch(403, { message: 'API rate limit exceeded' }))).r.state).toBe('unavailable')
    expect((await run(mockFetch(429))).r.state).toBe('unavailable')
    expect((await run(mockFetch(502))).r.state).toBe('unavailable')
    expect((await run(mockFetch(200, { message: 'odd' }))).r.state).toBe('unavailable')
    expect((await run(mockFetch(200, null))).r.state).toBe('unavailable')
    const offline: FetchLike = async () => {
      throw new TypeError('fetch failed')
    }
    const { r, saved } = await run(offline)
    expect(r.state).toBe('unavailable')
    // the attempt counts: no new request on every start while offline
    expect(saved.updateCheckedAt).toBe(NOW)
    // a server that never answers is given up after the timeout
    const hanging: FetchLike = (_u, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    const t0 = Date.now()
    expect((await run(hanging, 200)).r.state).toBe('unavailable')
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('ignores drafts and pre-releases and never trusts a foreign link', async () => {
    const fetchRel = (body: unknown) => fetchLatestRelease({ url: URL, fetch: mockFetch(200, body), userAgent: 'x' })
    expect(await fetchRel(release('v2.0.0', { prerelease: true }))).toBeNull()
    expect(await fetchRel(release('v2.0.0', { draft: true }))).toBeNull()
    expect(await fetchRel(release('v2.0.0', { html_url: 'https://evil.example/download' }))).toEqual({ version: '2.0.0', url: `${REPO_URL}/releases/tag/v2.0.0` })
    expect(releasePageUrl(`${REPO_URL}/releases/tag/v1.0.0`, 'v1.0.0')).toBe(`${REPO_URL}/releases/tag/v1.0.0`)
    expect(releasePageUrl(`${REPO_URL}/releases/x" onclick="`, 'v1')).toBe(`${REPO_URL}/releases/tag/v1`)
    expect(releasePageUrl(undefined, '../../etc')).toBe(`${REPO_URL}/releases/latest`)
  })
})

describe('app settings merge', () => {
  it('update() keeps the fields other parts of the app wrote', async () => {
    const { s, ready } = store({ kioskProjectId: 'trip-1' })
    await ready
    await Promise.all([s.update({ updateCheck: false }), s.update({ updateCheckedAt: 5 })])
    expect(await s.get()).toEqual({ kioskProjectId: 'trip-1', updateCheck: false, updateCheckedAt: 5 })
    await s.update({ kioskProjectId: null })
    expect(await s.get()).toEqual({ kioskProjectId: null, updateCheck: false, updateCheckedAt: 5 })
  })

  it('drops update fields of the wrong kind', async () => {
    const { s, ready } = store()
    await ready
    await s.update({ updateCheck: 'yes', updateCheckedAt: 'today', updateLatest: { version: '9', url: 'javascript:alert(1)' } } as unknown as AppSettings)
    expect(await s.get()).toEqual({})
  })
})
