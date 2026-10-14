// What Windows shows of the export queue outside the app: the progress in the app's taskbar button
// (green while a job renders, "busy" while it prepares its sources, yellow when paused, red for a
// moment when one fails) and a notification when a job is done or fails while none of the app's
// windows has the focus. No notification while the app shows something fullscreen (a presentation
// on the projector, kiosk mode, the fullscreen player): it would pop up in front of the audience.
// Electron-free; queueMain.ts wires it to the windows and to Windows' notifications.
import type { ExportJobInfo, ExportJobState } from '@shared/exportQueue'

export type TaskbarMode = 'none' | 'normal' | 'indeterminate' | 'paused' | 'error'

export interface FeedbackDeps {
  /** The taskbar button: 0…1 with a mode, or -1 with 'none' to hide it. */
  setProgress(progress: number, mode: TaskbarMode): void
  notify(kind: 'done' | 'error', job: ExportJobInfo): void
  /** One of the app's windows has the focus: the user sees the queue anyway. */
  focused(): boolean
  /** One of the app's windows is fullscreen: no notification in front of an audience. */
  fullscreen(): boolean
  /** Notifications are wanted (off in the tests: DIASHOW_NOTIFY=0). */
  notifications: boolean
  setTimer?: (fn: () => void, ms: number) => unknown
}

/** How long the taskbar button stays red after a job failed. */
export const ERROR_SHOWN_MS = 10_000

export interface ExportFeedback {
  /** The queue's jobs as they are now (after every change). */
  update(jobs: readonly ExportJobInfo[]): void
}

const fraction = (j: ExportJobInfo): number => (j.totalFrames > 0 ? Math.min(1, Math.max(0, j.frame / j.totalFrames)) : 0)

export function createExportFeedback(d: FeedbackDeps): ExportFeedback {
  const setTimer = d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  let states = new Map<string, ExportJobState>()
  let failedShown = false
  let lastJobs: readonly ExportJobInfo[] = []
  let shown = ''

  const show = (progress: number, mode: TaskbarMode): void => {
    const key = `${mode}:${Math.round(progress * 1000)}`
    if (key === shown) return
    shown = key
    d.setProgress(progress, mode)
  }

  const apply = (): void => {
    if (failedShown) return show(1, 'error')
    const running = lastJobs.find((j) => j.state === 'running')
    if (running) return running.phase === 'prepare' ? show(0, 'indeterminate') : show(fraction(running), 'normal')
    const paused = lastJobs.find((j) => j.state === 'paused')
    if (paused) return show(fraction(paused), 'paused')
    show(-1, 'none')
  }

  return {
    update(jobs) {
      lastJobs = jobs
      for (const j of jobs) {
        const before = states.get(j.id)
        // a job seen for the first time (the queue as it was at start) is no news
        if (before === undefined || before === j.state) continue
        if (j.state === 'error') {
          failedShown = true
          setTimer(() => {
            failedShown = false
            apply()
          }, ERROR_SHOWN_MS)
        }
        if ((j.state === 'done' || j.state === 'error') && d.notifications && !d.focused() && !d.fullscreen()) d.notify(j.state, j)
      }
      states = new Map(jobs.map((j) => [j.id, j.state]))
      apply()
    }
  }
}
