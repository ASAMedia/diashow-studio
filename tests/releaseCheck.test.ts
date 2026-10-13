// The release check (scripts/release-check.mjs) runs the end-to-end tests of the CI with its
// environment, read from .github/workflows/ci.yml. Also: every e2e spec is either in the CI or listed
// here with the reason it can't run there, so a new spec isn't forgotten.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ES module without types
import { ciE2e } from '../scripts/release-check.mjs'

const parse = ciE2e as (yml: string) => { specs: string[]; env: Record<string, string> } | null
const root = join(__dirname, '..')

/** Specs that don't run on GitHub's runner, and why. */
const LOCAL_ONLY: Record<string, string> = {
  'codecs.spec.ts': 'checks what the graphics card decodes',
  'demo-video.spec.ts': 'makes the website video (DIASHOW_DEMO_VIDEO)',
  'dragdrop.spec.ts': 'new, not yet in ci.yml',
  'exportspeed.spec.ts': 'measures hardware encoders with the original photos',
  'flicker.spec.ts': 'diagnostics on request',
  'handbook-shots.spec.ts': 'makes the handbook pictures (DIASHOW_HANDBOOK_SHOTS)',
  'magazine.spec.ts': 'needs a folder of real photos (DIASHOW_VISUAL_DIR)',
  'originals.spec.ts': 'needs the original photos (DIASHOW_ORIGINALS_DIR)',
  'pacing.spec.ts': 'measures preview timing on a real graphics card',
  'share.spec.ts': 'opens a network port the runner may block',
  'stabilize.spec.ts': 'long FFmpeg vid.stab runs',
  'systemcheck.spec.ts': 'tests hardware encoders',
  'trash.spec.ts': 'new, not yet in ci.yml',
  'ui-review.spec.ts': 'screenshots on request (DIASHOW_UI_REVIEW)'
}

describe('release check', () => {
  it('reads the specs and the environment of the CI end-to-end step', () => {
    const yml = ['jobs:', '  e2e:', '    steps:', '      - run: npx playwright test e2e/a.spec.ts  e2e/b.spec.ts', '        env:', "          DIASHOW_SOFTWARE_GL: '1'", '          # a note', '          DIASHOW_LOCALE: en-US', '        timeout-minutes: 40', '      - uses: x', '        env:', '          DIASHOW_OTHER: no'].join('\r\n')
    expect(parse(yml)).toEqual({ specs: ['e2e/a.spec.ts', 'e2e/b.spec.ts'], env: { DIASHOW_SOFTWARE_GL: '1', DIASHOW_LOCALE: 'en-US' } })
    expect(parse('jobs: {}')).toBeNull()
  })

  it('the CI runs every e2e spec that can run there, in English with software WebGL', () => {
    const ci = parse(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'))!
    expect(ci.env).toMatchObject({ DIASHOW_LOCALE: 'en-US', DIASHOW_SOFTWARE_GL: '1' })
    for (const s of ci.specs) expect(existsSync(join(root, s)), s).toBe(true)
    const inCi = new Set(ci.specs.map((s) => s.replace(/^e2e\//, '')))
    const specs = readdirSync(join(root, 'e2e')).filter((f) => f.endsWith('.spec.ts'))
    const missing = specs.filter((f) => !inCi.has(f) && !LOCAL_ONLY[f])
    expect(missing, 'add these to .github/workflows/ci.yml, or to LOCAL_ONLY with a reason').toEqual([])
    for (const f of Object.keys(LOCAL_ONLY)) expect(inCi.has(f), `${f} is listed as local only but runs in the CI`).toBe(false)
  })
})
