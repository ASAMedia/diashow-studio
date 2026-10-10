// Light or dark UI (Settings → Appearance): "system" follows Windows, "light" and "dark" are fixed.
// The choice lives in localStorage like the preview quality (every window of the app shares it) and
// becomes <html data-theme="light|dark">; styles.css switches its colour tokens on that attribute.
// The preview stage and the fullscreen player stay dark in both themes.

export type Appearance = 'system' | 'light' | 'dark'

const KEY = 'appearance'
/** Fired on window when the choice changes (also used by the UI review spec). */
export const APPEARANCE_EVENT = 'appearance'

/** Without storage (blocked) the choice lasts for this session only. */
let session: Appearance | null = null

export function appearance(): Appearance {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return session ?? 'system'
  }
}

export function setAppearance(value: Appearance): void {
  session = value
  try {
    if (value === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, value)
  } catch {
    // kept in `session`
  }
  window.dispatchEvent(new Event(APPEARANCE_EVENT))
}

const systemDark = (): MediaQueryList | null => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null)

/** The theme actually shown: "system" resolved through Windows' app mode. */
export function resolvedTheme(value: Appearance = appearance()): 'light' | 'dark' {
  if (value !== 'system') return value
  const mq = systemDark()
  return mq && !mq.matches ? 'light' : 'dark'
}

function applyTheme(value: Appearance = appearance()): void {
  document.documentElement.dataset.theme = resolvedTheme(value)
}

/** Applies the theme now and follows changes of the setting, of other windows and of Windows itself. */
export function watchAppearance(): () => void {
  applyTheme()
  const update = (): void => applyTheme()
  const mq = systemDark()
  mq?.addEventListener('change', update)
  window.addEventListener(APPEARANCE_EVENT, update)
  // another window of the app (e.g. the presentation) changed it
  const storage = (e: StorageEvent): void => {
    if (e.key === KEY || e.key === null) update()
  }
  window.addEventListener('storage', storage)
  return () => {
    mq?.removeEventListener('change', update)
    window.removeEventListener(APPEARANCE_EVENT, update)
    window.removeEventListener('storage', storage)
  }
}

/** True when Windows asks for less motion (UI animations only; the slideshow is not affected). */
export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
