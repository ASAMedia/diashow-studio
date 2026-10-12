// Collects the source code of every library compiled into the bundled FFmpeg build, for the GitHub
// release (GPLv3 section 6, Corresponding Source). The release workflow attaches FFmpeg's own source
// and the BtbN build scripts; this adds the libraries the build links in.
//
//   node scripts/gpl-sources.mjs [out-dir] [--work <dir>] [--jobs 5] [--tag <btbn-tag>] [--continue-on-error]
//
// Reads the pinned BtbN tag and asset from scripts/ffmpeg-build.json, downloads the build scripts of
// that tag and reads scripts.d as text: which stages the target / variant / addin of the asset builds,
// and what the download step of each stage fetches (repositories at their pinned revision, git
// submodules, shaderc's DEPS, meson wraps, Rust crates, the Opus model data). Every source is
// downloaded at that revision into out-dir (default dist/gpl-sources) as ffmpeg-deps-sources-<tag>.tar
// (.part1.tar, .part2.tar … when above 1.9 GB) with the manifest ffmpeg-deps-sources-<tag>.txt.
// Downloads are data only: nothing from them is run (no configure, no checkout, no hooks: bare
// repositories and git archive). A source that can't be fetched fails the run.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGunzip, gzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds'
const UA = 'diashow-studio-gpl-sources (+https://github.com/ASAMedia/diashow-studio)'
const PART_LIMIT = 1_900_000_000
const GITLAB_HOSTS = new Set(['gitlab.com', 'gitlab.freedesktop.org', 'code.videolan.org', 'gitlab.gnome.org', 'gitlab.xiph.org', 'invent.kde.org', 'salsa.debian.org'])
const log = (...a) => console.log('[gpl-sources]', ...a)

// ---------- reading the build scripts (pure functions, no network)

/** Variables and functions of a BtbN stage script, read as text (never run). */
export function parseScript(text) {
  const src = text.replace(/\r\n/g, '\n')
  const fn = /^(\w+)\(\)\s*\{[ \t]*\n([\s\S]*?)^\}[ \t]*$/gm
  const functions = {}
  for (const m of src.matchAll(fn)) functions[m[1]] = m[2]
  const vars = {}
  for (const line of src.replace(fn, '').split('\n')) {
    const m = /^(SCRIPT_\w+)=(.*)$/.exec(line.trim())
    if (m) vars[m[1]] = shellValue(m[2], vars)
  }
  return { vars, functions, skip: Boolean(vars.SCRIPT_SKIP), sources: scriptSources(vars) }
}

/** `"…$SCRIPT_X…"`, `'…'` or a bare word, with SCRIPT_* variables expanded. */
function shellValue(raw, vars) {
  const s = raw.trim()
  if (s.startsWith("'")) return s.slice(1, s.indexOf("'", 1))
  const dq = /^"((?:[^"\\]|\\.)*)"/.exec(s)
  return expand(dq ? dq[1] : s.split(/\s/)[0], vars)
}

/** Expands $SCRIPT_* / ${SCRIPT_*} and backslash escapes as bash does inside double quotes. */
function expand(text, vars) {
  return text.replace(/\\(.)|\$\{?(SCRIPT_\w+)\}?/g, (all, esc, name) => (esc !== undefined ? esc : vars[name] ?? all))
}

const FIELD = /^SCRIPT_(REPO|COMMIT|TAG|BRANCH|TAGFILTER|MIRROR|REV|HGREV|URL|SHA512|SHA256|SHA)(\d*)$/

/** The sources a script pins: SCRIPT_REPO/COMMIT/…, SCRIPT_URL/SHA…, and the numbered SCRIPT_REPO2 … */
export function scriptSources(vars) {
  const byNumber = new Map()
  for (const [key, value] of Object.entries(vars)) {
    const m = FIELD.exec(key)
    if (!m || !value) continue
    const n = m[2] ? Number(m[2]) : 1
    if (!byNumber.has(n)) byNumber.set(n, { n })
    byNumber.get(n)[m[1].toLowerCase()] = value
  }
  return [...byNumber.values()].sort((a, b) => a.n - b.n).map((f) => {
    if (f.url) {
      const sum = (f.sha512 ?? f.sha256 ?? f.sha)?.toLowerCase()
      return { n: f.n, kind: 'url', url: f.url, hash: sum ? { algo: sum.length === 128 ? 'sha512' : 'sha256', value: sum } : null }
    }
    if (!f.repo) return { n: f.n, kind: 'invalid', error: `SCRIPT_*${f.n > 1 ? f.n : ''} without SCRIPT_REPO or SCRIPT_URL` }
    if (f.rev) return { n: f.n, kind: 'svn', url: f.repo, ref: f.rev }
    if (f.hgrev) return { n: f.n, kind: 'hg', url: f.repo, ref: f.hgrev }
    const ref = f.commit ?? f.tag
    if (!ref) return { n: f.n, kind: 'invalid', url: f.repo, error: `${f.repo} is not pinned to a commit or tag` }
    const isSha = /^[0-9a-f]{40}$/i.test(ref)
    return { n: f.n, kind: 'git', url: f.repo, ref, isSha, isTag: !isSha, branch: f.branch, mirror: f.mirror }
  })
}

/** Splits a shell list at top-level &&, || (and ; when asked), outside quotes, [[ ]] and ( ). */
function splitList(s, separators = ['&&', '||']) {
  const parts = []
  const ops = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '\\') i++
    else if (s.startsWith('[[', i) || s.startsWith(']]', i)) {
      depth += c === '[' ? 1 : -1
      i++
    } else if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0) {
      const op = separators.find((sep) => s.startsWith(sep, i))
      if (op) {
        parts.push(s.slice(start, i).trim())
        ops.push(op)
        i += op.length - 1
        start = i + 1
      }
    }
  }
  parts.push(s.slice(start).trim())
  return { parts, ops }
}

function globToRegExp(pattern) {
  if (/[[\]\\$`"']/.test(pattern)) return null
  return new RegExp(`^${pattern.replace(/[.+^${}()|]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
}

/** One `$TARGET == win*` style test inside [[ ]]; null when it is something else. */
function evalAtom(atom, ctx) {
  let s = atom.trim()
  let negate = false
  if (s.startsWith('! ')) {
    negate = true
    s = s.slice(2).trim()
  }
  const m = /^"?\$\{?(TARGET|VARIANT|ADDINS_STR)\}?"?\s*(==|!=|=)\s*(\S+)$/.exec(s)
  if (!m) return null
  const value = ctx[m[1]]
  const quoted = /^(["']).*\1$/.exec(m[3])
  const re = quoted ? null : globToRegExp(m[3])
  if (!quoted && !re) return null
  const hit = quoted ? value === m[3].slice(1, -1) : re.test(value)
  return (m[2] === '!=' ? !hit : hit) !== negate
}

function evalTest(expr, ctx) {
  const { parts, ops } = splitList(expr)
  let value = null
  for (let i = 0; i < parts.length; i++) {
    if (i > 0 && (ops[i - 1] === '&&' ? !value : value)) continue
    value = evalAtom(parts[i], ctx)
    if (value === null) return null
  }
  return value
}

function evalArith(expr, ctx) {
  const e = expr.replace(/\$\(\s*ffbuild_ffver\s*\)/g, String(ctx.ffver)).trim()
  const m = /^(-?\d+)\s*(>=|<=|==|!=|>|<)\s*(-?\d+)$/.exec(e)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[3])
  return { '>': a > b, '>=': a >= b, '<': a < b, '<=': a <= b, '==': a === b, '!=': a !== b }[m[2]]
}

/** One command of ffbuild_enabled(): { status } or { ret } (a return ran); null if unreadable. */
function evalCommand(cmd, status, ctx, other) {
  let m
  if ((m = /^return(?:\s+(-?\d+))?$/.exec(cmd))) return { ret: m[1] === undefined ? status : Number(m[1]) }
  if (cmd === 'true' || cmd === ':') return { status: 0 }
  if (cmd === 'false') return { status: 1 }
  if ((m = /^\[\[\s+(.*)\s+\]\]$/.exec(cmd))) {
    const v = evalTest(m[1], ctx)
    return v === null ? null : { status: v ? 0 : 1 }
  }
  if ((m = /^\(\(\s*(.*?)\s*\)\)$/.exec(cmd))) {
    const v = evalArith(m[1], ctx)
    return v === undefined || v === null ? null : { status: v ? 0 : 1 }
  }
  if ((m = /^\(\s*source\s+"?([^"\s]+)"?\s*&&\s*ffbuild_enabled\s*\)$/.exec(cmd))) {
    const r = other(m[1])
    return !r || !r.sure ? null : { status: r.enabled ? 0 : 1 }
  }
  return null
}

/**
 * Evaluates ffbuild_enabled() of a parsed script for ctx = { TARGET, VARIANT, ADDINS_STR, ffver }.
 * Returns { enabled, sure, reason }. A line it can't read makes it unsure, and an unsure stage
 * counts as enabled: a superset of sources is fine, a missing one is not.
 */
export function evalEnabled(script, ctx, other = () => null) {
  const body = script.functions.ffbuild_enabled
  if (body === undefined) return { enabled: true, sure: false, reason: 'has no ffbuild_enabled()' }
  let status = 0
  let last = ''
  for (const raw of body.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (!line) continue
    const { parts, ops } = splitList(line)
    for (let i = 0; i < parts.length; i++) {
      if (i > 0 && (ops[i - 1] === '&&' ? status !== 0 : status === 0)) continue
      const r = evalCommand(parts[i], status, ctx, other)
      if (!r) return { enabled: true, sure: false, reason: `could not evaluate "${line}"` }
      if (r.ret !== undefined) return { enabled: r.ret === 0, sure: true, reason: line }
      status = r.status
    }
    last = line
  }
  return { enabled: status === 0, sure: true, reason: last }
}

/** FFmpeg version number for the addins (ffbuild_ffver in util/vars.sh). */
export function ffverFor(varsSh, addins) {
  const body = parseScript(varsSh).functions.ffbuild_ffver ?? ''
  for (const m of body.matchAll(/^\s*([^\s)]+)\)\s*\n\s*echo\s+(\d+)/gm)) if (globToRegExp(m[1])?.test(addins)) return Number(m[2])
  return null
}

const dependsOf = (script) => {
  const body = script.functions.ffbuild_depends
  if (body === undefined) return ['base'] // the default in util/vars.sh
  return [...body.matchAll(/^\s*echo\s+["']?([\w.-]+)["']?\s*$/gm)].map((m) => m[1])
}

const configureFlags = (script) => [...(script.functions.ffbuild_configure ?? '').matchAll(/--enable-[\w-]+/g)].map((m) => m[0])

/** target / variant / addins of a BtbN asset name like ffmpeg-n9.0.2-…-win64-gpl-shared-9.0. */
export function assetTarget(asset) {
  const m = /-((?:win|linux)[a-z0-9]+)-((?:gpl|lgpl|nonfree)(?:-shared)?)(?:-([\w.-]+))?$/.exec(asset)
  return m ? { target: m[1], variant: m[2], addins: m[3] ?? '' } : null
}

/**
 * Which stages the build compiles, as BtbN's generate.sh walks them: from the last entry of scripts.d
 * along ffbuild_depends, through enabled scripts. A folder stage is built when its last script is
 * enabled, and then each of its enabled scripts. `files` maps paths of the repository (scripts.d/…,
 * util/vars.sh) to their text.
 */
export function readBuild(files, { target, variant, addins }) {
  const ffver = ffverFor(files.get('util/vars.sh') ?? '', addins) ?? 99999999
  const ctx = { TARGET: target, VARIANT: variant, ADDINS_STR: addins, ffver }
  const scripts = new Map()
  const stages = new Map()
  for (const path of [...files.keys()].filter((p) => /^scripts\.d\/[^/]+(\/[^/]+)?\.sh$/.test(p)).sort()) {
    const parts = path.split('/')
    // generate.sh finds a stage as scripts.d/??-<name>
    const stage = parts[1].replace(/^..-/, '').replace(/\.sh$/, '')
    const key = parts.at(-1).replace(/^..-/, '').replace(/\.sh$/, '')
    scripts.set(path, { path, key, stage, ...parseScript(files.get(path)) })
    if (!stages.has(stage)) stages.set(stage, { name: stage, folder: parts.length > 2, scripts: [] })
    stages.get(stage).scripts.push(path)
  }
  const memo = new Map()
  const enabled = (path) => {
    const p = path.replace(/^\.\//, '')
    if (!memo.has(p)) {
      memo.set(p, { enabled: true, sure: false, reason: 'recursive check' })
      const s = scripts.get(p)
      memo.set(p, s ? evalEnabled(s, ctx, enabled) : { enabled: true, sure: false, reason: `${p} is missing` })
    }
    return memo.get(p)
  }
  const wantedBy = new Map()
  for (const s of scripts.values()) for (const dep of dependsOf(s)) wantedBy.set(dep, [...(wantedBy.get(dep) ?? []), s.stage])

  const entry = [...stages.values()].at(-1)
  const decisions = new Map()
  const seen = new Set()
  const queue = [entry.name]
  while (queue.length) {
    const st = stages.get(queue.shift())
    if (!st || seen.has(st.name)) continue
    seen.add(st.name)
    const gate = st.folder ? enabled(st.scripts.at(-1)) : null
    for (const path of st.scripts) {
      const e = enabled(path)
      const on = (gate ? gate.enabled : true) && e.enabled
      const sure = e.sure && (gate ? gate.sure : true)
      let reason = on ? (sure ? '' : `included, unsure: ${(e.sure ? gate : e).reason}`) : ''
      if (!on) reason = gate && !gate.enabled ? `folder ${st.name} not built (${gate.reason})` : `not built for ${target} ${variant} ${addins}: ${e.reason}`
      decisions.set(path, { included: on, sure, reason })
      // generate.sh follows the dependencies of every enabled script, also in a folder that is off
      if (e.enabled) queue.push(...dependsOf(scripts.get(path)))
    }
  }
  for (const s of scripts.values()) {
    if (decisions.has(s.path)) continue
    const by = [...new Set(wantedBy.get(s.stage) ?? [])]
    decisions.set(s.path, { included: false, sure: true, reason: by.length ? `only needed by ${by.join(', ')}, which ${by.length > 1 ? 'are' : 'is'} not built` : 'no built stage needs it' })
  }
  const list = [...scripts.values()].map((s) => ({ ...s, ...decisions.get(s.path) }))
  return { ctx, entry: entry.name, scripts: list, included: list.filter((s) => s.included) }
}

// ---------- what a download step fetches

/** Splits a shell command into words (quotes removed; a="$(x)" stays one word). */
function shellWords(cmd) {
  const words = []
  let cur = null
  for (const m of cmd.matchAll(/(\s+)|"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:[^\s"'\\]|\\.)+)/g)) {
    if (m[1]) {
      if (cur !== null) words.push(cur)
      cur = null
    } else cur = (cur ?? '') + (m[2] ?? m[3] ?? m[4])
  }
  if (cur !== null) words.push(cur)
  return words
}

/**
 * Reads ffbuild_dockerdl() (the download step) statically: which repositories go where, the git
 * submodules it checks out, the files it deletes, and the extra downloads its commands make.
 * Commands that might download something it does not understand end up in `unhandled`.
 */
export function dlPlan(script) {
  const body = script.functions.ffbuild_dockerdl ?? 'default_dl .\n'
  const plan = { placed: [], unhandled: [], notes: [] }
  const commands = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    let m
    if (!line || line.startsWith('#') || /^(return(\s+0)?|true|:)$/.test(line)) continue
    if ((m = /^default_dl\s+(\S+)$/.exec(line))) commands.push(`git-mini-clone "$SCRIPT_REPO" "$SCRIPT_COMMIT" ${m[1]}`)
    else if ((m = /^echo\s+"((?:[^"\\]|\\.)*)"$/.exec(line))) commands.push(m[1])
    else if ((m = /^echo\s+'([^']*)'$/.exec(line))) commands.push(m[1].replace(/[\\$"]/g, '\\$&'))
    else plan.unhandled.push(`unreadable download step: ${line}`)
  }
  const sourceAt = (dir) => plan.placed.filter((p) => dir === p.dir || dir.startsWith(`${p.dir}/`) || p.dir === '.').sort((a, b) => b.dir.length - a.dir.length)[0]
  const place = (url, dir, ref) => plan.placed.push({ url, dir, ref, submodules: null, excludes: [], extras: [] })
  let cwd = '.'
  const at = (p) => posix.normalize(posix.join(cwd, p))
  const run = (cmd) => {
    for (const simple of splitList(cmd, ['&&', '||', ';']).parts) {
      const words = shellWords(simple)
      while (words.length && /^\w+=/.test(words[0])) words.shift()
      if (!words.length) continue
      const [w0, ...rest] = words
      const sub = w0 === 'git' && rest[0] === '-C' ? rest[2] : rest[0]
      const gitArgs = w0 === 'git' ? (rest[0] === '-C' ? rest.slice(3) : rest.slice(1)) : []
      const gitDir = w0 === 'git' && rest[0] === '-C' ? at(rest[1]) : cwd
      const args = (list) => {
        // positional arguments; these options take the next word as their value
        const out = []
        for (let i = 0; i < list.length; i++) {
          if (/^(-[bcjo]|--(branch|config|depth|jobs|origin|reference|filter|username|password|config-dir))$/.test(list[i])) i++
          else if (!list[i].startsWith('-')) out.push(list[i])
        }
        return out
      }
      const here = sourceAt(cwd)
      if (w0 === 'retry-tool') run(simple.trim().slice('retry-tool'.length))
      else if (w0 === 'sh' && rest[0] === '-c') run(rest[1] ?? '')
      else if (w0 === 'git-mini-clone') place(rest[0], at(rest[2] ?? '.'), rest[1])
      else if (w0 === 'git' && sub === 'clone') {
        const [url, dir] = args(gitArgs)
        place(url, at(dir ?? posix.basename(url).replace(/\.git$/, '')))
      } else if (w0 === 'git' && sub === 'submodule' && gitArgs[0] === 'update' && gitArgs.includes('--init')) {
        const paths = args(gitArgs.slice(1))
        const s = sourceAt(gitDir)
        if (s) s.submodules = { recursive: gitArgs.includes('--recursive'), paths: paths.length ? paths.map((p) => posix.relative(s.dir, posix.join(gitDir, p))) : null }
        else plan.unhandled.push(`submodules without a repository: ${simple}`)
      } else if (w0 === 'git' && (sub === 'checkout' || (sub === 'fetch' && gitArgs.includes('--unshallow')))) {
        // the revision comes from SCRIPT_COMMIT; history is not needed
      } else if (w0 === 'svn' && ['checkout', 'co', 'export'].includes(args(rest)[0])) {
        const [, url, dir] = args(rest)
        place(url.replace(/@\w+$/, ''), at(dir ?? '.'))
      } else if (w0 === 'rm') {
        for (const p of args(rest)) {
          const target = at(p)
          const s = sourceAt(target)
          // only deleting inside a fetched tree counts; "rm -rf x" before cloning into x is a retry cleanup
          if (s && target !== s.dir && posix.basename(target) !== '.git') s.excludes.push(posix.relative(s.dir, target))
        }
      } else if (w0 === 'cd') cwd = at(rest[0] ?? '.')
      else if (['mkdir', 'autoreconf', 'exit', 'true', ':'].includes(w0)) {
        // no downloads
      } else if (here && /(^|\/)git-sync-deps$/.test(w0)) here.extras.push({ type: 'deps', file: posix.relative(here.dir, at('DEPS')) })
      else if (here && /^(\.\/)?autogen\.sh$/.test(w0)) here.extras.push({ type: 'autogen', file: posix.relative(here.dir, at('autogen.sh')) })
      else if (here && w0 === 'meson' && rest[0] === 'subprojects' && rest[1] === 'download') here.extras.push({ type: 'wraps', names: args(rest.slice(2)) })
      else if (here && w0 === 'cargo' && rest[0] === 'vendor') here.extras.push({ type: 'cargo', file: posix.relative(here.dir, at('Cargo.lock')) })
      else plan.unhandled.push(`unknown command in the download step: ${simple}`)
    }
  }
  for (const c of commands) run(expand(c, script.vars))
  // "rm -rf gnulib" before cloning gnulib into a tree is a cleanup for retries, not a deletion
  for (const s of plan.placed) s.excludes = s.excludes.filter((x) => !plan.placed.some((o) => o !== s && posix.join(s.dir, x) === o.dir))
  // cargo during the build (rav1e) downloads the crates of Cargo.lock
  const build = script.functions.ffbuild_dockerbuild ?? ''
  if (/^\s*cargo\s+(c?install|c?build|fetch)\b/m.test(build) && !/CARGO_NET_OFFLINE=true/.test(build)) {
    const main = plan.placed[0]
    if (main && !main.extras.some((x) => x.type === 'cargo')) main.extras.push({ type: 'cargo', file: 'Cargo.lock', atBuild: true })
    for (const m of build.matchAll(/^\s*cargo\s+update\s+([\w-]+)/gm))
      plan.notes.push(`BtbN runs "cargo update ${m[1]}" before building, so cargo may use a newer ${m[1]} crate than Cargo.lock names; ${m[1]} is a build-time helper (it drives the C compiler) and is not linked into the library`)
  }
  for (const m of build.matchAll(/(?:^|[;&|(]\s*)\s*(git\s+clone|git-mini-clone|wget|curl|svn\s+(?:checkout|co|export)|meson\s+subprojects\s+download|git\s+submodule\s+update)\b/gm))
    plan.unhandled.push(`download in the build step: ${m[1]}`)
  return plan
}

/** Splits a Chromium-style DEPS file (shaderc) into { path, url, rev }. */
export function parseDeps(text) {
  const t = text.replace(/\r\n/g, '\n').replace(/"/g, "'")
  const vars = {}
  for (const m of (/^vars\s*=\s*\{([\s\S]*?)^\}/m.exec(t)?.[1] ?? '').matchAll(/'([^']+)'\s*:\s*'([^']*)'/g)) vars[m[1]] = m[2]
  const block = /^deps\s*=\s*\{([\s\S]*?)^\}/m.exec(t)?.[1]
  if (block === undefined) throw new Error('DEPS has no deps = { … }')
  return [...block.matchAll(/'([^']+)'\s*:\s*((?:(?:Var\('[^']+'\)|'[^']*')\s*\+?\s*)+)/g)].map((m) => {
    const value = [...m[2].matchAll(/Var\('([^']+)'\)|'([^']*)'/g)].map((x) => (x[1] !== undefined ? vars[x[1]] ?? '' : x[2])).join('')
    const i = value.lastIndexOf('@')
    return { path: m[1], url: value.slice(0, i), rev: value.slice(i + 1) }
  })
}

/** Registry packages of a Cargo.lock (v3/v4: checksum next to each package). */
export function cargoLockPackages(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((block) => {
      const get = (k) => new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm').exec(block)?.[1]
      return { name: get('name'), version: get('version'), source: get('source'), checksum: get('checksum') }
    })
}

/** The main section of a meson .wrap file ([wrap-file] or [wrap-git]). */
export function parseWrap(text) {
  const out = {}
  let current = null
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const s = /^\s*\[([\w-]+)\]\s*$/.exec(line)
    if (s) {
      out.section ??= s[1]
      current = s[1]
      continue
    }
    const kv = /^\s*([\w-]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (kv && current === out.section) out[kv[1]] = kv[2]
  }
  return out
}

export function parseGitmodules(text) {
  const mods = []
  let cur = null
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const s = /^\s*\[submodule\s+"([^"]*)"\s*\]/.exec(line)
    if (s) mods.push((cur = { name: s[1] }))
    else if (/^\s*\[/.test(line)) cur = null
    else {
      const kv = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (kv && cur) cur[kv[1].toLowerCase()] = kv[2].replace(/^"(.*)"$/, '$1')
    }
  }
  return mods
}

/** A submodule URL; relative ones (../x.git) are relative to the superproject's URL, as git does it. */
export function submoduleUrl(url, parent) {
  if (!/^\.\.?\//.test(url)) return url
  let base = parent.replace(/\/+$/, '')
  let rest = url
  for (;;) {
    if (rest.startsWith('./')) rest = rest.slice(2)
    else if (rest.startsWith('../')) {
      rest = rest.slice(3)
      base = base.slice(0, base.lastIndexOf('/'))
    } else break
  }
  if (!/^[a-z]+:\/\/[^/]+/.test(base)) throw new Error(`cannot resolve submodule URL ${url} against ${parent}`)
  return `${base}/${rest}`
}

// A licence text starts with its title; the GPL itself mentions the Lesser GPL near its end
const TITLES = [
  [/GNU LESSER GENERAL PUBLIC LICENSE\W+Version (\d(?:\.\d)?)/i, (v) => `LGPL-${v.includes('.') ? v : `${v}.0`}`],
  [/GNU LIBRARY GENERAL PUBLIC LICENSE\W+Version 2/i, () => 'LGPL-2.0'],
  [/GNU AFFERO GENERAL PUBLIC LICENSE\W+Version 3/i, () => 'AGPL-3.0'],
  [/GNU GENERAL PUBLIC LICENSE\W+Version (\d)/i, (v) => `GPL-${v}.0`],
  [/Apache License\W+Version 2\.0/i, () => 'Apache-2.0'],
  [/Mozilla Public License,?\W+(?:Version |v\. ?)(\d\.\d)/i, (v) => `MPL-${v}`],
  [/Boost Software License\W+Version 1\.0/i, () => 'BSL-1.0'],
  [/The FreeType Project LICENSE/i, () => 'FTL'],
  [/PNG Reference Library License version 2/i, () => 'libpng-2.0'],
  [/Zope Public License \(ZPL\) Version 2\.1/i, () => 'ZPL-2.1'],
  [/DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE/i, () => 'WTFPL']
]

/** SPDX-style name of a licence text, or null (good enough for a manifest; the file is authoritative). */
export function classifyLicence(text) {
  const flat = text.slice(0, 40000).replace(/\s+/g, ' ')
  const head = flat.slice(0, 1500)
  const spdx = /SPDX-License-Identifier:\W*([A-Za-z][\w.+-]*(?: (?:OR|AND|WITH) [A-Za-z][\w.+-]*)*)/.exec(head)
  if (spdx) return spdx[1]
  // "provided under a dual [Apache-2.0](https://spdx.org/licenses/Apache-2.0.html) OR [GPL-2.0-or-later](…)"
  const linked = [...new Set([...head.matchAll(/spdx\.org\/licenses\/([\w.+-]+?)(?:\.html)?\)/g)].map((m) => m[1]))]
  if (linked.length) return linked.join(/\bdual\b|\bOR\b|\beither\b/i.test(head) ? ' OR ' : ' AND ')
  let best = null
  for (const [re, id] of TITLES) {
    const m = re.exec(head)
    if (m && (!best || m.index < best.index)) best = { index: m.index, id: id(m[1] ?? '') }
  }
  if (best) return best.id
  const named = /licensed under the ([A-Z][\w.]*-[\w.+-]*\d[\w.+-]*) License/.exec(head)
  if (named) return named[1]
  if (/"Old MIT" license/i.test(head)) return 'MIT-Modern-Variant'
  if (/Permission to use, copy, modify, and(\/or)? distribute this software for any purpose with or without fee/i.test(flat))
    return /provided that the above copyright notice/i.test(flat) ? 'ISC' : '0BSD'
  if (/Permission is hereby granted, free of charge/i.test(flat)) return 'MIT'
  if (/Redistribution and use in source and binary forms/i.test(flat)) return /Neither the name|names of (its|their) contributors/i.test(flat) ? 'BSD-3-Clause' : 'BSD-2-Clause'
  if (/This software is provided ['‘]as-is['’]/i.test(flat) && /altered source versions must be plainly marked/i.test(flat)) return 'Zlib'
  if (/This is free and unencumbered software released into the public domain/i.test(flat)) return 'Unlicense'
  if (/\bCC0\b/.test(head)) return 'CC0-1.0'
  if (/(placed|released|dedicated) (in|into|to) the public domain/i.test(head)) return 'public domain'
  return null
}

// Trees whose top-level files don't name the licence plainly (by archive name)
const KNOWN_LICENCES = {
  AviSynthPlus: 'GPL-2.0-or-later with the AviSynth linking exception (distrib/gpl.txt)',
  'nv-codec-headers': 'MIT (in the header files)',
  freetype: 'FTL OR GPL-2.0-or-later (LICENSE.TXT)',
  gnulib: 'GPL, LGPL or more permissive, stated in each file (COPYING)'
}

const LICENCE_FILE = /^(licen[cs]e|copying|copyright|unlicense|mit-license)([._-][\w.+-]*)?$/i
const isLicenceFile = (name) => LICENCE_FILE.test(name) && !/template|checker|\.(cfg|py|sh|json|xml|ya?ml)$/i.test(name)
const REUSE_FILE = /^LICENSES\/([\w.+-]+)\.txt$/

// ---------- tar (read and write, no dependencies)

const pad512 = (n) => (512 - (n % 512)) % 512
const cstr = (buf, start, len) => {
  const s = buf.subarray(start, start + len)
  const end = s.indexOf(0)
  return s.subarray(0, end < 0 ? len : end).toString('utf8')
}

/**
 * Reads a tar or .tar.gz: counts files, finds the top folders and the commit of a git archive (pax
 * comment), and returns the text of the files want(pathWithoutTopFolder) asks for. Throws on
 * anything that is not a valid tar, e.g. an HTML page saved under an archive name.
 */
export async function scanTar(file, want = () => false, { limit = 256 << 10, paths = false } = {}) {
  const head = Buffer.alloc(2)
  const fd = openSync(file, 'r')
  readSync(fd, head, 0, 2, 0)
  closeSync(fd)
  const raw = createReadStream(file, { highWaterMark: 1 << 20 })
  const stream = head[0] === 0x1f && head[1] === 0x8b ? raw.pipe(createGunzip()) : raw
  raw.on('error', (e) => stream.destroy(e))
  try {
    return await readTarStream(stream, file, want, limit, paths)
  } finally {
    // an open handle would keep Windows from deleting the file
    raw.destroy()
    stream.destroy()
  }
}

async function readTarStream(stream, file, want, limit, paths) {
  const out = { files: 0, bytes: 0, tops: new Set(), texts: new Map(), commit: null, paths: paths ? [] : null }
  let buf = Buffer.alloc(0)
  let rest = 0
  let keep = null
  let pax = {}
  let ended = false
  let zeros = 0
  const finish = () => {
    const data = Buffer.concat(keep.parts).toString('utf8')
    if (keep.type === 'x' || keep.type === 'g') {
      const rec = {}
      for (const m of data.matchAll(/^\d+ ([^=\n]+)=(.*)$/gm)) rec[m[1]] = m[2]
      if (keep.type === 'g' && /^[0-9a-f]{40}$/.test(rec.comment ?? '')) out.commit = rec.comment
      if (keep.type === 'x') pax = rec
    } else if (keep.type === 'L') pax = { path: data.replace(/\0+$/, '') }
    else if (keep.type === 'file') out.texts.set(keep.path, data)
    keep = null
  }
  for await (const chunk of stream) {
    if (ended) continue
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    let off = 0
    while (!ended) {
      if (rest > 0) {
        const n = Math.min(rest, buf.length - off)
        if (n === 0) break
        if (keep && keep.got < keep.max) {
          const take = Math.min(n, keep.max - keep.got)
          keep.parts.push(Buffer.from(buf.subarray(off, off + take)))
          keep.got += take
        }
        off += n
        rest -= n
        if (rest === 0 && keep) finish()
        continue
      }
      if (buf.length - off < 512) break
      const h = buf.subarray(off, off + 512)
      off += 512
      if (h.every((b) => b === 0)) {
        if (++zeros >= 2) ended = true
        continue
      }
      zeros = 0
      let sum = 0
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]
      if (sum !== parseInt(cstr(h, 148, 8).trim() || '-1', 8)) throw new Error(`${file}: not a tar archive (bad header)`)
      const type = h[156] ? String.fromCharCode(h[156]) : '0'
      let size = 0
      if (h[124] & 0x80) for (let i = 125; i < 136; i++) size = size * 256 + h[i]
      else size = parseInt(cstr(h, 124, 12).trim() || '0', 8)
      const prefix = cstr(h, 257, 5) === 'ustar' ? cstr(h, 345, 155) : ''
      rest = size + pad512(size)
      if ('xgLK'.includes(type)) {
        keep = { type, max: size, got: 0, parts: [] }
        if (rest === 0) finish()
        continue
      }
      const path = (pax.path ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100))).replace(/^\.\//, '')
      pax = {}
      const parts = path.split('/').filter(Boolean)
      if (parts.length) out.tops.add(parts[0])
      if (out.paths) out.paths.push(path)
      if (type === '0' || type === '7') {
        out.files++
        out.bytes += size
        const rel = parts.slice(1).join('/')
        if (want(rel, path)) {
          keep = { type: 'file', path: rel, max: Math.min(size, limit), got: 0, parts: [] }
          if (rest === 0) finish()
        }
      }
    }
    buf = off < buf.length ? Buffer.from(buf.subarray(off)) : Buffer.alloc(0)
  }
  if (rest > 0) throw new Error(`${file}: truncated tar archive`)
  return out
}

function splitUstar(name) {
  if (Buffer.byteLength(name) <= 100) return ['', name]
  for (let i = name.indexOf('/'); i > 0; i = name.indexOf('/', i + 1)) {
    const prefix = name.slice(0, i)
    const base = name.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100 && base) return [prefix, base]
  }
  return null
}

function ustarHeader(name, size, mode, mtime, type) {
  const h = Buffer.alloc(512)
  const [prefix, base] = splitUstar(name) ?? ['', name.slice(-100)]
  const octal = (n, width) => `${n.toString(8).padStart(width - 1, '0')}\0`
  h.write(base, 0, 100, 'utf8')
  h.write(octal(mode, 8), 100, 'ascii')
  h.write(octal(0, 8), 108, 'ascii')
  h.write(octal(0, 8), 116, 'ascii')
  h.write(octal(size, 12), 124, 'ascii')
  h.write(octal(mtime, 12), 136, 'ascii')
  h.fill(0x20, 148, 156)
  h.write(type, 156, 'ascii')
  h.write('ustar\0' + '00', 257, 'ascii')
  h.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const b of h) sum += b
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return h
}

/** Header block(s) of one tar entry; names longer than ustar allows get a pax header. */
function tarHeader(name, size, mode = 0o644, mtime = Math.floor(Date.now() / 1000)) {
  if (splitUstar(name)) return ustarHeader(name, size, mode, mtime, '0')
  const body = ` path=${name}\n`
  let len = Buffer.byteLength(body)
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body)
  const rec = Buffer.from(`${len}${body}`)
  return Buffer.concat([ustarHeader('././@PaxHeader', rec.length, 0o644, mtime, 'x'), rec, Buffer.alloc(pad512(rec.length)), ustarHeader(name, size, mode, mtime, '0')])
}

/** Writes a tar of { name, file | data, mode } entries (files are streamed). */
function writeTar(out, entries) {
  const fd = openSync(out, 'w')
  const chunk = Buffer.allocUnsafe(4 << 20)
  try {
    for (const e of entries) {
      const size = e.data ? e.data.length : statSync(e.file).size
      writeSync(fd, tarHeader(e.name, size, e.mode))
      if (e.data) writeSync(fd, e.data)
      else {
        const src = openSync(e.file, 'r')
        try {
          for (let pos = 0, n; (n = readSync(src, chunk, 0, chunk.length, pos)) > 0; pos += n) writeSync(fd, chunk, 0, n)
        } finally {
          closeSync(src)
        }
      }
      if (pad512(size)) writeSync(fd, Buffer.alloc(pad512(size)))
    }
    writeSync(fd, Buffer.alloc(1024))
  } finally {
    closeSync(fd)
  }
}

const tarSize = (name, size) => tarHeader(name, 0).length + size + pad512(size)

// ---------- network and processes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Retries transient failures (network, 5xx, 429); errors marked permanent fail at once. */
async function retry(fn, what, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (e.permanent || i >= attempts) throw e
      const wait = [3, 10, 30, 60][i - 1] * 1000
      log(`  retry ${i}/${attempts - 1} in ${wait / 1000} s (${what}): ${e.message}`)
      await sleep(wait)
    }
  }
}

function httpError(status, url) {
  const e = new Error(`HTTP ${status} for ${url}`)
  e.permanent = status >= 400 && status < 500 && status !== 408 && status !== 429
  return e
}

/**
 * A plain GET that follows redirects. Not fetch(): fetch adds the browser header Sec-Fetch-Mode,
 * and GitLab answers archive downloads that carry it with 406.
 */
function get(url, redirects = 5) {
  return new Promise((resolveGet, reject) => {
    const u = new URL(url)
    const req = (u.protocol === 'http:' ? http : https).get(u, { headers: { 'user-agent': UA } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume()
        resolveGet(get(new URL(res.headers.location, u).href, redirects - 1))
      } else resolveGet(res)
    })
    req.on('error', reject)
    // also covers a stalled transfer: the socket timeout keeps running while the body streams
    req.setTimeout(90_000, () => req.destroy(new Error(`no data for 90 s from ${url}`)))
  })
}

/** Downloads url to file (one attempt; the caller retries): { size, sha256, sha512 }. */
async function downloadOnce(url, file) {
  const res = await get(url)
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume()
    throw httpError(res.statusCode, url)
  }
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  const out = createWriteStream(file)
  let size = 0
  try {
    for await (const chunk of res) {
      sha256.update(chunk)
      sha512.update(chunk)
      size += chunk.length
      if (!out.write(chunk)) await once(out, 'drain')
    }
  } finally {
    out.end()
    await once(out, 'close')
  }
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('hex') }
}

/** Downloads with retries and, when given, a checksum check (a mismatch is retried too). */
function download(url, file, hash = null) {
  return retry(async () => {
    const r = await downloadOnce(url, file)
    if (hash && r[hash.algo] !== hash.value) throw new Error(`${hash.algo} mismatch for ${url}: got ${r[hash.algo]}, expected ${hash.value}`)
    return r
  }, url)
}

let GIT = null

/** git without system/global config (no credential helpers, filters or hooks) and only network protocols. */
function setupGit(work) {
  const noHooks = join(work, 'no-hooks')
  const config = join(work, 'empty.gitconfig')
  mkdirSync(noHooks, { recursive: true })
  writeFileSync(config, '')
  const c = (kv) => ['-c', kv]
  GIT = {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1' },
    pre: [
      ...c(`core.hooksPath=${noHooks}`),
      ...c('core.autocrlf=false'),
      ...c('core.eol=lf'),
      ...c('core.longpaths=true'),
      ...c('protocol.allow=never'),
      ...c('protocol.https.allow=always'),
      ...c('protocol.http.allow=always'),
      ...c('protocol.git.allow=always'),
      ...c('http.lowSpeedLimit=1000'),
      ...c('http.lowSpeedTime=90'),
      ...c('gc.auto=0'),
      ...c('maintenance.auto=false'),
      ...c('fetch.recurseSubmodules=false')
    ]
  }
}

function git(args, what = `git ${args.find((a) => !a.startsWith('-') && !a.includes('\\') && !a.includes('/')) ?? ''}`) {
  return new Promise((resolve, reject) => {
    execFile('git', [...GIT.pre, ...args], { env: GIT.env, maxBuffer: 512 << 20, windowsHide: true, timeout: 30 * 60_000 }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout))
      const tail = String(stderr || err.message).trim().split('\n').slice(-3).join(' / ')
      reject(new Error(`${what}: ${tail}`))
    })
  })
}

function checkUrl(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    throw Object.assign(new Error(`not a URL: ${url}`), { permanent: true })
  }
  if (!['https:', 'http:', 'git:'].includes(u.protocol)) throw Object.assign(new Error(`refusing ${u.protocol} URL ${url}`), { permanent: true })
  return u
}

const normUrl = (url) => {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`.toLowerCase().replace(/(\.git)?\/*$/, '')
  } catch {
    return url
  }
}

/** Download URL of a host-generated archive (GitHub, GitLab) of a commit or tag, else null. */
export function archiveUrl(url, ref, isTag) {
  const u = new URL(url)
  const path = u.pathname.replace(/\/+$/, '').replace(/\.git$/, '')
  const parts = path.split('/').filter(Boolean)
  if (u.hostname === 'github.com' && parts.length === 2) return `https://github.com/${parts[0]}/${parts[1]}/archive/${isTag ? `refs/tags/${ref}` : ref}.tar.gz`
  if (GITLAB_HOSTS.has(u.hostname) && parts.length >= 2) return `https://${u.hostname}/${parts.join('/')}/-/archive/${encodeURIComponent(ref)}/${parts.at(-1)}-${encodeURIComponent(ref)}.tar.gz`
  return null
}

// ---------- fetching one source

let counter = 0
function freshDir(work, slug) {
  const dir = join(work, `${String(++counter).padStart(4, '0')}-${slug.replace(/[^\w.-]+/g, '_').slice(0, 40)}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

async function gitFetch(repo, url, p) {
  const ref = p.isTag ? `refs/tags/${p.ref}` : p.ref
  try {
    await retry(() => git(['-C', repo, 'fetch', '-q', '--depth=1', '--no-tags', '--', url, ref], `git fetch ${url} ${p.ref}`), `git fetch ${url}`, 3)
    const commit = (await git(['-C', repo, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], 'git rev-parse')).trim()
    if (p.isSha && !commit.startsWith(p.ref.toLowerCase())) throw new Error(`got commit ${commit} instead of ${p.ref}`)
    return commit
  } catch (e) {
    // some servers refuse a commit by its id: fetch all branches and tags instead
    log(`  ${p.label}: fetching ${p.ref} by itself failed (${e.message}); fetching the whole repository`)
    await retry(() => git(['-C', repo, 'fetch', '-q', '--no-tags', '--', url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], `git fetch ${url}`), `git fetch ${url}`, 2)
    return (await git(['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`], `git rev-parse ${p.ref}`)).trim()
  }
}

/** Submodules of a fetched commit, as `git submodule update --init [--recursive] [paths]` would check them out. */
async function submodulesOf(repo, commit, url, want) {
  const links = (await git(['-C', repo, 'ls-tree', '-r', '-z', '--full-tree', commit], 'git ls-tree'))
    .split('\0')
    .filter((l) => l.startsWith('160000 '))
    .map((l) => ({ sha: l.split('\t')[0].split(' ')[2], path: l.split('\t')[1] }))
    .filter((l) => !want.paths || want.paths.some((p) => l.path === p || l.path.startsWith(`${p}/`)))
  if (!links.length) return []
  const mods = parseGitmodules(await git(['-C', repo, 'cat-file', 'blob', `${commit}:.gitmodules`], 'git cat-file .gitmodules'))
  const out = []
  for (const link of links) {
    const mod = mods.find((m) => m.path === link.path)
    if (!mod?.url) throw new Error(`submodule ${link.path} has no URL in .gitmodules`)
    if (mod.update === 'none') continue
    out.push({ path: link.path, sha: link.sha, url: submoduleUrl(mod.url, url) })
  }
  return out
}

async function fetchGit(p, dir, onSubmodules) {
  const out = join(dir, p.fileName)
  const archive = !p.submodules && !p.excludes.length ? archiveUrl(p.url, p.ref, p.isTag) : null
  if (archive) {
    try {
      await download(archive, out)
      const scan = await scanTar(out, p.want)
      if (!scan.files) throw new Error('empty archive')
      if (p.isSha && scan.commit && scan.commit !== p.ref.toLowerCase()) throw new Error(`archive is of commit ${scan.commit}`)
      return { file: out, scan, method: new URL(archive).hostname === 'github.com' ? 'GitHub archive' : 'GitLab archive', from: p.url, commit: scan.commit }
    } catch (e) {
      log(`  ${p.label}: archive download failed (${e.message}); using git`)
      rmSync(out, { force: true })
    }
  }
  let lastError
  const urls = [p.url, p.mirror].filter(Boolean)
  for (const [i, url] of urls.entries()) {
    const repo = join(dir, `repo${i}`)
    try {
      checkUrl(url)
      await git(['init', '-q', '--bare', '--template=', repo], 'git init')
      const commit = await gitFetch(repo, url, p)
      if (p.submodules) onSubmodules(await submodulesOf(repo, commit, url, p.submodules))
      const pathspec = p.excludes.length ? ['--', '.', ...p.excludes.map((x) => `:(exclude)${x}`)] : []
      await git(['-C', repo, 'archive', '--format=tar.gz', `--prefix=${p.prefix}/`, '-o', out, commit, ...pathspec], 'git archive')
      return { file: out, scan: await scanTar(out, p.want), method: 'git', from: url, commit }
    } catch (e) {
      lastError = e
      if (i < urls.length - 1) log(`  ${p.label}: ${url} failed (${e.message}); trying the mirror ${urls[i + 1]}`)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }
  throw lastError
}

/** Exports a Subversion path at a revision over HTTP (WebDAV, as svn does) into a .tar.gz. */
async function fetchSvn(p, dir) {
  const base = checkUrl(p.url.replace(/\/+$/, ''))
  let auth = null
  const request = (method, url, { body, depth } = {}) =>
    retry(async () => {
      for (;;) {
        const headers = { 'user-agent': UA, ...(auth ? { authorization: auth } : {}), ...(depth ? { depth } : {}), ...(body ? { 'content-type': 'text/xml' } : {}) }
        const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(120_000) })
        // svn.xvid.org wants the anonymous login BtbN's script uses (user "anonymous", no password)
        if (res.status === 401 && !auth) {
          auth = `Basic ${Buffer.from('anonymous:').toString('base64')}`
          continue
        }
        if (!res.ok && res.status !== 207) throw httpError(res.status, url)
        return { headers: res.headers, data: Buffer.from(await res.arrayBuffer()) }
      }
    }, `${method} ${url}`)
  const options = await request('OPTIONS', base.href, { body: '<?xml version="1.0" encoding="utf-8"?><D:options xmlns:D="DAV:"><D:activity-collection-set/></D:options>' })
  const repoRoot = options.headers.get('svn-repository-root')
  if (repoRoot === null) throw new Error(`${p.url} is not a Subversion repository over HTTP`)
  const relPath = decodeURIComponent(base.pathname).slice(repoRoot.length).replace(/\/+$/, '')
  const enc = (s) => s.split('/').map(encodeURIComponent).join('/')
  const bc = `${repoRoot}/!svn/bc/${p.ref}${relPath}`
  const propfind = '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:" xmlns:S="http://subversion.tigris.org/xmlns/svn/"><prop><resourcetype/><getcontentlength/><S:executable/><S:externals/></prop></propfind>'
  const files = []
  const dirs = ['']
  while (dirs.length) {
    const d = dirs.shift()
    const { data } = await request('PROPFIND', `${base.origin}${enc(`${bc}/${d}`)}`, { body: propfind, depth: '1' })
    for (const resp of data.toString('utf8').split(/<(?:\w+:)?response[\s>]/).slice(1)) {
      const href = decodeURIComponent(/<(?:\w+:)?href>([^<]*)</.exec(resp)?.[1] ?? '')
      const ok = resp.split(/<(?:\w+:)?propstat>/).find((s) => /HTTP\/1\.\d 200/.test(s)) ?? ''
      const rel = href.slice(href.indexOf(`${bc}/`) + bc.length + 1).replace(/\/$/, '')
      if (!href.includes(`${bc}/`)) throw new Error(`unexpected PROPFIND entry ${href}`)
      if (rel === d.replace(/\/$/, '')) continue
      if (/<(?:\w+:)?externals\b/.test(ok)) throw new Error(`${p.url}/${rel} uses svn:externals, which is not supported`)
      if (/<(?:\w+:)?collection\b/.test(ok)) dirs.push(`${rel}/`)
      else files.push({ rel, exec: /<(?:\w+:)?executable\b/.test(ok) })
    }
  }
  const entries = []
  let next = 0
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < files.length) {
        const f = files[next++]
        const { data } = await request('GET', `${base.origin}${enc(`${bc}/${f.rel}`)}`)
        entries.push({ name: `${p.prefix}/${f.rel}`, data, mode: f.exec ? 0o755 : 0o644 })
      }
    })
  )
  entries.sort((a, b) => (a.name < b.name ? -1 : 1))
  const tar = join(dir, `${p.fileName}.tar`)
  writeTar(tar, entries)
  const out = join(dir, p.fileName)
  writeFileSync(out, gzipSync(readFileSync(tar), { level: 9 }))
  rmSync(tar)
  return { file: out, scan: await scanTar(out, p.want), method: 'Subversion over HTTP', from: p.url, commit: null }
}

async function fetchUrl(p, dir) {
  const out = join(dir, p.fileName)
  let lastError
  for (const url of [p.url, ...(p.fallbacks ?? [])]) {
    try {
      checkUrl(url)
      await download(url, out, p.hash)
      const tarLike = /\.(tar(\.gz)?|tgz|crate)$/.test(p.fileName)
      const scan = tarLike ? await scanTar(out, p.want) : { files: null, tops: new Set(), texts: new Map(), commit: null }
      return { file: out, scan, method: p.kind === 'crate' ? 'crates.io' : 'download', from: url, commit: null }
    } catch (e) {
      lastError = e
    }
  }
  throw lastError
}

async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) hash.update(chunk)
  return hash.digest('hex')
}

const fmtSize = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const fmtTime = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`)
const short = (ref) => (/^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 12) : ref.replace(/[^\w.+-]+/g, '_'))
const repoName = (url) => posix.basename(new URL(url).pathname.replace(/\/+$/, '')).replace(/\.git$/, '')
// SourceForge and Subversion paths end in generic names ("code", "trunk"); the library's name says more
const pieceName = (url, key) => (/^(|code|git|svn|trunk|src|source|mirror)$/i.test(repoName(url)) ? key : repoName(url))

/** The commit the vendored ffmpeg.exe was configured with, when it is this build. */
function ffmpegConfiguration(tag) {
  const dir = join(root, 'vendor', 'ffmpeg')
  const exe = join(dir, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  try {
    if (JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')).tag !== tag) return null
    return new Promise((resolve) =>
      execFile(exe, ['-hide_banner', '-version'], { windowsHide: true }, (err, stdout) => resolve(err ? null : /configuration: (.*)/.exec(String(stdout))?.[1] ?? null))
    )
  } catch {
    return null
  }
}

// ---------- the run

async function collect({ out, work, jobs, continueOnError, tag: tagArg }) {
  const t0 = Date.now()
  const pin = JSON.parse(readFileSync(join(root, 'scripts', 'ffmpeg-build.json'), 'utf8'))
  const tag = tagArg ?? pin.tag
  const target = assetTarget(pin.asset)
  if (!target) throw new Error(`cannot read target and variant from ${pin.asset}`)
  if (!/^[\w.-]+$/.test(tag)) throw new Error(`odd BtbN tag: ${tag}`)
  let vendored = null
  try {
    vendored = JSON.parse(readFileSync(join(root, 'vendor', 'ffmpeg', 'build.json'), 'utf8')).tag
  } catch {
    // no FFmpeg installed (not on Windows): nothing to compare
  }
  if (vendored && vendored !== tag && !tagArg) throw new Error(`vendor/ffmpeg holds the BtbN build "${vendored}", not the pinned ${tag}; pin a month-end build in scripts/ffmpeg-build.json and run npm ci again`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  mkdirSync(out, { recursive: true })
  setupGit(work)
  const stage = join(work, 'files')

  // the build scripts of the tag
  log(`BtbN FFmpeg-Builds ${tag}, ${target.target} ${target.variant}${target.addins ? ` + ${target.addins}` : ''}: reading the build scripts`)
  const btbnFile = join(freshDir(work, 'btbn'), `FFmpeg-Builds-${tag}.tar.gz`)
  await download(`${BTBN}/archive/refs/tags/${tag}.tar.gz`, btbnFile)
  const tree = await scanTar(btbnFile, (rel) => /^(scripts\.d\/.+\.sh|util\/vars\.sh)$/.test(rel), { paths: true, limit: 1 << 20 })
  const repoPaths = new Set(tree.paths.map((p) => p.split('/').slice(1).join('/')))
  if (!repoPaths.has(`variants/${target.target}-${target.variant}.sh`)) throw new Error(`BtbN ${tag} has no variant ${target.target}-${target.variant}`)
  for (const addin of target.addins ? target.addins.split('-') : []) if (!repoPaths.has(`addins/${addin}.sh`)) throw new Error(`BtbN ${tag} has no addin ${addin}`)
  const build = readBuild(tree.texts, target)
  log(`${build.scripts.length} scripts in scripts.d, FFmpeg version ${build.ctx.ffver}; walking the dependencies from ${build.entry}:`)
  const problems = []
  for (const s of build.scripts) {
    const sign = !s.included ? '-' : s.sources.length ? (s.sure ? '+' : '?') : '='
    const why = !s.included ? s.reason : !s.sources.length ? 'built, no source of its own' : s.sure ? '' : s.reason
    console.log(`  ${sign} ${s.key.padEnd(20)} ${s.path.padEnd(42)} ${why}`)
  }

  // cross-check with the configuration of the vendored ffmpeg.exe of this build, when present
  const configuration = await ffmpegConfiguration(tag)
  if (configuration) {
    const flags = new Set(configuration.split(/\s+/))
    for (const s of build.scripts) for (const f of configureFlags(s)) if (!s.included && flags.has(f)) problems.push(`ffmpeg.exe was configured with ${f}, but ${s.path} was left out`)
    log(problems.length ? 'the configuration of vendor/ffmpeg disagrees:' : 'checked against the configuration of vendor/ffmpeg: every --enable-… of a script is covered')
  }

  // the sources to fetch; the queue starts once the scripts are read without problems
  const pieces = []
  const byKey = new Map()
  const crates = new Map()
  const librariesByKey = new Map()
  const waiting = []
  const failures = []
  let started = false
  let active = 0
  let finished = 0
  let total = 0
  let cratesDone = 0
  let stop = false
  let idle
  const allDone = new Promise((r) => (idle = r))
  const attach = (lib, piece) => {
    if (!lib.pieces.includes(piece)) lib.pieces.push(piece)
  }
  const addPiece = (p) => {
    const key = `${p.kind} ${normUrl(p.url)} ${p.ref} ${JSON.stringify([p.submodules, p.excludes, p.extras])}`
    if (byKey.has(key)) {
      const known = byKey.get(key)
      if (!known.libraries.includes(p.library)) known.libraries.push(p.library)
      return known
    }
    const name = p.name ?? pieceName(p.url, p.library.key)
    const piece = {
      excludes: [],
      extras: [],
      submodules: null,
      ...p,
      id: pieces.length,
      libraries: [p.library],
      fileName: p.fileName ?? `${name}-${p.kind === 'svn' ? `r${p.ref}` : short(p.ref)}.tar.gz`,
      prefix: `${name}-${p.kind === 'svn' ? `r${p.ref}` : short(p.ref)}`,
      label: `${p.library.key}${p.role ? ` ${p.role}` : ''}`
    }
    piece.archivePath = `${piece.dir}/${piece.fileName}`
    const wanted = new Set(piece.extras.flatMap((x) => (x.type === 'wraps' ? x.names.map((n) => `subprojects/${n}.wrap`) : x.type === 'autogen' ? [x.file, 'dnn/download_model.sh'] : [x.file])))
    // licence files at the top, and REUSE's LICENSES/<SPDX id>.txt
    piece.want = (rel) => (!rel.includes('/') && isLicenceFile(rel)) || REUSE_FILE.test(rel) || wanted.has(rel) || (piece.kind === 'crate' && rel === 'Cargo.toml')
    byKey.set(key, piece)
    pieces.push(piece)
    if (started) queue(piece)
    return piece
  }
  for (const s of build.included) {
    if (!s.sources.length) continue
    const plan = dlPlan(s)
    for (const u of plan.unhandled) problems.push(`${s.path}: ${u}`)
    const lib = librariesByKey.get(s.key) ?? { key: s.key, scripts: [], pieces: [], notes: [] }
    librariesByKey.set(s.key, lib)
    lib.scripts.push(s.path)
    const used = new Set()
    for (const src of s.sources) {
      if (src.kind === 'invalid' || src.kind === 'hg') {
        problems.push(`${s.path}: ${src.error ?? `Mercurial sources (${src.url}) are not supported`}`)
        continue
      }
      const urls = [src.url, src.mirror].filter(Boolean).map(normUrl)
      const placed = plan.placed.find((x) => !used.has(x) && urls.includes(normUrl(x.url)) && (x.ref ?? src.ref) === src.ref) ?? (src.n === 1 && !used.has(plan.placed[0]) ? plan.placed[0] : null)
      if (placed) used.add(placed)
      if (!placed) plan.notes.push(`${src.url} is pinned in the script but not fetched by its download step; included anyway`)
      const piece = {
        library: lib,
        role: src.n > 1 ? `source ${src.n}` : '',
        kind: src.kind,
        url: src.url,
        ref: src.kind === 'url' ? 'download' : src.ref,
        isSha: src.isSha,
        isTag: src.isTag,
        mirror: src.mirror,
        branch: src.branch,
        hash: src.hash,
        dir: s.key,
        place: placed?.dir ?? null,
        submodules: placed?.submodules ?? null,
        excludes: placed?.excludes ?? [],
        extras: placed?.extras ?? []
      }
      if (src.kind === 'url') piece.fileName = posix.basename(new URL(src.url).pathname)
      attach(lib, addPiece(piece))
    }
    for (const u of plan.placed) if (!s.sources.some((src) => [src.url, src.mirror].filter(Boolean).map(normUrl).includes(normUrl(u.url)))) problems.push(`${s.path}: the download step fetches ${u.url}, which is not pinned in the script`)
    lib.notes.push(...plan.notes)
  }
  const libraries = [...librariesByKey.values()]
  for (const p of problems) log(`ERROR ${p}`)
  if (problems.length && !continueOnError) throw new Error(`${problems.length} problem(s) reading the build scripts; nothing was downloaded`)

  // fetch with a few parallel jobs; extras found in a source (submodules, crates, …) join the queue
  log(`fetching the sources of ${libraries.length} libraries with ${jobs} parallel jobs`)
  started = true
  for (const p of pieces) queue(p)
  function queue(piece) {
    waiting.push(piece)
    pump()
  }
  function pump() {
    while (active < jobs && waiting.length) {
      const piece = waiting.shift()
      active++
      runPiece(piece).finally(() => {
        active--
        pump()
        if (!active && !waiting.length) idle()
      })
    }
  }
  async function runPiece(p) {
    if (stop) return
    const t1 = Date.now()
    const dir = freshDir(work, p.label)
    try {
      let r
      if (p.kind === 'git') r = await fetchGit(p, dir, (subs) => addSubmodules(p, subs))
      else if (p.kind === 'svn') r = await fetchSvn(p, dir)
      else r = await fetchUrl(p, dir)
      if (p.kind !== 'url' && r.scan.files === 0) throw new Error('the archive holds no files')
      const dest = join(stage, ...p.archivePath.split('/'))
      mkdirSync(dirname(dest), { recursive: true })
      renameSync(r.file, dest)
      const size = statSync(dest).size
      const licences = [...r.scan.texts]
        .filter(([rel]) => isLicenceFile(rel) || REUSE_FILE.test(rel))
        .map(([rel, text]) => ({ file: rel, id: REUSE_FILE.exec(rel)?.[1] ?? classifyLicence(text) }))
      p.result = { ...r, size, sha256: await sha256File(dest), files: r.scan.files, licences, file: undefined, scan: undefined }
      if (p.kind === 'crate') p.result.licence = /^license\s*=\s*"([^"]+)"/m.exec(r.scan.texts.get('Cargo.toml') ?? '')?.[1] ?? (/^license-file\s*=\s*"([^"]+)"/m.exec(r.scan.texts.get('Cargo.toml') ?? '') ? 'see its licence file' : null)
      finished++
      total += size
      if (p.kind === 'crate') {
        cratesDone++
        if (cratesDone % 50 === 0 || cratesDone === crates.size) log(`[${finished}/${pieces.length}] ${cratesDone}/${crates.size} Rust crates  total ${fmtSize(total)}`)
      } else log(`[${finished}/${pieces.length}] ${p.label} ${p.kind === 'url' ? p.fileName : p.prefix}  ${fmtSize(size)}, ${r.scan.files ?? '?'} files (${r.method}, ${fmtTime(Date.now() - t1)})  total ${fmtSize(total)}`)
      await discover(p, r.scan.texts)
    } catch (e) {
      p.error = e.message
      failures.push(p)
      log(`FAILED ${p.label}: ${e.message}`)
      if (!continueOnError) stop = true
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  function addSubmodules(parent, subs) {
    for (const sub of subs) {
      const path = parent.subPath ? `${parent.subPath}/${sub.path}` : sub.path
      attach(
        parent.library,
        addPiece({
          library: parent.library,
          role: `submodule ${path}`,
          subPath: path,
          kind: 'git',
          url: sub.url,
          ref: sub.sha,
          isSha: true,
          isTag: false,
          name: path.replace(/[^\w.-]+/g, '_'),
          dir: `${parent.dir.split('/')[0]}/submodules`,
          submodules: parent.submodules.recursive ? { recursive: true, paths: null } : null
        })
      )
    }
  }
  async function discover(p, texts) {
    const lib = p.library
    for (const x of p.extras) {
      if (x.type === 'deps') {
        for (const d of parseDeps(texts.get(x.file) ?? '')) {
          if (!/^[0-9a-f]{40}$/.test(d.rev)) throw new Error(`DEPS entry ${d.path} is not pinned to a commit`)
          attach(lib, addPiece({ library: lib, role: `DEPS ${d.path}`, kind: 'git', url: d.url, ref: d.rev, isSha: true, isTag: false, dir: `${p.dir}/deps`, name: posix.basename(d.path) }))
        }
      } else if (x.type === 'autogen') {
        const autogen = texts.get(x.file) ?? ''
        const model = /download_model\.(?:sh|bat)\s+"?([0-9a-f]{8,64})"?/.exec(autogen)
        if (model) {
          const script = texts.get('dnn/download_model.sh') ?? ''
          const name = /^\s*model=([^\s;]+)/m.exec(script)?.[1]?.replace(/\$\{?1\}?/, model[1])
          const urlBase = /(https:\/\/[^\s"']+\/)\$\{?model\}?/.exec(script)?.[1]
          if (!name || !urlBase) throw new Error('cannot read the model download in dnn/download_model.sh')
          const hash = model[1].length === 64 ? { algo: 'sha256', value: model[1] } : null
          attach(lib, addPiece({ library: lib, role: 'model data (autogen.sh)', kind: 'url', url: `${urlBase}${name}`, ref: 'download', hash, dir: p.dir, fileName: name }))
        } else if (/\b(wget|curl|git\s+clone)\b/.test(autogen)) throw new Error(`${x.file} downloads something this script does not understand`)
      } else if (x.type === 'wraps') {
        for (const n of x.names) {
          const w = parseWrap(texts.get(`subprojects/${n}.wrap`) ?? '')
          if (w.section === 'wrap-file') {
            const hash = (h) => (h ? { algo: 'sha256', value: h.toLowerCase() } : null)
            attach(lib, addPiece({ library: lib, role: `meson subproject ${n}`, kind: 'url', url: w.source_url, fallbacks: [w.source_fallback_url].filter(Boolean), ref: 'download', hash: hash(w.source_hash), dir: `${p.dir}/subprojects`, fileName: w.source_filename }))
            if (w.patch_url) attach(lib, addPiece({ library: lib, role: `meson subproject ${n} (build files)`, kind: 'url', url: w.patch_url, fallbacks: [w.patch_fallback_url].filter(Boolean), ref: 'download', hash: hash(w.patch_hash), dir: `${p.dir}/subprojects`, fileName: w.patch_filename }))
          } else if (w.section === 'wrap-git' && /^[0-9a-f]{40}$/.test(w.revision ?? '')) {
            attach(lib, addPiece({ library: lib, role: `meson subproject ${n}`, kind: 'git', url: w.url, ref: w.revision, isSha: true, isTag: false, dir: `${p.dir}/subprojects`, name: n }))
          } else throw new Error(`cannot read subprojects/${n}.wrap`)
        }
      } else if (x.type === 'cargo') {
        const lock = texts.get(x.file)
        if (!lock) throw new Error(`${x.file} not found`)
        const used = []
        for (const c of cargoLockPackages(lock)) {
          if (!c.source) continue // part of the workspace
          if (c.source !== 'registry+https://github.com/rust-lang/crates.io-index') throw new Error(`crate ${c.name} ${c.version} comes from ${c.source}, which is not supported`)
          if (!/^[0-9a-f]{64}$/.test(c.checksum ?? '')) throw new Error(`crate ${c.name} ${c.version} has no checksum in Cargo.lock`)
          const id = `${c.name}-${c.version}`
          used.push(id)
          if (crates.has(id)) {
            crates.get(id).users.add(lib.key)
            continue
          }
          const piece = addPiece({ library: lib, role: `crate ${id}`, kind: 'crate', url: `https://static.crates.io/crates/${c.name}/${id}.crate`, ref: c.version, hash: { algo: 'sha256', value: c.checksum }, dir: 'crates', fileName: `${id}.crate` })
          crates.set(id, { piece, name: c.name, version: c.version, users: new Set([lib.key]) })
        }
        lib.crates = { count: used.length, from: x.file, atBuild: Boolean(x.atBuild) }
      }
    }
  }
  if (pieces.length) await allDone
  if (failures.length) {
    const list = failures.map((p) => `  ${p.label}: ${p.error}`).join('\n')
    if (!continueOnError) throw new Error(`${failures.length} source(s) could not be fetched; no archive was written:\n${list}`)
    log(`WARNING ${failures.length} source(s) are missing (--continue-on-error):\n${list}`)
  }

  // the archive(s): one folder per library, crates in crates/; parts stay below PART_LIMIT
  const rootName = `ffmpeg-deps-sources-${tag}`
  const done = pieces.filter((p) => p.result).sort((a, b) => (a.archivePath < b.archivePath ? -1 : 1))
  const parts = [[]]
  let partSize = 1024
  for (const p of done) {
    const size = tarSize(`${rootName}/${p.archivePath}`, p.result.size)
    if (partSize + size > PART_LIMIT && parts.at(-1).length) {
      parts.push([])
      partSize = 1024
    }
    parts.at(-1).push(p)
    partSize += size
  }
  for (const f of [`${rootName}.tar`, ...Array.from({ length: 99 }, (_, i) => `${rootName}.part${i + 1}.tar`), `${rootName}.txt`]) rmSync(join(out, f), { force: true })
  const archives = []
  for (const [i, list] of parts.entries()) {
    const name = parts.length > 1 ? `${rootName}.part${i + 1}.tar` : `${rootName}.tar`
    writeTar(
      join(out, name),
      list.map((p) => ({ name: `${rootName}/${p.archivePath}`, file: join(stage, ...p.archivePath.split('/')) }))
    )
    const check = await scanTar(join(out, name))
    if (check.files !== list.length) throw new Error(`${name}: wrote ${list.length} files but reads back ${check.files}`)
    for (const p of list) p.part = name
    archives.push({ name, files: list.length, size: statSync(join(out, name)).size })
  }

  // the manifest
  const excluded = build.scripts.filter((s) => !s.included && s.sources.length)
  const noSource = build.scripts.filter((s) => s.included && !s.sources.length)
  const ffmpeg = /-g([0-9a-f]{7,40})-/.exec(pin.asset)?.[1]
  const heading = (text) => [text, '-'.repeat(text.length)]
  const lines = [
    `Sources of the libraries in the FFmpeg build of Diashow Studio`,
    '='.repeat(62),
    '',
    `FFmpeg build   BtbN FFmpeg-Builds ${tag}`,
    `               ${pin.asset} (target ${target.target}, variant ${target.variant}, addins ${target.addins || 'none'})`,
    `Build scripts  ${BTBN}/tree/${tag}`,
    ...archives.map((a, i) => `${i ? '               ' : 'Archive        '}${a.name}  (${a.files} files, ${fmtSize(a.size)})`),
    `Created        ${new Date().toISOString().slice(0, 10)} by scripts/gpl-sources.mjs of Diashow Studio`,
    '',
    'The FFmpeg DLLs that Diashow Studio ships are built by the BtbN scripts above, which compile the',
    'libraries listed here into them. This archive holds the source code of each library at the exact',
    'revision of that build: what the download step (ffbuild_dockerdl) of its script in scripts.d',
    'fetches, together with the git submodules, DEPS checkouts and meson subprojects it adds, the Rust',
    'crates cargo builds with and the Opus model data. Each file is an unmodified archive of one source:',
    'a .tar.gz of the commit (git archive, or the archive GitHub/GitLab generate from it), a .tar.gz of',
    'a Subversion revision, a .crate from crates.io (checked against Cargo.lock), or the upstream',
    'download (checked against its checksum). A submodule, DEPS entry or subproject unpacks into the',
    'path given for it inside the tree of its library.',
    '',
    `FFmpeg's own source and the build scripts with their patches and configure options are separate`,
    'files of the same release: ffmpeg-source-<commit>.tar.gz and ffmpeg-build-scripts-<tag>.tar.gz.',
    ffmpeg ? `The FFmpeg commit of this build is ${ffmpeg}.` : '',
    '',
    'Licences are read from the licence files at the top of each source tree or its LICENSES folder',
    '(the licence text a file holds, not whether a project allows later versions), or for a few trees',
    'whose files only summarise from a short list in the script; the files themselves are authoritative.',
    '',
    ...heading(`Libraries (${libraries.length})`)
  ]
  const revision = (p) => {
    if (p.kind === 'svn') return `r${p.ref} (Subversion)`
    if (p.kind === 'url' || p.kind === 'crate') return p.hash ? `${p.hash.algo} ${p.hash.value}` : 'no checksum given'
    const commit = p.result?.commit
    return p.isSha ? p.ref : `${p.ref} (tag)${commit ? `, commit ${commit}` : ''}`
  }
  const licenceOf = (p, lib) => {
    const known = KNOWN_LICENCES[p.prefix.slice(0, p.prefix.lastIndexOf('-'))]
    if (known) return known
    const found = p.result?.licences ?? []
    const named = found.filter((l) => l.id)
    if (named.length) return named.map((l) => `${l.id} (${l.file})`).join(', ')
    if (p.kind === 'url' && lib.pieces[0] !== p) return `that of ${lib.key}`
    return found.length ? `see ${found.map((l) => l.file).join(', ')}` : 'no licence file at the top of the tree; see the source files'
  }
  for (const lib of libraries) {
    lines.push('', `${lib.key.padEnd(24)} ${[...new Set(lib.scripts)].join(', ')}`)
    for (const p of lib.pieces.filter((x) => x.kind !== 'crate')) {
      const indent = p.role ? '    ' : '  '
      if (p.role) lines.push(`  ${p.role}${p.place && p.place !== '.' ? ` (in ${p.place})` : ''}`)
      else if (p.place && p.place !== '.') lines.push(`  download folder: ${p.place}`)
      lines.push(`${indent}licence   ${licenceOf(p, lib)}`)
      lines.push(`${indent}source    ${p.result?.from ?? p.url}${p.branch ? ` (branch ${p.branch})` : ''}`)
      lines.push(`${indent}revision  ${revision(p)}`)
      if (p.excludes.length) lines.push(`${indent}without   ${p.excludes.join(', ')} (deleted by BtbN's download step)`)
      if (p.result) {
        lines.push(`${indent}file      ${rootName}/${p.archivePath}${archives.length > 1 ? ` in ${p.part}` : ''}`)
        lines.push(`${indent}          ${fmtSize(p.result.size)}, ${p.result.files ?? '?'} files, sha256 ${p.result.sha256}`)
      } else lines.push(`${indent}MISSING   ${p.error ?? 'not fetched'}`)
    }
    if (lib.crates) lines.push(`  Rust crates: ${lib.crates.count} from ${lib.crates.from}${lib.crates.atBuild ? ' (downloaded by cargo during the build)' : ' (cargo vendor)'}, listed under "Rust crates"`)
    for (const n of new Set(lib.notes)) lines.push(`  note: ${n}`)
  }
  if (crates.size) {
    lines.push('', ...heading(`Rust crates (${crates.size})`), `Files in ${rootName}/crates/, from crates.io, checked against the checksums in Cargo.lock.`, '')
    for (const c of [...crates.values()].sort((a, b) => (a.piece.fileName < b.piece.fileName ? -1 : 1))) {
      const r = c.piece.result
      lines.push(`  ${`${c.name} ${c.version}`.padEnd(44)} ${(r?.licence ?? (r ? 'see the crate' : 'MISSING')).padEnd(36)} ${[...c.users].join(', ')}`)
    }
  }
  lines.push('', ...heading(`Not part of this build (${excluded.length} scripts)`))
  for (const s of excluded) lines.push(`  ${s.key.padEnd(22)} ${s.path.padEnd(42)} ${s.reason}`)
  lines.push(
    '',
    `Built without a source of their own: ${noSource.map((s) => s.path).join(', ')}`,
    '',
    ...heading('Toolchains'),
    'The DLLs also contain runtime code of the compilers: libgcc, libstdc++ and libgomp of GCC (GPL with',
    'the GCC Runtime Library Exception), the mingw-w64 CRT and winpthreads (their source is the mingw',
    'entry above) and the Rust standard library (MIT or Apache-2.0) in librsvg and rav1e. The',
    'toolchain is built from images/ of the build scripts.',
    ''
  )
  const manifest = join(out, `${rootName}.txt`)
  writeFileSync(manifest, lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\r\n'), 'utf8')

  const size = archives.reduce((n, a) => n + a.size, 0)
  log(`${libraries.length} libraries, ${done.length} source archives (${crates.size} Rust crates), ${fmtSize(size)} in ${fmtTime(Date.now() - t0)}:`)
  for (const a of archives) log(`  ${join(out, a.name)}  ${fmtSize(a.size)}`)
  log(`  ${manifest}`)
  return { archives, manifest, failures }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const opts = { out: null, work: null, jobs: 5, continueOnError: false, tag: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--work') opts.work = argv[++i]
    else if (a === '--jobs') opts.jobs = Math.max(1, Number(argv[++i]) || 5)
    else if (a === '--tag') opts.tag = argv[++i]
    else if (a === '--continue-on-error') opts.continueOnError = true
    else if (!a.startsWith('-') && !opts.out) opts.out = a
    else {
      console.error('usage: node scripts/gpl-sources.mjs [out-dir] [--work <dir>] [--jobs 5] [--tag <btbn-tag>] [--continue-on-error]')
      process.exit(2)
    }
  }
  opts.out = opts.out ? resolve(opts.out) : join(root, 'dist', 'gpl-sources')
  opts.work = opts.work ? resolve(opts.work) : join(opts.out, '.work')
  try {
    await collect(opts)
  } catch (e) {
    console.error(`[gpl-sources] ${e.message}`)
    process.exitCode = 1
  } finally {
    rmSync(opts.work, { recursive: true, force: true })
  }
}
