// Reference counting for "keep the display awake" requests. Electron-free: ipc.ts plugs in
// powerSaveBlocker and releases a window's requests when it closes.

export interface PowerBlocker {
  start(): number
  stop(id: number): void
}

export interface KeepAwake {
  /** on: one more request from `owner` (a window); off: one request fewer. */
  set(owner: number, on: boolean): void
  /** Drops every request of `owner` (window closed). */
  release(owner: number): void
  readonly active: boolean
}

/** One blocker for the whole app, held while any window has an open request. */
export function createKeepAwake(blocker: PowerBlocker): KeepAwake {
  const counts = new Map<number, number>()
  let id: number | null = null
  const sync = (): void => {
    const wanted = counts.size > 0
    if (wanted && id === null) id = blocker.start()
    else if (!wanted && id !== null) {
      blocker.stop(id)
      id = null
    }
  }
  return {
    set(owner, on) {
      const n = (counts.get(owner) ?? 0) + (on ? 1 : -1)
      if (n > 0) counts.set(owner, n)
      else counts.delete(owner)
      sync()
    },
    release(owner) {
      counts.delete(owner)
      sync()
    },
    get active() {
      return id !== null
    }
  }
}
