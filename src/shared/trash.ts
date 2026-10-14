// The trash for slideshows: "Delete" on the home screen moves a show there for TRASH_DAYS days, with
// its older versions, undo history, the pupils' uploads and its finished export jobs; then it is
// deleted for good (src/main/trash.ts). What the home screen, the trash dialog and Settings → Privacy
// show of it.

/** Days a show stays in the trash before it is deleted for good. */
export const TRASH_DAYS = 30

export interface TrashEntry {
  id: string
  name: string
  /** When it was deleted, and when it goes for good (TRASH_DAYS later). */
  deletedAt: number
  purgeAt: number
  /** The show's deletion reminder (src/shared/cleanup.ts): it stays in the trash. */
  deleteAt?: number
  slideCount: number
  /** What went into the trash with it: older versions, uploaded and pasted pictures, finished export jobs. */
  versions: number
  uploads: number
  exports: number
  /** It holds face data (detected faces, face features, marked people), as it did when it was deleted. */
  faces: boolean
  /** Bytes it takes in the trash. */
  bytes: number
}

/** Something in the trash the app can't read (no or a broken description): never restored, deleted for good like the rest. */
export interface TrashProblem {
  /** Its folder name in the trash. */
  key: string
  bytes: number
}

export interface TrashContents {
  entries: TrashEntry[]
  problems: TrashProblem[]
  /** Everything in the trash. */
  bytes: number
}

/** What deleting for good removed, and what could not be deleted (in use). */
export interface TrashRemoveResult {
  files: number
  bytes: number
  failed: string[]
}

/**
 * Why a show didn't go into the trash or didn't come back: an export of it is still to run, its id
 * belongs to another show now (restoring never overwrites a show), or it isn't there (any more).
 */
export type TrashRefusal = 'export-pending' | 'id-taken' | 'not-found'

/** Deleting a show (moving it into the trash). */
export type TrashMoveResult =
  | {
      entry: TrashEntry
      /** Its cache folders, deleted right away (they are made again after a restore). */
      cache: { files: number; bytes: number }
      /** Cache files that could not be deleted (in use). */
      failed: string[]
    }
  | { refused: TrashRefusal; unfinished?: number }

export type TrashRestoreResult =
  | {
      id: string
      name: string
      /** Uploads whose place was taken meanwhile: they came back under another name (the show follows them). */
      renamed: number
      /** The undo history came back too (it goes when uploads had to be renamed). */
      history: boolean
      /** It had an undo history that did not come back (it no longer fits the show): the notice says so. */
      historyDropped?: boolean
      /** Export jobs back in the queue. */
      exports: number
    }
  | { refused: TrashRefusal }
