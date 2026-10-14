// The GPU tone-mapping check (src/main/media/hdr.ts) makes small clips in the temp folder; an app that
// quits during the check leaves them there. The next check removes its own old ones, nothing else.
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { sweepOldChecks } from '../src/main/media/hdr'

const dir = mkdtempSync(join(tmpdir(), 'diashow-hdrsweep-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('left-over HDR check files', () => {
  it('removes only the check’s own files that are an hour old or more', async () => {
    const now = Date.now()
    const old = (now - 2 * 3_600_000) / 1000
    const files = {
      'diashow-hdr-1234-0a1b2c3d.mp4': old,
      'diashow-hdr-1234-0a1b2c3d-a.mp4': old,
      'diashow-hdr-1234-0a1b2c3d-h264.mp4': old,
      'diashow-hdr-1234-0a1b2c3d.rgb': old,
      // a check running right now
      'diashow-hdr-99-ffffffff.mp4': now / 1000,
      // not ours
      'diashow-hdr-notes.txt': old,
      'other-hdr-1234-0a1b2c3d.mp4': old,
      'diashow-hdr-1234-0a1b2c3d.mp4.keep': old
    }
    for (const [name, t] of Object.entries(files)) {
      writeFileSync(join(dir, name), 'x')
      utimesSync(join(dir, name), t, t)
    }
    expect(await sweepOldChecks(dir, now)).toBe(4)
    const left = Object.keys(files).filter((n) => existsSync(join(dir, n)))
    expect(left.sort()).toEqual(['diashow-hdr-1234-0a1b2c3d.mp4.keep', 'diashow-hdr-99-ffffffff.mp4', 'diashow-hdr-notes.txt', 'other-hdr-1234-0a1b2c3d.mp4'])
    // a folder that can't be read is no error
    expect(await sweepOldChecks(join(dir, 'missing'), now)).toBe(0)
  })
})
