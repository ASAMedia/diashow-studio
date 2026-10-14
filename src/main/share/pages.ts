// The two web pages the phones see: uploading photos/videos and downloading offered videos. Plain
// inline HTML, CSS and JS (no external resources: the network may have no internet), German or
// English after the browser's Accept-Language.
import type { ShareOffer } from '@shared/share'
import { FAVICON } from './favicon'

/** The app icon in the browser tab and on the home screen (inline: the page loads nothing else). */
const ICON_LINKS = `<link rel="icon" type="image/png" href="${FAVICON}"><link rel="apple-touch-icon" href="${FAVICON}">`

export type PageLang = 'de' | 'en'

/** 'de' when German comes before English in Accept-Language, else 'en'. */
export function pageLang(acceptLanguage: string | undefined): PageLang {
  const tags = (acceptLanguage ?? '')
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().toLowerCase().split(';')
      const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)?.[1]).find(Boolean)
      return { tag, q: q === undefined ? 1 : Number(q) || 0, i }
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
  for (const { tag } of tags) {
    if (tag === 'de' || tag.startsWith('de-')) return 'de'
    if (tag === 'en' || tag.startsWith('en-')) return 'en'
  }
  return 'en'
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** JSON for a <script type="application/json"> block (no "</script>" can end it early). */
function jsonBlock(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

export function fmtBytes(n: number, lang: PageLang): string {
  const num = (v: number, d: number): string => v.toLocaleString(lang === 'de' ? 'de-DE' : 'en-US', { maximumFractionDigits: d })
  if (n >= 1e9) return `${num(n / 1e9, 1)} GB`
  if (n >= 1e6) return `${num(n / 1e6, n >= 1e8 ? 0 : 1)} MB`
  return `${num(Math.max(1, Math.round(n / 1e3)), 0)} KB`
}

const STYLE = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#1c1c1e;color:#ececef}
main{max-width:560px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:22px;margin:4px 0 2px}
.sub{color:#a9a9b1;margin:0 0 18px}
label{display:block;font-size:14px;color:#a9a9b1;margin:0 0 6px}
input[type=text]{width:100%;font-size:17px;padding:12px;border-radius:10px;border:1px solid #3a3a3f;background:#262629;color:#ececef}
.pick{display:block;margin:16px 0 8px;padding:18px;border-radius:14px;background:#2f7fe0;color:#fff;font-size:18px;font-weight:600;text-align:center;cursor:pointer}
.pick input{display:none}
.hint{color:#7c7c85;font-size:13px;margin:6px 0}
.sum{margin:18px 0 6px;font-weight:600}
.bar{height:8px;border-radius:4px;background:#303034;overflow:hidden}
.bar>div{height:100%;width:0;background:#4d9fff;transition:width .2s}
ul{list-style:none;padding:0;margin:14px 0 0}
li{padding:10px 0;border-bottom:1px solid #303034}
li .n{display:flex;gap:8px;justify-content:space-between;font-size:14px}
li .n span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
li .s{font-size:13px;color:#a9a9b1}
li.ok .s{color:#57d68d}
li.bad .s{color:#ff6b6b}
li.bad .bar{display:none}
li .bar{height:4px;margin-top:6px}
.btn{display:inline-block;margin-top:14px;padding:10px 16px;border-radius:10px;border:1px solid #3a3a3f;background:#2e2e32;color:#ececef;font-size:15px}
.files a{display:inline-block;margin:8px 8px 0 0;padding:10px 14px;border-radius:10px;background:#2f7fe0;color:#fff;text-decoration:none;font-weight:600}
.files a.alt{background:#2e2e32;border:1px solid #3a3a3f}
.closed{padding:14px;border-radius:10px;background:#3a2a1e;color:#ffc861}
`

interface UploadTexts {
  title: string
  forProject: string
  name: string
  namePlaceholder: string
  pick: string
  keepOn: string
  limits: string
  summary: string
  waiting: string
  uploading: string
  done: string
  allDone: string
  tooBig: string
  badType: string
  closed: string
  full: string
  failed: string
  retry: string
  busy: string
}

const UPLOAD_TEXT: Record<PageLang, UploadTexts> = {
  de: {
    title: 'Fotos und Videos teilen',
    forProject: 'für „{p}“',
    name: 'Dein Name (freiwillig)',
    namePlaceholder: 'z. B. Mia',
    pick: 'Fotos und Videos auswählen',
    keepOn: 'Lass den Bildschirm an und die Seite offen, bis alles hochgeladen ist.',
    limits: 'Höchstens {p} pro Foto und {v} pro Video.',
    summary: '{d} von {t} hochgeladen',
    waiting: 'wartet…',
    uploading: 'wird hochgeladen… {p} %',
    done: 'angekommen',
    allDone: 'Danke! Alles ist angekommen.',
    tooBig: 'zu groß',
    badType: 'Dateityp wird nicht unterstützt',
    closed: 'Hochladen ist gerade pausiert',
    full: 'Kein Platz mehr auf dem Laptop',
    failed: 'fehlgeschlagen',
    retry: 'Fehlgeschlagene noch einmal senden',
    busy: 'Viele senden gleichzeitig – gleich geht es weiter…'
  },
  en: {
    title: 'Share photos and videos',
    forProject: 'for “{p}”',
    name: 'Your name (optional)',
    namePlaceholder: 'e.g. Mia',
    pick: 'Choose photos and videos',
    keepOn: 'Keep the screen on and this page open until everything is uploaded.',
    limits: 'At most {p} per photo and {v} per video.',
    summary: '{d} of {t} uploaded',
    waiting: 'waiting…',
    uploading: 'uploading… {p} %',
    done: 'arrived',
    allDone: 'Thanks! Everything arrived.',
    tooBig: 'too large',
    badType: 'file type not supported',
    closed: 'Uploading is paused right now',
    full: 'The laptop is out of space',
    failed: 'failed',
    retry: 'Send failed ones again',
    busy: 'Many people are sending – continuing in a moment…'
  }
}

/** Client script of the upload page: one file at a time, raw body, retries on 503 and network errors. */
const UPLOAD_SCRIPT = `
(function () {
  var C = JSON.parse(document.getElementById('cfg').textContent)
  var T = C.t
  var nameEl = document.getElementById('name')
  var pick = document.getElementById('files')
  var list = document.getElementById('list')
  var sum = document.getElementById('sum')
  var bar = document.getElementById('bar')
  var note = document.getElementById('note')
  var retryBtn = document.getElementById('retry')
  var items = []
  var running = false
  var lock = null
  try { nameEl.value = localStorage.getItem('diashowName') || '' } catch (e) {}
  nameEl.addEventListener('change', function () { try { localStorage.setItem('diashowName', nameEl.value) } catch (e) {} })
  function ext(n) { var m = /\\.([^.\\/\\\\]+)$/.exec(n || ''); return m ? m[1].toLowerCase() : '' }
  function kindOf(f) {
    var e = ext(f.name)
    if (C.photo.indexOf(e) >= 0) return 'photo'
    if (C.video.indexOf(e) >= 0) return 'video'
    var m = C.mime[(f.type || '').toLowerCase()]
    if (m) return C.photo.indexOf(m) >= 0 ? 'photo' : 'video'
    return null
  }
  function fmt(b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB' }
  function txt(el, s) { el.textContent = s }
  function show(it) {
    var s = it.state
    it.row.className = s === 'ok' ? 'ok' : (s === 'big' || s === 'type' || s === 'err' || s === 'closed' || s === 'full') ? 'bad' : ''
    var label = s === 'ok' ? T.done : s === 'up' ? T.uploading.replace('{p}', String(Math.floor(100 * it.sent / Math.max(1, it.file.size)))) :
      s === 'big' ? T.tooBig + ' (max. ' + fmt(C.limits[it.kind || 'photo']) + ')' : s === 'type' ? T.badType : s === 'closed' ? T.closed :
      s === 'full' ? T.full : s === 'err' ? T.failed : T.waiting
    txt(it.status, label)
    it.fill.style.width = (s === 'ok' ? 100 : 100 * it.sent / Math.max(1, it.file.size)) + '%'
  }
  function total() {
    var good = items.filter(function (i) { return i.state !== 'big' && i.state !== 'type' })
    var all = good.reduce(function (n, i) { return n + i.file.size }, 0)
    var sent = good.reduce(function (n, i) { return n + (i.state === 'ok' ? i.file.size : i.sent) }, 0)
    var done = good.filter(function (i) { return i.state === 'ok' }).length
    bar.style.width = (all ? 100 * sent / all : 0) + '%'
    txt(sum, T.summary.replace('{d}', done).replace('{t}', good.length))
    var failed = items.some(function (i) { return i.state === 'err' })
    retryBtn.style.display = failed && !running ? '' : 'none'
    if (!running && good.length && done === good.length) txt(note, T.allDone)
  }
  function wake(on) {
    try {
      if (on && !lock && navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { lock = l }, function () {})
      if (!on && lock) { lock.release(); lock = null }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && running) { lock = null; wake(true) } })
  pick.addEventListener('change', function () {
    var files = Array.prototype.slice.call(pick.files || [])
    files.forEach(function (f) {
      var row = document.createElement('li')
      var n = document.createElement('div'); n.className = 'n'
      var a = document.createElement('span'); txt(a, f.name || '?')
      var b = document.createElement('span'); txt(b, fmt(f.size))
      n.appendChild(a); n.appendChild(b)
      var st = document.createElement('div'); st.className = 's'
      var pb = document.createElement('div'); pb.className = 'bar'
      var fill = document.createElement('div'); pb.appendChild(fill)
      row.appendChild(n); row.appendChild(st); row.appendChild(pb)
      list.appendChild(row)
      var kind = kindOf(f)
      var it = { file: f, kind: kind, row: row, status: st, fill: fill, sent: 0, busy: 0, tries: 0, state: 'wait' }
      if (!kind) it.state = 'type'
      else if (f.size > C.limits[kind]) it.state = 'big'
      items.push(it)
      show(it)
    })
    pick.value = ''
    txt(note, '')
    total()
    run()
  })
  retryBtn.addEventListener('click', function () {
    items.forEach(function (i) { if (i.state === 'err') { i.state = 'wait'; i.tries = 0; i.sent = 0; show(i) } })
    txt(note, '')
    run()
  })
  function run() {
    if (running) return
    var next = null
    for (var k = 0; k < items.length; k++) if (items[k].state === 'wait') { next = items[k]; break }
    if (!next) { wake(false); total(); return }
    running = true
    wake(true)
    send(next)
  }
  function finish(it) { show(it); running = false; total(); run() }
  function later(it, sec) {
    it.state = 'wait'; it.sent = 0; show(it); total()
    setTimeout(function () { send(it) }, sec * 1000)
  }
  function send(it) {
    var x = new XMLHttpRequest()
    x.open('POST', C.upload)
    x.setRequestHeader('X-File-Name', encodeURIComponent(it.file.name || ''))
    x.setRequestHeader('X-Uploader', encodeURIComponent(nameEl.value.trim().slice(0, 40)))
    x.setRequestHeader('Content-Type', it.file.type || 'application/octet-stream')
    it.state = 'up'; it.sent = 0; show(it)
    var last = 0
    x.upload.onprogress = function (e) { it.sent = e.loaded; var now = Date.now(); if (now - last > 200) { last = now; show(it); total() } }
    x.onload = function () {
      var s = x.status
      if (s === 201) { it.state = 'ok'; it.sent = it.file.size; note.textContent = ''; return finish(it) }
      if (s === 503 && it.busy++ < 300) { txt(note, T.busy); return later(it, Number(x.getResponseHeader('Retry-After')) || 3) }
      if (s === 413) { it.state = 'big'; return finish(it) }
      if (s === 415) { it.state = 'type'; return finish(it) }
      if (s === 403) { it.state = 'closed'; return finish(it) }
      if (s === 507) { it.state = 'full'; return finish(it) }
      fail(it)
    }
    x.onerror = function () { fail(it) }
    x.send(it.file)
  }
  function fail(it) {
    if (it.tries++ < 3) return later(it, 2 + it.tries * 2)
    it.state = 'err'
    finish(it)
  }
})()
`

export interface UploadPageOptions {
  lang: PageLang
  project: string
  uploadPath: string
  collecting: boolean
  photoExt: string[]
  videoExt: string[]
  /** MIME type → extension, for files without a known extension. */
  mime: Record<string, string>
  limits: { photo: number; video: number }
  nonce: string
}

export function uploadPage(o: UploadPageOptions): string {
  const t = UPLOAD_TEXT[o.lang]
  const cfg = { upload: o.uploadPath, photo: o.photoExt, video: o.videoExt, mime: o.mime, limits: o.limits, t }
  const limits = t.limits.replace('{p}', fmtBytes(o.limits.photo, o.lang)).replace('{v}', fmtBytes(o.limits.video, o.lang))
  return `<!doctype html>
<html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(t.title)}</title>${ICON_LINKS}<style>${STYLE}</style></head>
<body><main>
<h1>${escapeHtml(t.title)}</h1>
<p class="sub">${escapeHtml(t.forProject.replace('{p}', o.project))}</p>
${o.collecting ? '' : `<p class="closed">${escapeHtml(t.closed)}</p>`}
<label for="name">${escapeHtml(t.name)}</label>
<input id="name" type="text" maxlength="40" autocomplete="given-name" placeholder="${escapeHtml(t.namePlaceholder)}">
<label class="pick">${escapeHtml(t.pick)}<input id="files" type="file" multiple accept="image/*,video/*"></label>
<p class="hint">${escapeHtml(t.keepOn)} ${escapeHtml(limits)}</p>
<p class="sum" id="sum"></p>
<div class="bar"><div id="bar"></div></div>
<p class="hint" id="note" aria-live="polite"></p>
<button class="btn" id="retry" type="button" style="display:none">${escapeHtml(t.retry)}</button>
<ul id="list"></ul>
</main>
<script type="application/json" id="cfg">${jsonBlock(cfg)}</script>
<script nonce="${o.nonce}">${UPLOAD_SCRIPT}</script>
</body></html>`
}

const DOWNLOAD_TEXT: Record<PageLang, { title: string; forProject: string; none: string; view: string; save: string; iphone: string; android: string; reload: string }> = {
  de: {
    title: 'Video herunterladen',
    forProject: 'Diashow „{p}“',
    none: 'Noch nichts angeboten. Lade die Seite gleich noch einmal.',
    view: 'Ansehen',
    save: 'Speichern',
    iphone: 'iPhone: „Ansehen“ tippen, dann über das Teilen-Symbol „Video sichern“ wählen.',
    android: 'Android: „Speichern“ legt das Video in „Downloads“ ab.',
    reload: 'Neu laden'
  },
  en: {
    title: 'Download the video',
    forProject: 'Slideshow “{p}”',
    none: 'Nothing offered yet. Reload this page in a moment.',
    view: 'Watch',
    save: 'Save',
    iphone: 'iPhone: tap “Watch”, then choose “Save Video” from the share button.',
    android: 'Android: “Save” puts the video into “Downloads”.',
    reload: 'Reload'
  }
}

export interface DownloadPageOptions {
  lang: PageLang
  project: string
  offers: ShareOffer[]
  /** Path of a file below the download token, e.g. /<token>/f/<id>/<name>. */
  fileHref: (offer: ShareOffer) => string
}

export function downloadPage(o: DownloadPageOptions): string {
  const t = DOWNLOAD_TEXT[o.lang]
  const rows = o.offers
    .map((f) => {
      const href = escapeHtml(o.fileHref(f))
      return `<li><div class="n"><span>${escapeHtml(f.name)}</span><span>${escapeHtml(fmtBytes(f.size, o.lang))}</span></div>
<div class="files"><a href="${href}">${escapeHtml(t.view)}</a><a class="alt" href="${href}?dl=1" download>${escapeHtml(t.save)}</a></div></li>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(t.title)}</title>${ICON_LINKS}<style>${STYLE}</style></head>
<body><main>
<h1>${escapeHtml(t.title)}</h1>
<p class="sub">${escapeHtml(t.forProject.replace('{p}', o.project))}</p>
${o.offers.length ? `<ul>${rows}</ul>` : `<p class="hint">${escapeHtml(t.none)}</p>`}
<p class="hint">${escapeHtml(t.iphone)}<br>${escapeHtml(t.android)}</p>
<a class="btn" href="">${escapeHtml(t.reload)}</a>
</main></body></html>`
}
