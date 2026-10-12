import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ES module without types
import * as gpl from '../scripts/gpl-sources.mjs'

interface Source { n: number; kind: string; url?: string; ref?: string; isSha?: boolean; isTag?: boolean; mirror?: string; hash?: { algo: string; value: string } | null }
interface Script { vars: Record<string, string>; functions: Record<string, string>; skip: boolean; sources: Source[] }
interface Enabled { enabled: boolean; sure: boolean; reason: string }
interface Placed { url: string; dir: string; submodules: { recursive: boolean; paths: string[] | null } | null; excludes: string[]; extras: { type: string }[] }
interface Build { included: { path: string }[]; scripts: { path: string; included: boolean; reason: string }[] }

const { parseScript, evalEnabled, dlPlan, readBuild, classifyLicence } = gpl as {
  parseScript: (text: string) => Script
  evalEnabled: (script: Script, ctx: Record<string, string | number>) => Enabled
  dlPlan: (script: Script) => { placed: Placed[]; unhandled: string[] }
  readBuild: (files: Map<string, string>, target: { target: string; variant: string; addins: string }) => Build
  classifyLicence: (text: string) => string | null
}

const win64 = { TARGET: 'win64', VARIANT: 'gpl-shared', ADDINS_STR: '9.0', ffver: 900 }

describe('BtbN build scripts, read without running them', () => {
  it('reads a GitHub repository pinned to a commit', () => {
    const s = parseScript(
      ['#!/bin/bash', '', 'SCRIPT_REPO="https://github.com/madler/zlib.git"', 'SCRIPT_COMMIT="767c4c947852e143f582c85f14cf573411df1b35"', '', 'ffbuild_enabled() {', '    return 0', '}'].join('\n')
    )
    expect(s.sources).toEqual([
      expect.objectContaining({ kind: 'git', url: 'https://github.com/madler/zlib.git', ref: '767c4c947852e143f582c85f14cf573411df1b35', isSha: true, isTag: false })
    ])
    expect(evalEnabled(s, win64)).toMatchObject({ enabled: true, sure: true })
    expect(dlPlan(s).placed).toEqual([expect.objectContaining({ url: 'https://github.com/madler/zlib.git', dir: '.', submodules: null })])
  })

  it('reads a tarball URL with its checksum, and a tag', () => {
    const sha = 'ab'.repeat(64)
    const s = parseScript(['SCRIPT_VER="1.2.3"', 'SCRIPT_URL="https://example.org/libfoo-${SCRIPT_VER}.tar.xz"', `SCRIPT_SHA512="${sha}"`].join('\n'))
    expect(s.sources).toEqual([{ n: 1, kind: 'url', url: 'https://example.org/libfoo-1.2.3.tar.xz', hash: { algo: 'sha512', value: sha } }])
    const tag = parseScript('SCRIPT_REPO="https://github.com/openssl/openssl.git"\nSCRIPT_COMMIT="openssl-3.6.4"\nSCRIPT_TAGFILTER="openssl-3.6.*"\n')
    expect(tag.sources[0]).toMatchObject({ kind: 'git', ref: 'openssl-3.6.4', isTag: true })
  })

  it('leaves out a dependency that is off for win64 and keeps one it cannot evaluate', () => {
    const linuxOnly = parseScript('SCRIPT_REPO="https://gitlab.freedesktop.org/xorg/lib/libx11.git"\nSCRIPT_COMMIT="13f9b8de400335f4b86bb0672da02f8166c0e796"\n\nffbuild_enabled() {\n    [[ $TARGET != linux* ]] && return -1\n    return 0\n}\n')
    expect(evalEnabled(linuxOnly, win64)).toEqual({ enabled: false, sure: true, reason: '[[ $TARGET != linux* ]] && return -1' })
    expect(evalEnabled(linuxOnly, { ...win64, TARGET: 'linux64' }).enabled).toBe(true)
    const checks = (body: string, ctx = win64) => evalEnabled(parseScript(`ffbuild_enabled() {\n${body}\n}\n`), ctx).enabled
    expect(checks('    [[ $VARIANT == lgpl* ]] && return -1\n    return 0')).toBe(true)
    expect(checks('    [[ $VARIANT == nonfree* ]] || return -1\n    return 0')).toBe(false)
    expect(checks('    (( $(ffbuild_ffver) <= 900 )) && return -1\n    return 0')).toBe(false)
    expect(checks('    [[ $ADDINS_STR == *4.4* && $TARGET == win* ]] && return -1\n    return 0')).toBe(true)
    expect(checks('    [[ $TARGET == win* ]]')).toBe(true)
    const unsure = evalEnabled(parseScript('ffbuild_enabled() {\n    if [[ -n "$FOO" ]]; then return -1; fi\n}\n'), win64)
    expect(unsure).toMatchObject({ enabled: true, sure: false })
  })

  it('reads numbered sources, mirrors and what the download step puts where', () => {
    const s = parseScript(
      [
        'SCRIPT_REPO="https://github.com/BtbN/Vulkan-Shim-Loader.git"',
        'SCRIPT_COMMIT="65b3936528cd92eb4ea3de485d03f858a3850484"',
        '',
        'SCRIPT_REPO2="https://github.com/KhronosGroup/Vulkan-Headers.git"',
        'SCRIPT_COMMIT2="v1.4.363"',
        'SCRIPT_MIRROR2="https://example.org/Vulkan-Headers.git"',
        '',
        'ffbuild_dockerdl() {',
        '    default_dl .',
        '    echo "git-mini-clone \\"$SCRIPT_REPO2\\" \\"$SCRIPT_COMMIT2\\" Vulkan-Headers"',
        '    echo "git submodule update --init --recursive --depth 1 third_party/highway"',
        '    echo "rm -rf .git Thirdparty"',
        '}'
      ].join('\n')
    )
    expect(s.sources.map((x) => [x.n, x.url, x.ref, x.mirror])).toEqual([
      [1, 'https://github.com/BtbN/Vulkan-Shim-Loader.git', '65b3936528cd92eb4ea3de485d03f858a3850484', undefined],
      [2, 'https://github.com/KhronosGroup/Vulkan-Headers.git', 'v1.4.363', 'https://example.org/Vulkan-Headers.git']
    ])
    const plan = dlPlan(s)
    expect(plan.unhandled).toEqual([])
    expect(plan.placed.map((p) => p.dir)).toEqual(['.', 'Vulkan-Headers'])
    expect(plan.placed[0]).toMatchObject({ submodules: { recursive: true, paths: ['third_party/highway'] }, excludes: ['Thirdparty'] })
    expect(dlPlan(parseScript('ffbuild_dockerdl() {\n    echo "curl -O https://example.org/x.tar.gz"\n}\n')).unhandled).toHaveLength(1)
  })

  it('names licences by their title, not by licences they mention', () => {
    const gpl2 = '\t\t    GNU GENERAL PUBLIC LICENSE\n\t\t       Version 2, June 1991\n…\nconsider it more useful to permit linking proprietary applications with the library. If this is what you want to do, use the GNU Lesser General Public License instead of this License.'
    expect(classifyLicence(gpl2)).toBe('GPL-2.0')
    expect(classifyLicence('                  GNU LESSER GENERAL PUBLIC LICENSE\n                       Version 2.1, February 1999')).toBe('LGPL-2.1')
    expect(classifyLicence('Files are provided under a dual [Apache-2.0](https://spdx.org/licenses/Apache-2.0.html)\nOR [GPL-2.0-or-later](https://spdx.org/licenses/GPL-2.0-or-later.html) license.')).toBe('Apache-2.0 OR GPL-2.0-or-later')
    expect(classifyLicence('Permission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted.')).toBe('0BSD')
    expect(classifyLicence('See the file COPYING.')).toBeNull()
  })

  it('walks the dependencies from the last stage and switches a folder off with its last script', () => {
    const files = new Map([
      ['util/vars.sh', 'ffbuild_ffver() {\n    case "$ADDINS_STR" in\n    *9.0*)\n        echo 900\n        ;;\n    *)\n        echo 99999999\n        ;;\n    esac\n}\n'],
      ['scripts.d/10-zlib.sh', 'SCRIPT_REPO="https://github.com/madler/zlib.git"\nSCRIPT_COMMIT="767c4c947852e143f582c85f14cf573411df1b35"\nffbuild_enabled() {\n    return 0\n}\n'],
      ['scripts.d/10-unused.sh', 'SCRIPT_REPO="https://github.com/a/unused.git"\nSCRIPT_COMMIT="767c4c947852e143f582c85f14cf573411df1b35"\nffbuild_enabled() {\n    return 0\n}\n'],
      ['scripts.d/50-curl/40-nghttp2.sh', 'SCRIPT_REPO="https://github.com/a/nghttp2.git"\nSCRIPT_COMMIT="767c4c947852e143f582c85f14cf573411df1b35"\nffbuild_enabled() {\n    return 0\n}\n'],
      ['scripts.d/50-curl/50-curl.sh', 'SCRIPT_REPO="https://github.com/a/curl.git"\nSCRIPT_COMMIT="767c4c947852e143f582c85f14cf573411df1b35"\nffbuild_depends() {\n    echo unused\n}\nffbuild_enabled() {\n    (( $(ffbuild_ffver) <= 900 )) && return -1\n    return 0\n}\n'],
      ['scripts.d/zz-final.sh', 'SCRIPT_SKIP="1"\nffbuild_depends() {\n    echo zlib\n    echo curl\n}\nffbuild_enabled() {\n    return 0\n}\n']
    ])
    const build = readBuild(files, { target: 'win64', variant: 'gpl-shared', addins: '9.0' })
    expect(build.included.map((s) => s.path)).toEqual(['scripts.d/10-zlib.sh', 'scripts.d/zz-final.sh'])
    const reason = (p: string) => build.scripts.find((s) => s.path === p)?.reason
    expect(reason('scripts.d/50-curl/40-nghttp2.sh')).toMatch(/folder curl not built/)
    expect(reason('scripts.d/10-unused.sh')).toBe('only needed by curl, which is not built')
  })
})
