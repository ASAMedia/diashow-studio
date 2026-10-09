import { buildTimeline, type Timeline } from '@shared/timeline'
import type { Project } from '@shared/types'
import { useStore } from './store'
import { localeTag } from './i18n'

const cache = new WeakMap<Project, Timeline>()

export function timelineOf(p: Project): Timeline {
  let tl = cache.get(p)
  if (!tl) cache.set(p, (tl = buildTimeline(p, localeTag())))
  return tl
}

export function useTimeline(): Timeline | null {
  const project = useStore((s) => s.project)
  return project ? timelineOf(project) : null
}
