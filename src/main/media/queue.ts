/** Minimal FIFO concurrency limiter. */
export function createLimiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  const next = (): void => {
    if (active >= concurrency) return
    const start = waiting.shift()
    if (start) {
      active++
      start()
    }
  }
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--
            next()
          })
      })
      next()
    })
}

/**
 * Order of the pending media work, shared by all queues of the media service: the show order of the
 * items (import order, i.e. capture time) and the items the user looks at right now.
 */
export class MediaOrder {
  private rank = new Map<string, number>()
  private focus = new Map<string, number>()
  private counter = 0
  private listeners = new Set<() => void>()

  /** Appends ids that have no place yet, in the given order. */
  add(ids: Iterable<string>): void {
    for (const id of ids) if (!this.rank.has(id)) this.rank.set(id, this.counter++)
  }

  /**
   * The given ids (most urgent first) go ahead of all other pending work. Each call replaces the
   * previous one; an empty list goes back to show order.
   */
  prioritize(ids: Iterable<string>): void {
    this.focus.clear()
    for (const id of ids) if (typeof id === 'string' && !this.focus.has(id)) this.focus.set(id, this.focus.size)
    for (const fn of [...this.listeners]) fn()
  }

  focused(id: string | undefined): boolean {
    return id !== undefined && this.focus.has(id)
  }

  /**
   * Sort key of a task (lower runs first): focused items in the order given, all their work before
   * anything else; then by work class (thumbnails before display images before analysis); then by
   * show order. Tasks without an id come after the ranked ones of their class.
   */
  key(cls: number, id?: string): [number, number, number] {
    const f = id === undefined ? undefined : this.focus.get(id)
    if (f !== undefined) return [0, f, cls]
    return [1, cls, id === undefined ? Number.MAX_SAFE_INTEGER : (this.rank.get(id) ?? Number.MAX_SAFE_INTEGER)]
  }

  /** Called after every prioritize(); returns the unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

export interface Gate {
  /** One more unit of work the gate waits for (pair every enter with exactly one leave). */
  enter(): void
  leave(): void
  /** Resolves when no work is inside, or as soon as `id` is focused in the shared MediaOrder. */
  wait(id?: string): Promise<void>
  readonly count: number
}

/**
 * Counts work in progress of one kind (thumbnails, display images, essential processing) so later
 * stages can wait for all of it, e.g. proxies until every thumbnail exists. Focused items pass.
 */
export function createGate(order: MediaOrder): Gate {
  let count = 0
  let waiters: Array<{ id?: string; resolve: () => void }> = []
  const release = (): void => {
    const go = waiters.filter((w) => count === 0 || order.focused(w.id))
    if (!go.length) return
    waiters = waiters.filter((w) => !go.includes(w))
    for (const w of go) w.resolve()
  }
  order.onChange(release)
  return {
    enter() {
      count++
    },
    leave() {
      count = Math.max(0, count - 1)
      if (count === 0) release()
    },
    wait(id) {
      if (count === 0 || order.focused(id)) return Promise.resolve()
      return new Promise((resolve) => waiters.push({ id, resolve }))
    },
    get count() {
      return count
    }
  }
}

function before(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]
}

export interface PriorityLimiter {
  /**
   * Runs `task` when a slot is free. Queued tasks start in MediaOrder.key order: focused items first,
   * then lower `priority` (work class), then show order of `id`; FIFO among equals.
   */
  <T>(task: () => Promise<T>, priority?: number, id?: string): Promise<T>
  /**
   * Resolves once no task with priority <= maxPriority is queued or running, or as soon as `id` is
   * focused (MediaOrder.prioritize), so the item the user looks at doesn't wait for the others.
   */
  drained(maxPriority: number, id?: string): Promise<void>
  /** Tasks queued or running. */
  readonly size: number
}

/** Concurrency limiter with priority classes and an optional shared MediaOrder. */
export function createPriorityLimiter(concurrency: number, order: MediaOrder = new MediaOrder()): PriorityLimiter {
  let active = 0
  let seq = 0
  let total = 0
  const waiting: Array<{ priority: number; id?: string; seq: number; start: () => void }> = []
  const counts = new Map<number, number>()
  const watchers: Array<{ max: number; id?: string; resolve: () => void }> = []

  const busy = (max: number): boolean => [...counts].some(([p, n]) => p <= max && n > 0)
  const notify = (): void => {
    // In registration order: whoever waits first continues first
    const ready = watchers.filter((w) => !busy(w.max) || order.focused(w.id))
    if (!ready.length) return
    for (const w of ready) watchers.splice(watchers.indexOf(w), 1)
    for (const w of ready) w.resolve()
  }
  const next = (): void => {
    while (active < concurrency && waiting.length) {
      let best = 0
      let bestKey = order.key(waiting[0].priority, waiting[0].id)
      for (let i = 1; i < waiting.length; i++) {
        const k = order.key(waiting[i].priority, waiting[i].id)
        if (before(k, bestKey) || (!before(bestKey, k) && waiting[i].seq < waiting[best].seq)) {
          best = i
          bestKey = k
        }
      }
      const [entry] = waiting.splice(best, 1)
      active++
      entry.start()
    }
  }
  order.onChange(notify)

  const limiter = <T>(task: () => Promise<T>, priority = 0, id?: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      counts.set(priority, (counts.get(priority) ?? 0) + 1)
      total++
      waiting.push({
        priority,
        id,
        seq: seq++,
        start: () => {
          task()
            .then(resolve, reject)
            .finally(() => {
              active--
              total--
              counts.set(priority, counts.get(priority)! - 1)
              notify()
              next()
            })
        }
      })
      next()
    })

  limiter.drained = (maxPriority: number, id?: string): Promise<void> =>
    busy(maxPriority) && !order.focused(id) ? new Promise<void>((resolve) => watchers.push({ max: maxPriority, id, resolve })) : Promise.resolve()
  Object.defineProperty(limiter, 'size', { get: () => total })

  return limiter as PriorityLimiter
}
