// Offline export: renders every frame with the same engine as the preview and streams
// the pixels to FFmpeg in the main process. Audio is mixed there from the same plan.
import type { ExportQuality, Project, VideoCodec } from '@shared/types'
import { buildTimeline } from '@shared/timeline'
import { buildAudioPlan } from '@shared/audioPlan'
import { Engine, loadFonts } from './engine'

export interface ExportRequest {
  outPath: string
  width: number
  height: number
  fps: number
  codec: VideoCodec
  quality: ExportQuality
  hardware: boolean
}

export interface ExportTick {
  frame: number
  total: number
  /** Seconds per rendered frame, averaged. */
  speed: number
}

export async function exportShow(
  project: Project,
  req: ExportRequest,
  locale: string,
  onTick: (p: ExportTick) => void,
  signal: AbortSignal
): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = req.width
  canvas.height = req.height
  const engine = new Engine(canvas, 'export')
  try {
    await loadFonts()
    const tl = buildTimeline(project, locale)
    engine.setProject(project, tl)
    engine.resize(req.width, req.height)
    const audio = buildAudioPlan(project, tl)
    await window.api.exportStart({ ...req, audio })
    const total = Math.max(1, Math.ceil(tl.duration * req.fps))
    const buf = new Uint8Array(req.width * req.height * 4)
    const t0 = performance.now()
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError')
      const t = i / req.fps
      await engine.prepare(t)
      engine.render(t)
      engine.readPixels(buf)
      await window.api.exportFrame(buf)
      if (i % 5 === 0 || i === total - 1) onTick({ frame: i + 1, total, speed: (performance.now() - t0) / 1000 / (i + 1) })
    }
    return await window.api.exportFinish()
  } catch (e) {
    await window.api.exportCancel().catch(() => {})
    throw e
  } finally {
    engine.dispose()
  }
}
