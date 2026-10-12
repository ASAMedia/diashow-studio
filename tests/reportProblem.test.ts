// "Problem melden": the link to the bug form (only version, Windows and graphics card, short enough for
// GitHub) and the main process's check of what it may open in the browser (pages of the project only).
import { describe, expect, it } from 'vitest'
import { bugReportUrl, gpuSummary, MAX_FIELD_LENGTH, MAX_URL_LENGTH } from '@shared/reportProblem'
import { checkProjectUrl } from '../src/main/ipcGuards'

const fields = { version: '1.0.0', windows: 'Windows 11 Home (10.0.26100)', gpu: 'NVIDIA GeForce RTX 3060 (32.0.15.6094)' }

describe('bug report link', () => {
  it('fills in the bug form with the three fields', () => {
    const url = bugReportUrl(fields)
    expect(url).toBe(
      'https://github.com/ASAMedia/diashow-studio/issues/new?template=bug.yml&version=1.0.0&windows=Windows%2011%20Home%20(10.0.26100)&gpu=NVIDIA%20GeForce%20RTX%203060%20(32.0.15.6094)'
    )
    const q = new URL(url).searchParams
    expect([...q.keys()]).toEqual(['template', 'version', 'windows', 'gpu'])
    expect(q.get('windows')).toBe(fields.windows)
    expect(q.get('gpu')).toBe(fields.gpu)
  })

  it('leaves out empty fields, flattens line breaks and keeps the link short', () => {
    expect(bugReportUrl({ version: '1.0.0', windows: '', gpu: '  ' })).toBe('https://github.com/ASAMedia/diashow-studio/issues/new?template=bug.yml&version=1.0.0')
    const q = new URL(bugReportUrl({ version: '1.0.0\r\n&title=x', windows: 'a\tb', gpu: 'ü'.repeat(5000) })).searchParams
    expect(q.get('version')).toBe('1.0.0 &title=x')
    expect(q.get('title')).toBeNull()
    expect(q.get('windows')).toBe('a b')
    expect(q.get('gpu')!.length).toBe(MAX_FIELD_LENGTH)
    const long = bugReportUrl({ version: '%'.repeat(9999), windows: '€'.repeat(9999), gpu: '"'.repeat(9999) })
    expect(long.length).toBeLessThan(MAX_URL_LENGTH)
    expect(checkProjectUrl(long)).toBe(new URL(long).href)
  })

  it('names the graphics cards, the active one first, without the software adapter', () => {
    expect(
      gpuSummary([
        { vendor: 'Microsoft', device: 'Microsoft Basic Render Driver', active: false },
        { vendor: 'Intel', device: 'Intel(R) UHD Graphics 770', driver: '31.0.101.4502', active: false },
        { vendor: 'NVIDIA', device: 'NVIDIA GeForce RTX 3060', driver: '32.0.15.6094', active: true }
      ])
    ).toBe('NVIDIA GeForce RTX 3060 (32.0.15.6094), Intel(R) UHD Graphics 770 (31.0.101.4502)')
    expect(gpuSummary([{ vendor: 'AMD', device: '0x15bf', active: true }])).toBe('AMD 0x15bf')
    expect(gpuSummary([{ vendor: 'Microsoft', device: 'Microsoft Basic Render Driver', active: true }])).toBe('Microsoft Basic Render Driver')
    expect(gpuSummary([])).toBe('')
  })
})

describe('what the browser may open', () => {
  it('opens pages of the project on GitHub', () => {
    for (const url of [
      bugReportUrl(fields),
      'https://github.com/ASAMedia/diashow-studio/issues/new/choose',
      'https://github.com/ASAMedia/diashow-studio/releases/latest',
      'https://github.com/ASAMedia/diashow-studio/issues?q=is%3Aissue+export'
    ])
      expect(checkProjectUrl(url)).toBe(url)
  })

  it('refuses everything else', () => {
    for (const url of [
      undefined,
      null,
      42,
      { href: 'https://github.com/ASAMedia/diashow-studio/' },
      '',
      'https://github.com/ASAMedia/diashow-studio',
      'http://github.com/ASAMedia/diashow-studio/issues',
      'https://github.com/ASAMedia/other/issues',
      'https://github.com/asamedia/diashow-studio/issues',
      'https://github.com/ASAMedia/diashow-studio-fork/issues',
      'https://github.com/ASAMedia/diashow-studio.evil.example/',
      'https://github.com.evil.example/ASAMedia/diashow-studio/',
      'https://user@github.com/ASAMedia/diashow-studio/',
      'https://github.com:444/ASAMedia/diashow-studio/',
      'https://example.com/?https://github.com/ASAMedia/diashow-studio/',
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)//https://github.com/ASAMedia/diashow-studio/',
      'ms-settings:https://github.com/ASAMedia/diashow-studio/',
      // leaves the project once the path is resolved
      'https://github.com/ASAMedia/diashow-studio/../../evil/repo',
      'https://github.com/ASAMedia/diashow-studio/%2e%2e/%2e%2e/evil/repo',
      'https://github.com/ASAMedia/diashow-studio/.%2E/x',
      'https://github.com/ASAMedia/diashow-studio/%2F%2Fevil.example',
      'https://github.com/ASAMedia/diashow-studio/..%5c..%5cevil',
      'https://github.com/ASAMedia/diashow-studio/\\..\\..\\evil',
      // control characters, spaces and line breaks
      'https://github.com/ASAMedia/diashow-studio/issues\n',
      'https://github.com/ASAMedia/diashow-studio/is sues',
      'https://github.com/ASAMedia/diashow-studio/\u0000',
      // too long for GitHub
      `https://github.com/ASAMedia/diashow-studio/issues/new?body=${'x'.repeat(MAX_URL_LENGTH)}`
    ])
      expect(() => checkProjectUrl(url), String(url)).toThrow(/only pages of the project/)
  })
})
