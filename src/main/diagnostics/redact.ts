// What goes into the log and the diagnostics package is cleaned first: the user profile part of paths
// becomes %USERPROFILE% (other profiles' names become <user>), and anything that could carry media
// content or personal data is cut out: data: URLs, long base64 runs, long lists of numbers (face
// descriptors) and the random tokens of share links. Pure, no Electron.

export interface RedactOptions {
  /** The user profile folder, e.g. C:\Users\name (os.homedir()). */
  home?: string
  /** Longest result; longer text is cut with "…". Default 8000. */
  maxLength?: number
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The spellings a path shows up in: \ and /, doubled \ (JSON), URL-encoded, and file URLs (C:/…). */
function pathVariants(home: string): string[] {
  const back = home.replace(/\//g, '\\').replace(/\\+$/, '')
  const fwd = back.replace(/\\/g, '/')
  const variants = new Set([back, fwd, back.replace(/\\/g, '\\\\'), encodeURIComponent(back), encodeURIComponent(fwd), encodeURI(fwd)])
  return [...variants].filter((v) => v.length >= 3).sort((a, b) => b.length - a.length)
}

const cache = new Map<string, RegExp | null>()

function homeRegExp(home: string | undefined): RegExp | null {
  if (!home) return null
  let re = cache.get(home)
  if (re === undefined) {
    const variants = pathVariants(home)
    // the profile folder itself or anything below it, never a longer name (C:\Users\anna vs. C:\Users\annabel)
    re = variants.length ? new RegExp(`(?:${variants.map(escapeRe).join('|')})(?=$|[\\\\/%"'\\s:;,)\\]}>|])`, 'gi') : null
    cache.set(home, re)
  }
  return re
}

export function redact(input: unknown, opts: RedactOptions = {}): string {
  let s = typeof input === 'string' ? input : input instanceof Error ? `${input.message}\n${input.stack ?? ''}` : String(input ?? '')
  const max = opts.maxLength ?? 8000
  // the patterns below never see more than a bounded amount of text
  if (s.length > max * 2 + 1000) s = s.slice(0, max * 2 + 1000)
  // control characters other than line breaks and tabs
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  const home = homeRegExp(opts.home)
  if (home) s = s.replace(home, '%USERPROFILE%')
  // other profiles (e.g. a colleague's packed project): keep the drive, hide the name
  s = s.replace(/([A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))(?!%USERPROFILE%)([^\\/:*?"<>|\r\n]+)/gi, (_m, pre: string, name: string) =>
    /^(public|default|all users)$/i.test(name) ? `${pre}${name}` : `${pre}<user>`
  )
  // media content
  s = s.replace(/data:([\w/+.-]{0,60})[;,][^\s"')]{40,}/gi, (_m, mime: string) => `data:${mime || '?'},<removed>`)
  s = s.replace(/[A-Za-z0-9+/]{200,}={0,2}/g, (m) => `<base64 ${m.length} chars>`)
  // 16 or more numbers in a row: face descriptors, pixel data
  s = s.replace(/-?\d{1,20}(?:\.\d{1,20})?(?:e-?\d{1,3})?(?:\s{0,3},\s{0,3}-?\d{1,20}(?:\.\d{1,20})?(?:e-?\d{1,3})?){15,}/gi, (m) => `<${m.split(',').length} numbers>`)
  // share links: http://host:port/<token>/…
  s = s.replace(/(https?:\/\/[^/\s]{1,300}\/)[A-Za-z0-9_-]{24,}(?=[/?#\s"']|$)/g, '$1<token>')
  return s.length > max ? `${s.slice(0, max)}…` : s
}
