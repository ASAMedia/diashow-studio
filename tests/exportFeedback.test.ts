// The export queue outside the app (src/main/export/feedback.ts): the taskbar button's progress and
// mode, and a notification when a job is done or failed while the app isn't in front, never while it
// shows something fullscreen, never for jobs that were already finished when the app started.
import { describe, expect, it } from 'vitest'
import type { ExportJobInfo } from '@shared/exportQueue'
import { createExportFeedback, ERROR_SHOWN_MS, type FeedbackDeps } from '../src/main/export/feedback'

const job = (id: string, patch: Partial<ExportJobInfo> = {}): ExportJobInfo =>
  ({ id, name: `Klassenfahrt ${id}`, outPath: `C:\\Videos\\${id}.mp4`, state: 'queued', frame: 0, totalFrames: 300, createdAt: 0, width: 1920, height: 1080, ...patch }) as ExportJobInfo

function setup(over: Partial<FeedbackDeps> = {}) {
  const bar: string[] = []
  const notes: string[] = []
  const timers: (() => void)[] = []
  let focused = false
  let fullscreen = false
  const fb = createExportFeedback({
    setProgress: (p, mode) => bar.push(`${mode} ${p}`),
    notify: (kind, j) => notes.push(`${kind} ${j.id}`),
    focused: () => focused,
    fullscreen: () => fullscreen,
    notifications: true,
    setTimer: (fn) => timers.push(fn),
    ...over
  })
  return { fb, bar, notes, timers, focus: (v: boolean) => (focused = v), full: (v: boolean) => (fullscreen = v) }
}

describe('export feedback', () => {
  it('shows the running job in the taskbar, busy while it prepares, yellow when paused, nothing when idle', () => {
    const { fb, bar } = setup()
    fb.update([])
    fb.update([job('a', { state: 'running', phase: 'prepare' })])
    fb.update([job('a', { state: 'running', phase: 'video', frame: 75 })])
    fb.update([job('a', { state: 'running', phase: 'video', frame: 75 })])
    fb.update([job('a', { state: 'paused', frame: 150 })])
    fb.update([job('a', { state: 'cancelled', frame: 150 })])
    // the same state twice is set once
    expect(bar).toEqual(['none -1', 'indeterminate 0', 'normal 0.25', 'paused 0.5', 'none -1'])
  })

  it('notifies when a job is done or failed in the background, not in front, not fullscreen, not when switched off', () => {
    const s = setup()
    s.fb.update([job('a', { state: 'running' }), job('b', { state: 'running' })])
    s.fb.update([job('a', { state: 'done', frame: 300 }), job('b', { state: 'running' })])
    s.focus(true)
    s.fb.update([job('a', { state: 'done' }), job('b', { state: 'error', error: 'disk full' })])
    expect(s.notes).toEqual(['done a'])
    s.focus(false)
    s.full(true)
    s.fb.update([job('a', { state: 'done' }), job('b', { state: 'running' })])
    s.fb.update([job('a', { state: 'done' }), job('b', { state: 'done' })])
    expect(s.notes).toEqual(['done a'])
    const off = setup({ notifications: false })
    off.fb.update([job('c', { state: 'running' })])
    off.fb.update([job('c', { state: 'done' })])
    expect(off.notes).toEqual([])
  })

  it('jobs the app finds when it starts are no news', () => {
    const s = setup()
    s.fb.update([job('old', { state: 'done' }), job('bad', { state: 'error' })])
    expect(s.notes).toEqual([])
    expect(s.bar).toEqual(['none -1'])
  })

  it('a failed job turns the button red for a while, then it shows the queue again', () => {
    const s = setup()
    s.fb.update([job('a', { state: 'running', frame: 30 }), job('b', { state: 'queued' })])
    s.fb.update([job('a', { state: 'error', error: 'encoder' }), job('b', { state: 'running', frame: 0 })])
    expect(s.notes).toEqual(['error a'])
    s.fb.update([job('a', { state: 'error' }), job('b', { state: 'running', frame: 150 })])
    expect(s.bar.slice(-1)).toEqual(['error 1'])
    expect(s.timers).toHaveLength(1)
    expect(ERROR_SHOWN_MS).toBeGreaterThanOrEqual(5000)
    s.timers[0]()
    expect(s.bar.slice(-1)).toEqual(['normal 0.5'])
  })
})
