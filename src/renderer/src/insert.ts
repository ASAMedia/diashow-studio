// Inserting photos and videos at a place in the show: files dropped from Explorer onto the filmstrip,
// files or a picture pasted with Ctrl+V (behind the selected slide, else at the end), and "Insert…" in
// a slide's menu (behind that slide). Files are imported like any import (folders expanded, Live
// Photos and RAW+JPEG paired, sorted by capture time) and go in as one undo step; the new slides are
// selected. Where they go is decided in insertAt.ts. What the show has already is skipped (repeats.ts).
import { splitAudio } from '@shared/formats'
import type { MediaItem } from '@shared/types'
import { useStore } from './store'
import { timelineOf } from './timeline'
import { entriesFor } from './entryEdits'
import { notifyError } from './errors'
import { anchorAt, canJoin, insertEntries, insertInto } from './insertAt'
import { againPaths, importChecked, noticeRepeats, serially, type CheckedImport } from './repeats'

/**
 * Where new items go: in front of an entry (null: at the end), or (`into`, the entry ids of a slide
 * they were dropped onto) into that slide when they fit, else in front of `before`.
 */
export interface InsertPlace {
  before: string | null
  into?: string[]
}

/** Drops of files the filmstrip or a show's card took (the window's own drop handler leaves them alone). */
export const handledDrops = new WeakSet<Event>()

/** The paths of the files (and folders) dropped from Explorer. */
export const droppedPaths = (dt: DataTransfer | null | undefined): string[] => [...(dt?.files ?? [])].map((f) => window.api.pathForFile(f)).filter(Boolean)

/** Scrolls the filmstrip to the slide of an entry (set while the filmstrip is shown). */
export const stripReveal: { current: ((entryId: string) => void) | null } = { current: null }

/**
 * Imports `paths` and puts the new photos and videos at `place`, in one undo step, then selects them.
 * Audio files go into the music as with any drop. Resolves with the new entry ids.
 */
export async function insertFiles(paths: string[], place: InsertPlace): Promise<string[]> {
  const { audio, media } = splitAudio(paths)
  if (audio.length) void useStore.getState().addMusic(audio).catch((e) => notifyError(e, 'import'))
  if (!media.length) return []
  return serially(async () => {
    let checked: CheckedImport
    try {
      checked = await importChecked(media, useStore.getState().project)
    } catch (e) {
      notifyError(e, 'import')
      return []
    }
    const ids = putAt(checked.fresh, place)
    const cur = useStore.getState().project
    if (checked.skipped.length && cur) {
      // "Add anyway": at the same place (behind the ones that went in), one undo step
      noticeRepeats(cur, checked, () =>
        serially(async () => {
          const items = await window.api.importPaths(againPaths(checked.skipped))
          return useStore.getState().project?.id === cur.id ? putAt(items, place) : []
        })
      )
    }
    if (ids.length) {
      useStore.getState().select(ids)
      stripReveal.current?.(ids[0])
    }
    return ids
  })
}

/** Puts imported items at `place` in one undo step; returns the new entry ids. */
function putAt(items: MediaItem[], place: InsertPlace): string[] {
  const cur = useStore.getState().project
  if (!items.length || !cur) return []
  const fresh = entriesFor(items)
  // the timeline as it is now: the user may have changed the show while the files were read
  const tl = timelineOf(cur)
  const target = place.into?.length ? tl.slides.find((s) => s.entries.some((e) => e.id === place.into![0])) : undefined
  const join = !!target && canJoin(target, items, cur.settings)
  const before = place.before != null && cur.entries.some((e) => e.id === place.before) ? place.before : null
  useStore.getState().update((p) => {
    const known = new Set(p.media.map((m) => m.id))
    for (const m of items) if (!known.has(m.id)) p.media.push(m)
    if (join) insertInto(p, fresh, target!.entries.map((e) => e.id))
    else insertEntries(p, fresh, before, tl)
  })
  return fresh.map((e) => e.id)
}

/** The slide boundary behind the last selected slide, or the end of the show without a selection. */
export function boundaryAfterSelection(): number {
  const s = useStore.getState()
  if (!s.project) return 0
  const tl = timelineOf(s.project)
  const sel = new Set(s.selection)
  let last = -1
  for (const sl of tl.slides) if (sl.entries.some((e) => sel.has(e.id)) || (!!sl.captionEntryId && sel.has(sl.captionEntryId))) last = sl.index
  return last >= 0 ? last + 1 : tl.slides.length
}

/** The entry in front of which items for slide boundary `at` of the open show go. */
export function placeAt(at: number): InsertPlace {
  const p = useStore.getState().project
  return { before: p ? anchorAt(timelineOf(p), p.entries, at) : null }
}

/**
 * Ctrl+V: files copied in Explorer, or a copied picture without a file (a screenshot), which the
 * main process saves as a PNG first. They go behind the selected slide, or at the end.
 */
export async function pasteMedia(): Promise<void> {
  const p = useStore.getState().project
  if (!p) return
  let paths: string[]
  try {
    paths = await window.api.clipboardMedia(p.name)
  } catch (e) {
    notifyError(e, 'import')
    return
  }
  if (paths.length) await insertFiles(paths, placeAt(boundaryAfterSelection()))
}
