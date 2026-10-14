// The UI's language in the main process, and the titles and filter names of the Windows file dialogs
// (and windows) it opens in that language (the renderer's own strings are in src/renderer/src/i18n.ts).
import { app } from 'electron'

/** DIASHOW_LOCALE (e.g. en-US) overrides the Windows language, for tests in either language. */
export const appLocale = (): string => process.env.DIASHOW_LOCALE || app.getLocale()

const TEXT = {
  addMedia: ['Fotos und Videos hinzufügen', 'Add photos and videos'],
  photosAndVideos: ['Fotos und Videos', 'Photos and videos'],
  allFiles: ['Alle Dateien', 'All files'],
  addFolder: ['Ordner hinzufügen', 'Add folder'],
  addMusic: ['Musik hinzufügen', 'Add music'],
  music: ['Musik', 'Music'],
  exportShow: ['Diashow exportieren', 'Export slideshow'],
  mp4: ['MPEG-4-Video', 'MPEG-4 video'],
  packTarget: ['Projekt packen: Zielordner wählen', 'Pack project: choose a target folder'],
  openProject: ['Projekt öffnen', 'Open project'],
  project: ['Diashow-Projekt', 'Slideshow project'],
  archiveShow: ['Diashow als ZIP archivieren', 'Archive slideshow as ZIP'],
  addVideo: ['Video hinzufügen', 'Add video'],
  video: ['Video', 'Video'],
  videos: ['Videos', 'Videos'],
  saveDiagnostics: ['Diagnosepaket speichern', 'Save diagnostics package'],
  offerFile: ['Datei zum Herunterladen anbieten', 'Offer a file for download'],
  // the window on the second display (taskbar, Alt+Tab)
  presentation: ['Diashow Studio – Präsentation', 'Diashow Studio – Presentation'],
  // Windows notifications when an export in the background is done or failed
  notifyDone: ['Export fertig', 'Export finished'],
  notifyDoneHint: ['Ein Klick zeigt das Video im Ordner.', 'Click to show the video in its folder.'],
  notifyFailed: ['Export fehlgeschlagen', 'Export failed'],
  notifyFailedHint: ['Mehr dazu in der Export-Warteschlange.', 'The export queue tells you more.']
} as const

export type DialogTextKey = keyof typeof TEXT

/** A dialog text in the language of the UI. */
export function dialogText(key: DialogTextKey): string {
  return TEXT[key][appLocale().toLowerCase().startsWith('de') ? 0 : 1]
}
