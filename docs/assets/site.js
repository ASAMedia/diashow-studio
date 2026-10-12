// Download box of the Diashow Studio website: asks GitHub for the newest release and fills in its
// version, date, file sizes and the direct links of the installer and the portable exe. Without
// JavaScript, offline, rate-limited or on any unexpected answer, the links to the releases page stay.
;(() => {
  const API = 'https://api.github.com/repos/ASAMedia/diashow-studio/releases/latest'
  const DOWNLOADS = 'https://github.com/ASAMedia/diashow-studio/releases/download/'
  const PATTERNS = { setup: /-Setup-[\w.-]+\.exe$/i, portable: /-portable\.exe$/i }

  const box = document.querySelector('[data-release]')
  if (!box || !window.fetch) return
  const de = document.documentElement.lang.startsWith('de')

  const megabytes = (bytes) => `${Math.round(bytes / 1048576).toLocaleString(de ? 'de-DE' : 'en-GB')} MB`
  const set = (selector, text) => {
    for (const el of document.querySelectorAll(selector)) el.textContent = text
  }

  function fill(release) {
    const version = /^v?(\d+\.\d+\.\d+[\w.-]*)$/.exec(String(release?.tag_name ?? ''))?.[1]
    if (!version || !Array.isArray(release.assets)) return
    let found = 0
    for (const [kind, pattern] of Object.entries(PATTERNS)) {
      const asset = release.assets.find((a) => typeof a?.name === 'string' && pattern.test(a.name))
      const url = String(asset?.browser_download_url ?? '')
      if (!asset || !url.startsWith(DOWNLOADS) || !(asset.size > 0)) continue
      for (const link of document.querySelectorAll(`[data-dl="${kind}"]`)) link.href = url
      set(`[data-file="${kind}"]`, `${asset.name} · ${megabytes(asset.size)}`)
      found++
    }
    if (!found) return
    set('[data-version]', version)
    const date = new Date(release.published_at)
    if (!Number.isNaN(date.getTime())) {
      set('[data-date]', date.toLocaleDateString(de ? 'de-DE' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))
    }
    for (const el of document.querySelectorAll('[data-release-known]')) el.hidden = false
    for (const el of document.querySelectorAll('[data-release-unknown]')) el.hidden = true
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  fetch(API, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctrl.signal })
    .then((r) => (r.ok ? r.json() : null))
    .then((release) => release && fill(release))
    .catch(() => {})
    .finally(() => clearTimeout(timer))
})()
