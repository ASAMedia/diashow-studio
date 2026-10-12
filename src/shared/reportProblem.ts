// "Problem melden" (Settings → Troubleshooting, About): the bug form on GitHub
// (.github/ISSUE_TEMPLATE/bug.yml), opened in the browser with three fields filled in: the app version,
// the Windows version and the graphics card. Nothing else goes into the link: no names, paths or
// project data. The main process opens only pages of the project (ipcGuards.checkProjectUrl).
import { REPO_URL } from './about'
import type { GpuDeviceInfo } from './systemCheck'

/** Every URL the app may open in the browser through `shell:open-github` starts with this. */
export const PROJECT_PAGE_PREFIX = `${REPO_URL}/`

/** GitHub refuses longer URLs (about 8 KB); the bug link stays far below. */
export const MAX_URL_LENGTH = 8000

/** Longest value of one field in the link. */
export const MAX_FIELD_LENGTH = 200

/** What the bug form is filled in with; the keys are the field ids in bug.yml. */
export interface ReportFields {
  version: string
  windows: string
  gpu: string
}

export const REPORT_FIELDS: (keyof ReportFields)[] = ['version', 'windows', 'gpu']

/** One line of plain text, at most MAX_FIELD_LENGTH characters. */
export function cleanField(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FIELD_LENGTH)
}

/** The bug form on GitHub with the fields filled in (empty ones are left out). */
export function bugReportUrl(fields: Partial<ReportFields>): string {
  const query = [['template', 'bug.yml'], ...REPORT_FIELDS.map((k) => [k, cleanField(fields[k])])]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
  return `${REPO_URL}/issues/new?${query.join('&')}`
}

/**
 * The graphics cards as one line, the active one first, e.g. "NVIDIA GeForce RTX 3060 (32.0.15.6094),
 * Intel UHD Graphics 770". Windows' software adapter only counts when it is the active one.
 */
export function gpuSummary(devices: GpuDeviceInfo[]): string {
  const real = devices.filter((d) => d.vendor !== 'Microsoft' || d.active)
  real.sort((a, b) => Number(b.active) - Number(a.active))
  const name = (d: GpuDeviceInfo): string => `${d.device.startsWith(d.vendor) ? '' : `${d.vendor} `}${d.device}${d.driver ? ` (${d.driver})` : ''}`
  return cleanField(real.map(name).join(', '))
}
