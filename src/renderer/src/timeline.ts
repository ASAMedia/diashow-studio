import { buildTimeline, type Timeline } from '@shared/timeline'
import type { ThemeTrack } from '@shared/themeMusic'
import type { Project } from '@shared/types'
import { useStore } from './store'
import { localeTag } from './i18n'

const cache = new WeakMap<Project, { themeTracks: ThemeTrack[]; tl: Timeline }>()

/** The show's timeline with the bundled theme songs (cached per project). */
export function timelineOf(p: Project): Timeline {
  const themeTracks = useStore.getState().themeTracks
  let hit = cache.get(p)
  if (!hit || hit.themeTracks !== themeTracks) cache.set(p, (hit = { themeTracks, tl: buildTimeline(p, localeTag(), themeTracks) }))
  return hit.tl
}

export function useTimeline(): Timeline | null {
  const project = useStore((s) => s.project)
  // the theme songs arrive once at start; a timeline built before then is rebuilt
  useStore((s) => s.themeTracks)
  return project ? timelineOf(project) : null
}
