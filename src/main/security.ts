// Electron hardening for every window the app opens (editor, presentation, hidden export worker):
//
// - Navigation: a page may only ever show the app's own renderer page. A dropped link or a stray
//   `location = …` would otherwise load a web page into a window whose preload exposes `window.api`.
// - New windows, <webview>: refused (links to the app's own sites open in the browser instead, linkAllowed).
// - Permissions: only what the app uses (clipboard write for "Copy", fullscreen); camera, microphone,
//   location, notifications, USB/HID/serial and the like are denied.
// - Network: the app's pages may not reach the internet (requestAllowed).
// - IPC: every ipcMain.handle call is answered only for the app's own page (frames showing anything
//   else get an error), whichever module registers the channel.
import { app, ipcMain, session, shell, webContents, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The renderer page of a packaged / built app: out/renderer/index.html. */
export const rendererPage = (): string => join(__dirname, '../renderer/index.html')

/**
 * electron-vite's dev server (ELECTRON_RENDERER_URL), when the app runs from the sources. An installed
 * app never takes it: set on a school PC, it would load a foreign page with the app's preload.
 */
export const devRendererUrl = (): string | undefined => (app?.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL || undefined)

/**
 * True for the app's own page: the built index.html (any hash or query), or the dev server
 * (electron-vite sets ELECTRON_RENDERER_URL). Pure for tests: page and dev URL are passed in.
 */
export function isAppUrlFor(url: string | undefined | null, page: string, devUrl?: string): boolean {
  if (!url) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (devUrl) {
    try {
      const dev = new URL(devUrl)
      if (u.origin === dev.origin && (u.protocol === 'http:' || u.protocol === 'https:')) return true
    } catch {
      // not a URL: ignore
    }
  }
  if (u.protocol !== 'file:' || (u.host && u.host !== 'localhost')) return false
  try {
    return resolve(fileURLToPath(`file://${u.pathname}`)).toLowerCase() === resolve(page).toLowerCase()
  } catch {
    return false
  }
}

export const isAppUrl = (url: string | undefined | null): boolean => isAppUrlFor(url, rendererPage(), devRendererUrl())

/**
 * Sites the app's pages link to (About, the update hint, the handbook, licences). window.open and
 * target="_blank" open only these in the browser: a URL to anywhere else could carry what the page
 * knows (pupils' names, file names) past the network block below.
 */
export const LINK_HOSTS: ReadonlySet<string> = new Set(['github.com', 'asamedia.github.io', 'www.gnu.org'])

/** A link the browser may open for a page: https on one of LINK_HOSTS, no user name, password or port. */
export function linkAllowed(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(raw)) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  return u.protocol === 'https:' && LINK_HOSTS.has(u.hostname) && !u.username && !u.password && !u.port
}

/** Handles window.open / target="_blank" of any app window: never a new window; allowed links go to the browser. */
export function openLinks(contents: WebContents, warn: Warn = () => {}): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (linkAllowed(url)) void shell.openExternal(url)
    else warn(`blocked opening ${url.slice(0, 120)}`)
    return { action: 'deny' }
  })
}

/** Permissions the app's pages may have. */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen'])

/** A navigation of `contents` to `url` is fine: to the app's page, or within a page the app did not load itself. */
export function navigationAllowed(currentUrl: string, url: string, appUrl: (u: string) => boolean = isAppUrl): boolean {
  if (appUrl(url)) return true
  // e.g. a test window the main process pointed at the share server itself: not one of the app's pages
  return !(appUrl(currentUrl) || !currentUrl || currentUrl === 'about:blank')
}

type Warn = (message: string) => void

function guardContents(contents: WebContents, warn: Warn): void {
  const block = (event: { preventDefault(): void }, url: string, what: string): void => {
    if (navigationAllowed(contents.getURL(), url)) return
    event.preventDefault()
    warn(`blocked ${what} to ${url.slice(0, 200)}`)
  }
  contents.on('will-navigate', (event, url) => block(event, url, 'navigation'))
  contents.on('will-redirect', (event, url) => block(event, url, 'redirect'))
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
    warn('blocked a <webview>')
  })
  // windows set the same handler again (presentation.ts denyPopups); this one covers any other contents
  openLinks(contents, warn)
}

/**
 * The app's pages never need the network (fonts and models are bundled; the update check runs in the
 * main process): a request from them to http(s)/ws(s) other than the dev server is cancelled, so no
 * library can send anything about the pupils' photos anywhere. Pure for tests.
 */
export function requestAllowed(url: string, fromAppPage: boolean, devUrl = devRendererUrl()): boolean {
  if (!fromAppPage) return true
  if (!devUrl) return false
  try {
    return new URL(url).host === new URL(devUrl).host
  } catch {
    return false
  }
}

export function hardenSession(ses: Session, warn: Warn): void {
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const contents = details.webContentsId !== undefined ? webContents.fromId(details.webContentsId) : undefined
    const ok = requestAllowed(details.url, !!contents && !contents.isDestroyed() && isAppUrl(contents.getURL()))
    if (!ok) warn(`blocked a request to ${details.url.slice(0, 120)}`)
    callback({ cancel: !ok })
  })
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const ok = ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details?.requestingUrl || contents?.getURL())
    if (!ok) warn(`denied permission ${permission}`)
    callback(ok)
  })
  ses.setPermissionCheckHandler((contents, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && (isAppUrl(contents?.getURL()) || isAppUrl(origin)))
  ses.setDevicePermissionHandler(() => false)
}

/** Answers ipcMain.handle calls only from the app's own page. Call before any channel is registered. */
export function guardIpc(warn: Warn): void {
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    handle(channel, (event, ...args) => {
      if (!trustedSender(event)) {
        warn(`blocked IPC ${channel}`)
        throw new Error(`${channel} is not available to this page`)
      }
      return listener(event, ...args)
    })
  }
}

/** The event comes from the app's own page (main frame or not: the app has no frames of its own). */
export function trustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  try {
    return isAppUrl(event.senderFrame?.url)
  } catch {
    return false
  }
}

/** Installs all of the above; call once, before app ready (IPC guard) — the rest attaches when ready. */
export function hardenApp(warn: Warn = () => {}): void {
  guardIpc(warn)
  app.on('web-contents-created', (_e, contents) => guardContents(contents, warn))
  void app.whenReady().then(() => hardenSession(session.defaultSession, warn))
}
