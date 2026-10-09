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
