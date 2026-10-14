import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// The tests run in parallel, each with an app of its own: every launch gets a fresh data folder
// (DIASHOW_DATA_DIR: projects, cache, userData with settings, logs, history, exports and Electron's
// single-instance lock), share servers and fake GitHubs listen on port 0, and test-media/ is made once
// before the workers start (e2e/globalSetup.ts). The one thing they share, the Windows clipboard, is
// taken one test at a time with Playwright's test lock 'clipboard' (Ctrl+V of files, "Copy chapters",
// the system check's report); a spec that uses the clipboard declares it: test('…', { lock: 'clipboard' }, …).
//
// DIASHOW_E2E_WORKERS sets how many apps run at once (1: one after another). Without it: half the
// logical processors, at most 6 (6 on an 8-core laptop); but one at a time where the processor draws
// everything, WebGL and windows: software WebGL on a CI runner, which has no GPU, or with --disable-gpu
// (e2e/launch.ts). Every app keeps the processor busy there, and two at once were no faster.
const cpuRendering = !!process.env.DIASHOW_SOFTWARE_GL && (!!process.env.CI || /--disable-gpu\b/.test(process.env.DIASHOW_E2E_ARGS ?? ''))
const workers = Number(process.env.DIASHOW_E2E_WORKERS) || (cpuRendering ? 1 : Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2))))

// The longest tests start first, so the run doesn't end waiting for one that started late. The two
// projects differ only in that order (Playwright starts the projects' tests in the order given here).
const LONG = /[\\/](app|features|livephoto|panorama|queue|pack|privacy|trash)\.spec\.ts$/

/** Seconds a spec takes on GitHub's runner (CI of 1.7.0); one not listed counts 15. */
const CI_SECONDS: Record<string, number> = { queue: 120, app: 108, chapters: 72, features: 66, livephoto: 66, dragdrop: 45, cleanup: 44, archive: 37, panorama: 35, trash: 35, privacy: 30 }

/**
 * DIASHOW_E2E_SHARD=i/n: this run takes part i of n of the CI's specs (the list in ci.yml), for one
 * runner per part. The specs are dealt out by CI_SECONDS so that the parts take about as long (Playwright's
 * own --shard cuts the list by the number of tests). Returns the specs of the other parts.
 */
function otherShards(): RegExp | undefined {
  const m = /^(\d+)\/(\d+)$/.exec(process.env.DIASHOW_E2E_SHARD ?? '')
  if (!m) return undefined
  const part = Number(m[1]) - 1
  const line = /npx playwright test (.*)/.exec(readFileSync(join(__dirname, '.github', 'workflows', 'ci.yml'), 'utf8'))?.[1] ?? ''
  const specs = line.trim().split(/\s+/).map((s) => /([\w-]+)\.spec\.ts$/.exec(s)?.[1]).filter((s): s is string => !!s)
  const weight = (s: string): number => CI_SECONDS[s] ?? 15
  const load: number[] = Array(Number(m[2])).fill(0)
  const others: string[] = []
  for (const s of specs.sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const i = load.indexOf(Math.min(...load))
    load[i] += weight(s)
    if (i !== part) others.push(s)
  }
  return new RegExp(`[\\\\/](${others.join('|') || '$^'})\\.spec\\.ts$`)
}
const notThisShard = otherShards()

export default defineConfig({
  testDir: 'e2e',
  timeout: 600_000,
  // a test next to others runs slower than alone: what the default 5 s left a slow load (a waveform,
  // a still cut from a clip), 15 s leaves it now; a passing check takes no longer for it
  expect: { timeout: 15_000 },
  workers,
  // the tests of one file run in parallel too: none of them depends on another
  fullyParallel: true,
  globalSetup: './e2e/globalSetup.ts',
  reporter: [['list']],
  outputDir: 'test-results',
  projects: [
    { name: 'long', testMatch: LONG, testIgnore: notThisShard ?? [] },
    { name: 'other', testIgnore: notThisShard ? [LONG, notThisShard] : LONG }
  ]
})
