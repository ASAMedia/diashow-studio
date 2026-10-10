// Diagnostics (error log, diagnostics package) and project checks (validation, repair): types shared by
// the main process (src/main/diagnostics, src/main/projectSchema.ts) and the renderer.
import type { BackupInfo } from './types'

/** An error the renderer reports for the log (window errors, unhandled rejections, console.error). */
export interface RendererLogEntry {
  kind: 'error' | 'rejection' | 'console' | 'export' | 'media' | 'info'
  message: string
  stack?: string
  /** Where it happened (file:line), or a short context such as a dialog name. */
  where?: string
  /** Times the same message was reported in a row and folded into this entry. */
  repeat?: number
}

/** What the renderer adds to the diagnostics package (nothing personal: no names, no paths). */
export interface DiagnosticsInput {
  /** The open project, summarised without names or paths. */
  projectId?: string
  /** Renderer-side settings and facts (preview quality, WebGL renderer, language). */
  renderer?: Record<string, string | number | boolean | null>
  /** Export jobs without names and paths: state, size, codec, error. */
  exportJobs?: { state: string; width: number; height: number; codec: string; fps?: number; error?: string }[]
}

/** One file of the diagnostics package, as the dialog shows it before saving. */
export interface DiagnosticsFile {
  /** Path inside the zip. */
  name: string
  bytes: number
  /** What it is (i18n key of the dialog). */
  about: 'readme' | 'versions' | 'system' | 'settings' | 'project' | 'exports' | 'log'
  /** Its text (shortened for long logs). */
  preview: string
}

export interface DiagnosticsPreview {
  files: DiagnosticsFile[]
  /** Size of the zip. */
  bytes: number
  /** Suggested file name. */
  fileName: string
}

// ---- projects: format versions, validation and repair

export type RepairCode =
  /** The file was cut off (e.g. power loss while saving); what could be read was kept. */
  | 'truncated'
  /** The file came from an older format and was converted. */
  | 'migrated'
  /** Name, id or dates were missing and were filled in. */
  | 'basics'
  /** The list of slides or of photos/videos was missing or broken. */
  | 'listsMissing'
  /** Settings with wrong values were reset to their defaults. */
  | 'settings'
  | 'entriesDropped'
  /** Slides whose photo or video is not in the media list. */
  | 'entriesMissingMedia'
  | 'entriesRepaired'
  | 'mediaDropped'
  | 'mediaRepaired'
  | 'musicDropped'
  | 'musicRepaired'
  | 'peopleDropped'

export interface RepairReport {
  /** Format version of the file before migration, when it was older. */
  fromVersion?: number
  changes: { code: RepairCode; count: number }[]
}

/** Sent after a project was opened (or imported, restored, repaired) and had to be changed. */
export interface ProjectReportEvent {
  projectId: string
  source: 'open' | 'import' | 'backup' | 'repair'
  report: RepairReport
}

/** A project file in the projects folder that cannot be opened as it is. */
export interface DamagedProject {
  /** Project id (the file name). */
  id: string
  file: string
  bytes: number
  modifiedAt: number
  /** 'damaged': unreadable or broken; 'too-new': saved by a newer version of the app. */
  reason: 'damaged' | 'too-new'
  /** Format version of a too-new file. */
  version?: number
  /** Name read from the damaged file, when it was still there. */
  name?: string
  backups: number
}

/** What a repair could do for a damaged file: rescue what is readable, and/or go back to a backup. */
export interface RepairPlan {
  /** Projects folder id, or undefined for a file elsewhere (e.g. a packed project on a USB stick). */
  id?: string
  file: string
  /** What rescuing the file itself gives; null when nothing could be read. */
  salvage: { name: string; slides: number; media: number; music: number; report: RepairReport } | null
  /** Backups of this project, newest first, with what each holds; `damaged`: unreadable itself. */
  backups: (BackupInfo & { damaged?: boolean })[]
}

export type RepairChoice = { kind: 'salvage' } | { kind: 'backup'; file: string }

/** Where a repair or open can be addressed: a project in the projects folder, or any .dshow file. */
export type ProjectRef = { id: string } | { path: string }
