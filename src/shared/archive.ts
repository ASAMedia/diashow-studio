// "Diashow als ZIP archivieren": one ZIP file with everything needed to open, change and play a
// finished show again on any PC with Diashow Studio (src/main/archive): the project with relative
// paths, the original photos, videos and songs, the theme song, finished exports if wanted, and a
// read-me. Types shared by the dialog (components/Archive.tsx) and the main process, and the size
// estimate the dialog shows and compares with the free space. Pure.

/** Files of one part of the archive. */
export interface ArchivePart {
  files: number
  bytes: number
}

/** A video that can go into the archive: a finished export of the show, or one the user picked. */
export interface ArchiveVideo {
  path: string
  /** File name. */
  name: string
  bytes: number
  /** A finished export of this show in the export queue (else added with "Add another video file…"). */
  fromQueue: boolean
}

/** An original that is not there (moved, deleted, on a share that isn't allowed): skipped with a warning. */
export interface ArchiveMissing {
  name: string
  path: string
  /** It belongs only to items left out of the show. */
  leftOut: boolean
}

/** What the archive dialog lists before anything is written. */
export interface ArchiveInventory {
  projectId: string
  name: string
  /** Deletion reminder of the show (ms since 1970). */
  deleteAt?: number
  /** Photos and videos of the show: the originals, with Live Photo videos. */
  media: ArchivePart
  /** Photos and videos only left out of the show (with "include left-out items"); `items`: how many. */
  leftOut: ArchivePart & { items: number }
  /** The show's own songs. */
  music: ArchivePart
  /** The theme song, when the show plays one. */
  theme?: { title: string; bytes: number }
  /** Finished exports of this show that the export queue knows and whose files are there. */
  exports: ArchiveVideo[]
  /** Project file and read-me. */
  project: ArchivePart
  missing: ArchiveMissing[]
  /** The show holds face data (detected faces, face features, marked people). */
  faceData: boolean
  /** Suggested file: the show's name and today's date, in Documents. */
  target: string
  /** Free bytes on the drive of `target`; null when unknown. */
  free: number | null
  /** The largest file that drive holds (FAT32: 4 GB); null: no limit known. Only asked for archives that may reach it. */
  maxFile: number | null
}

/** What goes into the archive. */
export interface ArchiveChoice {
  /** The photos and videos left out of the show too; otherwise their slides are not in the archived project. */
  leftOut: boolean
  /** Leave face data out; what is pixelated stays pixelated (shared/cleanup.ts withoutFaceData). */
  withoutFaceData: boolean
  /** Videos to add: paths from `ArchiveInventory.exports` or from pickArchiveVideos. */
  videos: string[]
  /** Language of the read-me. */
  lang: 'de' | 'en'
}

/** A target picked in the save dialog, with the free space on its drive (null: unknown). */
export interface ArchiveTarget {
  path: string
  free: number | null
  /** ArchiveInventory.maxFile for this drive. */
  maxFile: number | null
}

/** FAT and FAT32 (many USB sticks) hold files of at most 4 GB − 1 byte. */
export const FAT_MAX_FILE = 0xffffffff

/** Archives from this size on are checked against the drive's largest file (FAT32). */
export const CHECK_FILE_SYSTEM_FROM = 3.5 * 1024 ** 3

export interface ArchiveProgress {
  /** Writing the archive, then reading it back to check it. */
  phase: 'write' | 'verify'
  /** Bytes done and in all, for this phase. */
  done: number
  total: number
  /** The file being written. */
  file?: string
}

export interface ArchiveResult {
  /** The .zip file. */
  path: string
  bytes: number
  /** Entries in it. */
  files: number
  media: number
  music: number
  videos: number
  /** The theme song is in it. */
  theme: boolean
  /** Originals that were not there: not in the archive. */
  missing: { name: string; path: string }[]
  deleteAt?: number
  /** The check after writing: entries read back, of which CRC-checked. */
  verified: { entries: number; checked: number }
}

/** Bytes per file beyond its data: local header, ZIP64 field, central directory record (generous). */
export const ENTRY_OVERHEAD = 400

/** About how large the archive becomes with these choices (data plus headers). */
export function archiveSize(inv: ArchiveInventory, leftOut: boolean, videos: readonly ArchiveVideo[]): number {
  const parts = [inv.media, inv.music, inv.project, ...(leftOut ? [inv.leftOut] : [])]
  const files = parts.reduce((n, p) => n + p.files, 0) + (inv.theme ? 1 : 0) + videos.length
  const bytes = parts.reduce((n, p) => n + p.bytes, 0) + (inv.theme?.bytes ?? 0) + videos.reduce((n, v) => n + v.bytes, 0)
  return bytes + files * ENTRY_OVERHEAD + 1024
}
