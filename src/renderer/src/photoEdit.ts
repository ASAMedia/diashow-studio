// Rotate, straighten and crop (MediaItem.edit) in the editor: opening and closing the edit view over the
// preview, storing an edit as one undo step, Ctrl+R on the selected slides, and light and colour
// (edit.adjust) for one or several pictures, with a live preview while a slider is dragged.
import type { MediaAdjust, MediaEdit, MediaItem } from '@shared/types'
import { editKey, normalizeEdit, rotateEdit } from '@shared/mediaEdit'
import { withAdjust } from '@shared/adjust'
import { playerRef, useStore } from './store'

function withEdit(m: MediaItem, edit: MediaEdit | undefined): MediaItem {
  const { edit: _old, ...rest } = m
  return edit ? { ...rest, edit } : rest
}

/**
 * Stores the edit of a media item (undefined or an edit that changes nothing: the original). One
 * undo step, or one per `key` for steps that follow each other within a moment (arrow keys).
 */
export function setMediaEdit(mediaId: string, edit: MediaEdit | undefined, key?: string): void {
  const next = normalizeEdit(edit)
  const cur = useStore.getState().project?.media.find((m) => m.id === mediaId)
  if (!cur || editKey(cur.edit) === editKey(next)) return
  useStore.getState().update((p) => {
    p.media = p.media.map((m) => (m.id === mediaId ? withEdit(m, next) : m))
  }, key && `edit:${mediaId}:${key}`)
}

/** Media of the selected photos and videos (of every selected slide), each once. */
export function selectedMediaIds(): string[] {
  const s = useStore.getState()
  const want = new Set(s.selection)
  const ids = (s.project?.entries ?? []).flatMap((e) => (want.has(e.id) && e.type !== 'text' ? [e.mediaId] : []))
  return [...new Set(ids)]
}

/** Turns the pictures of the selected slides a quarter (-1 left, as Ctrl+R; 1 right), as one undo step. */
export function rotateSelection(dir: -1 | 1 = -1): number {
  const ids = new Set(selectedMediaIds())
  if (!ids.size) return 0
  useStore.getState().update((p) => {
    p.media = p.media.map((m) => (ids.has(m.id) ? withEdit(m, normalizeEdit(rotateEdit(m.edit, dir))) : m))
  })
  return ids.size
}

/**
 * Sets light and colour sliders (the others stay) on several pictures at once, as one undo step (or
 * one per `key` for a run of key presses). The draft of the live preview ends with it.
 */
export function setMediaAdjust(mediaIds: readonly string[], patch: MediaAdjust, key?: string): void {
  const ids = new Set(mediaIds)
  const media = useStore.getState().project?.media ?? []
  const next = new Map<string, MediaEdit | undefined>()
  for (const m of media) {
    if (!ids.has(m.id)) continue
    const edit = normalizeEdit({ ...(m.edit ?? { rotate: 0, straighten: 0 }), adjust: withAdjust(m.edit?.adjust, patch) })
    if (editKey(edit) !== editKey(m.edit)) next.set(m.id, edit)
  }
  if (!next.size) return previewAdjust(null)
  // the draft shows what is stored now: it goes when the preview has the new project (no flash between)
  playerRef.current?.endAdjustDraft()
  useStore.getState().update((p) => {
    p.media = p.media.map((m) => (next.has(m.id) ? withEdit(m, next.get(m.id)) : m))
  }, key && `adjust:${[...ids].join(',')}:${key}`)
}

/** The preview shows these slider values on these pictures without storing them (null: as stored). */
export function previewAdjust(draft: { ids: readonly string[]; patch: MediaAdjust } | null): void {
  playerRef.current?.setAdjustDraft(draft && { ids: new Set(draft.ids), patch: draft.patch })
}

/** Opens the edit view for the picture of an entry (selecting it, and pausing the preview). */
export function openPhotoEdit(entryId: string): void {
  const s = useStore.getState()
  const e = s.project?.entries.find((x) => x.id === entryId)
  if (!e || e.type === 'text') return
  const m = s.project!.media.find((x) => x.id === e.mediaId)
  if (!m || m.status === 'error') return
  if (s.selection.length !== 1 || s.selection[0] !== entryId) s.select([entryId])
  playerRef.current?.pause()
  s.set({ photoEdit: { entryId, mediaId: m.id, before: m.edit }, kbEdit: null, privacyEdit: null, textSel: null, tab: 'slide' })
}

/** Closes the edit view; `cancel` puts back the edit it opened with (an undo step of its own). */
export function closePhotoEdit(cancel: boolean): void {
  const s = useStore.getState()
  const open = s.photoEdit
  if (!open) return
  s.set({ photoEdit: null })
  if (cancel) setMediaEdit(open.mediaId, open.before)
}
