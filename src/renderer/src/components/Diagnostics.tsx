// "Diagnosepaket erstellen" (Settings): shows every file of the diagnostics package before anything is
// saved, then writes the zip where the user chooses. The package is built by the main process
// (src/main/diagnostics/package.ts) from counts, versions and the log; no photos, names or face data.
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, Save, X } from 'lucide-react'
import type { DiagnosticsFile, DiagnosticsInput, DiagnosticsPreview } from '@shared/diagnostics'
import { useStore } from '../store'
import { localeTag, t, type StringKey } from '../i18n'
import { ErrorText } from '../errors'

const ABOUT: Record<DiagnosticsFile['about'], StringKey> = {
  readme: 'diagAboutReadme',
  versions: 'diagAboutVersions',
  system: 'diagAboutSystem',
  settings: 'diagAboutSettings',
  project: 'diagAboutProject',
  exports: 'diagAboutExports',
  log: 'diagAboutLog'
}

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(localeTag())} KB`

/** WebGL renderer string (graphics card as Chromium uses it), or '' without WebGL. */
function webgl(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return ''
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return r
  } catch {
    return ''
  }
}

/** Preview quality chosen in Settings (read here: Settings imports this dialog). */
function storedQuality(): string {
  try {
    return localStorage.getItem('previewQuality') ?? 'high'
  } catch {
    return 'high'
  }
}

/** What the renderer adds: nothing personal (no names, no paths). */
function collectInput(): DiagnosticsInput {
  const s = useStore.getState()
  return {
    projectId: s.project?.id,
    renderer: {
      language: navigator.language,
      previewQuality: storedQuality(),
      webgl: webgl(),
      screen: `${screen.width}x${screen.height} @${window.devicePixelRatio}`,
      cpuThreads: navigator.hardwareConcurrency ?? null,
      view: s.view
    },
    exportJobs: s.exportJobs.map((j) => ({ state: j.state, width: j.width, height: j.height, codec: j.codec, fps: j.fps, ...(j.error ? { error: j.error } : {}) }))
  }
}

export function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const input = useMemo(collectInput, [])
  const [preview, setPreview] = useState<DiagnosticsPreview | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.api
      .diagnosticsPreview(input)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError(e))
    return () => {
      alive = false
    }
  }, [input])

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const path = await window.api.diagnosticsSave(input)
      if (path) setSaved(path)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay">
      <div className="dialog wide diag-dialog" data-testid="diagnostics-dialog">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0, flex: 1 }}>{t('diagTitle')}</h2>
          <button className="btn ghost icon" title={t('close')} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          {t('diagIntro')}
        </p>
        <p className="diag-privacy">{t('diagPrivacy')}</p>
        {!preview && !error && <p className="hint">{t('diagCollecting')}</p>}
        {preview && (
          <div className="diag-files" data-testid="diagnostics-files">
            {preview.files.map((f) => (
              <div key={f.name} className="diag-file">
                <button className="diag-head" onClick={() => setOpen(open === f.name ? null : f.name)}>
                  {open === f.name ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="name">{f.name}</span>
                  <span className="about">{t(ABOUT[f.about])}</span>
                  <span className="val">{kb(f.bytes)}</span>
                </button>
                {open === f.name && <pre className="diag-preview">{f.preview}</pre>}
              </div>
            ))}
          </div>
        )}
        {preview && (
          <p className="hint">
            {t('diagTotal')
              .replace('{n}', String(preview.files.length))
              .replace('{s}', kb(preview.bytes))}
          </p>
        )}
        {saved && (
          <div className="row diag-saved">
            <span style={{ flex: 1 }}>{t('diagSaved').replace('{path}', saved)}</span>
            <button className="btn small" onClick={() => void window.api.revealInFolder(saved)}>
              <FolderOpen size={13} /> {t('showInFolder')}
            </button>
          </div>
        )}
        {error !== null && <ErrorText err={error} context="save" />}
        <div className="actions">
          <button className="btn" onClick={onClose}>
            {t('close')}
          </button>
          <button className="btn primary" disabled={!preview || busy} onClick={() => void save()} data-testid="diagnostics-save">
            <Save size={13} /> {t('diagSave')}
          </button>
        </div>
      </div>
    </div>
  )
}
