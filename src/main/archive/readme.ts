// The read-me of an archived show (archive.ts): LIESMICH.txt or README.txt in the UI's language, with
// what the archive holds, the app version and date, how to open it (extract first, then the .dshow)
// and the data-protection note with the show's deletion date. Plain text with Windows line breaks
// (Notepad); the caller adds a UTF-8 byte order mark. Pure.

export const WEBSITE = 'https://asamedia.github.io/diashow-studio/'

export interface ReadmeInfo {
  name: string
  /** File name of the project inside the archive. */
  projectFile: string
  appVersion: string
  /** When it was archived (ms). */
  date: number
  media: number
  music: number
  /** The theme song's copy (path inside the archive). */
  theme?: { file: string; title: string; artist?: string; licence?: string }
  /** Names of the videos in videos/. */
  videos: string[]
  /** Items left out of the show: in it, not in it, or there were none. */
  leftOut: 'included' | 'omitted' | 'none'
  faceData: 'kept' | 'removed' | 'none'
  /** Names of originals that were missing. */
  missing: string[]
  deleteAt?: number
}

export const readmeName = (lang: 'de' | 'en'): string => (lang === 'de' ? 'LIESMICH.txt' : 'README.txt')

const fmtDate = (ms: number, lang: 'de' | 'en'): string => new Date(ms).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

const winPath = (rel: string): string => rel.split('/').join('\\')

/** At most `n` names, then "…". */
const some = (names: string[], n = 8): string => (names.length > n ? `${names.slice(0, n).join(', ')} …` : names.join(', '))

export function readmeText(i: ReadmeInfo, lang: 'de' | 'en'): string {
  const de = lang === 'de'
  const date = fmtDate(i.date, lang)
  const lines: string[] = []
  const title = de ? `Diashow „${i.name}“ – Archiv` : `Slideshow “${i.name}” – archive`
  lines.push(title, '='.repeat(Math.min(72, title.length)), '')
  lines.push(de ? `Erstellt am ${date} mit Diashow Studio ${i.appVersion}.` : `Made on ${date} with Diashow Studio ${i.appVersion}.`, '')

  lines.push(de ? 'INHALT' : 'CONTENTS')
  lines.push(de ? `- ${i.projectFile}: das Projekt mit allen Folien, Texten und Einstellungen` : `- ${i.projectFile}: the project with all slides, texts and settings`)
  if (i.media) lines.push(de ? `- media\\: ${i.media} Fotos und Videos (Originale)` : `- media\\: ${i.media} photos and videos (originals)`)
  if (i.music) lines.push(de ? `- music\\: ${i.music} Song(s) der Diashow` : `- music\\: ${i.music} song(s) of the slideshow`)
  if (i.theme) {
    const by = i.theme.artist ? (de ? ` von ${i.theme.artist}` : ` by ${i.theme.artist}`) : ''
    const lic = i.theme.licence ? ` (${i.theme.licence})` : ''
    lines.push(de ? `- ${winPath(i.theme.file)}: die Titelmusik „${i.theme.title}“${by}${lic}` : `- ${winPath(i.theme.file)}: the theme song “${i.theme.title}”${by}${lic}`)
  }
  if (i.videos.length) lines.push(de ? `- videos\\: ${i.videos.length} exportierte(s) Video(s): ${some(i.videos)}` : `- videos\\: ${i.videos.length} exported video(s): ${some(i.videos)}`)
  if (i.leftOut === 'included') lines.push(de ? '- Auch die Fotos und Videos, die nicht in der Diashow sind (aussortiert), sind enthalten.' : '- The photos and videos left out of the slideshow are included too.')
  if (i.leftOut === 'omitted') lines.push(de ? '- Aussortierte Fotos und Videos (nicht in der Diashow) sind nicht enthalten.' : '- Photos and videos left out of the slideshow are not included.')
  if (i.faceData === 'removed') lines.push(de ? '- Gesichtsdaten (erkannte Gesichter, Personenliste) sind nicht enthalten. Was verpixelt war, bleibt verpixelt.' : '- Face data (detected faces, the people list) is not included. What was pixelated stays pixelated.')
  if (i.faceData === 'kept') lines.push(de ? '- Gesichtsdaten (erkannte Gesichter, Personenliste mit Namen) sind enthalten.' : '- Face data (detected faces, the people list with names) is included.')
  if (i.missing.length) lines.push(de ? `- Nicht enthalten, weil die Datei beim Archivieren fehlte (${i.missing.length}): ${some(i.missing)}` : `- Not included because the file was missing when archiving (${i.missing.length}): ${some(i.missing)}`)
  lines.push('')

  lines.push(de ? 'ÖFFNEN' : 'OPENING IT')
  if (de) {
    lines.push(
      '1. Das ZIP-Archiv zuerst entpacken: Rechtsklick darauf und „Alle extrahieren…“, z. B. auf die Festplatte',
      '   oder einen USB-Stick. Direkt aus dem ZIP lässt sich die Diashow nicht öffnen.',
      `2. Diashow Studio installieren, falls es fehlt: ${WEBSITE}`,
      `3. Im entpackten Ordner „${i.projectFile}“ doppelklicken, oder in Diashow Studio „Projekt öffnen…“ wählen.`,
      '',
      'Die Diashow erscheint dann unter „Deine Diashows“. Fotos, Videos und Musik bleiben im entpackten Ordner:',
      'Lass ihn, wo er ist, solange du die Diashow brauchst.'
    )
    if (i.theme) lines.push('Spielt eine spätere Version von Diashow Studio andere Titelmusik, nimmt sie beim Öffnen die Titelmusik aus diesem Archiv.')
  } else {
    lines.push(
      '1. Extract the ZIP archive first: right-click it and choose “Extract All…”, e.g. to the hard disk or a',
      '   USB stick. The slideshow cannot be opened straight from the ZIP.',
      `2. Install Diashow Studio if it is missing: ${WEBSITE}`,
      `3. In the extracted folder, double-click “${i.projectFile}”, or choose “Open project…” in Diashow Studio.`,
      '',
      'The slideshow then appears under “Your slideshows”. Its photos, videos and music stay in the extracted',
      'folder: leave it where it is as long as you need the slideshow.'
    )
    if (i.theme) lines.push('If a later version of Diashow Studio has other theme music, it takes the theme song from this archive when opening it.')
  }
  lines.push('')

  lines.push(de ? 'DATENSCHUTZ' : 'DATA PROTECTION')
  if (de) {
    lines.push(
      'Dieses Archiv enthält Fotos und Videos von Schülerinnen und Schülern. Bewahre es sicher auf (z. B. auf einem',
      'verschlüsselten Datenträger, nicht in einem geteilten oder öffentlichen Ordner) und gib es nicht weiter.'
    )
    if (i.deleteAt) lines.push(`Für diese Diashow ist als Löschfrist der ${fmtDate(i.deleteAt, lang)} eingetragen. Lösche dieses Archiv spätestens dann.`)
    else lines.push('Lösche es, sobald es nach den Fristen deiner Schule nicht mehr gebraucht wird.')
    lines.push('Das Archiv ist eine Kopie: Das Aufräumen in Diashow Studio erreicht es nicht, du musst es selbst löschen.')
  } else {
    lines.push(
      'This archive holds photos and videos of pupils. Keep it safe (e.g. on an encrypted drive, not in a shared or',
      'public folder) and do not pass it on.'
    )
    if (i.deleteAt) lines.push(`The deletion date of this slideshow is ${fmtDate(i.deleteAt, lang)}. Delete this archive by then at the latest.`)
    else lines.push('Delete it as soon as it is no longer needed under your school’s retention periods.')
    lines.push('The archive is a copy: the clean-up in Diashow Studio cannot reach it, you have to delete it yourself.')
  }
  return `${lines.join('\r\n')}\r\n`
}
