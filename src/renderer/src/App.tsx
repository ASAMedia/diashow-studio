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
import { BackupsDialog, HelpDialog, MissingBanner, SettingsDialog, Tip } from './components/Settings'
import { PresenterPanel } from './components/Presentation'
import { Cull } from './components/Cull'
import { QueueDialog } from './components/Queue'
import { PrivacyReviewDialog } from './components/PrivacyReview'
import { ShareDialog } from './components/ShareDialog'
import { SystemCheck } from './components/SystemCheck'
import { HandbookDialog } from './components/Handbook'
import { AboutDialog } from './components/AboutDialog'
import { Wizard } from './components/Wizard'
import { DiagnosticsHost } from './components/ProjectRepair'
import { CleanupHost } from './components/Cleanup'
import { ArchiveHost } from './components/Archive'
import { watchStabilize } from './stabilize'
import { timelineOf } from './timeline'
import { keyForFocus, modalOpen } from './keys'
import { closePhotoEdit, rotateSelection } from './photoEdit'
import { handledDrops, pasteMedia } from './insert'
import { NetworkBanner } from './components/NetworkBanner'

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
    const offStabilize = watchStabilize()
    void window.api.queueList().then((exportJobs) => useStore.getState().set({ exportJobs })).catch(() => {})
    const offQueue = window.api.onQueueUpdate((exportJobs) => useStore.getState().set({ exportJobs }))
    // kiosk mode: open the chosen show fullscreen in a loop right away
    void window.api.getAppSettings().catch(() => ({}) as { kioskProjectId?: string }).then(async (s) => {
      if (!s.kioskProjectId) return
      try {
        await useStore.getState().openProject(s.kioskProjectId)
        useStore.getState().set({ fullscreen: true, kiosk: true })
      } catch {
        // the project was deleted; start normally
      }
    })
    return () => {
      offMedia()
      offFaces()
      offQueue()
      offStabilize()
    }
  }, [])

  useEffect(() => {
    let depth = 0
    const isFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent): void => {
      if (!isFiles(e)) return
      // accepted here too: right after the element under the pointer changed (an edge between two
      // pictures), Chromium decides on a drop by this dragenter alone, and a refused one loses the drop
      e.preventDefault()
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
      // files dropped on the filmstrip went in where they were dropped (Filmstrip.tsx)
      if (handledDrops.has(e)) return
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
      const s = useStore.getState()
      // F1 works everywhere, also while typing
      if (e.key === 'F1') {
        e.preventDefault()
        s.set({ dialog: s.dialog === 'handbook' ? null : 'handbook' })
        return
      }
      // Ctrl+R turns the selected photos (as in Photos); it never reloads the window
      const rotateKey = e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'r'
      if (rotateKey) e.preventDefault()
      // typing in a field, or Space/Enter on a button reached with the keyboard
      if (keyForFocus(e)) return
      if (e.key === 'Escape' && s.dialog) {
        s.set({ dialog: null })
        return
      }
      if (s.view !== 'editor' || s.fullscreen || s.exportOpen || s.presenting || s.dialog || modalOpen()) return
      if (rotateKey) {
        rotateSelection(-1)
        return
      }
      // Ctrl+V: photos, videos or a screenshot copied elsewhere go in behind the selected slide (insert.ts);
      // in a text field it pastes text (keyForFocus above)
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        void pasteMedia()
        return
      }
      if (e.key === 'Escape' && s.photoEdit) {
        closePhotoEdit(true)
        return
      }
      if (e.key === 'Escape' && (s.privacyEdit || s.textSel)) {
        s.set({ privacyEdit: null, textSel: null })
        return
      }
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
      else if ((e.key === 'Delete' || e.key === 'Backspace') && s.textSel && s.project) {
        const owner = s.project.entries.find((x) => x.texts?.some((ft) => ft.id === s.textSel))
        if (owner) s.removeFreeText(owner.id, s.textSel)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selection.length) s.removeEntries(s.selection)
      else if (e.ctrlKey && (e.key === 'a' || e.key === 'A') && s.project) {
        e.preventDefault()
        s.select(timelineOf(s.project).slides.flatMap((sl) => sl.entries.map((x) => x.id)))
        s.set({ tab: 'slide' })
      }
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
      ) : view === 'cull' ? (
        <Cull />
      ) : (
        <div className="editor">
          <div className="notices">
            <MissingBanner />
            <NetworkBanner />
            <Tip id="editor">{t('onboardEditor')}</Tip>
          </div>
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
      {dialog === 'settings' && <SettingsDialog />}
      {dialog === 'backups' && <BackupsDialog />}
      {dialog === 'help' && <HelpDialog />}
      {dialog === 'queue' && <QueueDialog />}
      {dialog === 'privacyReview' && <PrivacyReviewDialog />}
      {dialog === 'share' && <ShareDialog />}
      {dialog === 'systemcheck' && <SystemCheck />}
      {dialog === 'handbook' && <HandbookDialog />}
      {dialog === 'about' && <AboutDialog />}
      <Wizard />
      {presenting && <PresenterPanel />}
      <DiagnosticsHost />
      <CleanupHost />
      <ArchiveHost />
      {dragging && <div className="window-drop">{t('dropHere')}</div>}
    </div>
  )
}
