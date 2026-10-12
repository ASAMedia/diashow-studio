// rename over an existing file that waits a moment while Windows keeps the target busy. Replacing a
// file fails with EPERM/EBUSY/EACCES while anyone still has it open: our own read a moment earlier,
// Explorer's preview, a virus scanner. That lasts milliseconds to seconds, so a few retries with a
// growing pause fix it instead of showing "the file is locked" to the user.
import { rename } from 'node:fs/promises'

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])

export async function replaceFile(from: string, to: string, opts: { attempts?: number; delayMs?: number } = {}): Promise<void> {
  const attempts = opts.attempts ?? 8
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt + 1 >= attempts || !code || !BUSY.has(code)) throw err
      // 25, 50, 100 … 400 ms: about 1.6 s in all by default
      await new Promise((r) => setTimeout(r, opts.delayMs ?? Math.min(400, 25 * 2 ** attempt)))
    }
  }
}
