// Tells the main process which media the user is looking at, so a big import processes those
// first: the slide in the preview, then the visible tiles of the review grid, then the visible
// filmstrip cards.
import { useStore } from './store'

const ORDER = ['viewer', 'cull', 'filmstrip'] as const
type Source = (typeof ORDER)[number]

const sources = new Map<Source, string[]>()
let timer: ReturnType<typeof setTimeout> | undefined
let last = ''

function flush(): void {
  const p = useStore.getState().project
  const pending = new Set(p?.media.filter((m) => m.status === 'pending' || m.status === 'processing').map((m) => m.id))
  const ids = [...new Set(ORDER.flatMap((k) => sources.get(k) ?? []))].filter((id) => pending.has(id))
  const key = ids.join(',')
  if (key === last) return
  last = key
  void window.api.mediaPrioritize(ids).catch(() => {})
}

/** Media ids a part of the UI shows right now (most important first); [] when it shows none. */
export function prioritize(source: Source, ids: string[]): void {
  sources.set(source, ids)
  clearTimeout(timer)
  timer = setTimeout(flush, 250)
}
