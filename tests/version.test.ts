import { describe, expect, it } from 'vitest'
import { compareVersions, isNewerVersion, parseVersion, plainVersion } from '@shared/version'

describe('version compare', () => {
  it('parses tags and short versions', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] })
    expect(parseVersion('1.2')).toEqual({ major: 1, minor: 2, patch: 0, pre: [] })
    expect(parseVersion('2.0.0-beta.11+build.7')).toEqual({ major: 2, minor: 0, patch: 0, pre: ['beta', 11] })
    expect(parseVersion('Diashow 1.0')).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('latest')).toBeNull()
  })

  it('orders major, minor and patch numerically', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1)
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
  })

  it('ranks pre-releases below their release, following semver', () => {
    const sorted = ['1.0.0', '1.0.0-rc.1', '1.0.0-beta.11', '1.0.0-beta.2', '1.0.0-beta', '1.0.0-alpha.beta', '1.0.0-alpha.1', '1.0.0-alpha']
    expect([...sorted].sort(compareVersions)).toEqual([
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0'
    ])
    expect(compareVersions('1.0.1-beta', '1.0.0')).toBe(1)
  })

  it('says whether a release is newer', () => {
    expect(isNewerVersion('v1.1.0', '1.0.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
    expect(isNewerVersion('0.9.0', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0', '1.0.0-rc.2')).toBe(true)
    // nonsense from the server never counts as newer
    expect(isNewerVersion('nightly', '1.0.0')).toBe(false)
    // an unknown current version: any real release is newer
    expect(isNewerVersion('1.0.0', 'dev')).toBe(true)
  })

  it('drops the v of a tag for display', () => {
    expect(plainVersion('v1.2.0')).toBe('1.2.0')
    expect(plainVersion('1.2.0')).toBe('1.2.0')
    expect(plainVersion('vintage')).toBe('vintage')
  })
})
