// Electron side of sharing over the local network: the share:control channel, status updates to the
// windows, the uploads folder, and stopping the server when the dialog's window goes away or the app
// quits. The server itself is in server.ts.
//
// Windows Firewall asks once per program whether it may accept connections from the network (the
// first time it listens on a LAN address); the dialog explains that prompt. We never change firewall
// settings ourselves.
import { app, ipcMain, type WebContents } from 'electron'
import { join } from 'node:path'
import { IMAGE_EXT, VIDEO_EXT } from '@shared/formats'
import type { ShareCommand, ShareFilesEvent, ShareStatus } from '@shared/share'
import { lanAddresses } from './net'
import { createShareServer, DEFAULT_LIMITS, showFolderName, type ShareServer } from './server'
import { showOpen } from '../dialogs'

export interface ShareMainConfig {
  /** <Documents>/Diashow Studio/Uploads */
  uploadsRoot: string
  broadcast: (channel: string, payload: unknown) => void
}

interface Session {
  server: ShareServer
  projectId: string
  projectName: string
  folder: string
  /** Removes the listeners on the dialog's page. */
  detach: () => void
}

export function registerShare(cfg: ShareMainConfig): { stop(): Promise<void> } {
  let session: Session | null = null
  let error: string | undefined
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastSent = 0

  /**
   * Tests set DIASHOW_SHARE_HOST=127.0.0.1: loopback needs no firewall permission. With
   * DIASHOW_SHARE_PUBLIC=1 it counts as a public address (the dialog's warning).
   */
  const addresses = (): ShareStatus['addresses'] => {
    const list = lanAddresses()
    const forced = process.env.DIASHOW_SHARE_HOST
    if (!forced) return list
    const entry: ShareStatus['addresses'][number] = { name: 'DIASHOW_SHARE_HOST', address: forced, kind: 'other', ...(process.env.DIASHOW_SHARE_PUBLIC === '1' ? { public: true } : {}) }
    return [entry, ...list.filter((a) => a.address !== forced)]
  }

  const status = (): ShareStatus => {
    const s = session
    return {
      running: !!s?.server.port,
      address: s?.server.host ?? undefined,
      port: s?.server.port ?? undefined,
      addresses: addresses(),
      uploadUrl: s?.server.uploadUrl() ?? undefined,
      downloadUrl: s?.server.downloadUrl() ?? undefined,
      collecting: s?.server.collecting ?? false,
      projectId: s?.projectId,
      projectName: s?.projectName,
      folder: s?.folder,
      received: s?.server.received() ?? [],
      uploading: s?.server.uploading() ?? 0,
      offered: s?.server.offers() ?? [],
      error,
      limits: s?.server.limits ?? DEFAULT_LIMITS
    }
  }

  /** Status to every window, at most 4 times a second. */
  const push = (): void => {
    if (timer) return
    const wait = Math.max(0, lastSent + 250 - Date.now())
    timer = setTimeout(() => {
      timer = null
      lastSent = Date.now()
      cfg.broadcast('share:update', status())
    }, wait)
  }

  async function stop(): Promise<void> {
    const s = session
    session = null
    error = undefined
    if (!s) return
    s.detach()
    await s.server.close().catch(() => {})
    push()
  }

  async function start(projectId: string, projectName: string, address: string | undefined, owner: WebContents): Promise<void> {
    if (session && session.projectId === projectId) {
      // same project: move to another address, or try again after a failed start
      const want = address ?? (session.server.port ? undefined : addresses()[0]?.address)
      if (want && (want !== session.server.host || !session.server.port)) await listen(session, want)
      return
    }
    await stop()
    const folder = join(cfg.uploadsRoot, showFolderName(projectName))
    let s: Session | null = null
    const server = createShareServer({
      uploadDir: folder,
      projectName,
      onChange: push,
      onReceived: (file) => {
        if (session !== s) return
        const event: ShareFilesEvent = { projectId, paths: [file.path] }
        cfg.broadcast('share:files', event)
        push()
      }
    })
    // The dialog's page going away (closed, reloaded, crashed) stops the server like closing the dialog
    const gone = (): void => {
      if (session === s) void stop()
    }
    const events = ['destroyed', 'did-navigate', 'render-process-gone'] as const
    for (const ev of events) owner.once(ev as 'destroyed', gone)
    const detach = (): void => {
      if (owner.isDestroyed()) return
      for (const ev of events) owner.removeListener(ev as 'destroyed', gone)
    }
    s = { server, projectId, projectName, folder, detach }
    session = s
    const pick = address ?? addresses()[0]?.address
    if (!pick) {
      error = 'no-network'
      return
    }
    await listen(s, pick)
  }

  async function listen(s: Session, address: string): Promise<void> {
    // Only the machine's own private addresses (or the test override)
    if (!addresses().some((a) => a.address === address)) throw new Error('unknown address')
    try {
      await s.server.listen(address)
      error = undefined
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  ipcMain.handle('share:control', async (e, cmd: ShareCommand): Promise<ShareStatus> => {
    switch (cmd?.type) {
      case 'status':
        break
      case 'start':
        if (typeof cmd.projectId !== 'string' || !cmd.projectId) throw new Error('no project')
        await start(cmd.projectId, String(cmd.projectName ?? ''), typeof cmd.address === 'string' ? cmd.address : undefined, e.sender)
        break
      case 'stop':
        await stop()
        break
      case 'address':
        if (session && typeof cmd.address === 'string') await listen(session, cmd.address)
        break
      case 'collect':
        if (session) session.server.collecting = !!cmd.on
        break
      case 'offer':
        if (session && Array.isArray(cmd.paths)) for (const p of cmd.paths.slice(0, 50)) await session.server.offer(p)
        break
      case 'unoffer':
        if (session && typeof cmd.id === 'string') session.server.unoffer(cmd.id)
        break
      case 'pickOffer': {
        if (!session) break
        const opts: Electron.OpenDialogOptions = {
          title: 'Datei zum Herunterladen anbieten',
          defaultPath: app.getPath('videos'),
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: 'Videos', extensions: VIDEO_EXT },
            { name: 'Fotos und Videos', extensions: [...VIDEO_EXT, ...IMAGE_EXT] }
          ]
        }
        const r = await showOpen(e, opts)
        if (!r.canceled) for (const p of r.filePaths) await session?.server.offer(p)
        break
      }
      default:
        throw new Error('unknown share command')
    }
    push()
    return status()
  })

  app.on('before-quit', () => void stop())
  return { stop }
}
