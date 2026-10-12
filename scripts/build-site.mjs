// Builds the generated parts of the project website in docs/ (GitHub Pages, served from docs/ on main;
// https://asamedia.github.io/diashow-studio/). Run it with `npm run site` after changing the handbook,
// its screenshots, the app icon or the site's header and footer below; the output is committed.
//
//   docs/handbuch.html, docs/en/handbook.html   the in-app handbook (src/renderer/src/handbook/de.md,
//                                                en.md), parsed by the app's own parser (src/shared/handbook.ts)
//   docs/img/<de|en>/*.jpg                       its screenshots (src/renderer/public/handbook/<de|en>/), those
//                                                the handbook or a start page shows; recompressed when that helps
//   docs/assets/icon.svg, icon-32.png, icon-180.png   logo and favicons from build/icon.svg
//   docs/assets/og-de.jpg, og-en.jpg            preview pictures for links shared in messengers
//   header and footer of docs/index.html and docs/en/index.html (between <!-- site:header --> markers);
//   the rest of those two pages is written by hand.
// Not made here: docs/media/demo.mp4 and its poster demo.jpg, the demo video on the start pages, made by
// the app itself from the sample trip (npm run samples, then DIASHOW_DEMO_VIDEO=1 e2e/demo-video.spec.ts).
//
// Re-runnable: unchanged files are not rewritten, screenshots no longer in the handbook are removed.
// Needs Node 22.18 or newer (it imports the TypeScript parser directly).
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const docs = join(root, 'docs')
const SITE = 'https://asamedia.github.io/diashow-studio/'
const REPO = 'https://github.com/ASAMedia/diashow-studio'
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src https://api.github.com; base-uri 'none'; form-action 'none'"

if (typeof process.features.typescript !== 'string') {
  console.error('npm run site needs Node 22.18 or newer: it imports src/shared/handbook.ts directly.')
  process.exit(1)
}
const { parseHandbook, plain } = await import(pathToFileURL(join(root, 'src', 'shared', 'handbook.ts')).href)

/** Text of each language; paths are relative to the page. */
const LANG = {
  de: {
    folder: '',
    base: '',
    handbook: 'handbuch.html',
    other: { code: 'en', label: 'English', home: 'en/', handbook: 'en/handbook.html' },
    skip: 'Zum Inhalt springen',
    navLabel: 'Hauptmenü',
    sections: [
      ['funktionen', 'Funktionen'],
      ['datenschutz', 'Datenschutz']
    ],
    handbookLabel: 'Handbuch',
    download: 'Download',
    footerLabel: 'Weitere Links',
    footerLinks: [
      ['handbook', 'Handbuch'],
      [`${REPO}/issues/new/choose`, 'Problem melden'],
      [`${REPO}/releases`, 'Alle Versionen'],
      [REPO, 'Quellcode auf GitHub'],
      ['#lizenz', 'Lizenz (MIT)']
    ],
    footerNote:
      'Diese Website setzt keine Cookies und hat keine Tracker. Sie wird von GitHub Pages ausgeliefert; die Startseite fragt bei GitHub nach der neuesten Version.',
    hbTitle: 'Handbuch – Diashow Studio',
    hbDescription: 'Das Handbuch von Diashow Studio: erste Schritte, Themen, Musik, Gesichter verpixeln, Fotos im WLAN einsammeln, Export und Hilfe, wenn etwas nicht klappt.',
    hbLead: 'Alles für deine erste Diashow und darüber hinaus. Dasselbe Handbuch steckt in der App: <kbd>F1</kbd> drücken.',
    toc: 'Inhalt',
    ogLocale: 'de_DE',
    ogAltLocale: 'en_GB',
    where: { shortcuts: 'in der App: Einstellungen → Tastenkürzel', settings: 'in der App: Zahnrad oben rechts', wizard: 'in der App auf der Startseite' },
    og: { tagline: ['Diashows wie auf dem Mac –', 'für Windows.'], points: ['11 Themen und eigene Musik', 'Gesichter verpixeln', 'Fotos per QR-Code einsammeln', 'Kostenlos, offline, Open Source'] }
  },
  en: {
    folder: 'en',
    base: '../',
    handbook: 'handbook.html',
    other: { code: 'de', label: 'Deutsch', home: '../', handbook: '../handbuch.html' },
    skip: 'Skip to content',
    navLabel: 'Main menu',
    sections: [
      ['features', 'Features'],
      ['privacy', 'Privacy']
    ],
    handbookLabel: 'Handbook',
    download: 'Download',
    footerLabel: 'More links',
    footerLinks: [
      ['handbook', 'Handbook'],
      [`${REPO}/issues/new/choose`, 'Report a problem'],
      [`${REPO}/releases`, 'All versions'],
      [REPO, 'Source code on GitHub'],
      ['#licence', 'Licence (MIT)']
    ],
    footerNote:
      'This website sets no cookies and has no trackers. It is served by GitHub Pages; the start page asks GitHub for the newest version.',
    hbTitle: 'Handbook – Diashow Studio',
    hbDescription: 'The Diashow Studio handbook: getting started, themes, music, pixelating faces, collecting photos over Wi-Fi, exporting and troubleshooting.',
    hbLead: 'Everything for your first slideshow and beyond. The same handbook is built into the app: press <kbd>F1</kbd>.',
    toc: 'Contents',
    ogLocale: 'en_GB',
    ogAltLocale: 'de_DE',
    where: { shortcuts: 'in the app: Settings → Keyboard shortcuts', settings: 'in the app: the gear at the top right', wizard: 'in the app on the home screen' },
    og: { tagline: ['Slideshows like on the Mac –', 'for Windows.'], points: ['11 themes and your own music', 'Pixelate faces', 'Collect photos by QR code', 'Free, offline, open source'] }
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const written = []

/** Writes a file only when its content changed (keeps unchanged files untouched). */
async function put(file, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  const old = existsSync(file) ? await readFile(file) : null
  if (old && old.equals(buf)) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, buf)
  written.push(relative(root, file).replaceAll('\\', '/'))
}

// ---------------------------------------------------------------- screenshots

/** Names of the screenshots of a language that its handbook or a start page shows. */
async function usedScreenshots(lang) {
  const md = await readFile(join(root, 'src', 'renderer', 'src', 'handbook', `${lang}.md`), 'utf8')
  const used = new Set([...md.matchAll(/!\[[^\]]*\]\(([\w.-]+)\)/g)].map((m) => m[1]))
  for (const page of ['index.html', 'en/index.html']) {
    for (const m of (await readFile(join(docs, page), 'utf8')).matchAll(new RegExp(`img/${lang}/([\\w.-]+)`, 'g'))) used.add(m[1])
  }
  return used
}

/**
 * Copies the handbook screenshots of a language that the website shows (the app has more); recompressed
 * when that saves at least 10 %.
 */
async function screenshots(lang) {
  const src = join(root, 'src', 'renderer', 'public', 'handbook', lang)
  const dest = join(docs, 'img', lang)
  const used = await usedScreenshots(lang)
  const files = (await readdir(src)).filter((f) => /\.(jpe?g|png)$/i.test(f) && used.has(f)).sort()
  const sizes = new Map()
  for (const file of files) {
    const input = await readFile(join(src, file))
    const meta = await sharp(input).metadata()
    let out = input
    if (meta.format === 'jpeg') {
      const smaller = await sharp(input).jpeg({ quality: 80, mozjpeg: true }).toBuffer()
      if (smaller.length < input.length * 0.9) out = smaller
    }
    await put(join(dest, file), out)
    sizes.set(file, { width: meta.width, height: meta.height })
  }
  // screenshots the handbook no longer has
  if (existsSync(dest)) {
    for (const file of await readdir(dest)) {
      if (!sizes.has(file)) {
        await rm(join(dest, file))
        written.push(`docs/img/${lang}/${file} (removed)`)
      }
    }
  }
  return sizes
}

// ---------------------------------------------------------------- icons and link previews

async function icons() {
  const svg = await readFile(join(root, 'build', 'icon.svg'))
  await put(join(docs, 'assets', 'icon.svg'), svg)
  // rendered at 256 px and scaled down, as scripts/make-icon.mjs does
  await put(join(docs, 'assets', 'icon-32.png'), await sharp(svg, { density: 72 }).resize(32, 32, { kernel: 'lanczos3' }).png().toBuffer())
  // iOS shows transparent touch icons on black: the icon on white with a margin
  const inner = await sharp(svg, { density: 72 }).resize(148, 148, { kernel: 'lanczos3' }).png().toBuffer()
  await put(
    join(docs, 'assets', 'icon-180.png'),
    await sharp({ create: { width: 180, height: 180, channels: 4, background: '#ffffff' } })
      .composite([{ input: inner, left: 16, top: 16 }])
      .png()
      .toBuffer()
  )
}

/** 1200×630 preview picture for links in messengers: icon, name, tagline, four points and the editor. */
async function ogImage(lang) {
  const t = LANG[lang]
  const W = 1200
  const H = 630
  const font = "'Segoe UI', 'Noto Sans', 'DejaVu Sans', Arial, sans-serif"
  const points = t.og.points
    .map(
      (p, i) =>
        `<g transform="translate(64 ${372 + i * 50})"><circle cx="13" cy="-9" r="13" fill="#2f7fe0"/><path d="M7 -9 l4.5 4.5 l8 -9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<text x="38" y="0" font-family="${font}" font-size="27" fill="#dbe7f7">${esc(p)}</text></g>`
    )
    .join('')
  const base = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#121722"/><stop offset="1" stop-color="#18365f"/></linearGradient>
      <radialGradient id="glow" cx="0.85" cy="0.75" r="0.6"><stop offset="0" stop-color="#4d9fff" stop-opacity="0.35"/><stop offset="1" stop-color="#4d9fff" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    <text x="180" y="125" font-family="${font}" font-size="62" font-weight="700" fill="#ffffff">Diashow Studio</text>
    <text x="64" y="232" font-family="${font}" font-size="38" font-weight="600" fill="#ffffff">${esc(t.og.tagline[0])}</text>
    <text x="64" y="282" font-family="${font}" font-size="38" font-weight="600" fill="#7db8ff">${esc(t.og.tagline[1])}</text>
    ${points}
  </svg>`
  const icon = await sharp(await readFile(join(root, 'build', 'icon.svg')), { density: 72 }).resize(96, 96).png().toBuffer()
  const sw = 560
  const sh = Math.round((sw * 688) / 1100)
  const shot = await sharp(join(root, 'src', 'renderer', 'public', 'handbook', lang, 'editor.jpg'))
    .resize(sw, sh)
    .composite([{ input: Buffer.from(`<svg width="${sw}" height="${sh}"><rect width="${sw}" height="${sh}" rx="14" ry="14"/></svg>`), blend: 'dest-in' }])
    .png()
    .toBuffer()
  const frame = Buffer.from(`<svg width="${sw + 4}" height="${sh + 4}"><rect x="1" y="1" width="${sw + 2}" height="${sh + 2}" rx="15" ry="15" fill="none" stroke="#4d9fff" stroke-opacity="0.55" stroke-width="2"/></svg>`)
  const left = W - sw - 56
  const top = H - sh - 64
  const jpg = await sharp(Buffer.from(base))
    .composite([
      { input: icon, left: 64, top: 46 },
      { input: shot, left, top },
      { input: frame, left: left - 2, top: top - 2 }
    ])
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer()
  await put(join(docs, 'assets', `og-${lang}.jpg`), jpg)
}

// ---------------------------------------------------------------- header and footer

/** "2026 ASAMedia", from LICENSE. */
let licenseText = ''
const copyright = () => /Copyright \(c\) (\d{4}) (.+)/i.exec(licenseText)?.slice(1).join(' ').trim() ?? 'ASAMedia'

/** The shared header; `page` is 'home' or 'handbook'. */
function header(lang, page) {
  const t = LANG[lang]
  const home = page === 'home'
  const icon = `${t.base}assets/icon.svg`
  const section = (id) => (home ? `#${id}` : `./#${id}`)
  const other = home ? t.other.home : t.other.handbook
  return [
    `<a class="skip" href="#main">${esc(t.skip)}</a>`,
    `<header class="site-header">`,
    `  <div class="wrap header-inner">`,
    `    <a class="brand" href="./"><img src="${icon}" alt="" width="32" height="32">Diashow Studio</a>`,
    `    <nav class="site-nav" aria-label="${esc(t.navLabel)}">`,
    ...t.sections.map(([id, label]) => `      <a class="nav-wide" href="${section(id)}">${esc(label)}</a>`),
    `      <a href="${t.handbook}"${home ? '' : ' aria-current="page"'}>${esc(t.handbookLabel)}</a>`,
    `      <a class="nav-cta" href="${section('download')}">${esc(t.download)}</a>`,
    `      <a class="nav-lang" href="${other}" hreflang="${t.other.code}" lang="${t.other.code}">${esc(t.other.label)}</a>`,
    `    </nav>`,
    `  </div>`,
    `</header>`
  ].join('\n')
}

function footer(lang, page) {
  const t = LANG[lang]
  const home = page === 'home'
  const href = (h) => (h === 'handbook' ? t.handbook : h.startsWith('#') && !home ? `./${h}` : h)
  return [
    `<footer class="site-footer">`,
    `  <div class="wrap footer-inner">`,
    `    <a class="brand" href="./"><img src="${t.base}assets/icon.svg" alt="" width="24" height="24">Diashow Studio</a>`,
    `    <nav aria-label="${esc(t.footerLabel)}">`,
    `      <ul class="footer-nav">`,
    ...t.footerLinks.map(([h, label]) => `        <li><a href="${esc(href(h))}">${esc(label)}</a></li>`),
    `      </ul>`,
    `    </nav>`,
    `    <p>© ${esc(copyright())}. ${esc(t.footerNote)}</p>`,
    `  </div>`,
    `</footer>`
  ].join('\n')
}

/** Replaces what stands between <!-- site:name … --> and <!-- /site:name --> in a hand-written page. */
function fillMarkers(html, parts, file) {
  for (const [name, content] of Object.entries(parts)) {
    const re = new RegExp(`(<!-- site:${name}\\b[^>]*-->)[\\s\\S]*?(<!-- /site:${name} -->)`)
    if (!re.test(html)) throw new Error(`${file}: the <!-- site:${name} --> markers are missing`)
    html = html.replace(re, (_m, open, close) => `${open}\n${content}\n${close}`)
  }
  return html
}

// ---------------------------------------------------------------- handbook

/** Inline markup of the handbook subset, as handbook/markdown.tsx renders it in the app. */
const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\)/g

function inline(text, ctx) {
  let out = ''
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    out += esc(text.slice(last, m.index))
    if (m[1] != null) out += `<strong>${esc(m[1])}</strong>`
    else if (m[2] != null) out += `<code>${esc(m[2])}</code>`
    else if (m[3] != null) out += `<kbd>${esc(m[3])}</kbd>`
    else {
      const [label, href] = [m[4], m[5]]
      if (href.startsWith('#')) {
        if (!ctx.ids.has(href.slice(1))) throw new Error(`${ctx.lang}.md: link to a missing chapter ${href}`)
        out += `<a href="${esc(href)}">${esc(label)}</a>`
      } else if (href.startsWith('app:')) {
        // an action in the app (opens a dialog): named, with where to find it when the name doesn't say
        const where = ctx.where[href.slice(4)]
        out += `<strong>${esc(label)}</strong>${where ? ` <span class="in-app">(${esc(where)})</span>` : ''}`
      } else if (/^https:\/\//.test(href)) out += `<a href="${esc(href)}">${esc(label)}</a>`
      else out += esc(label)
    }
    last = m.index + m[0].length
  }
  return out + esc(text.slice(last))
}

function block(b, ctx) {
  switch (b.type) {
    case 'p':
      return `<p>${inline(b.text, ctx)}</p>`
    case 'h3':
      return `<h3>${inline(b.text, ctx)}</h3>`
    case 'tip':
      return `<p class="tip">${inline(b.text, ctx)}</p>`
    case 'ul':
    case 'ol':
      return `<${b.type}>\n${b.items.map((it) => `  <li>${inline(it, ctx)}</li>`).join('\n')}\n</${b.type}>`
    case 'table':
      return `<div class="table-wrap"><table>\n<tbody>\n${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join('')}</tr>`).join('\n')}\n</tbody>\n</table></div>`
    case 'img': {
      const size = ctx.sizes.get(b.file)
      if (!size) throw new Error(`${ctx.lang}.md: the screenshot ${b.file} is missing`)
      const alt = plain(b.alt)
      return `<figure>\n  <img src="${ctx.base}img/${ctx.lang}/${esc(b.file)}" width="${size.width}" height="${size.height}" alt="${esc(alt)}" loading="lazy" decoding="async">\n  ${alt ? `<figcaption>${esc(alt)}</figcaption>` : ''}\n</figure>`
    }
    default:
      throw new Error(`unknown block ${b.type}`)
  }
}

async function handbookPage(lang, sizes) {
  const t = LANG[lang]
  const md = await readFile(join(root, 'src', 'renderer', 'src', 'handbook', `${lang}.md`), 'utf8')
  const book = parseHandbook(md)
  const ctx = { lang, base: t.base, sizes, where: t.where, ids: new Set(book.chapters.map((c) => c.id)) }
  const url = `${SITE}${t.folder ? `${t.folder}/` : ''}${t.handbook}`
  const otherUrl = `${SITE}${t.other.handbook.replace(/^\.\.\//, '')}`
  const [deUrl, enUrl] = lang === 'de' ? [url, otherUrl] : [otherUrl, url]
  const title = book.title || t.handbookLabel
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<!-- Generated by scripts/build-site.mjs from src/renderer/src/handbook/${lang}.md: edit that file and run npm run site. -->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${esc(t.hbTitle)}</title>
<meta name="description" content="${esc(t.hbDescription)}">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="de" href="${deUrl}">
<link rel="alternate" hreflang="en" href="${enUrl}">
<link rel="alternate" hreflang="x-default" href="${deUrl}">
<link rel="icon" href="${t.base}assets/icon.svg" type="image/svg+xml">
<link rel="icon" href="${t.base}assets/icon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="${t.base}assets/icon-180.png">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f5f6f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141518" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Diashow Studio">
<meta property="og:locale" content="${t.ogLocale}">
<meta property="og:locale:alternate" content="${t.ogAltLocale}">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(t.hbTitle)}">
<meta property="og:description" content="${esc(t.hbDescription)}">
<meta property="og:image" content="${SITE}assets/og-${lang}.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="${t.base}assets/site.css">
</head>
<body>
<!-- site:header -->
${header(lang, 'handbook')}
<!-- /site:header -->

<div class="wrap hb-layout">
<nav class="hb-toc" aria-labelledby="toc-title">
<p class="toc-title" id="toc-title">${esc(t.toc)}</p>
<ol>
${book.chapters.map((c) => `  <li><a href="#${c.id}">${inline(c.title, ctx)}</a></li>`).join('\n')}
</ol>
</nav>

<main id="main" class="hb-main">
<h1>${esc(title)}</h1>
<p class="lead">${t.hbLead}</p>
${book.chapters
  .map((c) => `\n<section class="hb-chapter" id="${c.id}" aria-labelledby="${c.id}-title">\n<h2 id="${c.id}-title">${inline(c.title, ctx)}</h2>\n${c.blocks.map((b) => block(b, ctx)).join('\n')}\n</section>`)
  .join('\n')}
</main>
</div>

<!-- site:footer -->
${footer(lang, 'handbook')}
<!-- /site:footer -->
</body>
</html>
`
  await put(join(docs, t.folder, t.handbook), html)
}

// ---------------------------------------------------------------- start pages

async function startPage(lang) {
  const t = LANG[lang]
  const file = join(docs, t.folder, 'index.html')
  const html = await readFile(file, 'utf8')
  await put(file, fillMarkers(html, { header: header(lang, 'home'), footer: footer(lang, 'home') }, relative(root, file)))
}

/** Every local file a page links to or loads exists (screenshots, assets, the other pages). */
async function checkLinks() {
  const missing = []
  const pages = ['index.html', 'handbuch.html', 'en/index.html', 'en/handbook.html']
  for (const page of pages) {
    const html = await readFile(join(docs, page), 'utf8')
    for (const m of html.matchAll(/\s(?:src|href|poster)="([^"]*)"/g)) {
      const ref = m[1]
      if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('#')) continue
      let path = posix.normalize(posix.join(posix.dirname(page), ref.replace(/[?#].*$/, '')))
      if (path.endsWith('/') || path === '.') path = posix.join(path, 'index.html')
      if (path.startsWith('..') || !existsSync(join(docs, path))) missing.push(`${page}: ${ref}`)
    }
    for (const m of html.matchAll(/\shref="#([^"]+)"/g)) {
      if (!html.includes(`id="${m[1]}"`)) missing.push(`${page}: #${m[1]}`)
    }
  }
  if (missing.length) throw new Error(`broken links in docs/:\n  ${missing.join('\n  ')}`)
}

// ---------------------------------------------------------------- run

licenseText = await readFile(join(root, 'LICENSE'), 'utf8')
await put(join(docs, '.nojekyll'), '')
await icons()
for (const lang of Object.keys(LANG)) {
  const sizes = await screenshots(lang)
  await ogImage(lang)
  await handbookPage(lang, sizes)
  await startPage(lang)
}
await checkLinks()

console.log(written.length ? `docs/ updated:\n  ${written.join('\n  ')}` : 'docs/ is up to date.')
