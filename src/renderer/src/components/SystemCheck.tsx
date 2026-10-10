// System check (opened from Settings): what this PC offers the app, each item with a plain verdict
// and what it means, e.g. on a school PC without an NVIDIA card. Ends with a short export benchmark
// through the real export path; "Bericht kopieren" puts everything on the clipboard as plain text.
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2, RefreshCw } from 'lucide-react'
import type { BenchMedia, EncoderTest, SystemInfo } from '@shared/systemCheck'
import { buildTimeline } from '@shared/timeline'
import { DEFAULT_SETTINGS, type Entry, type MediaItem, type Project } from '@shared/types'
import { exportShow, type ExportTick } from '../engine/exporter'
import { useStore } from '../store'
import { localeTag, t, type StringKey } from '../i18n'
import { Modal } from './Modal'

type Verdict = 'ok' | 'slow' | 'low' | 'missing' | 'info' | 'pending'

interface Item {
  id: string
  title: StringKey
  verdict: Verdict
  value: string
  meaning: string
  /** Missing, but without a drawback (shown in a neutral colour). */
  harmless?: boolean
}

/** Display order: graphics, video, machine, versions, then the benchmark. */
const ORDER = ['gpu', 'webgl', 'features', 'encoders', 'webcodecs', 'hevc', 'tonemap', 'cpu', 'ram', 'disk', 'versions', 'bench']

const VERDICT: Record<Verdict, StringKey | null> = { ok: 'scOk', slow: 'scSlow', low: 'scLow', missing: 'scMissing', info: null, pending: 'scChecking' }

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toLocaleString(localeTag(), { maximumFractionDigits: 1 })} GB`

/** WebGL 2 renderer string as Chromium reports it (ANGLE + the graphics card). */
function webglRenderer(): { renderer: string; software: boolean } {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return { renderer: '', software: true }
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '')
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return { renderer, software: /swiftshader|basic render|llvmpipe|software/i.test(renderer) }
  } catch {
    return { renderer: '', software: true }
  }
}

/** Hardware H.264 / HEVC encoders WebCodecs offers at 1080p. */
async function webCodecsEncoders(): Promise<string[]> {
  if (typeof VideoEncoder === 'undefined') return []
  const found: string[] = []
  for (const [label, codec] of [
    ['H.264', 'avc1.640028'],
    ['HEVC', 'hvc1.1.6.L120.B0']
  ] as const) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: 1920, height: 1080, bitrate: 10e6, framerate: 30, hardwareAcceleration: 'prefer-hardware' })
      if (r.supported) found.push(label)
    } catch {
      // unknown codec string in this build
    }
  }
  return found
}

/** A 3-photo + 1-clip show at 1080p from generated media (classic theme, no title). */
export function benchProject(media: BenchMedia): Project {
  const items: MediaItem[] = [
    ...media.photos.map((p, i): MediaItem => ({ id: `bench-photo-${i}`, path: p.path, name: `photo${i + 1}.jpg`, kind: 'photo', format: 'JPEG', width: p.width, height: p.height, captureTime: i, status: 'ready', thumb: p.path, display: p.path })),
    { id: 'bench-video', path: media.video.path, name: 'clip.mp4', kind: 'video', format: 'MP4', width: media.video.width, height: media.video.height, duration: media.video.duration, fps: media.video.fps, hasAudio: false, captureTime: 9, status: 'ready', thumb: media.photos[0].path, playback: media.video.path }
  ]
  const entries: Entry[] = [
    { id: 'e1', type: 'photo', mediaId: items[0].id, duration: 1.5 },
    { id: 'e2', type: 'video', mediaId: 'bench-video', trimIn: 0, trimOut: 1.5 },
    { id: 'e3', type: 'photo', mediaId: items[1].id, duration: 1.5 }
  ]
  return {
    version: 1,
    id: 'bench',
    name: 'Benchmark',
    createdAt: 0,
    updatedAt: 0,
    entries,
    media: items,
    music: [],
    settings: { ...structuredClone(DEFAULT_SETTINGS), theme: 'kenburns', showTitle: false }
  }
}

/** Renders and exports the generated show at 1080p30; resolves with show seconds per wall second. */
/**
 * Renders and exports the generated show at 1080p30. `factor`: show seconds per second of rendering
 * and encoding (the export's own per-frame timing, as for a long show); `seconds`: the whole run
 * including start-up and joining with the sound.
 */
async function benchmark(signal: AbortSignal): Promise<{ factor: number; seconds: number; show: number; path: string }> {
  const media = await window.api.systemBenchMedia()
  try {
    const project = benchProject(media)
    const show = buildTimeline(project, localeTag()).duration
    const outPath = media.video.path.replace(/[^\\/]+$/, 'bench.mp4')
    let last: ExportTick | null = null
    const t0 = performance.now()
    await exportShow(project, { outPath, width: 1920, height: 1080, fps: 30, codec: 'h264', quality: 'high', hardware: true }, localeTag(), (tick: ExportTick) => (last = tick), signal)
    const seconds = (performance.now() - t0) / 1000
    const tick = last as ExportTick | null
    // milliseconds per frame in the render loop (preparing media, drawing, reading back, sending)
    const perFrame = tick ? tick.phases.prepare + tick.phases.render + tick.phases.encode + tick.phases.send : 0
    const factor = perFrame > 0 ? 1000 / 30 / perFrame : show / seconds
    return { factor, seconds, show, path: tick?.path ?? '' }
  } finally {
    await window.api.systemBenchCleanup().catch(() => {})
  }
}

function verdictsFromInfo(info: SystemInfo, gl: { renderer: string; software: boolean }): Item[] {
  const items: Item[] = []
  const active = info.gpu.devices.find((d) => d.active) ?? info.gpu.devices[0]
  // Windows always lists its software adapter ("Microsoft Basic Render Driver") too
  const real = info.gpu.devices.filter((d) => d.vendor !== 'Microsoft' || d.active)
  const devices = real.map((d) => `${d.device.startsWith(d.vendor) ? '' : `${d.vendor} `}${d.device}${d.driver ? ` (${d.driver})` : ''}${d.active && real.length > 1 ? ' ✓' : ''}`).join(', ')
  const software = gl.software || !active || active.vendor === 'Microsoft'
  items.push({ id: 'gpu', title: 'scGpu', verdict: software ? 'missing' : 'ok', value: devices || '—', meaning: software ? t('scGpuSoftware') : t('scGpuOk') })
  const f = info.gpu.features
  // Electron 44 reports 'webgl' (older versions also 'webgl2')
  const glKey = f.webgl2 ? 'webgl2' : 'webgl'
  const keys = [glKey, 'gpu_compositing', 'video_decode', 'rasterization'].filter((k) => f[k])
  const off = keys.filter((k) => !f[k].startsWith('enabled'))
  items.push({
    id: 'features',
    title: 'scFeatures',
    verdict: !f[glKey]?.startsWith('enabled') ? 'missing' : off.length ? 'slow' : 'ok',
    value: keys.map((k) => `${k}: ${f[k]}`).join(', '),
    meaning: off.length ? t('scFeaturesSome').replace('{list}', off.join(', ')) : t('scFeaturesOk')
  })
  items.push({ id: 'webgl', title: 'scWebgl', verdict: gl.renderer && !gl.software ? 'ok' : 'missing', value: gl.renderer || '—', meaning: gl.renderer && !gl.software ? t('scGpuOk') : t('scGpuSoftware') })
  items.push({
    id: 'hevc',
    title: 'scHevc',
    verdict: info.hevcDirect === null ? 'info' : info.hevcDirect ? 'ok' : 'slow',
    value: info.hevcDirect === null ? '?' : info.hevcDirect ? t('on') : t('off'),
    meaning: info.hevcDirect ? t('scHevcOk') : t('scHevcNone')
  })
  items.push({
    id: 'tonemap',
    title: 'scTonemap',
    verdict: info.tonemap ? 'ok' : 'slow',
    value: info.tonemap ? `Vulkan #${info.tonemap.device} · ${info.tonemap.decode}` : '—',
    meaning: info.tonemap ? t('scTonemapOk') : t('scTonemapNone')
  })
  items.push({
    id: 'cpu',
    title: 'scCpu',
    verdict: info.cpu.threads >= 8 ? 'ok' : 'slow',
    value: `${info.cpu.model} · ${info.cpu.threads} Threads`,
    meaning: (info.cpu.threads >= 8 ? t('scCpuOk') : t('scCpuSlow')).replace('{n}', String(info.cpu.threads))
  })
  const ramOk = info.memory.total >= 7.5 * 1024 ** 3
  items.push({ id: 'ram', title: 'scRam', verdict: ramOk ? 'ok' : 'low', value: gb(info.memory.total), meaning: (ramOk ? t('scRamOk') : t('scRamLow')).replace('{t}', gb(info.memory.total)) })
  const free = info.disk.free
  items.push({
    id: 'disk',
    title: 'scDisk',
    verdict: free === null ? 'info' : free >= 20 * 1024 ** 3 ? 'ok' : free >= 5 * 1024 ** 3 ? 'low' : 'missing',
    value: free === null ? info.disk.path : `${gb(free)} / ${info.disk.total ? gb(info.disk.total) : '?'} · ${info.disk.path}`,
    meaning: free === null ? '' : (free >= 20 * 1024 ** 3 ? t('scDiskOk') : t('scDiskLow')).replace('{f}', gb(free))
  })
  const v = info.versions
  items.push({ id: 'versions', title: 'scVersions', verdict: 'info', value: `Diashow Studio ${v.app} · Electron ${v.electron} · Chromium ${v.chrome} · Node ${v.node} · FFmpeg ${v.ffmpeg} · ${v.windows}`, meaning: '' })
  return items
}

/** Encoder family → graphics card vendor (a failing AMF test on a PC without AMD is no news). */
const ENCODER_VENDOR: Record<string, string> = { nvenc: 'NVIDIA', qsv: 'Intel', amf: 'AMD' }

function encoderItem(tests: EncoderTest[], vendors: string[]): Item {
  const hw = tests.filter((x) => x.hardware)
  const working = hw.filter((x) => x.ok)
  const h264 = working.find((x) => x.encoder.startsWith('h264'))
  const relevant = tests.filter((x) => x.ok || !x.hardware || vendors.includes(ENCODER_VENDOR[x.encoder.split('_')[1]] ?? ''))
  const value = relevant.map((x) => (x.ok ? `${x.encoder} ${x.fps} fps` : `${x.encoder}: ${t('scEncFailed')}`)).join(' · ')
  return {
    id: 'encoders',
    title: 'scEncoders',
    verdict: h264 ? 'ok' : 'slow',
    value: value || '—',
    meaning: h264 ? t('scEncOk').replace('{enc}', working.map((x) => x.encoder).join(', ')) : t('scEncNone')
  }
}

export function SystemCheck() {
  const set = useStore((s) => s.set)
  const exportRunning = useStore((s) => s.exportJobs.some((j) => j.state === 'running'))
  const [items, setItems] = useState<Item[]>([])
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState(false)
  const abort = useRef<AbortController | null>(null)

  const put = (item: Item): void =>
    setItems((list) => [...list.filter((x) => x.id !== item.id), item].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id)))

  const run = async (): Promise<void> => {
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    setRunning(true)
    setCopied(false)
    const pending = (id: string, title: StringKey): Item => ({ id, title, verdict: 'pending', value: '', meaning: '' })
    setItems([pending('gpu', 'scGpu'), pending('encoders', 'scEncoders'), pending('webcodecs', 'scWebCodecs'), pending('bench', 'scBench')])
    try {
      const gl = webglRenderer()
      const [info, codecs] = await Promise.all([window.api.systemInfo(), webCodecsEncoders()])
      if (ctrl.signal.aborted) return
      for (const it of verdictsFromInfo(info, gl)) put(it)
      put({
        id: 'webcodecs',
        title: 'scWebCodecs',
        verdict: codecs.length ? 'ok' : 'missing',
        value: codecs.length ? codecs.join(', ') : '—',
        meaning: codecs.length ? t('scWebCodecsOk').replace('{c}', codecs.join(', ')) : t('scWebCodecsNone'),
        harmless: !codecs.length
      })
      put(encoderItem(await window.api.systemEncoderTest(), info.gpu.devices.map((d) => d.vendor)))
      if (ctrl.signal.aborted) return
      try {
        const b = await benchmark(ctrl.signal)
        const minutes = Math.max(1, Math.round(300 / b.factor / 60))
        put({
          id: 'bench',
          title: 'scBench',
          verdict: b.factor >= 1 ? 'ok' : 'slow',
          value: t('scBenchValue')
            .replace('{s}', b.show.toLocaleString(localeTag(), { maximumFractionDigits: 1 }))
            .replace('{w}', b.seconds.toLocaleString(localeTag(), { maximumFractionDigits: 1 })),
          meaning: t('scBenchResult')
            .replace('{x}', b.factor.toLocaleString(localeTag(), { maximumFractionDigits: 1 }))
            .replace('{path}', b.path || '?')
            .replace('{m}', `${minutes} min`)
        })
      } catch (e) {
        if (!ctrl.signal.aborted) put({ id: 'bench', title: 'scBench', verdict: 'missing', value: '', meaning: t('scBenchFailed').replace('{e}', (e as Error).message) })
      }
    } catch (e) {
      put({ id: 'gpu', title: 'scGpu', verdict: 'missing', value: '', meaning: (e as Error).message })
    } finally {
      if (abort.current === ctrl) setRunning(false)
    }
  }

  useEffect(() => {
    void run()
    return () => abort.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const report = (): string => {
    const lines = [`Diashow Studio – ${t('systemCheck')} – ${new Date().toLocaleString(localeTag())}`, '']
    for (const it of items) {
      const v = VERDICT[it.verdict]
      lines.push(`${t(it.title)}: ${v ? t(v) : '–'}`)
      if (it.value) lines.push(`  ${it.value}`)
      if (it.meaning) lines.push(`  ${it.meaning}`)
    }
    return lines.join('\n')
  }

  const close = (): void => set({ dialog: null })
  return (
    <Modal
      title={t('systemCheck')}
      onClose={close}
      className="wide"
      actions={
        <>
          <button className="btn" disabled={running} onClick={() => void run()}>
            <RefreshCw size={14} className={running ? 'spin' : ''} /> {t('scAgain')}
          </button>
          <button className="btn" disabled={!items.length} onClick={() => void navigator.clipboard.writeText(report()).then(() => setCopied(true), () => {})}>
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t('scCopied') : t('scCopy')}
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={close}>
            {t('close')}
          </button>
        </>
      }
    >
      <p className="hint lead">{t('scIntro')}</p>
      {exportRunning && <p className="callout warn">{t('scBenchBusy')}</p>}
      <div className="sc-list" data-testid="systemcheck" aria-busy={running}>
        {items.map((it) => {
          const v = VERDICT[it.verdict]
          return (
            <div key={it.id} className="sc-item" data-id={it.id} data-verdict={it.verdict}>
              <span className="title">{t(it.title)}</span>
              <span>
                {it.verdict === 'pending' ? (
                  <span className="sc-badge pending">
                    <Loader2 size={11} className="spin" aria-hidden /> {t('scChecking')}
                  </span>
                ) : v ? (
                  <span className={`sc-badge ${it.harmless ? 'info' : it.verdict}`}>{t(v)}</span>
                ) : (
                  <span className="sc-badge info">–</span>
                )}
              </span>
              <span className="value">
                {it.value}
                {it.meaning && <span className="meaning">{it.meaning}</span>}
              </span>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
