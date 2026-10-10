// Stabilised clips ("Verwacklung beruhigen"): asks the main process for the stabilised version of
// every clip whose entry wants it (when switched on, and when a project opens whose cache lacks it,
// e.g. after a cleanup or on another PC). Progress and the result arrive as media updates
// (MediaItem.stabilizing / stabilized); failures are kept here so a clip is not retried in a loop.
import { useSyncExternalStore } from 'react'
import type { Project } from '@shared/types'
import { useStore } from './store'

const asked = new Set<string>()
const failed = new Map<string, string>()
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((l) => l())

/** Requests the stabilised version once per session; `retry` asks again after a failure. */
export function requestStabilize(mediaId: string, retry = false): void {
  if (retry && failed.delete(mediaId)) {
    asked.delete(mediaId)
    notify()
  }
  if (asked.has(mediaId) || failed.has(mediaId)) return
  asked.add(mediaId)
  notify()
  window.api.stabilizeVideo(mediaId).then(
    () => {
      // asked again if the file disappears later (cache cleanup)
      asked.delete(mediaId)
      notify()
    },
    (e: unknown) => {
      failed.set(mediaId, e instanceof Error ? e.message : String(e))
      notify()
    }
  )
}

/** 'failed' after an error, 'asked' while a request is open (it may wait for another clip), else null. */
export function useStabilizeRequest(mediaId: string): 'failed' | 'asked' | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => (failed.has(mediaId) ? 'failed' : asked.has(mediaId) ? 'asked' : null)
  )
}

function missingIn(p: Project): string[] {
  const media = new Map(p.media.map((m) => [m.id, m]))
  const out: string[] = []
  for (const e of p.entries) {
    if (e.type !== 'video' || !e.stabilize) continue
    const m = media.get(e.mediaId)
    if (m && m.kind === 'video' && m.status === 'ready' && m.playback && !m.stabilized && m.stabilizing === undefined) out.push(m.id)
  }
  return out
}

/** Watches the open project and requests what is missing; returns the unsubscribe function. */
export function watchStabilize(): () => void {
  const check = (p: Project | null): void => {
    if (p) for (const id of missingIn(p)) requestStabilize(id)
  }
  check(useStore.getState().project)
  return useStore.subscribe((s, prev) => {
    if (s.project && (s.project.entries !== prev.project?.entries || s.project.media !== prev.project?.media)) check(s.project)
  })
}
