// Drag and drop on the filmstrip (Filmstrip.tsx): a card dropped on the middle of another combines both
// slides, near the edges it moves there; files from Explorer go in between two cards or, when they fit,
// into the slide they are dropped onto (insert.ts), as one undo step.
import { useRef, useState, type DragEvent as ReactDragEvent, type RefObject } from 'react'
import type { Timeline, TimelineSlide } from '@shared/timeline'
import type { Project } from '@shared/types'
import { useStore } from '../store'
import { droppedPaths, handledDrops, insertFiles } from '../insert'
import { anchorAt, canJoin } from '../insertAt'
import type { StripScale } from './stripScale'

/** Cards narrower than this take no "drop onto the card" (combine): the middle would be too small to hit. */
const MIN_MERGE_CARD = 40

export interface StripDrop {
  /** The card being dragged, the gap a drop would go into, the card a drop would combine with. */
  drag: number | null
  dropAt: number | null
  mergeAt: number | null
  /** Files from Explorer are over the filmstrip (the window's "drop here" overlay steps aside). */
  filesOver: boolean
  /** For the strip's inner element. */
  handlers: {
    onDragEnter: (e: ReactDragEvent) => void
    onDragOver: (e: ReactDragEvent) => void
    onDragLeave: (e: ReactDragEvent) => void
    onDrop: (e: ReactDragEvent) => void
  }
  /** A card's drag starts and ends. */
  start: (index: number) => void
  end: () => void
}

export function useStripDrop(o: {
  innerRef: RefObject<HTMLDivElement | null>
  tl: Timeline
  project: Project
  scale: StripScale
  /** The theme's most photos per slide. */
  maxPer: number
  moveSlide: (from: number, to: number) => void
}): StripDrop {
  const { tl, project, scale, maxPer } = o
  const { step } = scale
  const n = tl.slides.length
  const [drag, setDrag] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [mergeAt, setMergeAt] = useState<number | null>(null)
  // files from Explorer over the filmstrip (the window's "drop here" overlay steps aside)
  const [filesOver, setFilesOver] = useState(false)
  const filesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // drag events can arrive faster than React re-renders, so the handlers read refs
  const dragRef = useRef<number | null>(null)

  /** Files dragged from Explorer: can they join slide `target` (same rule as dragging a slide onto another)? */
  const filesFit = (target: TimelineSlide | undefined, items: DataTransferItemList): boolean => {
    // a panorama keeps its slide to itself
    if (!target || target.pano) return false
    const list = [...items].filter((it) => it.kind === 'file')
    // folders and unknown types (HEIC, RAW) are only known after the import: they go between slides
    if (!list.length || !list.every((it) => /^(image|video)\//.test(it.type))) return false
    return canJoin(target, list.map((it) => ({ kind: it.type.startsWith('video/') ? 'video' : 'photo' })), project.settings)
  }

  // Dropping on the middle of another slide combines both; near the edges it reorders (or inserts files).
  const dropTarget = (e: ReactDragEvent, files: boolean): { merge?: number; insert?: number } => {
    const rect = o.innerRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const i = Math.floor(x / step)
    const within = (x - i * step) / scale.card
    const target = tl.slides[i]
    const source = dragRef.current != null ? tl.slides[dragRef.current] : undefined
    const canMerge = files
      ? filesFit(target, e.dataTransfer.items)
      : maxPer > 1 && !!target && !!source && i !== dragRef.current && target.kind !== 'title' && target.kind !== 'text' && source.kind !== 'text' &&
        target.entries.length + source.entries.length <= maxPer && !target.pano && !source.pano
    if (canMerge && scale.card >= MIN_MERGE_CARD && within > 0.25 && within < 0.75) return { merge: i }
    return { insert: Math.max(0, Math.min(n, Math.round(x / step))) }
  }
  const isFiles = (e: ReactDragEvent): boolean => dragRef.current == null && e.dataTransfer.types.includes('Files')
  const clearMarks = (): void => {
    clearTimeout(filesTimer.current)
    setFilesOver(false)
    setDropAt(null)
    setMergeAt(null)
  }
  // dragover, and dragenter alike: when the element under the pointer has just changed (an edge between
  // two cards or pictures), Chromium fires no dragover in that step and decides on the drop by the
  // dragenter, so it is accepted (with the same effect) and shows the same mark
  const onDragOver = (e: ReactDragEvent): void => {
    const files = isFiles(e)
    if (dragRef.current == null && !files) return
    e.preventDefault()
    e.dataTransfer.dropEffect = files ? 'copy' : 'move'
    if (files) {
      setFilesOver(true)
      clearTimeout(filesTimer.current)
      // dragover repeats while the files hover; when it stops, they left (or were dropped)
      filesTimer.current = setTimeout(clearMarks, 250)
    }
    const target = dropTarget(e, files)
    setMergeAt(target.merge ?? null)
    setDropAt(target.insert ?? null)
  }
  // the dragleave of a picture inside a card bubbles up here: only leaving the filmstrip (or the
  // window, or Esc: nowhere to go) clears the marks, or a card's mark would flicker at the edge
  // between its pictures
  const onDragLeave = (e: ReactDragEvent): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) clearMarks()
  }
  const onDrop = (e: ReactDragEvent): void => {
    e.preventDefault()
    const drag = dragRef.current
    const files = isFiles(e)
    // where it is dropped, not where the last dragover was: the drop can follow a dragenter at once
    const { merge, insert } = dropTarget(e, files)
    if (files) {
      // files from Explorer go in right here, as one undo step; the window's drop handler leaves them
      handledDrops.add(e.nativeEvent)
      const paths = droppedPaths(e.dataTransfer)
      const at = merge != null ? merge + 1 : (insert ?? n)
      const into = merge != null ? tl.slides[merge].entries.map((x) => x.id) : undefined
      if (paths.length) void insertFiles(paths, { before: anchorAt(tl, project.entries, at), ...(into ? { into } : {}) })
    } else if (drag != null && merge != null) {
      const ids = [...tl.slides[merge].entries, ...tl.slides[drag].entries].map((x) => x.id)
      useStore.getState().mergeEntries(ids)
      useStore.getState().select(ids)
    } else if (drag != null && insert != null && insert !== drag && insert !== drag + 1) o.moveSlide(drag, insert)
    dragRef.current = null
    setDrag(null)
    clearMarks()
  }

  return {
    drag,
    dropAt,
    mergeAt,
    filesOver,
    handlers: { onDragEnter: onDragOver, onDragOver, onDragLeave, onDrop },
    start: (index) => {
      dragRef.current = index
      setDrag(index)
    },
    end: () => {
      dragRef.current = null
      setDrag(null)
      clearMarks()
    }
  }
}
