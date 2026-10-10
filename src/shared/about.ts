// About dialog and update hint: what the main process reports (src/main/about.ts).

/** The project's home; releases are published there. */
export const REPO_URL = 'https://github.com/ASAMedia/diashow-studio'
/** GitHub API: the newest published release (no drafts, no pre-releases). */
export const LATEST_RELEASE_API = 'https://api.github.com/repos/ASAMedia/diashow-studio/releases/latest'

export interface AboutInfo {
  version: string
  electron: string
  chrome: string
  node: string
  /** e.g. "n9.0.2-17-g2a571b6068-20260930"; 'missing' without FFmpeg. */
  ffmpeg: string
  /** Where the bundled FFmpeg build and its exact source code are (GPL). */
  ffmpegBuild: { release: string; source?: string; scripts?: string }
  repo: string
  license: string
}

/**
 * Result of an update check:
 * - newer: `latest` is newer than `current` (with the release page `url`);
 * - current: this is the newest release; none: nothing published yet;
 * - off: the automatic check is switched off in Settings; skipped: not due (checked within a day,
 *   or a development build);
 * - unavailable: offline, timed out, rate-limited or an unexpected answer.
 */
export interface UpdateStatus {
  state: 'newer' | 'current' | 'none' | 'off' | 'skipped' | 'unavailable'
  current: string
  latest?: string
  url?: string
  /** When GitHub was last asked (ms since 1970). */
  checkedAt?: number
}
