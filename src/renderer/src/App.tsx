import { useEffect, useState } from 'react'
import { classify } from '@shared/formats'
import { useStore, wireMediaUpdates, playerRef } from './store'
import { startFaceQueue } from './faces'
import { t } from './i18n'
import { TitleBar } from './components/TitleBar'
import { Home } from './components/Home'
import { Viewer } from './components/Viewer'
import { Inspector } from './components/Inspector'
import { Filmstrip } from './components/Filmstrip'
import { ExportDialog } from './components/ExportDialog'
import { FullscreenPlayer } from './components/FullscreenPlayer'
import { PackDialog, RejectsDialog } from './components/Dialogs'
import { PresenterPanel } from './components/Presentation'

/** Routes dropped files: audio goes to the playlist, everything else into the show. */
export async function handleDroppedPaths(paths: string[]): Promise<void> {
  const s = useStore.getState()
  const audio = paths.filter((p) => classify(p) === 'audio')
  const media = paths.filter((p) => classify(p) !== 'audio')
  if (!s.project) {
    if (media.length) await s.createProject(media)
    if (audio.length) await useStore.getState().addMusic(audio)
    return
  }
  if (media.length) await s.importMedia(media)
  if (audio.length) await s.addMusic(audio)
}

export function App() {
  const view = useStore((s) => s.view)
  const fullscreen = useStore((s) => s.fullscreen)
  const exportOpen = useStore((s) => s.exportOpen)
  const dialog = useStore((s) => s.dialog)
  const presenting = useStore((s) => s.presenting)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    void useStore.getState().loadProjects()
    const offMedia = wireMediaUpdates()
    const offFaces = startFaceQueue()
    return () => {
      offMedia()
      offFaces()
    }
  }, [])

  useEffect(() => {
    let depth = 0
    const isFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent): void => {
      if (!isFiles(e)) return
      depth++
      setDragging(true)
    }
    const leave = (e: DragEvent): void => {
      if (!isFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const over = (e: DragEvent): void => {
      if (isFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent): void => {
      if (!isFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => window.api.pathForFile(f)).filter(Boolean)
      if (paths.length) void handleDroppedPaths(paths)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, select')) return
      const s = useStore.getState()
      if (s.view !== 'editor' || s.fullscreen || s.exportOpen || s.presenting || s.dialog) return
      const p = playerRef.current
      if (e.ctrlKey && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        if (e.key.toLowerCase() === 'y' || e.shiftKey) s.redo()
        else s.undo()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        p?.toggle()
      } else if (e.key === 'ArrowLeft') p?.step(-1)
      else if (e.key === 'ArrowRight') p?.step(1)
      else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selection.length) s.removeEntries(s.selection)
      else if (e.key === 'Enter' && e.altKey) s.set({ fullscreen: true })
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  return (
    <div className="app">
      <TitleBar />
      {view === 'home' ? (
        <Home />
      ) : (
        <div className="editor">
          <div className="workspace">
            <Viewer />
            <Inspector />
          </div>
          <Filmstrip />
        </div>
      )}
      {exportOpen && <ExportDialog />}
      {fullscreen && <FullscreenPlayer />}
      {dialog === 'rejects' && <RejectsDialog />}
      {dialog === 'pack' && <PackDialog />}
      {presenting && <PresenterPanel />}
      {dragging && <div className="window-drop">{t('dropHere')}</div>}
    </div>
  )
}
