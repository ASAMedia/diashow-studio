import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ES module without types
import { releaseNotes } from '../scripts/release-notes.mjs'

const notes = releaseNotes as (changelog: string, version: string) => string | null

describe('release notes from the changelog', () => {
  const log = ['# Changelog', '', '## [1.1.0] - 2026-11-01', '', '- New thing', '', '## [1.0.0]', '', 'First.', '', '## 0.9.0', 'Old', '', '[1.1.0]: https://example.com/1.1.0'].join('\r\n')

  it('takes the section of a tag or version up to the next heading', () => {
    expect(notes(log, 'v1.1.0')).toBe('- New thing')
    expect(notes(log, '1.0.0')).toBe('First.')
    expect(notes(log, '0.9.0')).toBe('Old')
  })

  it('does not mix up similar versions and fails for missing ones', () => {
    expect(notes(log, '1.0')).toBeNull()
    expect(notes(log, '2.0.0')).toBeNull()
    expect(notes('## [1.0.0]\n\n', '1.0.0')).toBeNull()
  })

  it('CHANGELOG.md has notes for the version in package.json', () => {
    const root = join(__dirname, '..')
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
    const text = notes(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version)
    expect(text).toBeTruthy()
    expect(text).toContain('THIRD_PARTY_NOTICES')
  })
})
