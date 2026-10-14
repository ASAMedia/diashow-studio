// Files dragged from Explorer onto the window (App.tsx): the "drop here" overlay, and the drop into the
// open show (or a new one) unless the filmstrip or a show's card took it (insert.ts handledDrops). While
// a dialog is open they are refused with "Close the dialog first" (keys.ts dialogRefusesFiles).
import { useEffect, useState } from 'react'
import { splitAudio } from '@shared/formats'
import { useStore } from './store'
import { dialogRefusesFiles } from './keys'
import { droppedPaths, handledDrops } from './insert'

/** Routes dropped files: audio goes to the playlist, everything else into the show. */
async function handleDroppedPaths(paths: string[]): Promise<void> {
  const s = useStore.getState()
  const { audio, media } = splitAudio(paths)
  if (!s.project) {
    if (media.length) await s.createProject(media)
    if (audio.length) await useStore.getState().addMusic(audio)
    return
  }
  if (media.length) await s.importMedia(media)
  if (audio.length) await s.addMusic(audio)
}

/**
 * The window's drop handling; `dragging`: files are over the window (the overlay shows), `refused`:
 * they came while a dialog was open (the hint shows).
 */
export function useWindowDrop(): { dragging: boolean; refused: boolean } {
  const [dragging, setDragging] = useState(false)
  /** Files came over the window while a dialog was open: "Close the dialog first". */
  const [refused, setRefused] = useState(false)

  useEffect(() => {
    const isFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')
    // While a dialog is open (Settings, the trash, the archive, …), files would land in the show behind
    // it or make a new show: they are refused (keys.ts; the assistant takes them). Caught before any
    // other handler sees them, with the drop effect "none", also over a text field in the dialog (it
    // would take a file's path as text). The hint comes once per drag, and goes a moment after the
    // files left the window or were let go.
    let hinted = false
    let hintTimer: ReturnType<typeof setTimeout> | undefined
    const hint = (): void => {
      clearTimeout(hintTimer)
      if (!hinted) setRefused(true)
      hinted = true
    }
    const hideHint = (): void => {
      clearTimeout(hintTimer)
      hintTimer = setTimeout(() => {
        hinted = false
        setRefused(false)
      }, 3000)
    }
    const refuse = (e: DragEvent): void => {
      if (!isFiles(e) || !dialogRefusesFiles()) return
      e.stopImmediatePropagation()
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'none'
      setDragging(false)
      if (e.type === 'dragenter') hint()
      else if (e.type === 'drop') {
        // the dialog opened while the files hovered: nothing goes in
        hint()
        hideHint()
      }
    }
    // dragenter is accepted like dragover, with the same effect: right after the element under the
    // pointer changed (an edge between two pictures), Chromium decides on a drop by the dragenter
    // alone, and a refused one loses the drop
    const over = (e: DragEvent): void => {
      if (!isFiles(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    }
    const enter = (e: DragEvent): void => {
      if (!isFiles(e)) return
      over(e)
      setDragging(true)
    }
    // a dragleave with nowhere to go: the files left the window, or the drag was cancelled (Esc). A
    // count of enters and leaves missed the leave of an element removed under the files (a card that
    // scrolled out of the filmstrip, a picture that appeared) and kept the overlay up.
    const leave = (e: DragEvent): void => {
      if (!isFiles(e) || e.relatedTarget) return
      setDragging(false)
      if (hinted) hideHint()
    }
    const drop = (e: DragEvent): void => {
      if (!isFiles(e)) return
      e.preventDefault()
      setDragging(false)
      // files dropped on the filmstrip or a show's card went in there (stripDrop.ts, Home.tsx)
      if (handledDrops.has(e)) return
      const paths = droppedPaths(e.dataTransfer)
      if (paths.length) void handleDroppedPaths(paths)
    }
    for (const type of ['dragenter', 'dragover', 'drop']) window.addEventListener(type, refuse as EventListener, true)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      clearTimeout(hintTimer)
      for (const type of ['dragenter', 'dragover', 'drop']) window.removeEventListener(type, refuse as EventListener, true)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])
  return { dragging, refused }
}
