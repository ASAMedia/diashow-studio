// Tasks that must not overlap per project run one after another, those of different projects side
// by side: its saves, restores and repairs (projects.ts), the writes and loads of its undo history
// (history.ts), its clean-up, deletion and restore from the trash (cleanupMain.ts). Electron-free.

export interface SerialByKey {
  /** Runs `task` once the tasks queued before it under `key` have settled, also when one of them failed. */
  <T>(key: string, task: () => Promise<T>): Promise<T>
  /** Settles when every task queued so far has settled. */
  settled(): Promise<unknown>
}

export function serialByKey(): SerialByKey {
  const queues = new Map<string, Promise<unknown>>()
  const serial = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(task, task)
    const settled = next.catch(() => {})
    queues.set(key, settled)
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key)
    })
    return next
  }
  return Object.assign(serial, { settled: (): Promise<unknown> => Promise.all([...queues.values()]) })
}
