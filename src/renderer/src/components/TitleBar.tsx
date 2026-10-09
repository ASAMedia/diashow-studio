import { useState } from 'react'
import { ChevronLeft, Download, Images, Loader2, Play } from 'lucide-react'
import { useStore } from '../store'
import { useTimeline } from '../timeline'
import { fmtTime, t } from '../i18n'

export function TitleBar() {
  const project = useStore((s) => s.project)
  const update = useStore((s) => s.update)
  const set = useStore((s) => s.set)
  const tl = useTimeline()
  const [editing, setEditing] = useState(false)

  if (!project) {
    return (
      <div className="titlebar">
        <div className="brand">
          <Images size={18} /> {t('appName')}
        </div>
        <div className="grow" />
      </div>
    )
  }

  const busy = project.media.filter((m) => m.status === 'pending' || m.status === 'processing').length
  const slides = tl?.slides.length ?? 0
  return (
    <div className="titlebar">
      <button className="btn ghost icon" title={t('back')} onClick={() => useStore.getState().closeProject()}>
        <ChevronLeft size={18} />
      </button>
      {editing ? (
        <input
          className="name-edit"
          type="text"
          autoFocus
          defaultValue={project.name}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v) update((p) => (p.name = v))
            setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <span className="name" onDoubleClick={() => setEditing(true)} title={t('rename')}>
          {project.name}
        </span>
      )}
      <span className="meta">
        {slides} {t('slides')} · {fmtTime(tl?.duration ?? 0)} · {project.settings.aspect}
      </span>
      <div className="grow" />
      {busy > 0 && (
        <span className="chip">
          <Loader2 size={13} className="spin" /> {busy} {t('processing')}
        </span>
      )}
      <button className="btn" onClick={() => set({ fullscreen: true })} disabled={!slides}>
        <Play size={15} /> {t('play')}
      </button>
      <button className="btn primary" onClick={() => set({ exportOpen: true })} disabled={!slides}>
        <Download size={15} /> {t('export')}
      </button>
    </div>
  )
}
