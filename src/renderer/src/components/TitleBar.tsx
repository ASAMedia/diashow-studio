import { useEffect, useState } from 'react'
import { CalendarDays, ChevronLeft, Download, Eraser, FolderTree, Images, Loader2, MonitorPlay, MoreHorizontal, Package, Play, Redo2, ScanSearch, SortAsc, Undo2 } from 'lucide-react'
import { useStore } from '../store'
import { useTimeline } from '../timeline'
import { fmtTime, t } from '../i18n'

export function TitleBar() {
  const project = useStore((s) => s.project)
  const update = useStore((s) => s.update)
  const set = useStore((s) => s.set)
  const tl = useTimeline()
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)
  const canUndo = useStore((s) => s.canUndo)
  const canRedo = useStore((s) => s.canRedo)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

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
      <button className="btn ghost icon" title={t('undo')} disabled={!canUndo} onClick={() => useStore.getState().undo()}>
        <Undo2 size={16} />
      </button>
      <button className="btn ghost icon" title={t('redo')} disabled={!canRedo} onClick={() => useStore.getState().redo()}>
        <Redo2 size={16} />
      </button>
      <div className="grow" />
      {busy > 0 && (
        <span className="chip">
          <Loader2 size={13} className="spin" /> {busy} {t('processing')}
        </span>
      )}
      <div style={{ position: 'relative' }}>
        <button className="btn ghost icon" title={t('more')} onClick={() => setMenu(!menu)} onPointerDown={(e) => e.stopPropagation()}>
          <MoreHorizontal size={18} />
        </button>
        {menu && (
          <div className="menu" style={{ position: 'absolute', right: 0, top: 34 }} onPointerDown={(e) => e.stopPropagation()} onClick={() => setMenu(false)}>
            <button onClick={() => useStore.getState().insertDayTitles('date')}>
              <CalendarDays size={14} /> {t('dayTitlesDate')}
            </button>
            <button onClick={() => useStore.getState().insertDayTitles('folder')}>
              <FolderTree size={14} /> {t('dayTitlesFolder')}
            </button>
            <button onClick={() => useStore.getState().removeAutoTitles()}>
              <Eraser size={14} /> {t('removeAutoTitles')}
            </button>
            <button onClick={() => useStore.getState().sortByDate()}>
              <SortAsc size={14} /> {t('sortByDate')}
            </button>
            <hr />
            <button onClick={() => set({ dialog: 'rejects' })}>
              <ScanSearch size={14} /> {t('rejects')}
            </button>
            <button onClick={() => set({ dialog: 'pack' })}>
              <Package size={14} /> {t('pack')}
            </button>
            <button disabled={!slides} onClick={() => set({ presenting: true })}>
              <MonitorPlay size={14} /> {t('present')}
            </button>
          </div>
        )}
      </div>
      <button className="btn" onClick={() => set({ fullscreen: true })} disabled={!slides}>
        <Play size={15} /> {t('play')}
      </button>
      <button className="btn primary" onClick={() => set({ exportOpen: true })} disabled={!slides}>
        <Download size={15} /> {t('export')}
      </button>
    </div>
  )
}
