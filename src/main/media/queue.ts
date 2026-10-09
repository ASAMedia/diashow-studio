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

export interface PriorityLimiter {
  /** Runs `task` when a slot is free; queued tasks with a lower priority number start first. */
  <T>(task: () => Promise<T>, priority?: number): Promise<T>
  /** Resolves once no task with priority <= maxPriority is queued or running. */
  drained(maxPriority: number): Promise<void>
}

/** Concurrency limiter with priority classes (FIFO within a class). */
export function createPriorityLimiter(concurrency: number): PriorityLimiter {
  let active = 0
  const waiting = new Map<number, Array<() => void>>()
  const counts = new Map<number, number>()
  const watchers: Array<{ max: number; resolve: () => void }> = []

  const busy = (max: number): boolean => [...counts].some(([p, n]) => p <= max && n > 0)
  const notify = (): void => {
    // In registration order: whoever waits first continues first
    const ready = watchers.filter((w) => !busy(w.max))
    if (!ready.length) return
    for (const w of ready) watchers.splice(watchers.indexOf(w), 1)
    for (const w of ready) w.resolve()
  }
  const next = (): void => {
    while (active < concurrency) {
      const priority = [...waiting.keys()].filter((p) => waiting.get(p)!.length).sort((a, b) => a - b)[0]
      if (priority === undefined) return
      active++
      waiting.get(priority)!.shift()!()
    }
  }

  const limiter = <T>(task: () => Promise<T>, priority = 0): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      counts.set(priority, (counts.get(priority) ?? 0) + 1)
      let list = waiting.get(priority)
      if (!list) waiting.set(priority, (list = []))
      list.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--
            counts.set(priority, counts.get(priority)! - 1)
            notify()
            next()
          })
      })
      next()
    })

  limiter.drained = (maxPriority: number): Promise<void> =>
    busy(maxPriority) ? new Promise<void>((resolve) => watchers.push({ max: maxPriority, resolve })) : Promise.resolve()

  return limiter as PriorityLimiter
}
