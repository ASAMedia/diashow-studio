// Friendly error messages: technical failures (Node error codes, FFmpeg and sharp messages, project
// format errors) mapped to a few kinds the UI explains in plain words with what to do next. The
// renderer shows the text for the kind (i18n keys err*) and keeps the technical message as detail.
// Pure: shared by the renderer (messages) and the main process (diagnostics summary).

export type ErrorKind =
  | 'ffmpegMissing'
  | 'diskFull'
  | 'fileTooLarge'
  | 'outOfMemory'
  | 'fileLocked'
  | 'fileMissing'
  | 'networkBlocked'
  | 'unsupportedFile'
  | 'encoderFailed'
  | 'gpuLost'
  | 'portBlocked'
  | 'noNetwork'
  | 'projectDamaged'
  | 'projectTooNew'
  | 'openedFromZip'

/** Where the error happened; decides between kinds a message alone leaves open (EACCES on a port or a file). */
export type ErrorContext = 'import' | 'music' | 'export' | 'share' | 'project' | 'save'

/** Markers the main process puts into project format errors (an Error's own fields don't survive IPC). */
export const PROJECT_DAMAGED = 'project-damaged'
export const PROJECT_TOO_NEW = 'project-too-new'
/** A .dshow opened from inside a ZIP archive (only that file was extracted, to a temp folder). */
export const OPENED_FROM_ZIP = 'opened-from-zip'

/** The message of anything thrown, without Electron's "Error invoking remote method 'x': Error:" prefix. */
export function errorMessage(err: unknown): string {
  let msg = err instanceof Error ? err.message : typeof err === 'string' ? err : err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err ?? '')
  msg = msg.replace(/^Error invoking remote method '[^']*':\s*(\w*Error:\s*)?/, '')
  return msg.trim()
}

const RULES: { kind: ErrorKind; re: RegExp; only?: ErrorContext[] }[] = [
  { kind: 'openedFromZip', re: new RegExp(OPENED_FROM_ZIP) },
  { kind: 'projectTooNew', re: new RegExp(`${PROJECT_TOO_NEW}|unsupported project version|newer version of Diashow`, 'i') },
  { kind: 'projectDamaged', re: new RegExp(`${PROJECT_DAMAGED}|not a Diashow Studio project|backup is damaged`, 'i') },
  { kind: 'ffmpegMissing', re: /spawn\s+\S*ff(mpeg|probe)(\.exe)?\s+ENOENT|ff(mpeg|probe)(\.exe)?\W+(not found|missing)|FFmpeg (is )?missing/i },
  { kind: 'diskFull', re: /ENOSPC|no space left|not enough space|disk (is )?full|\b507\b|Datenträger ist voll/i },
  // a file over 4 GB on a FAT32 drive (many USB sticks), e.g. a large ZIP archive
  { kind: 'fileTooLarge', re: /EFBIG|file too large|FILE_TOO_LARGE|larger than the drive allows/i },
  { kind: 'outOfMemory', re: /ENOMEM|out of memory|Cannot allocate memory|Array buffer allocation failed|allocation failed|OOM\b/i },
  { kind: 'noNetwork', re: /^no-network$/i },
  { kind: 'portBlocked', re: /EADDRINUSE|EADDRNOTAVAIL|address already in use|listen E[A-Z]+|unknown address/i },
  { kind: 'portBlocked', re: /EACCES|permission denied|access is denied/i, only: ['share'] },
  { kind: 'gpuLost', re: /context (was )?lost|CONTEXT_LOST|GPU process|WebGL.{0,40}(lost|unavailable|not supported)|webgl2? (is )?not available/i },
  { kind: 'encoderFailed', re: /nvenc|h264_qsv|hevc_qsv|h264_amf|hevc_amf|OpenEncodeSession|No capable devices|Error while opening encoder|Could not open encoder|Error initializing output stream|encoder (failed|error)|VideoEncoder|EncodingError|the export expects \d+|frames? (missing|mismatch)/i },
  { kind: 'fileLocked', re: /EBUSY|EPERM|EACCES|resource busy|being used by another process|permission denied|access is denied|EROFS|read-only file system|locked/i },
  { kind: 'networkBlocked', re: /^network-blocked$/ },
  { kind: 'fileMissing', re: /ENOENT|no such file|does not exist|cannot find the (file|path)|^missing$|file not found/i },
  {
    kind: 'unsupportedFile',
    re: /Invalid data found|moov atom not found|no (video|audio) stream|unsupported|not supported|corrupt|damaged|Premature end|truncated|could not find codec parameters|End of file|unknown format|VipsForeignLoad|bad (huffman|marker)|Invalid (NAL|frame|argument)|could not be read|could not be converted|not a valid/i
  }
]

/**
 * The kind of a failure, or null when nothing fits. Without a match, imports default to
 * 'unsupportedFile' (a file the app could not process) and exports to 'encoderFailed'.
 */
export function classifyError(err: unknown, context?: ErrorContext): ErrorKind | null {
  const msg = errorMessage(err)
  if (!msg || msg === 'cancelled') return null
  for (const r of RULES) {
    if (r.only && (!context || !r.only.includes(context))) continue
    if (r.re.test(msg)) return r.kind
  }
  if (context === 'import' || context === 'music') return 'unsupportedFile'
  if (context === 'export') return 'encoderFailed'
  return null
}
