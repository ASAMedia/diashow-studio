// Which originals the renderer can decode without a proxy, asked from a renderer window: Chromium
// has no software HEVC decoder, so 8-bit HEVC only plays where the graphics hardware decodes it.
// app.getGPUInfo() doesn't list decoder profiles in Electron 44, hence the question to the page.
import { BrowserWindow } from 'electron'
import type { DirectDecode } from './media/videoInfo'

/**
 * Both renderer paths must work: the preview's <video> (canPlayType) and the export's WebCodecs
 * decoder (isConfigSupported). Level 5.1 at 3840x2160 covers every size playbackPlan sends directly.
 */
const PROBE = `(async () => {
  try {
    const codec = 'hvc1.1.6.L153.B0'
    const video = document.createElement('video').canPlayType('video/mp4; codecs="' + codec + '"') === 'probably'
    if (!video || typeof VideoDecoder === 'undefined') return false
    const r = await VideoDecoder.isConfigSupported({ codec, codedWidth: 3840, codedHeight: 2160 })
    return r.supported === true
  } catch {
    return false
  }
})()`

let hevc: Promise<boolean> | null = null

async function askRenderer(): Promise<boolean | null> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.isLoading() && !w.webContents.isCrashed())
  if (!win) return null
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
  try {
    const r = await Promise.race([win.webContents.executeJavaScript(PROBE, true) as Promise<unknown>, timeout])
    return r === null ? null : r === true
  } catch {
    return null
  }
}

/**
 * DIASHOW_DIRECT_HEVC=0 turns direct HEVC playback off (proxies as before). An answer is cached;
 * when no window could answer yet, the next call asks again.
 */
export function directDecodeSupport(): Promise<DirectDecode> {
  if (process.env.DIASHOW_DIRECT_HEVC === '0') return Promise.resolve({ hevc: false })
  if (!hevc) {
    const asking = askRenderer().then((r) => {
      if (r === null) hevc = null
      return r === true
    })
    hevc = asking
  }
  return hevc.then((ok) => ({ hevc: ok }))
}
