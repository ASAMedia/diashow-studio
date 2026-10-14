import { useState } from 'react'
import { CalendarDays, CircleHelp, Clapperboard, Copy, QrCode, ScanFace, ChevronLeft, Download, Eraser, FileArchive, FolderTree, History, LayoutGrid, Loader2, MonitorPlay, MoreHorizontal, Package, Play, Redo2, ScanSearch, Settings, ShieldCheck, SortAsc, Undo2 } from 'lucide-react'
import { useStore } from '../store'
import { useTimeline } from '../timeline'
import { count, fmtTime, t } from '../i18n'
import { QueueChip } from './Queue'
import { UpdateChip } from './Updates'
import { AppIcon } from './AppIcon'
import { Menu, MenuItem, MenuSeparator } from './Menu'
import { openCleanup } from './Cleanup'
import { openArchive } from './Archive'
import { duplicateShow } from './Duplicate'

/** An icon-only button of the title bar; the tooltip is its name for screen readers too. */
function IconButton(props: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; expanded?: boolean; popup?: boolean }) {
  return (
    <button
      className="btn ghost icon"
      title={props.label}
      aria-label={props.label}
      aria-haspopup={props.popup ? 'menu' : undefined}
      aria-expanded={props.popup ? !!props.expanded : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
      onPointerDown={props.popup ? (e) => e.stopPropagation() : undefined}
    >
      {props.children}
    </button>
  )
}

export function TitleBar() {
  const project = useStore((s) => s.project)
  const update = useStore((s) => s.update)
  const set = useStore((s) => s.set)
  const tl = useTimeline()
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)
  const canUndo = useStore((s) => s.canUndo)
  const canRedo = useStore((s) => s.canRedo)
  const view = useStore((s) => s.view)

  if (!project) {
    return (
      <header className="titlebar">
        <div className="brand">
          <AppIcon size={18} /> {t('appName')}
        </div>
        <div className="grow" />
        <UpdateChip />
        <QueueChip />
        <IconButton label={`${t('help')} (F1)`} onClick={() => useStore.getState().set({ dialog: 'handbook' })}>
          <CircleHelp size={18} />
        </IconButton>
        <IconButton label={t('settings')} onClick={() => useStore.getState().set({ dialog: 'settings' })}>
          <Settings size={18} />
        </IconButton>
      </header>
    )
  }

  const busy = project.media.filter((m) => m.status === 'pending' || m.status === 'processing').length
  const slides = tl?.slides.length ?? 0
  return (
    <header className="titlebar">
      <IconButton label={t('back')} onClick={() => useStore.getState().closeProject()}>
        <ChevronLeft size={18} />
      </IconButton>
      {editing ? (
        <input
          className="name-edit"
          type="text"
          autoFocus
          aria-label={t('projectName')}
          defaultValue={project.name}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v) update((p) => (p.name = v))
            setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              e.stopPropagation()
              setEditing(false)
            }
          }}
        />
      ) : (
        <button
          className="name"
          title={[project.name, `${count('slideCount', slides)} · ${fmtTime(tl?.duration ?? 0)} · ${project.settings.aspect}`, t('renameHint')].join('\n')}
          aria-label={`${project.name}. ${t('renameHint')}`}
          onDoubleClick={() => setEditing(true)}
          onKeyDown={(e) => (e.key === 'F2' || e.key === 'Enter') && (e.preventDefault(), setEditing(true))}
        >
          {project.name}
        </button>
      )}
      <span className="meta" title={`${count('slideCount', slides)} · ${fmtTime(tl?.duration ?? 0)} · ${project.settings.aspect}`}>
        {count('slideCount', slides)} · {fmtTime(tl?.duration ?? 0)} · {project.settings.aspect}
      </span>
      <span className="sep" aria-hidden />
      <IconButton label={t('undo')} disabled={!canUndo} onClick={() => useStore.getState().undo()}>
        <Undo2 size={17} />
      </IconButton>
      <IconButton label={t('redo')} disabled={!canRedo} onClick={() => useStore.getState().redo()}>
        <Redo2 size={17} />
      </IconButton>
      <div className="grow" />
      <UpdateChip />
      <QueueChip />
      {busy > 0 && (
        <span className="chip" role="status" title={t('processingHint')}>
          <Loader2 size={13} className="spin" aria-hidden /> {busy} {t('processing')}
        </span>
      )}
      <div style={{ position: 'relative' }}>
        <IconButton label={t('more')} popup expanded={menu} onClick={() => setMenu(!menu)}>
          <MoreHorizontal size={18} />
        </IconButton>
        {menu && (
          <Menu label={t('more')} onClose={() => setMenu(false)} style={{ position: 'absolute', right: 0, top: 34 }}>
            <MenuItem icon={<CalendarDays size={15} />} onSelect={() => useStore.getState().insertDayTitles('date')}>
              {t('dayTitlesDate')}
            </MenuItem>
            <MenuItem icon={<FolderTree size={15} />} onSelect={() => useStore.getState().insertDayTitles('folder')}>
              {t('dayTitlesFolder')}
            </MenuItem>
            <MenuItem icon={<Eraser size={15} />} onSelect={() => useStore.getState().removeAutoTitles()}>
              {t('removeAutoTitles')}
            </MenuItem>
            <MenuItem icon={<SortAsc size={15} />} onSelect={() => useStore.getState().sortByDate()}>
              {t('sortByDate')}
            </MenuItem>
            <MenuItem icon={<Clapperboard size={15} />} onSelect={() => useStore.getState().addCredits()}>
              {t('addCredits')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<ScanSearch size={15} />} onSelect={() => set({ dialog: 'rejects' })}>
              {t('rejects')}
            </MenuItem>
            <MenuItem icon={<ScanFace size={15} />} onSelect={() => set({ dialog: 'privacyReview' })}>
              {t('reviewCheck')}
            </MenuItem>
            <MenuItem icon={<QrCode size={15} />} onSelect={() => set({ dialog: 'share' })}>
              {t('shareMenu')}
            </MenuItem>
            <MenuItem icon={<Copy size={15} />} onSelect={() => void duplicateShow(project.id)}>
              {t('duplicate')}
            </MenuItem>
            <MenuItem icon={<Package size={15} />} onSelect={() => set({ dialog: 'pack' })}>
              {t('pack')}
            </MenuItem>
            <MenuItem icon={<FileArchive size={15} />} onSelect={() => openArchive(project.id)}>
              {t('archive')}
            </MenuItem>
            <MenuItem icon={<History size={15} />} onSelect={() => set({ dialog: 'backups' })}>
              {t('backups')}
            </MenuItem>
            <MenuItem icon={<ShieldCheck size={15} />} onSelect={() => openCleanup(project.id)}>
              {t('cleanupMenu')}
            </MenuItem>
            <MenuItem icon={<MonitorPlay size={15} />} disabled={!slides} onSelect={() => set({ presenting: true })}>
              {t('present')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Settings size={15} />} onSelect={() => set({ dialog: 'settings' })}>
              {t('settings')}
            </MenuItem>
            <MenuItem icon={<CircleHelp size={15} />} onSelect={() => set({ dialog: 'handbook' })}>
              {t('handbook')}
            </MenuItem>
          </Menu>
        )}
      </div>
      <button className={`btn ${view === 'cull' ? 'on' : ''}`} aria-pressed={view === 'cull'} title={t('cullTitle')} onClick={() => set({ view: view === 'cull' ? 'editor' : 'cull' })} disabled={!project.entries.length}>
        <LayoutGrid size={16} /> {t('cull')}
      </button>
      <button className="btn" title={`${t('playFullscreen')} (Alt+Enter)`} onClick={() => set({ fullscreen: true })} disabled={!slides}>
        <Play size={16} /> {t('play')}
      </button>
      <button className="btn primary" onClick={() => set({ exportOpen: true })} disabled={!slides}>
        <Download size={16} /> {t('export')}
      </button>
    </header>
  )
}
